import { describe, expect, it } from 'vitest'
import { type Hop, cpmmOut, cycleOut, edgeBps, optimalInput, sizeGrid, spotRate } from '../../src/math.js'

const Q96 = 2n ** 96n
const sqrtP = (price: number) => BigInt(Math.floor(Math.sqrt(price) * Number(Q96)))
const hop = (price: number, zeroForOne: boolean, fee = 3000, liquidity = 10n ** 18n): Hop => ({
  sqrtPriceX96: sqrtP(price),
  liquidity,
  fee,
  zeroForOne,
})

describe('spot math', () => {
  it('rates invert with direction and pay the fee', () => {
    expect(spotRate(hop(4, true, 0))).toBeCloseTo(4)
    expect(spotRate(hop(4, false, 0))).toBeCloseTo(0.25)
    expect(spotRate(hop(4, true, 3000))).toBeCloseTo(4 * 0.997)
  })

  it('a round trip through one price loses exactly the fees', () => {
    const e = edgeBps([hop(2, true), hop(2, false)])
    expect(e).toBeCloseTo((0.997 * 0.997 - 1) * 10_000, 6)
  })

  it('a price gap larger than the fees shows a positive edge', () => {
    // buy token1 cheap where 1 token0 = 2 token1, sell where 1 token0 = 1.9 token1
    expect(edgeBps([hop(2, true), hop(1.9, false)])).toBeGreaterThan(0)
    expect(edgeBps([hop(1.9, true), hop(2, false)])).toBeLessThan(0)
  })
})

describe('constant-product sizing', () => {
  it('output is monotone and below the reserve', () => {
    const a = cpmmOut(10n ** 6n, 10n ** 12n, 10n ** 12n, 3000)
    const b = cpmmOut(10n ** 9n, 10n ** 12n, 10n ** 12n, 3000)
    expect(b).toBeGreaterThan(a)
    expect(cpmmOut(10n ** 30n, 10n ** 12n, 10n ** 12n, 0)).toBeLessThan(10n ** 12n)
  })

  it('finds the profit-maximising input of a mispriced cycle', () => {
    const hops = [hop(2, true), hop(1.9, false)]
    const opt = optimalInput(hops)
    expect(opt).not.toBeNull()
    const at = (x: bigint) => cycleOut(hops, x) - x
    expect(opt!.profit).toBe(at(opt!.amountIn))
    expect(opt!.profit).toBeGreaterThanOrEqual(at((opt!.amountIn * 9n) / 10n))
    expect(opt!.profit).toBeGreaterThanOrEqual(at((opt!.amountIn * 11n) / 10n))
  })

  it('handles three legs', () => {
    // A->B at 2, B->C at 3, C->A at 1/5: 2*3/5 = 1.2, a 20% gap
    const hops = [hop(2, true, 500), hop(3, true, 500), hop(5, false, 500)]
    expect(edgeBps(hops)).toBeGreaterThan(1900)
    expect(optimalInput(hops)!.profit).toBeGreaterThan(0n)
  })

  it('reports nothing when no size profits', () => {
    expect(optimalInput([hop(2, true), hop(2, false)])).toBeNull()
  })
})

describe('sizeGrid', () => {
  it('spans seed/32 .. seed*8 geometrically', () => {
    const g = sizeGrid(1_000_000n)
    expect(g.length).toBe(16)
    expect(g[0]).toBe(31_250n)
    expect(g.at(-1)).toBe(8_000_000n)
    for (let i = 1; i < g.length; i++) expect(g[i]!).toBeGreaterThan(g[i - 1]!)
  })

  it('collapses duplicates for tiny seeds', () => {
    const g = sizeGrid(3n)
    expect(new Set(g).size).toBe(g.length)
    expect(g[0]).toBe(1n)
  })
})
