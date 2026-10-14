#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { formatUnits, parseGwei, parseUnits } from 'viem'
import { CHAIN_ID, COVEN_PROBE, DEFAULT_RPCS, DEX_GENESIS_BLOCK, MIN_GAS_PRICE, USDC, gasEstimate, gasToUsdc } from './constants.js'
import { backfillIndex } from './discovery.js'
import { Logger, pricedFields, run, usdc } from './engine.js'
import { Market } from './market.js'
import { PoolRegistry, defaultCachePath } from './pools.js'
import { findPayoutPools, payoutRoute, readProbeConfig } from './probe.js'
import { createRpc } from './rpc.js'
import { loadSigner } from './signer.js'
import { cycleCandidates, price } from './strategy.js'
import { Trader } from './trader.js'

const HELP = `coven-arb — atomic, capital-free arbitrage on Arc through CovenProbe

Usage:
  coven-arb run      [--dry-run] [--min-profit <usdc>] [--tip <gwei>] [--max-loss <usdc>] [--ws <url|off>] [--log <file>]
  coven-arb scan     [--min-profit <usdc>] [--json]
  coven-arb index    [--from <block>]
  coven-arb doctor

Commands:
  run     Watch every block, simulate every candidate route through CovenProbe and send
          the ones that pay for their gas. --dry-run reports what it would send without
          signing anything.
  scan    One pass over the current market; prints every route that is profitable on-chain.
  index   Index every v3/v4 pool ever created (resumable). Optional: run and scan discover
          active pools on their own, but a full index finds dormant venues too. Needs an
          RPC that serves historical logs; the public endpoints are slow at it.
  doctor  Check RPC endpoints, the CovenProbe contract, gas price and the signer.

Options:
  --rpc <url,...>        RPC endpoints, comma-separated; requests are spread across them
                         and transactions broadcast to all. Default: $ARC_RPC_URL or the
                         public Arc endpoints. A private endpoint is strongly recommended.
  --min-profit <usdc>    Smallest profit worth sending, after CovenProbe's 10% fee and gas.
                         The contract enforces it: a send whose gap has gone costs only the
                         check (~60k gas). Default 0.
  --tip <gwei>           Priority fee per gas. Arc orders transactions by it; measured on
                         Arc, bidding gives most of a contested profit away, so the default
                         is 0 and the bot wins by sending only what pays.
  --max-loss <usdc>      Stop once gas spent exceeds profit by this much. Default: no limit.
  --ws <url|off>         Websocket endpoint for pushed market events; polling stays on as a
                         safety net. Default: $ARC_WS_URL or the first --rpc URL as wss://.
                         Needs Node 22+.
  --log <file>           Append every opportunity, trade and outcome as JSON lines.
  --json                 scan: print opportunities as JSON.
  --from <block>         index: oldest block to index. Default: the first DEX block.

Signer (run only; there is deliberately no flag for it):
  COVEN_PRIVATE_KEY=0x...                           raw key, or
  COVEN_KEYSTORE=<file> COVEN_KEYSTORE_PASSWORD=... encrypted v3 keystore (geth, cast, MetaMask)
  Trades need no capital: CovenProbe settles each route atomically and pays only when it
  profits. The signer only needs USDC for gas: a trade costs 0.004-0.014 USDC, a send whose
  gap has gone ~0.0013, and each send needs ~0.03 USDC free up front.

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
    tip: { type: 'string' },
    'max-loss': { type: 'string' },
    ws: { type: 'string' },
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
const usdcFlag = (name: string, text: string) => {
  if (!/^\d+(\.\d{1,6})?$/.test(text)) fail(`--${name} must be a USDC amount like 0.05`)
  return parseUnits(text, 6)
}
const minNet = usdcFlag('min-profit', flags['min-profit'] ?? '0')
const maxLoss = flags['max-loss'] !== undefined ? usdcFlag('max-loss', flags['max-loss']) : undefined
const tipText = flags.tip ?? '0'
if (!/^\d+(\.\d{1,9})?$/.test(tipText)) fail('--tip must be a gwei amount like 0 or 1.5')
const tip = parseGwei(tipText)
const wsFlag = flags.ws ?? process.env.ARC_WS_URL
const wsUrl = wsFlag === 'off' ? undefined : (wsFlag ?? rpcUrls[0]?.replace(/^http/, 'ws'))
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
  const [{ feeBps }, block, hookPools] = await Promise.all([
    readProbeConfig(rpc.client),
    rpc.client.getBlock({ blockNumber: head }),
    findPayoutPools(rpc.client, market.reg.all()),
  ])
  const base = block.baseFeePerGas ?? MIN_GAS_PRICE
  const gasPrice = (base > MIN_GAS_PRICE ? base : MIN_GAS_PRICE) + tip
  const candidates = [...cycleCandidates(market.screen(market.cycles), gasPrice, 64), ...hookPools.map((p) => payoutRoute(p)!)]
  const priced = await price(rpc.client, candidates, { maxFeeBps: feeBps, gasPrice, blockNumber: head })
  const clearing = priced.filter((p) => p.net >= minNet)
  if (flags.json) {
    const out = priced.map((p) => ({ ...pricedFields(p, market), clearsFloor: p.net >= minNet }))
    console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
    return
  }
  log.info(`${market.cycles.length} cycles and ${hookPools.length} hook pools; simulated ${candidates.length}, ${priced.length} profitable on-chain, ${clearing.length} clear ${usdc(minNet)} after gas`)
  for (const p of priced) {
    const mark = p.net >= minNet ? '✓' : ' '
    console.log(`${mark} ${p.candidate.label(market.symbol)}\n    profit ${usdc(p.profit)}  gas ${usdc(p.gasUsdc)}  net ${usdc(p.net)}`)
  }
}

async function doRun() {
  const log = new Logger(flags.log)
  const account = flags['dry-run'] ? undefined : loadSigner()
  if (!flags['dry-run'] && !account) fail('run needs a signer: set COVEN_PRIVATE_KEY or COVEN_KEYSTORE (see --help), or pass --dry-run')
  const { rpc, market } = await openMarket(log)
  const { feeBps } = await readProbeConfig(rpc.client)
  const trader = account ? new Trader(rpc, account, { maxFeeBps: feeBps }) : undefined
  if (account) {
    const bal = await rpc.client.getBalance({ address: account.address })
    // Room for a few sends at their up-front gas limit.
    const need = (800_000n * Trader.maxFeePerGas(MIN_GAS_PRICE, tip) * 3n) / 1_000_000_000_000n
    log.info(`signer ${account.address}  balance ${formatUnits(bal, 18)} USDC`)
    if (bal / 1_000_000_000_000n < need) fail(`signer balance is below ${usdc(need)}; fund it with a little USDC for gas`, 1)
  }
  const loss = maxLoss !== undefined ? `, stop at a ${usdc(maxLoss)} loss` : ''
  log.info(`${account ? 'trading' : 'dry run'} through CovenProbe ${COVEN_PROBE}: fee ${feeBps / 100}% of profit, min net ${usdc(minNet)} after gas, tip ${tipText} gwei${loss}`)
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
  await run(market, { trader, minNet, tip, maxLoss, maxFeeBps: feeBps, wsUrl, log, signal: ctl.signal })
  if (trader) {
    const t = trader.stats
    log.info(`session: sent ${t.sent}, won ${t.won}, missed ${t.missed}, reverted ${t.reverted}, dropped ${t.dropped}; profit ${usdc(t.profit)}, gas ${usdc(t.gas)}, net ${usdc(t.profit - t.gas)}`)
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
    const code = await client.getCode({ address: COVEN_PROBE })
    const { feeBps, feeRecipient } = await readProbeConfig(client)
    add(!!code && code !== '0x', 'CovenProbe', `${COVEN_PROBE}, fee ${feeBps / 100}% of profit to ${feeRecipient}`)
  } catch (e) {
    add(false, 'CovenProbe', String((e as Error).message).split('\n')[0]!)
  }
  try {
    const block = await client.getBlock()
    const base = block.baseFeePerGas ?? 0n
    const cost = gasToUsdc(gasEstimate(2, 0), (base > MIN_GAS_PRICE ? base : MIN_GAS_PRICE) + tip)
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
