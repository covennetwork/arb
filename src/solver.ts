import type { Address } from 'viem'
import { USDC } from '@covennetwork/core'
import { type PoolSim, optimalCycle } from './math.js'
import { ARB_GAS_ESTIMATE, gasToUsdc } from './gas.js'
import { type Plan, type PoolKey, buildPlan } from './bindings.js'

export type ArbPool = PoolSim & {
  id: Address
  poolKey?: PoolKey
  tickSpacing: number
  hooks: Address
}

export type Opportunity = {
  token: Address
  buy: ArbPool
  sell: ArbPool
  size: bigint
  expectedProfit: bigint
  estimatedGasUsdc: bigint
  netProfit: bigint
  midGapBps: number
}

const Q96 = 2n ** 96n

function usdcPerToken(p: ArbPool, usdc: Address): number {
  const s = Number(p.sqrtPriceX96) / Number(Q96)
  const price = s * s
  return p.token0.toLowerCase() === usdc.toLowerCase() ? 1 / price : price
}

export type SolveOptions = {
  gasPriceWei: bigint
  arbGas?: bigint
  usdc?: Address
}

// Given every USDC pool for one token, pick the ordered pair (buy cheap, sell dear) with
// the greatest net profit. netProfit = expected USDC out - USDC in - exact gas in USDC.
// The only number that decides anything.
export function solveToken(token: Address, pools: ArbPool[], opts: SolveOptions): Opportunity | null {
  const usdc = opts.usdc ?? USDC
  const gasUsdc = gasToUsdc(opts.arbGas ?? ARB_GAS_ESTIMATE, opts.gasPriceWei)
  const live = pools.filter((p) => p.sqrtPriceX96 > 0n && p.liquidity > 0n)
  let best: Opportunity | null = null
  for (let i = 0; i < live.length; i++) {
    for (let j = 0; j < live.length; j++) {
      if (i === j) continue
      const buy = live[i]!
      const sell = live[j]!
      const buyUsdc0 = buy.token0.toLowerCase() === usdc.toLowerCase()
      const sellUsdc0 = sell.token0.toLowerCase() === usdc.toLowerCase()
      const cycle = optimalCycle(buy, sell, buyUsdc0, sellUsdc0)
      if (!cycle || cycle.usdcIn <= 1n) continue
      const netProfit = cycle.grossProfit - gasUsdc
      const pa = usdcPerToken(buy, usdc)
      const pb = usdcPerToken(sell, usdc)
      const midGapBps = pa > 0 && pb > 0 ? Math.round((Math.abs(pa - pb) / ((pa + pb) / 2)) * 10000) : 0
      if (!best || netProfit > best.netProfit) {
        best = {
          token,
          buy,
          sell,
          size: cycle.usdcIn,
          expectedProfit: cycle.grossProfit,
          estimatedGasUsdc: gasUsdc,
          netProfit,
          midGapBps,
        }
      }
    }
  }
  return best
}

// Turn a solved opportunity into an on-chain plan. minProfit is set from the simulation
// and floored to a positive value; it is never zero.
export function planFor(opp: Opportunity, minProfit: bigint, usdc: Address = USDC): Plan {
  const floor = minProfit > 0n ? minProfit : 1n
  return buildPlan(
    [
      {
        isV4: opp.buy.protocol === 'v4',
        pool: opp.buy.id,
        key: opp.buy.poolKey,
        zeroForOne: opp.buy.token0.toLowerCase() === usdc.toLowerCase(),
        amountIn: opp.size,
        fee: opp.buy.fee,
      },
      {
        isV4: opp.sell.protocol === 'v4',
        pool: opp.sell.id,
        key: opp.sell.poolKey,
        zeroForOne: opp.sell.token0.toLowerCase() !== usdc.toLowerCase(),
        amountIn: 0n,
        fee: opp.sell.fee,
      },
    ],
    floor,
    usdc,
  )
}
