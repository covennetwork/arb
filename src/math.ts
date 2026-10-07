// Off-chain math is only used to decide which cycles are worth asking the chain about and
// where to centre the size search. The chain decides the actual profit (see probe.ts).
const Q96 = 2n ** 96n
const FEE_DEN = 1_000_000n

export type Hop = {
  sqrtPriceX96: bigint
  liquidity: bigint
  // millionths
  fee: number
  zeroForOne: boolean
}

// Marginal output per unit input (raw token units) after the LP fee.
export function spotRate(h: Hop): number {
  const s = Number(h.sqrtPriceX96) / 2 ** 96
  const price = s * s // token1 per token0
  const rate = h.zeroForOne ? price : 1 / price
  return rate * (1 - h.fee / 1e6)
}

// Edge of a cycle at the margin, in basis points: >0 means an infinitesimal trade profits.
export function edgeBps(hops: Hop[]): number {
  let r = 1
  for (const h of hops) r *= spotRate(h)
  return (r - 1) * 10_000
}

// A concentrated-liquidity pool trades like constant product with virtual reserves
// x = L/sqrtP, y = L*sqrtP while the price stays inside the current tick range.
export function virtualReserves(h: Hop): { rIn: bigint; rOut: bigint } {
  if (h.sqrtPriceX96 <= 0n || h.liquidity <= 0n) return { rIn: 0n, rOut: 0n }
  const x = (h.liquidity * Q96) / h.sqrtPriceX96
  const y = (h.liquidity * h.sqrtPriceX96) / Q96
  return h.zeroForOne ? { rIn: x, rOut: y } : { rIn: y, rOut: x }
}

export function cpmmOut(amountIn: bigint, rIn: bigint, rOut: bigint, fee: number): bigint {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n
  const inAfterFee = (amountIn * (FEE_DEN - BigInt(fee))) / FEE_DEN
  return (inAfterFee * rOut) / (rIn + inAfterFee)
}

export function cycleOut(hops: Hop[], amountIn: bigint): bigint {
  let amt = amountIn
  for (const h of hops) {
    const { rIn, rOut } = virtualReserves(h)
    amt = cpmmOut(amt, rIn, rOut, h.fee)
    if (amt <= 0n) return 0n
  }
  return amt
}

// Input that maximises out - in under the virtual-reserve model. Profit is concave in the
// input, so ternary search converges. Returns null when no input is profitable.
export function optimalInput(hops: Hop[]): { amountIn: bigint; profit: bigint } | null {
  const first = hops[0]
  if (!first) return null
  const cap = virtualReserves(first).rIn
  if (cap < 2n) return null
  const profit = (x: bigint) => cycleOut(hops, x) - x
  let lo = 1n
  let hi = cap
  while (hi - lo > 2n) {
    const m1 = lo + (hi - lo) / 3n
    const m2 = hi - (hi - lo) / 3n
    if (profit(m1) < profit(m2)) lo = m1
    else hi = m2
  }
  let best = lo
  for (let x = lo; x <= hi; x++) if (profit(x) > profit(best)) best = x
  const p = profit(best)
  return p > 0n ? { amountIn: best, profit: p } : null
}

// Geometric grid of trade sizes around a seed, for one-shot on-chain sizing. The virtual
// reserve model can be off by an order of magnitude when a trade crosses ticks, so the
// grid spans seed/32 .. seed*8.
export function sizeGrid(seed: bigint, points = 16, below = 32, above = 8): bigint[] {
  if (seed <= 0n) return []
  const lo = Number(seed) / below
  const ratio = (above * below) ** (1 / (points - 1))
  const out = new Set<bigint>()
  for (let i = 0; i < points; i++) {
    const v = BigInt(Math.max(1, Math.round(lo * ratio ** i)))
    out.add(v)
  }
  return [...out]
}
