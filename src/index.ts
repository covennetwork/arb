import { type Address, type Hex, type PublicClient, type Transport, type WalletClient, createPublicClient } from 'viem'
import {
  type WatchPoolsOptions,
  arc,
  createContext,
  createPoolWatcher,
  createTokenRegistry,
} from '@covennetwork/core'
import { COVEN_ARB } from './addresses.js'
import { type Opportunity, type SolveOptions, solveToken } from './solver.js'
import { poolsForToken } from './scan.js'
import { type Plan, executePlan, simulatePlan } from './bindings.js'

export * from './math.js'
export * from './gas.js'
export * from './solver.js'
export * from './bindings.js'
export * from './scan.js'
export { COVEN_ARB } from './addresses.js'

export type CovenArbConfig = {
  transport: Transport
  arb?: Address
}

export type ScanParams = {
  tokens: Address[]
  minNetProfit?: bigint
}

export type WatchArbOptions = {
  onCandidates: (opps: Opportunity[]) => void
  onError?: (error: unknown) => void
  minNetProfit?: bigint
  lookbackBlocks?: bigint
  pollMs?: number
}

export interface CovenArbClient {
  publicClient: PublicClient
  scan(params: ScanParams): Promise<Opportunity[]>
  watch(options: WatchArbOptions): () => void
  simulate(plan: Plan, caller: Address): Promise<{ profit: bigint; asOfBlock: bigint }>
  execute(opts: { wallet: WalletClient; plan: Plan }): Promise<Hex>
}

export function createCovenArb(config: CovenArbConfig): CovenArbClient {
  const client = createPublicClient({ chain: arc, transport: config.transport, batch: { multicall: true } })
  const ctx = createContext({ arcTransport: config.transport })
  const tokens = createTokenRegistry(ctx)
  const pools = createPoolWatcher(ctx, tokens)
  const arbAddress = config.arb ?? COVEN_ARB

  async function solveOptions(): Promise<SolveOptions> {
    return { gasPriceWei: await client.getGasPrice() }
  }

  async function scan(params: ScanParams): Promise<Opportunity[]> {
    const opts = await solveOptions()
    const out: Opportunity[] = []
    for (const token of params.tokens) {
      const p = await poolsForToken(client, token)
      if (p.length < 2) continue
      const opp = solveToken(token, p, opts)
      if (opp && opp.netProfit >= (params.minNetProfit ?? 0n)) out.push(opp)
    }
    return out.sort((a, b) => (b.netProfit > a.netProfit ? 1 : -1))
  }

  function watch(options: WatchArbOptions): () => void {
    const usdc = '0x3600000000000000000000000000000000000000'.toLowerCase()
    const seen = new Set<string>()
    const watchOptions: WatchPoolsOptions = {
      lookbackBlocks: options.lookbackBlocks,
      pollMs: options.pollMs,
      onError: options.onError,
      onPools: (discovered) => {
        const targets = new Set<Address>()
        for (const p of discovered) {
          if (p.token0.toLowerCase() === usdc) targets.add(p.token1)
          else if (p.token1.toLowerCase() === usdc) targets.add(p.token0)
        }
        void (async () => {
          try {
            const opts = await solveOptions()
            const opps: Opportunity[] = []
            for (const token of targets) {
              const key = token.toLowerCase()
              const pool = await poolsForToken(client, token)
              if (pool.length < 2) continue
              const opp = solveToken(token, pool, opts)
              if (opp && opp.netProfit >= (options.minNetProfit ?? 0n)) {
                seen.add(key)
                opps.push(opp)
              }
            }
            if (opps.length > 0) options.onCandidates(opps)
          } catch (e) {
            options.onError?.(e)
          }
        })()
      },
    }
    return pools.watch(watchOptions)
  }

  return {
    publicClient: client,
    scan,
    watch,
    simulate: (plan: Plan, caller: Address) => simulatePlan(client, arbAddress, plan, caller),
    execute: (opts: { wallet: WalletClient; plan: Plan }) => executePlan(opts.wallet, arbAddress, opts.plan),
  }
}
