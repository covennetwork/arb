import { appendFileSync } from 'node:fs'
import { type Hex, formatGwei, formatUnits } from 'viem'
import { MIN_GAS_PRICE, gasLimitFor } from './constants.js'
import { MarketFeed } from './feed.js'
import type { Market } from './market.js'
import { type Candidate, findPayoutPools, hookInventory, payoutRoute, readProbeConfig } from './probe.js'
import { Backoff, EdgeFloors, type Priced, cycleCandidates, price } from './strategy.js'
import { LowBalanceError, type Outcome, type Trader } from './trader.js'

export const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`
const signed = (v: bigint) => `${v >= 0n ? '+' : ''}${formatUnits(v, 6)}`

export class Logger {
  constructor(private file?: string) {}

  info(msg: string): void {
    const t = new Date().toISOString().slice(11, 19)
    console.log(`${t}  ${msg}`)
  }

  // One JSON object per line, for later analysis. bigints are written as strings.
  event(type: string, data: Record<string, unknown>): void {
    if (!this.file) return
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    appendFileSync(this.file, line + '\n')
  }
}

export type RunOptions = {
  trader?: Trader
  // Floor on profit after CovenProbe's fee and gas, in USDC (6dp).
  minNet: bigint
  // Priority fee per gas (wei). Arc orders by it; the measured edge is in sending only what
  // pays, not in bidding, so the default is 0.
  tip: bigint
  // Stop once gas spent exceeds profit by this much (USDC 6dp).
  maxLoss?: bigint
  // Websocket endpoint for pushed market events; polling only when absent.
  wsUrl?: string
  maxFeeBps: number
  log: Logger
  pollMs?: number
  maxCandidates?: number
  signal?: AbortSignal
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const FULL_SCAN_MS = 30_000
const REFRESH_MS = 5 * 60_000
const STATUS_MS = 60_000

export function pricedFields(p: Priced, market: Market) {
  return {
    route: p.candidate.label(market.symbol),
    id: p.candidate.id,
    pools: p.candidate.pools,
    profit: p.profit,
    gas: p.gasUsdc,
    net: p.net,
  }
}

// The live loop. Per batch of new market events: update pool state, re-screen the cycles the
// events touched (all of them every 30 s), add the payout routes of touched fair-launch hook
// pools, simulate every candidate through CovenProbe in one round of eth_calls, and send each
// one that pays for its gas, alone, at the chosen tip. The send carries its gas cost as the
// on-chain profit floor, so a gap someone else takes first costs only the check (~60k gas).
export async function run(market: Market, opts: RunOptions): Promise<void> {
  const { client } = market
  const { log, trader } = opts
  const floors = new EdgeFloors()
  // Keyed by pool: many cycles share the same contested pools, so a miss on one pauses them all.
  const backoff = new Backoff(30_000, 30 * 60_000)
  const start = market.reg.syncedTo ?? (await client.getBlockNumber())
  let baseFee = (await client.getBlock()).baseFeePerGas ?? MIN_GAS_PRICE
  const gasPrice = () => (baseFee > MIN_GAS_PRICE ? baseFee : MIN_GAS_PRICE) + opts.tip
  const feed = new MarketFeed(client, start + 1n, opts.wsUrl, (m) => log.info(m))
  feed.start()
  let payouts = new Map<Hex, Candidate>()
  const refreshPayouts = async () => {
    const pools = await findPayoutPools(client, market.reg.all())
    payouts = new Map(pools.map((p) => [p.id, payoutRoute(p)!]))
  }
  await refreshPayouts().catch((e) => log.event('error', { where: 'payouts', reason: String(e) }))
  log.info(`watching ${market.cycles.length} cycles and ${payouts.size} fair-launch hook pools`)
  let lastFull = 0
  let lastRefresh = Date.now()
  let lastStatus = Date.now()
  let lowBalanceUntil = 0
  let discovery: Promise<void> | undefined
  let lastHead = start
  const stats = { simulated: 0, profitable: 0, belowFloor: 0 }

  const report = (o: Outcome) => {
    const net = o.profit - o.gas
    const id = o.send.candidate.id
    // A payout route's gate makes a miss cheap (~45k gas) and payouts can be large: no pause.
    if (!o.send.candidate.payout) {
      for (const pool of o.send.candidate.pools) {
        if (o.status === 'won') backoff.won(pool)
        else backoff.lost(pool)
      }
    }
    log.info(`${o.status.padEnd(8)} ${o.hash}  ${o.send.candidate.label(market.symbol)}  profit ${usdc(o.profit)}  gas ${usdc(o.gas)}  net ${signed(net)}`)
    log.event('outcome', {
      route: o.send.candidate.label(market.symbol),
      id,
      hash: o.hash,
      status: o.status,
      expectedProfit: o.send.profit,
      realizedProfit: o.profit,
      protocolFee: o.fee,
      gasPaid: o.gas,
      realizedNet: net,
      seenBlock: o.send.block,
      landedBlock: o.block,
    })
  }

  while (!opts.signal?.aborted) {
    try {
      const { logs, head } = await feed.next(opts.pollMs)
      if (logs.length === 0 && head <= lastHead) {
        if (trader) for (const o of await trader.poll()) report(o)
        continue
      }
      lastHead = head > lastHead ? head : lastHead
      const seenAt = Date.now()
      const touched = market.applyLogs(logs)
      for (const id of await market.refreshChanged(head)) touched.add(id)
      market.reg.syncedTo = feed.synced
      market.reg.markDirty()
      market.drainArbTxs()

      discovery ??= market
        .resolveUnknown()
        .then(async (added) => {
          if (added > 0) {
            lastFull = 0
            await refreshPayouts()
            log.info(`discovered ${added} pool(s); watching ${market.stats().cycles} cycles and ${payouts.size} hook pools`)
          }
        })
        .catch((e) => log.event('error', { where: 'discovery', reason: String(e) }))
        .finally(() => {
          discovery = undefined
        })

      const full = Date.now() - lastFull > FULL_SCAN_MS
      if (full) lastFull = Date.now()
      const busy = trader?.busyPools() ?? new Set()
      const free = (c: Candidate) => !c.pools.some((id) => busy.has(id) || backoff.blocked(id))
      const screened = market.screen(full ? market.cycles : market.cyclesThrough(touched), (c) => floors.get(c.id))
      const candidates = cycleCandidates(screened, gasPrice(), opts.maxCandidates ?? 24).filter(free)
      for (const [id, c] of payouts) if ((full || touched.has(id)) && free(c)) candidates.push(c)
      if (candidates.length === 0) {
        if (trader) for (const o of await trader.poll()) report(o)
        continue
      }

      stats.simulated += candidates.length
      const priced = await price(client, candidates, { maxFeeBps: opts.maxFeeBps, gasPrice: gasPrice(), account: trader?.account.address })
      const pricedIds = new Set(priced.map((p) => p.candidate.id))
      for (const s of screened) if (!pricedIds.has(s.cycle.id)) floors.fail(s.cycle.id, s.edgeBps)
      for (const p of priced) {
        stats.profitable++
        if (p.net < opts.minNet) {
          stats.belowFloor++
          log.event('below_floor', pricedFields(p, market))
          continue
        }
        const route = p.candidate.label(market.symbol)
        if (!trader) {
          log.info(`would send  ${route}  profit ${usdc(p.profit)}  net ${signed(p.net)}  (${Date.now() - seenAt} ms after block ${head})`)
          log.event('opportunity', { dryRun: true, reactionMs: Date.now() - seenAt, block: head, ...pricedFields(p, market) })
          continue
        }
        if (!trader.canSend(p.candidate) || Date.now() < lowBalanceUntil) continue
        try {
          // The floor the contract enforces: the send must pay for its own gas plus --min-profit.
          const r = p.candidate.route
          const gate = p.candidate.payout
            ? { ...r.gate, min: (await hookInventory(client, p.candidate)) / 2n || 1n }
            : r.gate
          const legs = r.legs.length
          const hooked = r.legs.filter((l) => l.v4 && l.key.hooks !== '0x0000000000000000000000000000000000000000').length
          const v3 = r.legs.filter((l) => !l.v4).length
          const gasLimit = p.candidate.payout ? 800_000n : gasLimitFor(legs, hooked, v3)
          const send = { candidate: p.candidate, route: { ...r, minProfit: p.gasUsdc + opts.minNet, gate }, profit: p.profit, block: head, gasUsdc: p.gasUsdc, net: p.net, gasLimit, tip: opts.tip }
          const hash = await trader.submit(send, baseFee)
          const reactionMs = Date.now() - seenAt
          log.info(`sent     ${hash}  ${route}  expect ${usdc(p.profit)}  net ${signed(p.net)}  tip ${formatGwei(opts.tip)} gwei  (${reactionMs} ms after block ${head})`)
          log.event('sent', { hash, reactionMs, block: head, ...pricedFields(p, market) })
        } catch (e) {
          if (e instanceof LowBalanceError) {
            lowBalanceUntil = Date.now() + 60_000
            log.info(`NOT SENT: ${e.message}`)
            log.event('low_balance', { have: e.have, need: e.need, ...pricedFields(p, market) })
            continue
          }
          log.info(`send failed: ${String((e as Error).message).split('\n')[0]}`)
          log.event('error', { where: 'send', reason: String(e), ...pricedFields(p, market) })
        }
      }

      if (trader) for (const o of await trader.poll()) report(o)
      if (trader && opts.maxLoss !== undefined && trader.stats.gas - trader.stats.profit > opts.maxLoss) {
        log.info(`stopping: net loss ${usdc(trader.stats.gas - trader.stats.profit)} reached --max-loss`)
        break
      }

      if (Date.now() - lastRefresh > REFRESH_MS) {
        lastRefresh = Date.now()
        await market.refreshAll(head)
        await refreshPayouts().catch(() => undefined)
        baseFee = (await client.getBlock()).baseFeePerGas ?? baseFee
        if ((await client.getBlockNumber()) - feed.synced > 100n) feed.resync()
        const { feeBps } = await readProbeConfig(client)
        if (feeBps > opts.maxFeeBps) log.info(`CovenProbe fee rose to ${feeBps / 100}% (sends cap it at ${opts.maxFeeBps / 100}%); sends will revert until restart`)
        market.reg.save()
      }
      if (Date.now() - lastStatus > STATUS_MS) {
        lastStatus = Date.now()
        const s = market.stats()
        const t = trader?.stats
        const pnl = t ? `  sent ${t.sent} won ${t.won} missed ${t.missed} reverted ${t.reverted} dropped ${t.dropped}  net ${signed(t.profit - t.gas)} USDC` : ''
        log.info(`block ${head}  ${s.cycles} cycles  ${payouts.size} hook pools  ${feed.live ? 'ws' : 'polling'}  simulated ${stats.simulated}  profitable ${stats.profitable}${pnl}`)
        log.event('status', { block: head, ...s, ...stats, hookPools: payouts.size, websocket: feed.live, ...(t ?? {}) })
      }
    } catch (e) {
      const err = e as { shortMessage?: string; details?: string; message?: string }
      log.info(`error: ${[err.shortMessage, err.details].filter(Boolean).join(' ') || String(err.message ?? e).split('\n')[0]}`)
      log.event('error', { where: 'loop', reason: String(e) })
      await sleep(1000)
    }
  }

  feed.close()
  if (trader && trader.pendingCount > 0) {
    log.info(`waiting for ${trader.pendingCount} pending transaction(s)`)
    const until = Date.now() + 15_000
    while (trader.pendingCount > 0 && Date.now() < until) {
      for (const o of await trader.poll()) report(o)
      await sleep(500)
    }
  }
  market.reg.save()
}
