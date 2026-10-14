import type { Address, PublicClient } from 'viem'
import { gasToUsdc } from './constants.js'
import type { Screened } from './cycles.js'
import { type Candidate, cycleRoute, simulate } from './probe.js'

export type Priced = {
  candidate: Candidate
  // Profit after CovenProbe's fee as simulated, the gas a send costs at the chosen tip, and
  // what is left (6-dec USDC).
  profit: bigint
  gasUsdc: bigint
  net: bigint
}

// Price every candidate in one round of eth_calls at `blockNumber`: the contract sizes and
// trades each route against that block's state, so the profit includes every tick
// crossing, hook and fee. Candidates that would not trade are left out.
export async function price(
  client: PublicClient,
  candidates: Candidate[],
  opts: { maxFeeBps: number; gasPrice: bigint; account?: Address; blockNumber?: bigint },
): Promise<Priced[]> {
  if (candidates.length === 0) return []
  const profits = await simulate(client, candidates.map((c) => c.route), { maxFeeBps: opts.maxFeeBps, account: opts.account, blockNumber: opts.blockNumber })
  const out: Priced[] = []
  candidates.forEach((candidate, i) => {
    const profit = profits[i]!
    if (profit <= 0n) return
    const gasUsdc = gasToUsdc(candidate.gas, opts.gasPrice)
    out.push({ candidate, profit, gasUsdc, net: profit - gasUsdc })
  })
  return out.sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0))
}

// Screened cycles worth simulating: the off-chain model must value them at a quarter of the
// gas bill at least, since it is rough and the chain decides.
export function cycleCandidates(screened: Screened[], gasPrice: bigint, max: number): Candidate[] {
  const out: Candidate[] = []
  for (const s of screened) {
    const c = cycleRoute(s.cycle, s.seedIn)
    if (s.seedProfit * 4n < gasToUsdc(c.gas, gasPrice)) continue
    out.push(c)
    if (out.length >= max) break
  }
  return out
}

// After a send that missed, the route sits out for a while, doubling with each consecutive
// miss: the simulation cannot see who else is about to take the same gap.
export class Backoff {
  private state = new Map<string, { until: number; streak: number }>()

  constructor(
    private baseMs = 30_000,
    private maxMs = 10 * 60_000,
  ) {}

  blocked(id: string, now = Date.now()): boolean {
    const s = this.state.get(id)
    return !!s && now < s.until
  }

  lost(id: string, now = Date.now()): void {
    const streak = (this.state.get(id)?.streak ?? 0) + 1
    this.state.set(id, { streak, until: now + Math.min(this.maxMs, this.baseMs * 2 ** (streak - 1)) })
  }

  won(id: string): void {
    this.state.delete(id)
  }
}

// The spot screen cannot see hook fees or thin liquidity just past the current tick, so some
// cycles look profitable forever while never being so on-chain. After a cycle simulates at
// no profit, it is only simulated again once its edge clears the failed edge by a margin, or
// the floor expires.
export class EdgeFloors {
  private floors = new Map<string, { bps: number; until: number }>()

  constructor(
    private marginBps = 5,
    private ttlMs = 10 * 60_000,
  ) {}

  get(id: string): number {
    const f = this.floors.get(id)
    if (!f) return 0
    if (Date.now() > f.until) {
      this.floors.delete(id)
      return 0
    }
    return f.bps
  }

  fail(id: string, edgeBps: number): void {
    // Proportional too: dust pools sit at edges of thousands of bps that wobble with every trade.
    this.floors.set(id, { bps: edgeBps * 1.05 + this.marginBps, until: Date.now() + this.ttlMs })
  }

  clear(id: string): void {
    this.floors.delete(id)
  }
}
