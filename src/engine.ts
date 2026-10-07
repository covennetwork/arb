import { appendFileSync } from 'node:fs'
import { type Log, formatUnits } from 'viem'
import { marketEvents } from './abis.js'
import { readArbConfig } from './covenArb.js'
import { describeCycle } from './cycles.js'
import type { Market } from './market.js'
import { MIN_GAS_PRICE, gasEstimate, gasToUsdc } from './constants.js'
import type { Screened } from './cycles.js'
import { getLogsChunked, isRangeError } from './rpc.js'
import { EdgeFloors, type Opportunity, evaluate } from './strategy.js'
import type { Outcome, Trader } from './trader.js'

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
  // Floor on profit after CovenArb's fee and gas, in USDC (6dp).
  minNet: bigint
  // Share of expected profit bid as priority fee (bps), and the floor on that fee (wei).
  bidBps: number
  minPriorityFee: bigint
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

export function oppFields(o: Opportunity, market: Market) {
  return {
    route: describeCycle(o.cycle, market.symbol),
    pools: o.cycle.legs.map((l) => l.pool.id),
    amountIn: o.amountIn,
    profit: o.profit,
    gas: o.gasUsdc,
    priorityFeeGwei: Number(o.priorityFee) / 1e9,
    net: o.net,
    edgeBps: Math.round(o.edgeBps * 10) / 10,
    block: o.block,
  }
}

// The live loop: per new block, apply market events, re-screen the cycles they touched,
// size survivors on-chain and trade those that clear the floor.
export async function run(market: Market, opts: RunOptions): Promise<void> {
  const { client } = market
  const { log, trader } = opts
  const floors = new EdgeFloors()
  let cursor = market.reg.syncedTo ?? (await client.getBlockNumber())
  let baseFee = (await client.getBlock()).baseFeePerGas ?? MIN_GAS_PRICE
  // Near the head, one eth_getLogs up to 'latest' is the whole poll. When behind, catch up
  // in explicit ranges.
  let catchingUp = true
  let lastFull = 0
  let lastRefresh = Date.now()
  let lastStatus = Date.now()
  let discovery: Promise<void> | undefined
  let probed = 0
  let found = 0

  const report = (o: Outcome) => {
    const net = o.profit - o.gas
    const route = describeCycle(o.opportunity.cycle, market.symbol)
    log.info(`${o.status.padEnd(8)} ${o.hash}  ${route}  profit ${usdc(o.profit)}  gas ${usdc(o.gas)}  net ${signed(net)}`)
    log.event('outcome', {
      ...oppFields(o.opportunity, market),
      hash: o.hash,
      status: o.status,
      realizedProfit: o.profit,
      gasPaid: o.gas,
      realizedNet: net,
      landedBlock: o.block,
    })
  }

  while (!opts.signal?.aborted) {
    try {
      let logs: Log[]
      let head: bigint
      if (catchingUp) {
        head = await client.getBlockNumber()
        logs = head > cursor ? await getLogsChunked(client, { events: marketEvents, fromBlock: cursor + 1n, toBlock: head }) : []
        catchingUp = false
      } else {
        try {
          logs = (await client.getLogs({ events: marketEvents, fromBlock: cursor + 1n, toBlock: 'latest', strict: true })) as Log[]
        } catch (e) {
          if (isRangeError(e)) {
            // Too far behind for one query.
            catchingUp = true
            continue
          }
          // Endpoints answer a bare "invalid params" when fromBlock is past their head: the
          // round robin reached a backend that has not seen the latest block yet.
          if (!/invalid param/i.test(String((e as Error).message))) throw e
          logs = []
        }
        // Blocks without market events are simply covered again by the next poll.
        head = logs.reduce((m, l) => (l.blockNumber !== null && l.blockNumber > m ? l.blockNumber : m), cursor)
      }
      if (head <= cursor) {
        if (trader) for (const o of await trader.poll()) report(o)
        await sleep(opts.pollMs ?? 150)
        continue
      }
      const seenAt = Date.now()
      const touched = market.applyLogs(logs)
      for (const id of await market.refreshChanged(head)) touched.add(id)
      cursor = head
      market.reg.syncedTo = head
      market.reg.markDirty()

      discovery ??= market
        .resolveUnknown()
        .then((added) => {
          if (added > 0) {
            lastFull = 0
            log.info(`discovered ${added} pool(s); tracking ${market.stats().cycles} cycles`)
          }
        })
        .catch((e) => log.event('error', { where: 'discovery', reason: String(e) }))
        .finally(() => {
          discovery = undefined
        })

      const full = Date.now() - lastFull > FULL_SCAN_MS
      if (full) lastFull = Date.now()
      const busy = trader?.busyPools() ?? new Set()
      // The virtual-reserve model is rough, but a cycle it values at under a quarter of the
      // gas bill is not worth a probe.
      const worthProbing = (s: Screened) =>
        s.seedProfit * 4n >= gasToUsdc(gasEstimate(s.cycle.legs.length, s.cycle.hooked), baseFee + opts.minPriorityFee) + opts.minNet
      const candidates = market
        .screen(full ? market.cycles : market.cyclesThrough(touched), (c) => floors.get(c))
        .filter((s) => worthProbing(s) && !s.cycle.legs.some((l) => busy.has(l.pool.id)))
        .slice(0, opts.maxCandidates ?? 8)

      if (candidates.length > 0) {
        probed += candidates.length
        const fees = { baseFee, minPriorityFee: opts.minPriorityFee, bidBps: opts.bidBps }
        // Probe at 'latest' rather than `head`: the chain may already be a block further on.
        const { opportunities, rejected } = await evaluate(client, candidates, { maxFeeBps: opts.maxFeeBps, fees })
        for (const r of rejected) floors.fail(r.cycle, r.edgeBps)
        for (const o of opportunities) {
          if (o.net < opts.minNet) {
            floors.fail(o.cycle, o.edgeBps)
            log.event('below_floor', oppFields(o, market))
            continue
          }
          found++
          const route = describeCycle(o.cycle, market.symbol)
          if (!trader) {
            log.info(`would trade  ${route}  in ${usdc(o.amountIn)}  net ${signed(o.net)}  (${Date.now() - seenAt} ms after block ${head})`)
            log.event('opportunity', { dryRun: true, reactionMs: Date.now() - seenAt, triggerBlock: head, ...oppFields(o, market) })
            floors.fail(o.cycle, o.edgeBps)
            continue
          }
          if (!trader.canSend(o)) continue
          try {
            const hash = await trader.submit(o, baseFee)
            const reactionMs = Date.now() - seenAt
            log.info(`sent     ${hash}  ${route}  in ${usdc(o.amountIn)}  expect net ${signed(o.net)}  (${reactionMs} ms after the trigger)`)
            log.event('sent', { hash, reactionMs, triggerBlock: head, ...oppFields(o, market) })
          } catch (e) {
            log.info(`send failed: ${String((e as Error).message).split('\n')[0]}`)
            log.event('error', { where: 'send', reason: String(e), ...oppFields(o, market) })
          }
        }
      }

      if (trader) for (const o of await trader.poll()) report(o)

      if (Date.now() - lastRefresh > REFRESH_MS) {
        lastRefresh = Date.now()
        await market.refreshAll(head)
        baseFee = (await client.getBlock()).baseFeePerGas ?? baseFee
        if ((await client.getBlockNumber()) - cursor > 100n) catchingUp = true
        const { feeBps } = await readArbConfig(client)
        if (feeBps > opts.maxFeeBps) log.info(`CovenArb fee rose to ${feeBps / 100}% (plans cap it at ${opts.maxFeeBps / 100}%); trades will revert until restart`)
        market.reg.save()
      }
      if (Date.now() - lastStatus > STATUS_MS) {
        lastStatus = Date.now()
        const s = market.stats()
        const t = trader?.stats
        const pnl = t ? `  sent ${t.sent} won ${t.won} reverted ${t.reverted} dropped ${t.dropped}  net ${signed(t.profit - t.gas)} USDC` : ''
        log.info(`block ${head}  ${s.pools} pools  ${s.cycles} cycles  probed ${probed}  profitable ${found}${pnl}`)
        log.event('status', { block: head, ...s, probed, found, ...(t ?? {}) })
      }
    } catch (e) {
      log.info(`error: ${String((e as Error).message ?? e).split('\n')[0]}`)
      log.event('error', { where: 'loop', reason: String(e) })
      await sleep(1000)
    }
  }

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
