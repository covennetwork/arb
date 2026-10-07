#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { formatUnits, parseGwei, parseUnits } from 'viem'
import { CHAIN_ID, COVEN_ARB, DEFAULT_RPCS, DEX_GENESIS_BLOCK, MIN_GAS_PRICE, USDC, gasEstimate, gasToUsdc } from './constants.js'
import { readArbConfig } from './covenArb.js'
import { describeCycle } from './cycles.js'
import { backfillIndex } from './discovery.js'
import { Logger, oppFields, run, usdc } from './engine.js'
import { Market } from './market.js'
import { PoolRegistry, defaultCachePath } from './pools.js'
import { createRpc } from './rpc.js'
import { loadSigner } from './signer.js'
import { evaluate } from './strategy.js'
import { Trader } from './trader.js'

const HELP = `coven-arb — atomic, capital-free arbitrage on Arc through CovenArb

Usage:
  coven-arb run      [--dry-run] [--min-profit <usdc>] [--bid <percent>] [--log <file>]
  coven-arb scan     [--min-profit <usdc>] [--json]
  coven-arb index    [--from <block>]
  coven-arb doctor

Commands:
  run     Watch every block and execute profitable cycles. --dry-run reports what it
          would trade without signing anything.
  scan    One pass over the current market; prints every opportunity verified on-chain.
  index   Index every v3/v4 pool ever created (resumable). Optional: run and scan discover
          active pools on their own, but a full index finds dormant venues too. Needs an
          RPC that serves historical logs; the public endpoints are slow at it.
  doctor  Check RPC endpoints, the CovenArb contract, gas price and the signer.

Options:
  --rpc <url,...>        RPC endpoints, comma-separated; requests are spread across them
                         and transactions broadcast to all. Default: $ARC_RPC_URL or the
                         public Arc endpoints. A private endpoint is strongly recommended.
  --min-profit <usdc>    Smallest profit worth trading, after CovenArb's fee and gas.
                         Default 0.01.
  --bid <percent>        Share of expected profit paid as priority fee. Arc orders by
                         priority fee, so this decides races with other bots; a lost race
                         reverts and still pays gas plus this bid. Default 20, floor 1 gwei.
  --log <file>           Append every opportunity, trade and outcome as JSON lines.
  --json                 scan: print opportunities as JSON.
  --from <block>         index: oldest block to index. Default: the first DEX block.

Signer (run only; there is deliberately no flag for it):
  COVEN_PRIVATE_KEY=0x...                           raw key, or
  COVEN_KEYSTORE=<file> COVEN_KEYSTORE_PASSWORD=... encrypted v3 keystore (geth, cast, MetaMask)
  Trades need no capital: CovenArb settles each cycle atomically and reverts unless it
  profits. The signer only needs USDC for gas, about 0.006 USDC per attempt.

Environment:
  COVEN_ARB_CACHE        Directory for the pool registry (default ~/.cache/coven-arb).
`

function fail(msg: string, code = 2): never {
  console.error(msg)
  process.exit(code)
}

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
    rpc: { type: 'string' },
    'min-profit': { type: 'string' },
    bid: { type: 'string' },
    'dry-run': { type: 'boolean' },
    log: { type: 'string' },
    json: { type: 'boolean' },
    from: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    fail(`${(e as Error).message}\n\nRun coven-arb --help for usage.`)
  }
}

const { values: flags, positionals } = parseCli()

const cmd = positionals[0]
const rpcUrls = (flags.rpc ?? process.env.ARC_RPC_URL ?? DEFAULT_RPCS.join(','))
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
const minNetText = flags['min-profit'] ?? '0.01'
if (!/^\d+(\.\d{1,6})?$/.test(minNetText)) fail('--min-profit must be a USDC amount like 0.05')
const minNet = parseUnits(minNetText, 6)
const bidPct = Number(flags.bid ?? '20')
if (!(bidPct >= 0 && bidPct < 100)) fail('--bid must be a percentage between 0 and 100')
const bidBps = Math.round(bidPct * 100)
const MIN_PRIORITY_FEE = parseGwei('1')
const LOOKBACK = 20_000n // ~3 hours of blocks, read once at startup to find the active pools

async function openMarket(log: Logger) {
  const rpc = createRpc(rpcUrls)
  const chainId = await rpc.client.getChainId()
  if (chainId !== CHAIN_ID) fail(`RPC is on chain ${chainId}, expected Arc (${CHAIN_ID})`, 1)
  const reg = PoolRegistry.load()
  const market = new Market(rpc, reg)
  const head = await rpc.client.getBlockNumber()
  const t0 = Date.now()
  await market.bootstrap(head, LOOKBACK, (m) => log.info(m))
  const s = market.stats()
  await market.loadSymbols([...new Set(market.cycles.flatMap((c) => c.legs.map((l) => l.tokenOut)))])
  log.info(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${s.pools} pools, ${s.cycles} cycles over ${s.tracked} pools, head ${head}`)
  return { rpc, market, head }
}

async function doScan() {
  const log = new Logger()
  const quiet = flags.json
  const { rpc, market, head } = await openMarket(quiet ? new Logger() : log)
  const [{ feeBps }, block] = await Promise.all([readArbConfig(rpc.client), rpc.client.getBlock({ blockNumber: head })])
  const fees = { baseFee: block.baseFeePerGas ?? MIN_GAS_PRICE, minPriorityFee: MIN_PRIORITY_FEE, bidBps }
  const candidates = market.screen(market.cycles).slice(0, 64)
  const { opportunities, rejected } = await evaluate(rpc.client, candidates, { maxFeeBps: feeBps, fees, block: head })
  const clearing = opportunities.filter((o) => o.net >= minNet)
  if (flags.json) {
    const out = opportunities.map((o) => ({ ...oppFields(o, market), clearsFloor: o.net >= minNet }))
    console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
    return
  }
  log.info(
    `${market.cycles.length} cycles, ${candidates.length} with a positive spot edge, ${opportunities.length} profitable on-chain, ${clearing.length} clear ${usdc(minNet)} after gas`,
  )
  for (const o of opportunities) {
    const mark = o.net >= minNet ? '✓' : ' '
    console.log(
      `${mark} ${describeCycle(o.cycle, market.symbol)}\n    in ${usdc(o.amountIn)}  profit ${usdc(o.profit)}  gas ${usdc(o.gasUsdc)}  net ${usdc(o.net)}  edge ${o.edgeBps.toFixed(1)}bps`,
    )
  }
  const reasons = new Map<string, number>()
  for (const r of rejected) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1)
  if (rejected.length) log.info(`rejected on-chain: ${[...reasons].map(([r, n]) => `${n}× ${r}`).join(', ')}`)
}

async function doRun() {
  const log = new Logger(flags.log)
  const account = flags['dry-run'] ? undefined : loadSigner()
  if (!flags['dry-run'] && !account) fail('run needs a signer: set COVEN_PRIVATE_KEY or COVEN_KEYSTORE (see --help), or pass --dry-run')
  const { rpc, market } = await openMarket(log)
  const { feeBps } = await readArbConfig(rpc.client)
  const trader = account ? new Trader(rpc, account, { maxFeeBps: feeBps }) : undefined
  if (account) {
    const bal = await rpc.client.getBalance({ address: account.address })
    const need = gasToUsdc(gasEstimate(3, 1), MIN_GAS_PRICE * 2n + MIN_PRIORITY_FEE) * 10n
    log.info(`signer ${account.address}  balance ${formatUnits(bal, 18)} USDC`)
    if (bal / 1_000_000_000_000n < need) fail(`signer balance is below ${usdc(need)}; fund it with a little USDC for gas`, 1)
  }
  log.info(`${account ? 'trading' : 'dry run'}: min net ${usdc(minNet)} after gas, CovenArb fee ${feeBps / 100}%, bidding ${bidPct}% of profit as priority fee`)
  const ctl = new AbortController()
  let stopping = false
  const stop = () => {
    if (stopping) process.exit(130)
    stopping = true
    log.info('stopping (Ctrl-C again to force)')
    ctl.abort()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  await run(market, { trader, minNet, bidBps, minPriorityFee: MIN_PRIORITY_FEE, maxFeeBps: feeBps, log, signal: ctl.signal })
  if (trader) {
    const t = trader.stats
    log.info(`session: sent ${t.sent}, won ${t.won}, reverted ${t.reverted}, dropped ${t.dropped}; profit ${usdc(t.profit)}, gas ${usdc(t.gas)}, net ${usdc(t.profit - t.gas)}`)
  }
}

async function doIndex() {
  const log = new Logger()
  const rpc = createRpc(rpcUrls)
  const reg = PoolRegistry.load()
  const head = await rpc.client.getBlockNumber()
  if (flags.from !== undefined && !/^\d+$/.test(flags.from)) fail('--from must be a block number')
  const from = flags.from ? BigInt(flags.from) : DEX_GENESIS_BLOCK
  // Coverage must stay one contiguous range. Windows run newest-first, so a gap below the
  // covered range (or a first run) extends coverage downwards window by window; the gap
  // above it only counts once it is complete.
  const gaps: { lo: bigint; hi: bigint; above: boolean }[] = []
  if (reg.indexedFrom === undefined || reg.indexedTo === undefined) gaps.push({ lo: from, hi: head, above: false })
  else {
    if (reg.indexedTo < head) gaps.push({ lo: reg.indexedTo + 1n, hi: head, above: true })
    if (from < reg.indexedFrom) gaps.push({ lo: from, hi: reg.indexedFrom - 1n, above: false })
  }
  if (gaps.length === 0) return log.info(`already indexed ${reg.indexedFrom}..${reg.indexedTo}: ${reg.size} pools in ${defaultCachePath()}`)
  const total = gaps.reduce((n, g) => n + (g.hi - g.lo + 1n), 0n)
  log.info(`indexing ${total} blocks into ${defaultCachePath()} (Ctrl-C is safe; progress is saved)`)
  let done = 0n
  const t0 = Date.now()
  for (const { lo, hi, above } of gaps) {
    await backfillIndex(rpc.client, reg, lo, hi, (windowLo, added) => {
      if (!above) {
        reg.indexedFrom = windowLo
        reg.indexedTo ??= hi
        reg.markDirty()
      }
      const covered = done + (hi - windowLo + 1n)
      const rate = Number(covered) / ((Date.now() - t0) / 1000)
      const eta = rate > 0 ? Math.round(Number(total - covered) / rate / 60) : 0
      process.stdout.write(`\r  ${((Number(covered) / Number(total)) * 100).toFixed(1)}%  block ${windowLo}  +${added} pools  ~${eta} min left   `)
    })
    if (above) {
      reg.indexedTo = hi
      reg.markDirty()
    }
    done += hi - lo + 1n
  }
  process.stdout.write('\n')
  reg.save()
  log.info(`indexed ${reg.indexedFrom}..${reg.indexedTo}: ${reg.size} pools`)
}

async function doDoctor() {
  const checks: { ok: boolean; name: string; detail: string }[] = []
  const add = (ok: boolean, name: string, detail: string) => checks.push({ ok, name, detail })
  const rpc = createRpc(rpcUrls)
  await Promise.all(
    rpc.endpoints.map(async (c, i) => {
      try {
        const id = await c.getChainId()
        const t = Date.now()
        const head = await c.getBlockNumber()
        const ms = Date.now() - t
        let logs = 'serves getLogs'
        try {
          await c.getLogs({ address: USDC, fromBlock: head - 100n, toBlock: head })
        } catch (e) {
          logs = `no getLogs (${String((e as { details?: string }).details ?? (e as Error).message).slice(0, 50)})`
        }
        add(id === CHAIN_ID, `rpc ${rpcUrls[i]}`, `chain ${id}, ${ms} ms per request, ${logs}`)
      } catch (e) {
        add(false, `rpc ${rpcUrls[i]}`, String((e as Error).message).split('\n')[0]!)
      }
    }),
  )
  const client = rpc.client
  try {
    const code = await client.getCode({ address: COVEN_ARB })
    const { feeBps, feeRecipient } = await readArbConfig(client)
    add(!!code && code !== '0x', 'CovenArb', `${COVEN_ARB}, fee ${feeBps / 100}% of profit to ${feeRecipient}`)
  } catch (e) {
    add(false, 'CovenArb', String((e as Error).message).split('\n')[0]!)
  }
  try {
    const block = await client.getBlock()
    const base = block.baseFeePerGas ?? 0n
    const cost = gasToUsdc(gasEstimate(2, 0), (base > MIN_GAS_PRICE ? base : MIN_GAS_PRICE) + MIN_PRIORITY_FEE)
    add(true, 'gas', `base fee ${formatUnits(base, 9)} gwei; a 2-leg trade costs ≈ ${usdc(cost)}`)
  } catch (e) {
    add(false, 'gas', String((e as Error).message).split('\n')[0]!)
  }
  try {
    const account = loadSigner()
    if (!account) add(true, 'signer', 'none set (fine for scan and run --dry-run)')
    else {
      const bal = await client.getBalance({ address: account.address })
      add(bal > 0n, 'signer', `${account.address}, ${formatUnits(bal, 18)} USDC for gas`)
    }
  } catch (e) {
    add(false, 'signer', (e as Error).message)
  }
  const reg = PoolRegistry.load()
  const indexed = reg.indexedFrom !== undefined ? `, full index ${reg.indexedFrom}..${reg.indexedTo}` : ', no full index (optional)'
  add(true, 'pool cache', `${reg.size} pools in ${defaultCachePath()}${indexed}`)
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(48)} ${c.detail}`)
  process.exit(checks.some((c) => !c.ok) ? 1 : 0)
}

async function main() {
  if (flags.help || !cmd) {
    console.log(HELP)
    process.exit(cmd || flags.help ? 0 : 1)
  }
  if (rpcUrls.length === 0) fail('no RPC endpoints given')
  const commands: Record<string, () => Promise<void>> = { run: doRun, scan: doScan, index: doIndex, doctor: doDoctor }
  const fn = commands[cmd]
  if (!fn) fail(`unknown command: ${cmd}\n\n${HELP}`)
  await fn()
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e).split('\n')[0])
  process.exit(1)
})
