#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { type Address, createPublicClient, createWalletClient, formatUnits, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_RPC_URL, USDC, arc, erc20Abi } from '@covennetwork/core'
import { createCovenArb } from './index.js'
import { type Plan, simulatePlan } from './bindings.js'
import { MIN_MAX_FEE_PER_GAS } from './gas.js'

const HELP = `coven-arb — atomic arbitrage on Arc

Usage:
  coven-arb scan     [--min-profit 0.50] [--tokens 0x..,0x..] [--log file.jsonl]
  coven-arb run      [--min-profit 0.50] [--tokens 0x..,0x..] [--log file.jsonl]
  coven-arb simulate <plan.json> [--log file.jsonl]
  coven-arb doctor

Common:
  --rpc <url>         Arc RPC (default ARC_RPC_URL or the public endpoint)
  --arb <address>     deployed CovenArb address (required for run)
  --min-profit <usdc> net profit floor in USDC (default 0.50)
  --tokens <list>     comma-separated token addresses to scan
  --log <file>        append JSONL of every attempt

Signing (run only):
  There is no --private-key flag on purpose: it lands in shell history and in
  screenshots when people paste logs. Provide the key out of band instead:
    COVEN_PRIVATE_KEY=0x...            a raw key in the environment, or
    COVEN_KEYSTORE=/path COVEN_KEYSTORE_PASSWORD=...   an encrypted keystore file
`

const args = parseArgs({
  allowPositionals: true,
  options: {
    'min-profit': { type: 'string' },
    tokens: { type: 'string' },
    rpc: { type: 'string' },
    arb: { type: 'string' },
    log: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

const cmd = args.positionals[0]
const rpc = args.values.rpc ?? process.env.ARC_RPC_URL ?? ARC_RPC_URL
const minProfit = parseUnits(args.values['min-profit'] ?? '0.50', 6)
const logFile = args.values.log
const usdc = (a: bigint) => `${formatUnits(a, 6)} USDC`

function log(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  if (logFile) appendFileSync(logFile, line + '\n')
  return line
}

function loadAccount() {
  const pk = process.env.COVEN_PRIVATE_KEY
  if (pk) return privateKeyToAccount(pk.startsWith('0x') ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`))
  if (process.env.COVEN_KEYSTORE) {
    throw new Error('Encrypted keystore support is not bundled in this build; export COVEN_PRIVATE_KEY from your keystore out of band.')
  }
  throw new Error('No signer. Set COVEN_PRIVATE_KEY (see --help). There is no --private-key flag by design.')
}

function tokenList(): Address[] {
  const raw = args.values.tokens
  if (!raw) return []
  return raw.split(',').map((t) => t.trim()) as Address[]
}

async function doDoctor() {
  const client = createPublicClient({ chain: arc, transport: http(rpc) })
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const t0 = Date.now()
  let chainId = 0
  try {
    chainId = await client.getChainId()
    checks.push({ name: 'rpc latency', ok: true, detail: `${Date.now() - t0} ms` })
  } catch (e) {
    checks.push({ name: 'rpc reachable', ok: false, detail: String((e as Error).message) })
  }
  checks.push({ name: 'chain id', ok: chainId === 5042, detail: `${chainId} (want 5042)` })
  try {
    const gp = await client.getGasPrice()
    const ok = gp >= MIN_MAX_FEE_PER_GAS
    checks.push({
      name: '20 gwei floor',
      ok,
      detail: `gasPrice ${Number(gp) / 1e9} gwei; maxFeePerGas must clear 20 gwei or the mempool silently drops the tx`,
    })
  } catch (e) {
    checks.push({ name: '20 gwei floor', ok: false, detail: String((e as Error).message) })
  }
  try {
    const head = await client.getBlockNumber()
    await client.getLogs({ fromBlock: head - 1001n, toBlock: head })
    checks.push({ name: 'eth_getLogs > 1000 blocks', ok: true, detail: 'endpoint serves wide ranges' })
  } catch (e) {
    checks.push({
      name: 'eth_getLogs > 1000 blocks',
      ok: false,
      detail: `capped/limited (${String((e as Error).message).slice(0, 80)}); the public RPC caps at 1000 blocks and rate-limits — use a private endpoint`,
    })
  }
  const pk = process.env.COVEN_PRIVATE_KEY
  if (pk) {
    try {
      const acct = loadAccount()
      const bal = (await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] })) as bigint
      checks.push({ name: 'signer USDC balance', ok: bal > 0n, detail: `${acct.address}: ${usdc(bal)} (gas + capital buffer)` })
    } catch (e) {
      checks.push({ name: 'signer USDC balance', ok: false, detail: String((e as Error).message) })
    }
  } else {
    checks.push({ name: 'signer', ok: false, detail: 'COVEN_PRIVATE_KEY not set (fine for scan; required for run)' })
  }
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(28)} ${c.detail}`)
  process.exit(checks.some((c) => !c.ok && ['chain id'].includes(c.name)) ? 1 : 0)
}

async function doScan() {
  const arbc = createCovenArb({ transport: http(rpc) })
  const tokens = tokenList()
  if (tokens.length === 0) {
    console.error('scan needs --tokens for now (a targeted list). watch mode streams discovery in run.')
    process.exit(2)
  }
  const all = await arbc.scan({ tokens, minNetProfit: -(10n ** 30n) })
  for (const o of all) {
    log({ event: 'scan', token: o.token, buy: `${o.buy.protocol}/${o.buy.fee}`, sell: `${o.sell.protocol}/${o.sell.fee}`, size: o.size, expectedProfit: o.expectedProfit, gas: o.estimatedGasUsdc, netProfit: o.netProfit, midGapBps: o.midGapBps })
  }
  const clearing = all.filter((o) => o.netProfit >= minProfit)
  log({ event: 'scan_summary', scanned: tokens.length, candidates: all.length, clearing: clearing.length, floor: minProfit })
  if (clearing.length === 0) console.log(`scanned ${tokens.length} token(s), ${all.length} candidate pair(s), none clear the ${usdc(minProfit)} floor`)
  for (const o of clearing) {
    console.log(
      `${o.token} ${o.buy.protocol}/${o.buy.fee} -> ${o.sell.protocol}/${o.sell.fee} size ${usdc(o.size)} net ${usdc(o.netProfit)} gap ${o.midGapBps}bps`,
    )
  }
}

async function doSimulate() {
  const file = args.positionals[1]
  if (!file) {
    console.error('simulate needs a plan.json path')
    process.exit(2)
  }
  const plan = JSON.parse(readFileSync(file, 'utf8'), (_k, v) => (typeof v === 'string' && /^\d+n?$/.test(v) ? BigInt(v.replace('n', '')) : v)) as Plan
  const arbAddr = args.values.arb as Address | undefined
  if (!arbAddr) {
    console.error('simulate needs --arb <deployed CovenArb address>')
    process.exit(2)
  }
  const client = createPublicClient({ chain: arc, transport: http(rpc) })
  const caller = process.env.COVEN_PRIVATE_KEY ? loadAccount().address : ('0x000000000000000000000000000000000000dEaD' as Address)
  try {
    const { profit, asOfBlock } = await simulatePlan(client, arbAddr, plan, caller)
    console.log(`simulated profit ${usdc(profit)} as of block ${asOfBlock}`)
    log({ event: 'simulate', profit, asOfBlock, ok: true })
  } catch (e) {
    console.log(`simulation reverted: ${String((e as Error).message).split('\n')[0]}`)
    log({ event: 'simulate', ok: false, reason: String((e as Error).message).split('\n')[0] })
  }
}

async function doRun() {
  const arbAddr = args.values.arb as Address | undefined
  if (!arbAddr) {
    console.error('run needs --arb <deployed CovenArb address>')
    process.exit(2)
  }
  const account = loadAccount()
  const arbc = createCovenArb({ transport: http(rpc), arb: arbAddr })
  const wallet = createWalletClient({ account, chain: arc, transport: http(rpc) })
  const client = arbc.publicClient
  console.log(`run: watching for candidates, min net ${usdc(minProfit)}, signer ${account.address}`)
  arbc.watch({
    minNetProfit: minProfit,
    onError: (e) => log({ event: 'error', reason: String(e) }),
    onCandidates: async (opps) => {
      for (const o of opps) {
        const plan = (await import('./solver.js')).planFor(o, o.netProfit > 0n ? o.netProfit : 1n)
        try {
          const { profit, asOfBlock } = await simulatePlan(client, arbAddr, plan, account.address)
          if (profit < minProfit) {
            log({ event: 'skip', token: o.token, simulatedProfit: profit, asOfBlock })
            continue
          }
          const hash = await arbc.execute({ wallet, plan })
          const receipt = await client.waitForTransactionReceipt({ hash })
          log({ event: 'attempt', token: o.token, simulatedProfit: profit, hash, status: receipt.status, gasUsed: receipt.gasUsed })
          console.log(`${receipt.status === 'success' ? 'won' : 'reverted'} ${hash} sim ${usdc(profit)}`)
        } catch (e) {
          log({ event: 'attempt', token: o.token, ok: false, reason: String((e as Error).message).split('\n')[0] })
        }
      }
    },
  })
}

async function main() {
  if (args.values.help || !cmd) {
    console.log(HELP)
    process.exit(cmd ? 0 : 1)
  }
  if (cmd === 'doctor') return doDoctor()
  if (cmd === 'scan') return doScan()
  if (cmd === 'simulate') return doSimulate()
  if (cmd === 'run') return doRun()
  console.error(`unknown command: ${cmd}`)
  console.log(HELP)
  process.exit(2)
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exit(1)
})