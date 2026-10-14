import { type Address, type Hex, type PublicClient, decodeFunctionResult, encodeFunctionData, zeroAddress } from 'viem'
import { covenProbeAbi, fairLaunchHookAbi } from './abis.js'
import { COVEN_PROBE, NATIVE, gasEstimate } from './constants.js'
import { type Cycle, describeCycle, isBase } from './cycles.js'
import { type Pool, type PoolKey, describePool, keyOf } from './pools.js'

const lc = (a: string) => a.toLowerCase() as Address

export type ProbeLeg = {
  v4: boolean
  zeroForOne: boolean
  feePips: number
  pool: Address
  tokenIn: Address
  tokenOut: Address
  key: PoolKey
  hookData: Hex
}

export type Gate = { target: Address; data: Hex; word: bigint; min: bigint }

// One CovenProbe route; see CovenProbe.sol for the semantics of each field.
export type ProbeRoute = {
  legs: ProbeLeg[]
  amountIn: bigint
  minProfit: bigint
  sized: boolean
  firstAtPrice: boolean
  check: boolean
  gate: Gate
}

// A route the bot watches, with what it needs to price and describe a send.
export type Candidate = {
  id: string
  route: ProbeRoute
  pools: Hex[]
  gas: bigint
  label: (symbol: (t: Address) => string) => string
  // Fair-launch hook payout: the hook's inventory of the token it sells, for the send's gate.
  payout?: { hook: Address; key: PoolKey; word: bigint }
  cycle?: Cycle
}

const EMPTY_KEY: PoolKey = { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }
const NO_GATE: Gate = { target: zeroAddress, data: '0x', word: 0n, min: 0n }
// Caps for a sized first leg: the pool stops at the meeting price long before this.
const CAP_USDC = 10n ** 12n // 1M USDC
const CAP_NATIVE = 10n ** 24n

function probeLeg(pool: Pool, zeroForOne: boolean, tokenIn: Address, tokenOut: Address): ProbeLeg {
  return pool.kind === 'v4'
    ? { v4: true, zeroForOne, feePips: 0, pool: zeroAddress, tokenIn: zeroAddress, tokenOut: zeroAddress, key: keyOf(pool), hookData: '0x' }
    : { v4: false, zeroForOne, feePips: pool.fee, pool: pool.id as Address, tokenIn, tokenOut, key: EMPTY_KEY, hookData: '0x' }
}

// A price-gap cycle as a route. Two-leg cycles are sized on-chain at the price where both
// pools meet. Longer ones trade `seedIn` (6-decimal USDC units, from the off-chain model).
export function cycleRoute(c: Cycle, seedIn: bigint): Candidate {
  const nativeStart = lc(c.legs[0]!.tokenIn) === lc(NATIVE)
  const sized = c.legs.length === 2
  const amountIn = sized ? (nativeStart ? CAP_NATIVE : CAP_USDC) : nativeStart ? seedIn * 10n ** 12n : seedIn
  return {
    id: c.id,
    cycle: c,
    pools: c.legs.map((l) => l.pool.id),
    gas: gasEstimate(c.legs.length, c.hooked, c.v3),
    label: (symbol) => describeCycle(c, symbol),
    route: {
      legs: c.legs.map((l) => probeLeg(l.pool, l.zeroForOne, l.tokenIn, l.tokenOut)),
      amountIn,
      minProfit: 1n,
      sized,
      firstAtPrice: false,
      check: true,
      gate: NO_GATE,
    },
  }
}

// A fair-launch hook sells the fees it has collected to whoever swaps its pool, at the pool
// price, before the swap itself. Buying with a limit next to the current price takes only
// that inventory; selling it back into the pool is the profit. The gate skips the route
// while the hook holds nothing.
export function payoutRoute(pool: Pool): Candidate | undefined {
  if (pool.kind !== 'v4' || pool.hooks === zeroAddress) return undefined
  const base = isBase(pool.token0) ? pool.token0 : isBase(pool.token1) ? pool.token1 : undefined
  if (!base) return undefined
  const token = base === pool.token0 ? pool.token1 : pool.token0
  const buy = base === pool.token0 // base -> token is zeroForOne when the base is currency0
  const key = keyOf(pool)
  const word = token === pool.token0 ? 0n : 1n
  return {
    id: `payout:${pool.id}`,
    pools: [pool.id],
    gas: 505_000n,
    label: (symbol) => `${symbol(base)} > ${symbol(token)} > ${symbol(base)}  [hook payout ${describePool(pool)}]`,
    payout: { hook: pool.hooks, key, word },
    route: {
      legs: [probeLeg(pool, buy, base, token), probeLeg(pool, !buy, token, base)],
      // The hook fills from its inventory and the limit stops the pool: this is only a cap.
      amountIn: 10n ** 30n,
      minProfit: 1n,
      sized: false,
      firstAtPrice: true,
      check: false,
      gate: { target: pool.hooks, data: encodeFunctionData({ abi: fairLaunchHookAbi, functionName: 'poolFees', args: [key] }), word, min: 1n },
    },
  }
}

// Hooked pools whose hook answers poolFees(key): the fair-launch kind payoutRoute can harvest.
export async function findPayoutPools(client: PublicClient, pools: Pool[]): Promise<Pool[]> {
  const hooked = pools.filter((p) => p.kind === 'v4' && p.hooks !== zeroAddress && (isBase(p.token0) || isBase(p.token1)))
  if (hooked.length === 0) return []
  const res = await client.multicall({
    allowFailure: true,
    contracts: hooked.map((p) => ({ address: p.hooks, abi: fairLaunchHookAbi, functionName: 'poolFees', args: [keyOf(p)] }) as const),
  })
  return hooked.filter((_, i) => res[i]?.status === 'success')
}

export async function hookInventory(client: PublicClient, c: Candidate, blockNumber?: bigint): Promise<bigint> {
  if (!c.payout) return 0n
  const fees = await client.readContract({ address: c.payout.hook, abi: fairLaunchHookAbi, functionName: 'poolFees', args: [c.payout.key], blockNumber })
  return fees[Number(c.payout.word)]!
}

export const encodeProbe = (routes: ProbeRoute[], maxFeeBps: number): Hex =>
  encodeFunctionData({ abi: covenProbeAbi, functionName: 'probe', args: [routes, maxFeeBps] })

// Every route's profit after CovenProbe's fee (6-decimal USDC), as of `blockNumber`, from one
// eth_call per chunk. A route that would fail reports 0. A chunk the node rejects (gas cap, a
// hook burning gas) is retried route by route, so one bad route cannot hide the rest.
export async function simulate(
  client: PublicClient,
  routes: ProbeRoute[],
  opts: { account?: Address; maxFeeBps: number; blockNumber?: bigint; probe?: Address; chunk?: number },
): Promise<bigint[]> {
  const to = opts.probe ?? COVEN_PROBE
  const chunk = opts.chunk ?? 16
  const call = async (part: ProbeRoute[]): Promise<bigint[]> => {
    const { data } = await client.call({ account: opts.account, to, data: encodeProbe(part, opts.maxFeeBps), blockNumber: opts.blockNumber, gas: 30_000_000n })
    if (!data) throw new Error('probe returned no data')
    return [...decodeFunctionResult({ abi: covenProbeAbi, functionName: 'probe', data })]
  }
  const parts: ProbeRoute[][] = []
  for (let i = 0; i < routes.length; i += chunk) parts.push(routes.slice(i, i + chunk))
  const out = await Promise.all(
    parts.map(async (part) => {
      try {
        return await call(part)
      } catch {
        return Promise.all(part.map((r) => call([r]).then((x) => x[0]!).catch(() => 0n)))
      }
    }),
  )
  return out.flat()
}

export async function readProbeConfig(client: PublicClient, probe: Address = COVEN_PROBE) {
  const [feeBps, feeRecipient] = await Promise.all([
    client.readContract({ address: probe, abi: covenProbeAbi, functionName: 'feeBps' }),
    client.readContract({ address: probe, abi: covenProbeAbi, functionName: 'feeRecipient' }),
  ])
  return { feeBps: Number(feeBps), feeRecipient }
}

