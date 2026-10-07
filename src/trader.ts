import { type Address, type Hex, type TransactionReceipt, decodeEventLog } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { erc20TransferEvent } from './abis.js'
import { CHAIN_ID, COVEN_ARB, MIN_GAS_PRICE, USDC, WEI_PER_USDC, gasLimitFor } from './constants.js'
import { buildPlan, encodeExecute } from './covenArb.js'
import { type Rpc, broadcast } from './rpc.js'
import type { Opportunity } from './strategy.js'

export type Outcome = {
  hash: Hex
  opportunity: Opportunity
  status: 'won' | 'reverted' | 'dropped'
  // USDC (6dp). profit is what CovenArb paid the signer; gas is what the signer paid.
  profit: bigint
  gas: bigint
  block?: bigint
}

type InFlight = { hash: Hex; opportunity: Opportunity; nonce: number; sentAt: number }

export type TraderStats = { sent: number; won: number; reverted: number; dropped: number; profit: bigint; gas: bigint }

const DROP_AFTER_MS = 45_000

export class Trader {
  stats: TraderStats = { sent: 0, won: 0, reverted: 0, dropped: 0, profit: 0n, gas: 0n }
  private nonce?: number
  private inflight = new Map<Hex, InFlight>()

  constructor(
    readonly rpc: Rpc,
    readonly account: PrivateKeyAccount,
    readonly opts: { maxFeeBps: number; maxInFlight?: number },
  ) {}

  private async syncNonce(): Promise<void> {
    this.nonce = await this.rpc.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' })
  }

  // Pools with a transaction of ours pending. Trading them again before it lands would
  // race our own trade.
  busyPools(): Set<Hex> {
    const s = new Set<Hex>()
    for (const f of this.inflight.values()) for (const l of f.opportunity.cycle.legs) s.add(l.pool.id)
    return s
  }

  canSend(o: Opportunity): boolean {
    if (this.inflight.size >= (this.opts.maxInFlight ?? 3)) return false
    const busy = this.busyPools()
    return !o.cycle.legs.some((l) => busy.has(l.pool.id))
  }

  // Signs locally and broadcasts to every endpoint: no estimateGas, nonce or fee lookups on
  // the hot path. minProfit is 1 wei-of-USDC: once sent, landing with any profit beats
  // reverting, since a revert burns the same gas for nothing.
  async submit(o: Opportunity, baseFee: bigint): Promise<Hex> {
    if (this.nonce === undefined) await this.syncNonce()
    const nonce = this.nonce!
    const plan = buildPlan(o.cycle, o.amountIn, 1n, this.opts.maxFeeBps)
    const floor = baseFee > MIN_GAS_PRICE ? baseFee : MIN_GAS_PRICE
    const raw = await this.account.signTransaction({
      type: 'eip1559',
      chainId: CHAIN_ID,
      nonce,
      to: COVEN_ARB,
      data: encodeExecute(plan),
      gas: gasLimitFor(o.cycle.legs.length, o.cycle.hooked),
      maxFeePerGas: floor * 2n + o.priorityFee,
      maxPriorityFeePerGas: o.priorityFee,
    })
    try {
      const hash = await broadcast(this.rpc, raw)
      this.nonce = nonce + 1
      this.inflight.set(hash, { hash, opportunity: o, nonce, sentAt: Date.now() })
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
    const receipts = await Promise.all(
      pending.map((f) => this.rpc.client.getTransactionReceipt({ hash: f.hash }).catch(() => undefined)),
    )
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
        out.push({ hash: f.hash, opportunity: f.opportunity, status: 'dropped', profit: 0n, gas: 0n })
      }
    })
    if (resync) await this.syncNonce().catch(() => undefined)
    return out
  }

  private settle(f: InFlight, r: TransactionReceipt): Outcome {
    const gas = (r.gasUsed * r.effectiveGasPrice) / WEI_PER_USDC
    const profit = r.status === 'success' ? payoutTo(r, this.account.address) : 0n
    this.stats.gas += gas
    if (r.status === 'success') {
      this.stats.won++
      this.stats.profit += profit
    } else {
      this.stats.reverted++
    }
    return { hash: f.hash, opportunity: f.opportunity, status: r.status === 'success' ? 'won' : 'reverted', profit, gas, block: r.blockNumber }
  }

  get pendingCount(): number {
    return this.inflight.size
  }
}

// USDC paid to `to` in this transaction. CovenArb pays the caller with a PoolManager `take`,
// so the transfer comes from the PoolManager, not from CovenArb; nothing else in an arb
// transaction sends the signer USDC.
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
