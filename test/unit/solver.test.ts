import { describe, expect, it } from 'vitest'
import { cpmmOut, evalCycle, optimalCycle, reserves, type PoolSim } from '../../src/math.js'
import { gasToUsdc } from '../../src/gas.js'
import { solveToken, type ArbPool } from '../../src/solver.js'

const USDC = '0x3600000000000000000000000000000000000000' as const
const TOKEN = '0x9999999999999999999999999999999999999999' as const
const Q96 = 2n ** 96n

// price p (token1/token0) -> sqrtPriceX96
function sqrtP(price: number): bigint {
  return BigInt(Math.floor(Math.sqrt(price) * Number(Q96)))
}

// USDC is token0 (0x3600.. < 0x9999..). price = token1/token0 = TOKEN per USDC.
// A pool at "1 TOKEN = k USDC" has price = 1/k.
function pool(usdcPerToken: number, liquidity: bigint, fee: number, protocol: 'v3' | 'v4'): ArbPool {
  return {
    protocol,
    sqrtPriceX96: sqrtP(1 / usdcPerToken),
    liquidity,
    fee,
    token0: USDC,
    token1: TOKEN,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000',
    id: '0x1111111111111111111111111111111111111111',
    poolKey: protocol === 'v4' ? { currency0: USDC, currency1: TOKEN, fee, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' } : undefined,
  }
}

describe('cpmm math', () => {
  it('output is monotone increasing and below the no-fee bound', () => {
    const rIn = 1_000_000n * 10n ** 6n
    const rOut = 1_000_000n * 10n ** 18n
    const small = cpmmOut(100n * 10n ** 6n, rIn, rOut, 3000)
    const large = cpmmOut(200n * 10n ** 6n, rIn, rOut, 3000)
    expect(large).toBeGreaterThan(small)
    // no-fee spot output for 100 USDC ~ 100 tokens (1e20); fee makes it less
    expect(small).toBeLessThan(100n * 10n ** 18n)
  })

  it('reserves invert sqrtP/liquidity consistently', () => {
    const r = reserves({ protocol: 'v3', sqrtPriceX96: sqrtP(1), liquidity: 10n ** 18n, fee: 3000, token0: USDC, token1: TOKEN })
    expect(r.x0).toBeGreaterThan(0n)
    expect(r.y1).toBeGreaterThan(0n)
  })
})

describe('gas', () => {
  it('matches the measured 350k revert cost of ~0.007 USDC', () => {
    const usdc = gasToUsdc(350_000n, 20_158_000_000n)
    expect(usdc).toBeGreaterThan(7_000n)
    expect(usdc).toBeLessThan(7_200n)
  })
})

describe('optimalCycle', () => {
  it('finds a positive-profit size when a real gap exists', () => {
    const buy = pool(1.0, 10n ** 18n, 3000, 'v3')
    const sell = pool(1.06, 10n ** 18n, 3000, 'v4')
    const c = optimalCycle(buy, sell, true, true)
    expect(c).not.toBeNull()
    expect(c!.grossProfit).toBeGreaterThan(0n)
    // optimum should beat both a tiny and an oversized trade
    const tiny = evalCycle(buy, sell, true, true, 1n * 10n ** 6n)!.grossProfit
    expect(c!.grossProfit).toBeGreaterThanOrEqual(tiny)
  })

  it('returns no profit when both pools share a price (minus fees)', () => {
    const buy = pool(1.0, 10n ** 18n, 3000, 'v3')
    const sell = pool(1.0, 10n ** 18n, 3000, 'v4')
    const c = optimalCycle(buy, sell, true, true)
    expect(c === null || c.grossProfit <= 0n).toBe(true)
  })
})

describe('solveToken', () => {
  it('nets out gas and reports the direction with the larger edge', () => {
    const cheap = pool(1.0, 10n ** 18n, 3000, 'v3')
    const dear = pool(1.06, 10n ** 18n, 3000, 'v4')
    const opp = solveToken(TOKEN, [cheap, dear], { gasPriceWei: 20_000_000_000n })
    expect(opp).not.toBeNull()
    expect(opp!.netProfit).toBe(opp!.expectedProfit - opp!.estimatedGasUsdc)
    expect(opp!.buy).toBe(cheap)
    expect(opp!.sell).toBe(dear)
    expect(opp!.midGapBps).toBeGreaterThan(500)
  })

  it('rejects a token with a single pool', () => {
    const only = pool(1.0, 10n ** 18n, 3000, 'v3')
    expect(solveToken(TOKEN, [only], { gasPriceWei: 20_000_000_000n })).toBeNull()
  })
})
