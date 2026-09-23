// Within-range constant-product model. A Uniswap v3/v4 pool is constant-product over
// its current tick range with virtual reserves x0 = L/sqrtP, y1 = L*sqrtP. This is the
// closed form the spec calls for; it is exact while a trade stays inside the current
// range (the common case for single-position launchpad pools) and a close seed
// otherwise, refined against the CovenLens oracle by the solver. All amounts are bigint.
const Q96 = 2n ** 96n
const FEE_DEN = 1_000_000n

export type PoolSim = {
  protocol: 'v3' | 'v4'
  sqrtPriceX96: bigint
  liquidity: bigint
  fee: number
  token0: `0x${string}`
  token1: `0x${string}`
}

export function reserves(p: PoolSim): { x0: bigint; y1: bigint } {
  if (p.sqrtPriceX96 <= 0n || p.liquidity <= 0n) return { x0: 0n, y1: 0n }
  return { x0: (p.liquidity * Q96) / p.sqrtPriceX96, y1: (p.liquidity * p.sqrtPriceX96) / Q96 }
}

// exact-input constant-product output with fee (fee is 1e6-based, e.g. 3000 = 0.30%)
export function cpmmOut(amountIn: bigint, rIn: bigint, rOut: bigint, fee: number): bigint {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n
  const inAfter = (amountIn * (FEE_DEN - BigInt(fee))) / FEE_DEN
  if (inAfter <= 0n) return 0n
  return (inAfter * rOut) / (rIn + inAfter)
}

export type CyclePlan = {
  usdcIn: bigint
  tokenMid: bigint
  usdcOut: bigint
  grossProfit: bigint
}

// Buy the shared token with USDC on `buy`, sell it back for USDC on `sell`.
export function evalCycle(
  buy: PoolSim,
  sell: PoolSim,
  usdcIsToken0OnBuy: boolean,
  usdcIsToken0OnSell: boolean,
  usdcIn: bigint,
): CyclePlan | null {
  const rb = reserves(buy)
  const rs = reserves(sell)
  const buyIn = usdcIsToken0OnBuy ? rb.x0 : rb.y1
  const buyOut = usdcIsToken0OnBuy ? rb.y1 : rb.x0
  const sellIn = usdcIsToken0OnSell ? rs.y1 : rs.x0
  const sellOut = usdcIsToken0OnSell ? rs.x0 : rs.y1
  if (buyIn <= 0n || buyOut <= 0n || sellIn <= 0n || sellOut <= 0n) return null
  const mid = cpmmOut(usdcIn, buyIn, buyOut, buy.fee)
  if (mid <= 0n) return null
  const out = cpmmOut(mid, sellIn, sellOut, sell.fee)
  return { usdcIn, tokenMid: mid, usdcOut: out, grossProfit: out - usdcIn }
}

// Ternary search for the USDC input maximising gross profit. The cycle's profit as a
// function of input is unimodal (concave), so ternary search converges to the optimum.
export function optimalCycle(
  buy: PoolSim,
  sell: PoolSim,
  usdcIsToken0OnBuy: boolean,
  usdcIsToken0OnSell: boolean,
): CyclePlan | null {
  const rb = reserves(buy)
  const buyUsdcReserve = usdcIsToken0OnBuy ? rb.x0 : rb.y1
  if (buyUsdcReserve < 2n) return null
  const profit = (x: bigint) => {
    const c = evalCycle(buy, sell, usdcIsToken0OnBuy, usdcIsToken0OnSell, x)
    return c ? c.grossProfit : -(1n << 255n)
  }
  let lo = 1n
  let hi = buyUsdcReserve
  for (let i = 0; i < 256 && hi - lo > 1n; i++) {
    const m1 = lo + (hi - lo) / 3n
    const m2 = hi - (hi - lo) / 3n
    if (profit(m1) < profit(m2)) lo = m1
    else hi = m2
  }
  let best = lo
  for (const c of [lo, (lo + hi) / 2n, hi]) if (profit(c) > profit(best)) best = c
  return evalCycle(buy, sell, usdcIsToken0OnBuy, usdcIsToken0OnSell, best)
}
