import type { PublicClient } from 'viem'
import { WEI_PER_USDC, gasEstimate, gasToUsdc } from './constants.js'
import { type ProbeResult, probe } from './covenArb.js'
import type { Cycle, Screened } from './cycles.js'
import { sizeGrid } from './math.js'

export type Opportunity = {
  cycle: Cycle
  amountIn: bigint
  // Profit the contract pays out, after its own fee. Exact as of the probed block.
  profit: bigint
  // Priority fee per gas this trade bids, and the total gas bill at that bid (USDC 6dp).
  priorityFee: bigint
  gasUsdc: bigint
  net: bigint
  edgeBps: number
  // Block the profit was measured at, when probed at a fixed block.
  block?: bigint
}

export type FeePolicy = {
  baseFee: bigint
  // Floor on the priority fee, in wei per gas.
  minPriorityFee: bigint
  // Share of expected profit bid as priority fee, in basis points. Arc orders transactions
  // by priority fee, so when two bots race for the same cycle the higher bid lands first and
  // the other reverts.
  bidBps: number
}

// Priority fee that spends `bidBps` of the profit, given the trade's gas use.
export function priorityFeeFor(profit: bigint, gas: bigint, p: FeePolicy): bigint {
  const bid = (profit * WEI_PER_USDC * BigInt(p.bidBps)) / 10_000n / gas
  return bid > p.minPriorityFee ? bid : p.minPriorityFee
}

export type Rejection = { cycle: Cycle; edgeBps: number; reason: string }

// Sizes each screened cycle on-chain: one probe per point of a geometric grid around the
// model's seed, all in a single round trip. The best grid point is the trade.
export async function evaluate(
  client: PublicClient,
  candidates: Screened[],
  opts: { maxFeeBps: number; fees: FeePolicy; block?: bigint; points?: number },
): Promise<{ opportunities: Opportunity[]; rejected: Rejection[] }> {
  const grids = candidates.map((c) => sizeGrid(c.seedIn, opts.points ?? 16))
  const requests = candidates.flatMap((c, i) => grids[i]!.map((amountIn) => ({ cycle: c.cycle, amountIn })))
  const results: ProbeResult[] = requests.length ? await probe(client, requests, { maxFeeBps: opts.maxFeeBps, blockNumber: opts.block }) : []
  const opportunities: Opportunity[] = []
  const rejected: Rejection[] = []
  let k = 0
  candidates.forEach((c, i) => {
    let best: { amountIn: bigint; profit: bigint } | undefined
    const reasons = new Map<string, number>()
    for (const amountIn of grids[i]!) {
      const r = results[k++]!
      if (r.ok) {
        if (!best || r.profit > best.profit) best = { amountIn, profit: r.profit }
      } else {
        reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1)
      }
    }
    if (!best) {
      const reason = [...reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'no profit'
      rejected.push({ cycle: c.cycle, edgeBps: c.edgeBps, reason })
      return
    }
    const gas = gasEstimate(c.cycle.legs.length, c.cycle.hooked)
    const priorityFee = priorityFeeFor(best.profit, gas, opts.fees)
    const gasUsdc = gasToUsdc(gas, opts.fees.baseFee + priorityFee)
    opportunities.push({ cycle: c.cycle, ...best, priorityFee, gasUsdc, net: best.profit - gasUsdc, edgeBps: c.edgeBps, block: opts.block })
  })
  opportunities.sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0))
  return { opportunities, rejected }
}

// The spot screen cannot see hook fees or thin liquidity just past the current tick, so some
// cycles look profitable forever while never being so on-chain. After a cycle fails a probe,
// it is only probed again once its edge clears the failed edge by a margin, or the floor
// expires.
export class EdgeFloors {
  private floors = new Map<string, { bps: number; until: number }>()

  constructor(
    private marginBps = 5,
    private ttlMs = 10 * 60_000,
  ) {}

  get(c: Cycle): number {
    const f = this.floors.get(c.id)
    if (!f) return 0
    if (Date.now() > f.until) {
      this.floors.delete(c.id)
      return 0
    }
    return f.bps
  }

  fail(c: Cycle, edgeBps: number): void {
    // Proportional too: dust pools sit at edges of thousands of bps that wobble with every trade.
    this.floors.set(c.id, { bps: edgeBps * 1.05 + this.marginBps, until: Date.now() + this.ttlMs })
  }

  clear(c: Cycle): void {
    this.floors.delete(c.id)
  }
}
