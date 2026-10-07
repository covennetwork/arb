import type { Address, Hex } from 'viem'
import { USDC } from './constants.js'
import { type Hop, edgeBps, optimalInput } from './math.js'
import { type Pool, type PoolRegistry, type PoolState, describePool, isHooked, isNative, otherToken } from './pools.js'

export type CycleLeg = { pool: Pool; zeroForOne: boolean; tokenIn: Address; tokenOut: Address }

export type Cycle = {
  id: string
  legs: CycleLeg[]
  hooked: number
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
  }
}

// Every USDC -> ... -> USDC cycle of 2 or 3 legs through distinct pools. Native-quoted pools
// are left out (see constants.ts).
export function enumerateCycles(reg: PoolRegistry, base: Address = USDC, maxLegs: 2 | 3 = 3): Cycle[] {
  const b = lc(base)
  const usable = (p: Pool) => !isNative(p)
  const out: Cycle[] = []
  const firstHops = reg.poolsOf(b).filter(usable)
  const neighbours = new Map<Address, Pool[]>()
  for (const p of firstHops) {
    const t = otherToken(p, b)
    const list = neighbours.get(t)
    if (list) list.push(p)
    else neighbours.set(t, [p])
  }
  for (const [t, pools] of neighbours) {
    for (const a of pools) for (const z of pools) if (a !== z) out.push(cycle([leg(a, b), leg(z, t)]))
  }
  if (maxLegs < 3) return out
  for (const [t1, in1] of neighbours) {
    for (const mid of reg.poolsOf(t1).filter(usable)) {
      const t2 = otherToken(mid, t1)
      if (t2 === b) continue
      const out2 = neighbours.get(t2)
      if (!out2) continue
      for (const a of in1) for (const z of out2) out.push(cycle([leg(a, b), leg(mid, t1), leg(z, t2)]))
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
}

export function hopsFor(c: Cycle, states: Map<Hex, PoolState>): Hop[] | null {
  const hops: Hop[] = []
  for (const l of c.legs) {
    const s = states.get(l.pool.id)
    if (!s || s.liquidity <= 0n || s.sqrtPriceX96 <= 0n) return null
    hops.push({ sqrtPriceX96: s.sqrtPriceX96, liquidity: s.liquidity, fee: s.lpFee, zeroForOne: l.zeroForOne })
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
  return { cycle: c, edgeBps: edge, seedIn: opt.amountIn, seedProfit: opt.profit }
}

export function describeCycle(c: Cycle, symbol: (t: Address) => string): string {
  const path = [c.legs[0]!.tokenIn, ...c.legs.map((l) => l.tokenOut)].map(symbol).join(' > ')
  const venues = c.legs.map((l) => describePool(l.pool)).join(' | ')
  return `${path}  [${venues}]`
}
