import { type Address, type Hex, type Log, type PublicClient, getAddress, hexToBytes, zeroAddress } from 'viem'
import {
  stateViewAbi,
  v3FactoryAbi,
  v3PoolAbi,
  v3PoolCreatedEvent,
  v4InitializeEvent,
} from './abis.js'
import { EURC, NATIVE, POOL_MANAGER, STATE_VIEW, USDC, V3_FACTORIES, V3_FACTORY } from './constants.js'
import { type Pool, type PoolKey, type PoolRegistry, DYNAMIC_FEE, isHooked, v4Pool, v4PoolId } from './pools.js'
import { getLogsChunked } from './rpc.js'

const lc = (a: string) => a.toLowerCase() as Address

export const V3_FEE_TIERS = [100, 500, 3000, 10000]
// (fee, tickSpacing) pairs seen on Arc's v4 pools, standard and launchpad.
export const V4_FEE_SPACINGS: [number, number][] = [
  [100, 1], [500, 10], [2500, 25], [2500, 50], [3000, 30], [3000, 60], [10000, 100], [10000, 200],
  [50000, 200], [0, 200], [0, 60], [DYNAMIC_FEE, 200], [DYNAMIC_FEE, 60],
]
const TICK_SPACINGS = [200, 60, 50, 25, 100, 10, 1, 30, 5, 20, 120, 240, 1000, 2000, 9000, 18000]
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// A v3-style pool reconstructs entirely from its own getters. Pools are accepted from the
// factories CovenProbe is known to trade (Uniswap v3, Synthra, Slipstream clones), which
// keeps spam pools that copy the Swap event out of the cycle set.
export async function introspectV3(client: PublicClient, addresses: Address[]): Promise<Pool[]> {
  if (addresses.length === 0) return []
  const fns = ['factory', 'token0', 'token1', 'fee', 'tickSpacing'] as const
  const res = await client.multicall({
    allowFailure: true,
    contracts: addresses.flatMap((address) => fns.map((functionName) => ({ address, abi: v3PoolAbi, functionName }) as const)),
  })
  const out: Pool[] = []
  addresses.forEach((a, i) => {
    const r = res.slice(i * fns.length, (i + 1) * fns.length)
    if (r.some((x) => x.status !== 'success')) return
    const [factory, token0, token1, fee, tickSpacing] = r.map((x) => x.result) as [Address, Address, Address, number, number]
    if (!FACTORIES.has(lc(factory))) return
    out.push({ kind: 'v3', id: lc(a), token0: lc(token0), token1: lc(token1), fee, tickSpacing, hooks: zeroAddress })
  })
  return out
}

const FACTORIES = new Set(V3_FACTORIES.map(lc))

type KeyTail = { fee: number; tickSpacing: number; hooks: Address }

// Routers encode a v4 PoolKey (c0, c1, fee, tickSpacing, hooks) or PathKey (currency, fee,
// tickSpacing, hooks, hookData) as consecutive ABI words, possibly inside nested calldata
// that shifts alignment by a 4-byte selector. Collect every (fee, tickSpacing, hooks)
// triple that looks plausible at any 4-byte offset.
export function keyTailsInCalldata(data: Hex): KeyTail[] {
  const b = hexToBytes(data)
  const word = (i: number) => {
    let v = 0n
    for (let j = i; j < i + 32; j++) v = (v << 8n) | BigInt(b[j]!)
    return v
  }
  const out = new Map<string, KeyTail>()
  for (let i = 0; i + 96 <= b.length; i += 4) {
    const fee = word(i)
    if (fee >= 1n << 24n) continue
    const ts = word(i + 32)
    if (ts === 0n || ts >= 1n << 15n) continue
    const hooks = word(i + 64)
    if (hooks >= 1n << 160n) continue
    const tail = { fee: Number(fee), tickSpacing: Number(ts), hooks: lc(`0x${hooks.toString(16).padStart(40, '0')}`) }
    out.set(`${tail.fee}/${tail.tickSpacing}/${tail.hooks}`, tail)
  }
  return [...out.values()]
}

// v4 only reveals a pool's key in its Initialize event, which may be far outside any range a
// public RPC will serve. Recover it instead from a transaction that swapped the pool: the
// currencies moved in or out of the PoolManager (or are native USDC), and the rest of the
// key is usually spelled out in the calldata. Failing that, the hook is usually among the
// log emitters and the fee is the Swap event's. Hash candidate keys until one matches.
export async function recoverV4Key(
  client: PublicClient,
  id: Hex,
  txHash: Hex,
  hint: { fee?: number; sharedHooks?: Iterable<Address>; spacings?: Iterable<number> } = {},
): Promise<Pool | null> {
  const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: txHash }), client.getTransaction({ hash: txHash })])
  const pm = lc(POOL_MANAGER)
  const currencies = new Set<Address>([NATIVE])
  const emitters = new Set<Address>()
  for (const l of receipt.logs) {
    const addr = lc(l.address)
    if (addr === pm) continue
    emitters.add(addr)
    if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue
    const from = lc(`0x${l.topics[1]!.slice(26)}`)
    const to = lc(`0x${l.topics[2]!.slice(26)}`)
    if (from === pm || to === pm) currencies.add(addr)
  }
  const sorted = [...currencies].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const want = lc(id)
  // Bounded: this runs on the event loop of the live trader, and a miss means trying every
  // candidate. ~4000 hashes is ~120 ms.
  let budget = 4000
  const match = (tails: Iterable<KeyTail>): Pool | null => {
    for (const t of tails) {
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          if (budget-- <= 0) return null
          const k: PoolKey = { currency0: sorted[i]!, currency1: sorted[j]!, ...t }
          if (v4PoolId(k) === want) return v4Pool(k)
        }
      }
    }
    return null
  }
  const fromCalldata = match(keyTailsInCalldata(tx.input))
  if (fromCalldata) return fromCalldata

  // Most likely first: no hook, then hooks that emitted logs, then hooks shared by other pools.
  // A non-zero hook address encodes its permissions in its low 14 bits, so it has some set.
  const isHookAddr = (h: Address) => (BigInt(h) & 0x3fffn) !== 0n && !currencies.has(h)
  const hooks = [...new Set([zeroAddress, ...[...emitters].filter(isHookAddr), ...[...(hint.sharedHooks ?? [])].map(lc).filter(isHookAddr)])]
  const fees = [...new Set([hint.fee, DYNAMIC_FEE].filter((f): f is number => f !== undefined))]
  const spacings = [...new Set([...TICK_SPACINGS, ...(hint.spacings ?? [])])]
  budget = 4000
  return match(
    (function* () {
      for (const h of hooks) for (const fee of fees) for (const tickSpacing of spacings) yield { fee, tickSpacing, hooks: h }
    })(),
  )
}

// Find the other venues a token trades on: canonical v3 tiers via the factory, and v4 pools
// with common (fee, tickSpacing) pairs against USDC, EURC or native USDC, hookless or with a
// hook the token already uses. CovenLens misses most of these.
export async function probeSiblings(client: PublicClient, reg: PoolRegistry, tokens: Address[]): Promise<Pool[]> {
  const quotes = [USDC, EURC, NATIVE].map(lc)
  const v3Calls: { a: Address; b: Address; fee: number }[] = []
  const v4Candidates: Pool[] = []
  for (const t of tokens.map(lc)) {
    const hooks = new Set<Address>([zeroAddress, ...reg.poolsOf(t).filter(isHooked).map((p) => p.hooks)])
    for (const q of quotes) {
      if (q === t) continue
      const [c0, c1] = BigInt(q) < BigInt(t) ? [q, t] : [t, q]
      // v3 pools hold ERC-20s only.
      if (q !== lc(NATIVE)) for (const fee of V3_FEE_TIERS) v3Calls.push({ a: c0, b: c1, fee })
      for (const [fee, tickSpacing] of V4_FEE_SPACINGS) {
        for (const h of hooks) {
          const p = v4Pool({ currency0: c0, currency1: c1, fee, tickSpacing, hooks: h })
          if (!reg.has(p.id)) v4Candidates.push(p)
        }
      }
    }
  }
  const [v3Res, v4Res] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: v3Calls.map((c) => ({ address: V3_FACTORY, abi: v3FactoryAbi, functionName: 'getPool', args: [c.a, c.b, c.fee] }) as const),
    }),
    client.multicall({
      allowFailure: true,
      contracts: v4Candidates.map((p) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [p.id] }) as const),
    }),
  ])
  const found: Pool[] = []
  v3Calls.forEach((c, i) => {
    const r = v3Res[i]
    if (r?.status !== 'success' || r.result === zeroAddress) return
    const id = lc(r.result)
    if (reg.has(id)) return
    const tickSpacing = { 100: 1, 500: 10, 3000: 60, 10000: 200 }[c.fee] ?? 60
    found.push({ kind: 'v3', id, token0: c.a, token1: c.b, fee: c.fee, tickSpacing, hooks: zeroAddress })
  })
  v4Candidates.forEach((p, i) => {
    const r = v4Res[i]
    // An uninitialised pool reads as sqrtPrice 0.
    if (r?.status === 'success' && (r.result as readonly [bigint, ...unknown[]])[0] > 0n) found.push(p)
  })
  return found
}

export function poolFromCreationLog(log: Log): Pool | null {
  const l = log as Log & { eventName?: string; args?: Record<string, unknown> }
  if (l.eventName === 'PoolCreated' && lc(l.address) === lc(V3_FACTORY)) {
    const a = l.args as { token0: Address; token1: Address; fee: number; tickSpacing: number; pool: Address }
    return { kind: 'v3', id: lc(a.pool), token0: lc(a.token0), token1: lc(a.token1), fee: a.fee, tickSpacing: a.tickSpacing, hooks: zeroAddress }
  }
  if (l.eventName === 'Initialize' && lc(l.address) === lc(POOL_MANAGER)) {
    const a = l.args as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
    return v4Pool({ currency0: a.currency0, currency1: a.currency1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks })
  }
  return null
}

// Every pool created between two blocks, newest first so an interrupted run has already
// covered the pools most likely to matter. onWindow fires after each window [lo, toBlock] is
// complete and saved, so callers can record coverage and resume.
export async function backfillIndex(
  client: PublicClient,
  reg: PoolRegistry,
  fromBlock: bigint,
  toBlock: bigint,
  onWindow?: (lo: bigint, added: number) => void,
): Promise<number> {
  let added = 0
  const window = 20_000n
  for (let hi = toBlock; hi >= fromBlock; hi -= window) {
    const lo = hi - window + 1n > fromBlock ? hi - window + 1n : fromBlock
    await getLogsChunked(
      client,
      { address: [getAddress(V3_FACTORY), getAddress(POOL_MANAGER)], events: [v3PoolCreatedEvent, v4InitializeEvent], fromBlock: lo, toBlock: hi },
      (logs) => {
        for (const log of logs) {
          const p = poolFromCreationLog(log)
          if (p && reg.add(p)) added++
        }
      },
    )
    onWindow?.(lo, added)
    reg.save()
    if (lo === fromBlock) break
  }
  return added
}
