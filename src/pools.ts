import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Address, type Hex, keccak256, zeroAddress } from 'viem'
import { CHAIN_ID, NATIVE } from './constants.js'

export type PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export type Pool = {
  kind: 'v3' | 'v4'
  // v3: pool address. v4: pool id.
  id: Hex
  token0: Address
  token1: Address
  // v3 fee tier, or the v4 key fee (0x800000 marks a dynamic-fee pool).
  fee: number
  tickSpacing: number
  hooks: Address
}

export type PoolState = {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  // Fee actually charged now, in millionths. Differs from `fee` for dynamic-fee v4 pools.
  lpFee: number
  block: bigint
}

export const DYNAMIC_FEE = 0x800000

const lc = (a: string) => a.toLowerCase() as Address

export function keyOf(p: Pool): PoolKey {
  return { currency0: p.token0, currency1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks }
}

const word = (x: bigint | number | string) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, '0')

// keccak256(abi.encode(PoolKey)), done by hand because key recovery hashes thousands of candidates.
export function v4PoolId(k: PoolKey): Hex {
  return keccak256(`0x${word(k.currency0)}${word(k.currency1)}${word(k.fee)}${word(k.tickSpacing)}${word(k.hooks)}`)
}

export function v4Pool(k: PoolKey): Pool {
  return {
    kind: 'v4',
    id: v4PoolId(k),
    token0: lc(k.currency0),
    token1: lc(k.currency1),
    fee: k.fee,
    tickSpacing: k.tickSpacing,
    hooks: lc(k.hooks),
  }
}

export const isHooked = (p: Pool) => p.kind === 'v4' && p.hooks !== zeroAddress
export const isNative = (p: Pool) => p.token0 === NATIVE || p.token1 === NATIVE
export const otherToken = (p: Pool, t: Address) => (lc(t) === p.token0 ? p.token1 : p.token0)

export function describePool(p: Pool): string {
  const fee = p.fee === DYNAMIC_FEE ? 'dyn' : `${p.fee / 10_000}%`
  const hook = isHooked(p) ? `+hook ${p.hooks.slice(0, 8)}` : ''
  return `${p.kind} ${fee}${hook ? ' ' + hook : ''}`
}

type CacheFile = {
  version: 1
  chainId: number
  pools: Pool[]
  // Block range covered by a full Initialize/PoolCreated backfill (`coven-arb index`).
  indexedFrom?: string
  indexedTo?: string
  // Last block whose events were applied by scan/run.
  syncedTo?: string
  // Swap emitters that are not canonical pools, or v4 ids whose key could not be recovered.
  unresolvable?: string[]
}

export function defaultCachePath(): string {
  const dir = process.env.COVEN_ARB_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'coven-arb')
  return join(dir, `pools-${CHAIN_ID}.json`)
}

// Every pool the bot knows about, persisted between runs. Pools are only ever added:
// a pool that dies just stops showing liquidity.
export class PoolRegistry {
  private pools = new Map<Hex, Pool>()
  private byToken = new Map<Address, Pool[]>()
  indexedFrom?: bigint
  indexedTo?: bigint
  syncedTo?: bigint
  private unresolvable = new Set<string>()
  private dirty = false

  constructor(readonly path?: string) {}

  static load(path = defaultCachePath()): PoolRegistry {
    const reg = new PoolRegistry(path)
    let file: CacheFile
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as CacheFile
    } catch {
      return reg
    }
    if (file.version !== 1 || file.chainId !== CHAIN_ID) return reg
    for (const p of file.pools) reg.add(p)
    reg.indexedFrom = file.indexedFrom ? BigInt(file.indexedFrom) : undefined
    reg.indexedTo = file.indexedTo ? BigInt(file.indexedTo) : undefined
    reg.syncedTo = file.syncedTo ? BigInt(file.syncedTo) : undefined
    reg.unresolvable = new Set(file.unresolvable ?? [])
    reg.dirty = false
    return reg
  }

  save(): void {
    if (!this.path || !this.dirty) return
    const file: CacheFile = {
      version: 1,
      chainId: CHAIN_ID,
      pools: [...this.pools.values()],
      indexedFrom: this.indexedFrom?.toString(),
      indexedTo: this.indexedTo?.toString(),
      syncedTo: this.syncedTo?.toString(),
      unresolvable: [...this.unresolvable],
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(file))
    renameSync(tmp, this.path)
    this.dirty = false
  }

  markDirty(): void {
    this.dirty = true
  }

  add(p: Pool): boolean {
    const pool: Pool = { ...p, id: lc(p.id) as Hex, token0: lc(p.token0), token1: lc(p.token1), hooks: lc(p.hooks) }
    if (this.pools.has(pool.id)) return false
    this.pools.set(pool.id, pool)
    for (const t of [pool.token0, pool.token1]) {
      const list = this.byToken.get(t)
      if (list) list.push(pool)
      else this.byToken.set(t, [pool])
    }
    this.dirty = true
    return true
  }

  markUnresolvable(id: string): void {
    this.unresolvable.add(lc(id))
    this.dirty = true
  }

  isUnresolvable(id: string): boolean {
    return this.unresolvable.has(lc(id))
  }

  get(id: Hex): Pool | undefined {
    return this.pools.get(lc(id) as Hex)
  }

  has(id: Hex): boolean {
    return this.pools.has(lc(id) as Hex)
  }

  poolsOf(token: Address): Pool[] {
    return this.byToken.get(lc(token)) ?? []
  }

  between(a: Address, b: Address): Pool[] {
    const bl = lc(b)
    return this.poolsOf(a).filter((p) => p.token0 === bl || p.token1 === bl)
  }

  tokens(): Address[] {
    return [...this.byToken.keys()]
  }

  all(): Pool[] {
    return [...this.pools.values()]
  }

  get size(): number {
    return this.pools.size
  }
}
