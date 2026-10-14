import { type Address, type Hex, type TransactionReceipt, decodeEventLog } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { covenProbeAbi, erc20TransferEvent } from './abis.js'
import { CHAIN_ID, COVEN_PROBE, MIN_GAS_PRICE, USDC, WEI_PER_USDC } from './constants.js'
import { type Candidate, type ProbeRoute, encodeProbe } from './probe.js'
import { type Rpc, broadcast } from './rpc.js'

// A route the simulation priced above its gas, about to be sent.
export type Send = {
  candidate: Candidate
  route: ProbeRoute
  // Profit after CovenProbe's fee as simulated (6-dec USDC), the block it was seen at, the gas
  // the send is expected to cost at the chosen tip, and what is left.
  profit: bigint
  block: bigint
  gasUsdc: bigint
  net: bigint
  gasLimit: bigint
  tip: bigint
}

export type Outcome = {
  hash: Hex
  send: Send
  // won: profit paid; missed: the gap was gone and the contract skipped the trade (cheap);
  // reverted: the transaction failed; dropped: never mined.
  status: 'won' | 'missed' | 'reverted' | 'dropped'
  // USDC (6dp): what CovenProbe paid the signer, the fee it took, and the gas paid.
  profit: bigint
  fee: bigint
  gas: bigint
  block?: bigint
}

type InFlight = { hash: Hex; send: Send; nonce: number; sentAt: number }

export type TraderStats = { sent: number; won: number; missed: number; reverted: number; dropped: number; profit: bigint; fee: bigint; gas: bigint }

const DROP_AFTER_MS = 45_000

// The signer cannot cover gas limit x max fee, which the node requires up front.
export class LowBalanceError extends Error {
  constructor(
    readonly have: bigint,
    readonly need: bigint,
  ) {
    super(`signer has ${Number(have) / 1e18} USDC but a send needs ${Number(need) / 1e18} USDC up front; fund it to keep trading`)
  }
}

export class Trader {
  stats: TraderStats = { sent: 0, won: 0, missed: 0, reverted: 0, dropped: 0, profit: 0n, fee: 0n, gas: 0n }
  private nonce?: number
  private inflight = new Map<Hex, InFlight>()
  // Native balance in wei, refreshed after every outcome.
  private balance?: bigint

  constructor(
    readonly rpc: Rpc,
    readonly account: PrivateKeyAccount,
    readonly opts: { maxFeeBps: number; maxInFlight?: number; probe?: Address },
  ) {}

  private async syncNonce(): Promise<void> {
    this.nonce = await this.rpc.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' })
  }

  async syncBalance(): Promise<bigint> {
    this.balance = await this.rpc.client.getBalance({ address: this.account.address })
    return this.balance
  }

  // Arc's base fee sits at its 20 gwei floor; 25% headroom covers a rise before inclusion.
  static maxFeePerGas(baseFee: bigint, tip: bigint): bigint {
    const floor = baseFee > MIN_GAS_PRICE ? baseFee : MIN_GAS_PRICE
    return (floor * 5n) / 4n + tip
  }

  // Pools with a transaction of ours pending: trading them again would race our own send.
  busyPools(): Set<Hex> {
    const s = new Set<Hex>()
    for (const f of this.inflight.values()) for (const id of f.send.candidate.pools) s.add(id)
    return s
  }

  canSend(c: Candidate): boolean {
    if (this.inflight.size >= (this.opts.maxInFlight ?? 3)) return false
    const busy = this.busyPools()
    return !c.pools.some((id) => busy.has(id))
  }

  // Signs locally and broadcasts to every endpoint: no estimateGas, nonce or fee lookups on
  // the hot path. The route's minProfit makes the contract skip a trade that no longer pays
  // for its gas, so a late send costs only the check.
  async submit(s: Send, baseFee: bigint): Promise<Hex> {
    if (this.nonce === undefined) await this.syncNonce()
    if (this.balance === undefined) await this.syncBalance()
    const maxFeePerGas = Trader.maxFeePerGas(baseFee, s.tip)
    const wei = s.gasLimit * maxFeePerGas
    // In-flight sends have already reserved part of the balance.
    let reserved = 0n
    for (const f of this.inflight.values()) reserved += f.send.gasLimit * maxFeePerGas
    if (this.balance! - reserved < wei) throw new LowBalanceError(this.balance! - reserved, wei)
    const nonce = this.nonce!
    const raw = await this.account.signTransaction({
      type: 'eip1559',
      chainId: CHAIN_ID,
      nonce,
      to: this.opts.probe ?? COVEN_PROBE,
      data: encodeProbe([s.route], this.opts.maxFeeBps),
      gas: s.gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: s.tip,
    })
    try {
      const hash = await broadcast(this.rpc, raw)
      this.nonce = nonce + 1
      this.inflight.set(hash, { hash, send: s, nonce, sentAt: Date.now() })
      this.stats.sent++
      return hash
    } catch (e) {
      await this.syncNonce().catch(() => undefined)
      throw e
    }
  }

  // Check every pending transaction once. Returns those that resolved.
  async poll(): Promise<Outcome[]> {
    if (this.inflight.size === 0) return []
    const pending = [...this.inflight.values()]
    const receipts = await Promise.all(pending.map((f) => this.rpc.client.getTransactionReceipt({ hash: f.hash }).catch(() => undefined)))
    const out: Outcome[] = []
    let resync = false
    pending.forEach((f, i) => {
      const r = receipts[i]
      if (r) {
        this.inflight.delete(f.hash)
        out.push(this.settle(f, r))
      } else if (Date.now() - f.sentAt > DROP_AFTER_MS) {
        this.inflight.delete(f.hash)
        this.stats.dropped++
        resync = true
        out.push({ hash: f.hash, send: f.send, status: 'dropped', profit: 0n, fee: 0n, gas: 0n })
      }
    })
    if (resync) await this.syncNonce().catch(() => undefined)
    if (out.length > 0) await this.syncBalance().catch(() => undefined)
    return out
  }

  private settle(f: InFlight, r: TransactionReceipt): Outcome {
    const gas = (r.gasUsed * r.effectiveGasPrice) / WEI_PER_USDC
    const { profit, fee } = r.status === 'success' ? executedFor(r, this.account.address, this.opts.probe) : { profit: 0n, fee: 0n }
    this.stats.gas += gas
    const status = r.status !== 'success' ? 'reverted' : profit > 0n ? 'won' : 'missed'
    this.stats[status]++
    this.stats.profit += profit
    this.stats.fee += fee
    return { hash: f.hash, send: f.send, status, profit, fee, gas, block: r.blockNumber }
  }

  get pendingCount(): number {
    return this.inflight.size
  }
}

// Profit CovenProbe paid `caller` in this transaction and the fee it kept, from its Executed
// events (6-decimal USDC).
export function executedFor(r: TransactionReceipt, caller: Address, probe: Address = COVEN_PROBE): { profit: bigint; fee: bigint } {
  let profit = 0n
  let fee = 0n
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== probe.toLowerCase()) continue
    try {
      const ev = decodeEventLog({ abi: covenProbeAbi, data: log.data, topics: log.topics })
      if (ev.eventName !== 'Executed' || ev.args.caller.toLowerCase() !== caller.toLowerCase()) continue
      profit += ev.args.profit
      fee += ev.args.fee
    } catch {
      // another event
    }
  }
  return { profit, fee }
}

// USDC paid to `to` in this transaction (ERC-20 transfers from any sender). CovenArb and
// CovenProbe pay through a PoolManager `take`.
export function payoutTo(r: TransactionReceipt, to: Address): bigint {
  let sum = 0n
  const usdc = USDC.toLowerCase()
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== usdc) continue
    try {
      const ev = decodeEventLog({ abi: [erc20TransferEvent], data: log.data, topics: log.topics })
      if (ev.args.to.toLowerCase() === to.toLowerCase()) sum += ev.args.value
    } catch {
      // not a Transfer
    }
  }
  return sum
}
