import type { Address, Hex } from 'viem'
import { NATIVE, USDC } from './constants.js'
import { failFastLimit } from './covenArb.js'
import { type Hop, edgeBps, optimalInput } from './math.js'
import { type Pool, type PoolRegistry, type PoolState, describePool, isHooked, otherToken } from './pools.js'

export type CycleLeg = { pool: Pool; zeroForOne: boolean; tokenIn: Address; tokenOut: Address }

export type Cycle = {
  id: string
  legs: CycleLeg[]
  hooked: number
  // Legs through v3-style pools (Uniswap v3, Synthra, Slipstream clones): they cost more gas.
  v3: number
}

const lc = (a: string) => a.toLowerCase() as Address

function leg(pool: Pool, tokenIn: Address): CycleLeg {
  const t = lc(tokenIn)
  return { pool, zeroForOne: pool.token0 === t, tokenIn: t, tokenOut: otherToken(pool, t) }
}

function cycle(legs: CycleLeg[]): Cycle {
  return {
    id: legs.map((l) => `${l.pool.id.slice(0, 18)}${l.zeroForOne ? '>' : '<'}`).join(''),
    legs,
    hooked: legs.filter((l) => isHooked(l.pool)).length,
    v3: legs.filter((l) => l.pool.kind === 'v3').length,
  }
}

const BASES = new Set<Address>([lc(USDC), lc(NATIVE)])
export const isBase = (t: Address) => BASES.has(lc(t))

// Every USDC -> ... -> USDC cycle of 2 or 3 legs through distinct pools. ERC-20 and native
// USDC are one balance on Arc, so either can start or end a cycle (CovenProbe converts).
export function enumerateCycles(reg: PoolRegistry, maxLegs: 2 | 3 = 3): Cycle[] {
  const out: Cycle[] = []
  // Pools between a base and another token, keyed by that token.
  const neighbours = new Map<Address, { pool: Pool; base: Address }[]>()
  for (const base of BASES) {
    for (const p of reg.poolsOf(base)) {
      const t = otherToken(p, base)
      if (isBase(t)) continue
      const list = neighbours.get(t)
      if (list) list.push({ pool: p, base })
      else neighbours.set(t, [{ pool: p, base }])
    }
  }
  for (const [t, pools] of neighbours) {
    for (const a of pools) for (const z of pools) if (a.pool !== z.pool) out.push(cycle([leg(a.pool, a.base), leg(z.pool, t)]))
  }
  if (maxLegs < 3) return out
  for (const [t1, in1] of neighbours) {
    for (const mid of reg.poolsOf(t1)) {
      const t2 = otherToken(mid, t1)
      if (isBase(t2)) continue
      const out2 = neighbours.get(t2)
      if (!out2) continue
      for (const a of in1) for (const z of out2) out.push(cycle([leg(a.pool, a.base), leg(mid, t1), leg(z.pool, t2)]))
    }
  }
  return out
}

export function indexByPool(cycles: Cycle[]): Map<Hex, Cycle[]> {
  const m = new Map<Hex, Cycle[]>()
  for (const c of cycles) {
    for (const l of c.legs) {
      const list = m.get(l.pool.id)
      if (list) list.push(c)
      else m.set(l.pool.id, [c])
    }
  }
  return m
}

export type Screened = {
  cycle: Cycle
  edgeBps: number
  // Size and gross profit under the virtual-reserve model; the seed for on-chain sizing.
  seedIn: bigint
  seedProfit: bigint
  // First-leg price limit that makes the trade fail fast once the edge is gone.
  firstLimit: bigint
}

// Hops in 6-decimal USDC units throughout. Native USDC is always a v4 pool's currency0 (it
// sorts as address 0); counting it in 6-decimal units multiplies the price by 1e12, so the
// sqrt price by 1e6, and divides the liquidity by 1e6 (virtual reserves L/sqrtP, L*sqrtP).
export function hopsFor(c: Cycle, states: Map<Hex, PoolState>): Hop[] | null {
  const hops: Hop[] = []
  for (const l of c.legs) {
    const s = states.get(l.pool.id)
    if (!s || s.liquidity <= 0n || s.sqrtPriceX96 <= 0n) return null
    const native = l.pool.token0 === lc(NATIVE)
    hops.push({
      sqrtPriceX96: native ? s.sqrtPriceX96 * 1_000_000n : s.sqrtPriceX96,
      liquidity: native ? s.liquidity / 1_000_000n : s.liquidity,
      fee: s.lpFee,
      zeroForOne: l.zeroForOne,
    })
  }
  return hops
}

// Spot-price screen. Hook fees are invisible here, so hooked cycles can pass the screen
// and still lose on-chain; the caller learns those floors from probe results.
export function screen(c: Cycle, states: Map<Hex, PoolState>, minEdgeBps = 0): Screened | null {
  const hops = hopsFor(c, states)
  if (!hops) return null
  const edge = edgeBps(hops)
  if (!(edge > minEdgeBps)) return null
  const opt = optimalInput(hops)
  if (!opt) return null
  const first = hops[0]!
  return { cycle: c, edgeBps: edge, seedIn: opt.amountIn, seedProfit: opt.profit, firstLimit: failFastLimit(first.sqrtPriceX96, first.zeroForOne, edge) }
}

export function describeCycle(c: Cycle, symbol: (t: Address) => string): string {
  const path = [c.legs[0]!.tokenIn, ...c.legs.map((l) => l.tokenOut)].map(symbol).join(' > ')
  const venues = c.legs.map((l) => describePool(l.pool)).join(' | ')
  return `${path}  [${venues}]`
}
