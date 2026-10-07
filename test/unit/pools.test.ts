import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, encodeAbiParameters, keccak256, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { USDC } from '../../src/constants.js'
import { enumerateCycles, indexByPool, screen } from '../../src/cycles.js'
import { keyTailsInCalldata } from '../../src/discovery.js'
import { type Pool, PoolRegistry, v4Pool, v4PoolId } from '../../src/pools.js'

const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1' as Address
const TOKEN = '0x9999999999999999999999999999999999999999' as Address
const OTHER = '0x5555555555555555555555555555555555555555' as Address
const usdc = USDC.toLowerCase() as Address

let n = 0
function v3(a: Address, b: Address, fee = 3000): Pool {
  const [token0, token1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
  n++
  return { kind: 'v3', id: `0x${n.toString(16).padStart(40, '0')}`, token0, token1, fee, tickSpacing: 60, hooks: zeroAddress }
}

describe('v4 pool ids', () => {
  it('matches the on-chain id of the USDC/EURC 0.05% pool', () => {
    const id = v4PoolId({ currency0: USDC, currency1: EURC, fee: 500, tickSpacing: 10, hooks: zeroAddress })
    expect(id).toBe('0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae')
  })

  it('agrees with abi.encode for negative-looking and hooked keys', () => {
    const key = { currency0: USDC, currency1: TOKEN, fee: 0x800000, tickSpacing: 200, hooks: '0x02e0be21eb7afae852bd3866afa7a360a72a2044' as Address }
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      ),
    )
    expect(v4PoolId(key)).toBe(expected)
  })
})

describe('calldata key hints', () => {
  it('finds a PoolKey tail at any 4-byte alignment', () => {
    const hooks = '0x02e0be21eb7afae852bd3866afa7a360a72a2044' as Address
    const words = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [USDC, TOKEN, 10000, 200, hooks],
    )
    // nested inside some outer call: selector + padding shifts alignment by 4
    const data = `0xdeadbeef${'00'.repeat(36)}${words.slice(2)}` as `0x${string}`
    const tails = keyTailsInCalldata(data)
    expect(tails).toContainEqual({ fee: 10000, tickSpacing: 200, hooks })
  })
})

describe('cycles', () => {
  it('enumerates both directions of every two-pool pair and three-leg loops', () => {
    const reg = new PoolRegistry()
    const a = v3(usdc, TOKEN, 3000)
    const b = v3(usdc, TOKEN, 10000)
    const c = v3(TOKEN, EURC, 3000)
    const d = v3(usdc, EURC, 500)
    for (const p of [a, b, c, d]) reg.add(p)
    const cycles = enumerateCycles(reg)
    const two = cycles.filter((x) => x.legs.length === 2)
    const three = cycles.filter((x) => x.legs.length === 3)
    expect(two.length).toBe(2) // a->b, b->a
    // USDC>TOKEN>EURC>USDC via (a|b, c, d) and reversed via (d, c, a|b)
    expect(three.length).toBe(4)
    for (const cyc of cycles) {
      expect(cyc.legs[0]!.tokenIn).toBe(usdc)
      expect(cyc.legs.at(-1)!.tokenOut).toBe(usdc)
      for (let i = 1; i < cyc.legs.length; i++) expect(cyc.legs[i]!.tokenIn).toBe(cyc.legs[i - 1]!.tokenOut)
    }
    expect(indexByPool(cycles).get(c.id)!.length).toBe(4)
  })

  it('leaves native-quoted pools out', () => {
    const reg = new PoolRegistry()
    reg.add(v3(usdc, TOKEN))
    reg.add(v4Pool({ currency0: zeroAddress, currency1: TOKEN, fee: 2500, tickSpacing: 50, hooks: zeroAddress }))
    expect(enumerateCycles(reg)).toHaveLength(0)
  })

  it('screens a mispriced pair and ignores a fair one', () => {
    const reg = new PoolRegistry()
    const a = v3(usdc, OTHER)
    const b = v3(usdc, OTHER)
    reg.add(a)
    reg.add(b)
    const Q96 = 2n ** 96n
    const st = (price: number) => ({ sqrtPriceX96: BigInt(Math.floor(Math.sqrt(price) * Number(Q96))), tick: 0, liquidity: 10n ** 15n, lpFee: 3000, block: 1n })
    const [ab, ba] = enumerateCycles(reg)
    const fair = new Map([[a.id, st(2)], [b.id, st(2)]])
    expect(screen(ab!, fair)).toBeNull()
    expect(screen(ba!, fair)).toBeNull()
    const skewed = new Map([[a.id, st(2)], [b.id, st(1.9)]])
    const hit = [ab!, ba!].map((c) => screen(c, skewed)).filter(Boolean)
    expect(hit).toHaveLength(1)
    expect(hit[0]!.seedProfit).toBeGreaterThan(0n)
  })
})

describe('registry persistence', () => {
  it('round-trips pools, coverage and unresolvable ids', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'coven-arb-')), 'pools.json')
    const reg = new PoolRegistry(path)
    reg.add(v3(usdc, TOKEN))
    reg.add(v4Pool({ currency0: USDC, currency1: EURC, fee: 500, tickSpacing: 10, hooks: zeroAddress }))
    reg.indexedFrom = 100n
    reg.indexedTo = 200n
    reg.syncedTo = 300n
    reg.markUnresolvable('0xABCDEF0000000000000000000000000000000000')
    reg.save()
    const back = PoolRegistry.load(path)
    expect(back.size).toBe(2)
    expect(back.indexedFrom).toBe(100n)
    expect(back.indexedTo).toBe(200n)
    expect(back.syncedTo).toBe(300n)
    expect(back.isUnresolvable('0xabcdef0000000000000000000000000000000000')).toBe(true)
    expect(back.between(USDC, EURC)).toHaveLength(1)
  })

  it('treats a missing or foreign cache as empty', () => {
    expect(PoolRegistry.load(join(tmpdir(), 'does-not-exist', 'x.json')).size).toBe(0)
  })
})
