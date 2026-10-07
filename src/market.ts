import { type Address, type Hex, type Log, type PublicClient, getAddress, parseAbi } from 'viem'
import { marketEvents } from './abis.js'
import { POOL_MANAGER, USDC, V3_FACTORY } from './constants.js'
import { type Cycle, type Screened, enumerateCycles, indexByPool, screen } from './cycles.js'
import { introspectV3, poolFromCreationLog, probeSiblings, recoverV4Key } from './discovery.js'
import { type Pool, type PoolRegistry, type PoolState, isHooked } from './pools.js'
import { type Rpc, getLogsChunked } from './rpc.js'
import { fetchStates, stateFromSwap } from './state.js'

const lc = (a: string) => a.toLowerCase() as Address
const PM = lc(POOL_MANAGER)
const FACTORY = lc(V3_FACTORY)

type MarketLog = Log & { eventName: string; args: Record<string, unknown> }

export type MarketStats = { pools: number; cycles: number; tracked: number; unresolved: number }

// Everything known about the market: pools, their live state, and the arbitrage cycles
// through them. Fed by one eth_getLogs per block.
export class Market {
  states = new Map<Hex, PoolState>()
  cycles: Cycle[] = []
  private byPool = new Map<Hex, Cycle[]>()
  private symbols = new Map<Address, string>()
  private unknownV3 = new Set<Address>()
  private unknownV4 = new Map<Hex, { tx: Hex; fee: number }>()
  private needsRefresh = new Set<Hex>()
  private newTokens = new Set<Address>()

  constructor(
    readonly rpc: Rpc,
    readonly reg: PoolRegistry,
  ) {
    this.rebuildCycles()
  }

  get client(): PublicClient {
    return this.rpc.client
  }

  stats(): MarketStats {
    return {
      pools: this.reg.size,
      cycles: this.cycles.length,
      tracked: this.byPool.size,
      unresolved: this.unknownV3.size + this.unknownV4.size,
    }
  }

  // Bring the registry and state up to `head`: replay recent market events to find the
  // active pools, resolve them, probe their sibling venues and read every relevant state.
  async bootstrap(head: bigint, lookback: bigint, progress?: (msg: string) => void): Promise<void> {
    const synced = this.reg.syncedTo
    const from = synced !== undefined && head - synced < lookback ? synced + 1n : head - lookback + 1n
    progress?.(`reading market events for blocks ${from}..${head}`)
    const active = new Set<Hex>()
    await getLogsChunked(this.client, { events: marketEvents, fromBlock: from, toBlock: head }, (logs) => {
      for (const id of this.applyLogs(logs)) active.add(id)
    })
    this.reg.syncedTo = head
    this.reg.markDirty()
    // Tokens that traded recently get their sibling venues re-checked: new pools for them
    // may have appeared since the last run.
    for (const id of active) {
      const p = this.reg.get(id)
      if (p) this.newTokens.add(p.token0).add(p.token1)
    }
    progress?.(`resolving ${this.unknownV3.size} v3 and ${this.unknownV4.size} v4 pools seen trading`)
    await this.resolveUnknown(Number.POSITIVE_INFINITY)
    progress?.(`reading state for ${this.byPool.size} pools`)
    await this.refreshAll(head)
    this.reg.save()
  }

  // Apply one batch of logs. Returns the pools whose price moved.
  applyLogs(logs: Log[]): Set<Hex> {
    const touched = new Set<Hex>()
    for (const raw of logs) {
      const log = raw as MarketLog
      const addr = lc(log.address)
      const block = log.blockNumber ?? 0n
      switch (log.eventName) {
        case 'PoolCreated':
        case 'Initialize': {
          if (log.eventName === 'PoolCreated' && addr !== FACTORY) break
          if (log.eventName === 'Initialize' && addr !== PM) break
          const p = poolFromCreationLog(log)
          if (p && this.reg.add(p)) {
            this.newTokens.add(p.token0)
            this.newTokens.add(p.token1)
          }
          break
        }
        case 'Swap': {
          if ('id' in log.args) {
            if (addr !== PM) break
            const id = lc(log.args.id as string) as Hex
            const pool = this.reg.get(id)
            if (!pool) {
              if (!this.reg.isUnresolvable(id) && log.transactionHash) {
                this.unknownV4.set(id, { tx: log.transactionHash, fee: Number(log.args.fee) })
              }
              break
            }
            const a = log.args as { sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number }
            this.states.set(id, stateFromSwap(pool, a, block, this.states.get(id)))
            touched.add(id)
          } else {
            const pool = this.reg.get(addr)
            if (!pool) {
              if (!this.reg.isUnresolvable(addr)) this.unknownV3.add(addr)
              break
            }
            const a = log.args as { sqrtPriceX96: bigint; liquidity: bigint; tick: number }
            this.states.set(pool.id, stateFromSwap(pool, a, block))
            touched.add(pool.id)
          }
          break
        }
        case 'Mint':
        case 'Burn':
          if (this.byPool.has(addr)) this.needsRefresh.add(addr)
          break
        case 'ModifyLiquidity': {
          if (addr !== PM) break
          const id = lc(log.args.id as string) as Hex
          if (this.byPool.has(id)) this.needsRefresh.add(id)
          break
        }
      }
    }
    return touched
  }

  // Read fresh state for pools whose liquidity changed. Returns them as touched.
  async refreshChanged(block: bigint): Promise<Set<Hex>> {
    const ids = [...this.needsRefresh]
    this.needsRefresh.clear()
    const pools = ids.map((id) => this.reg.get(id)).filter((p): p is Pool => !!p)
    const fresh = await fetchStates(this.client, pools, block)
    for (const [id, s] of fresh) this.states.set(id, s)
    return new Set(fresh.keys())
  }

  async refreshAll(block: bigint): Promise<void> {
    const pools = [...this.byPool.keys()].map((id) => this.reg.get(id)).filter((p): p is Pool => !!p)
    const fresh = await fetchStates(this.client, pools, block)
    for (const [id, s] of fresh) this.states.set(id, s)
  }

  // Turn unknown pools seen in swaps into registry entries, then look for sibling venues of
  // any new token. `budget` caps v4 key recoveries (one receipt fetch each) per call.
  // Returns the number of pools added.
  async resolveUnknown(budget = 6): Promise<number> {
    let added = 0
    if (this.unknownV3.size > 0) {
      const addrs = [...this.unknownV3]
      this.unknownV3.clear()
      const pools = await introspectV3(this.client, addrs.map((a) => getAddress(a)))
      const ok = new Set(pools.map((p) => p.id))
      for (const a of addrs) if (!ok.has(a)) this.reg.markUnresolvable(a)
      for (const p of pools) added += this.addPool(p)
    }
    const v4 = [...this.unknownV4].slice(0, budget === Number.POSITIVE_INFINITY ? undefined : budget)
    const hookUse = new Map<Address, number>()
    for (const p of this.reg.all()) if (isHooked(p)) hookUse.set(p.hooks, (hookUse.get(p.hooks) ?? 0) + 1)
    const sharedHooks = [...hookUse].filter(([, n]) => n > 1).map(([h]) => h)
    const spacings = new Set(this.reg.all().map((p) => p.tickSpacing))
    for (let i = 0; i < v4.length; i += 8) {
      await Promise.all(
        v4.slice(i, i + 8).map(async ([id, { tx, fee }]) => {
          this.unknownV4.delete(id)
          const p = await recoverV4Key(this.client, id, tx, { fee, sharedHooks, spacings }).catch(() => undefined)
          if (p) added += this.addPool(p)
          else if (p === null) this.reg.markUnresolvable(id)
        }),
      )
    }
    if (this.newTokens.size > 0) {
      const tokens = [...this.newTokens].filter((t) => t !== lc(USDC))
      this.newTokens.clear()
      for (let i = 0; i < tokens.length; i += 100) {
        const found = await probeSiblings(this.client, this.reg, tokens.slice(i, i + 100))
        for (const p of found) if (this.reg.add(p)) added++
      }
    }
    if (added > 0) {
      const before = new Set(this.byPool.keys())
      this.rebuildCycles()
      const fresh = [...this.byPool.keys()].filter((id) => !before.has(id) || !this.states.has(id))
      const pools = fresh.map((id) => this.reg.get(id)).filter((p): p is Pool => !!p)
      for (const [id, s] of await fetchStates(this.client, pools)) this.states.set(id, s)
      this.reg.save()
    }
    return added
  }

  private addPool(p: Pool): number {
    if (!this.reg.add(p)) return 0
    this.newTokens.add(p.token0)
    this.newTokens.add(p.token1)
    return 1
  }

  rebuildCycles(): void {
    this.cycles = enumerateCycles(this.reg)
    this.byPool = indexByPool(this.cycles)
  }

  cyclesThrough(ids: Iterable<Hex>): Cycle[] {
    const seen = new Set<string>()
    const out: Cycle[] = []
    for (const id of ids) {
      for (const c of this.byPool.get(id) ?? []) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        out.push(c)
      }
    }
    return out
  }

  screen(cycles: Cycle[], floorBps: (c: Cycle) => number = () => 0): Screened[] {
    const out: Screened[] = []
    for (const c of cycles) {
      const s = screen(c, this.states, floorBps(c))
      if (s) out.push(s)
    }
    return out.sort((a, b) => (b.seedProfit > a.seedProfit ? 1 : b.seedProfit < a.seedProfit ? -1 : 0))
  }

  async loadSymbols(tokens: Address[]): Promise<void> {
    const missing = tokens.filter((t) => !this.symbols.has(lc(t)))
    if (missing.length === 0) return
    const res = await this.client.multicall({
      allowFailure: true,
      contracts: missing.map((t) => ({ address: getAddress(t), abi: symbolAbi, functionName: 'symbol' }) as const),
    })
    missing.forEach((t, i) => {
      const r = res[i]
      const sym = r?.status === 'success' ? String(r.result).replace(/[^\x20-\x7e]/g, '').slice(0, 12) : ''
      this.symbols.set(lc(t), sym || `${t.slice(0, 6)}…${t.slice(-4)}`)
    })
  }

  symbol = (t: Address): string => this.symbols.get(lc(t)) ?? `${t.slice(0, 6)}…${t.slice(-4)}`
}

const symbolAbi = parseAbi(['function symbol() view returns (string)'])
