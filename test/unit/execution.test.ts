import { type Hex, encodeErrorResult, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { covenArbAbi } from '../../src/abis.js'
import { USDC } from '../../src/constants.js'
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, buildPlan, decodeProbe, failFastLimit } from '../../src/covenArb.js'
import type { Cycle } from '../../src/cycles.js'
import { v4Pool } from '../../src/pools.js'
import { Backoff, EdgeFloors } from '../../src/strategy.js'

const TOKEN = '0x9999999999999999999999999999999999999999'
const usdc = USDC.toLowerCase() as `0x${string}`

const cycle: Cycle = {
  id: 'test',
  hooked: 0,
  v3: 1,
  legs: [
    {
      pool: { kind: 'v3', id: '0x1111111111111111111111111111111111111111', token0: usdc, token1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
      zeroForOne: true,
      tokenIn: usdc,
      tokenOut: TOKEN,
    },
    {
      pool: v4Pool({ currency0: USDC, currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks: zeroAddress }),
      zeroForOne: false,
      tokenIn: TOKEN,
      tokenOut: usdc,
    },
  ],
}

describe('plans', () => {
  it('sets the amount on the first leg only and routes by protocol', () => {
    const plan = buildPlan(cycle, 5_000_000n, 1n, 1000)
    expect(plan.profitToken).toBe(USDC)
    expect(plan.legs.map((l) => l.amountIn)).toEqual([5_000_000n, 0n])
    expect(plan.legs[0]!.isV4).toBe(false)
    expect(plan.legs[0]!.pool).toBe('0x1111111111111111111111111111111111111111')
    expect(plan.legs[0]!.key.currency0).toBe(zeroAddress)
    expect(plan.legs[1]!.isV4).toBe(true)
    expect(plan.legs[1]!.pool).toBe(zeroAddress)
    expect(plan.legs[1]!.key.fee).toBe(10000)
    expect(plan.legs[0]!.sqrtLimit).toBe(MIN_SQRT_PRICE + 1n)
    expect(plan.legs[1]!.sqrtLimit).toBe(MAX_SQRT_PRICE - 1n)
  })
})

describe('probe decoding', () => {
  const enc = (errorName: string, args?: readonly unknown[]) =>
    encodeErrorResult({ abi: covenArbAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0])

  it('reads the profit out of BelowMinProfit', () => {
    expect(decodeProbe(enc('BelowMinProfit', [12345n, 2n ** 256n - 1n]))).toEqual({ ok: true, profit: 12345n })
  })

  it('maps known failures to reasons', () => {
    expect(decodeProbe(enc('NoProfit'))).toEqual({ ok: false, reason: 'no profit' })
    expect(decodeProbe(enc('FeeAbovePlanLimit', [1500, 1000]))).toEqual({ ok: false, reason: 'FeeAbovePlanLimit' })
    // Error("TF") from a token transfer inside a pool
    const tf = '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002544600000000000000000000000000000000000000000000000000000000000000' as Hex
    expect(decodeProbe(tf)).toEqual({ ok: false, reason: 'TF' })
    expect(decodeProbe('0x')).toEqual({ ok: false, reason: 'reverted' })
    expect(decodeProbe('0x52671e5b')).toEqual({ ok: false, reason: 'revert 0x52671e5b' })
  })
})

describe('revert backoff', () => {
  it('doubles the pause with each consecutive loss and clears on a win', () => {
    const b = new Backoff(1_000, 10_000)
    b.lost(cycle.id, 0)
    expect(b.blocked(cycle.id, 999)).toBe(true)
    expect(b.blocked(cycle.id, 1_000)).toBe(false)
    b.lost(cycle.id, 1_000)
    expect(b.blocked(cycle.id, 2_999)).toBe(true)
    expect(b.blocked(cycle.id, 3_000)).toBe(false)
    for (let i = 0; i < 10; i++) b.lost(cycle.id, 3_000)
    expect(b.blocked(cycle.id, 12_999)).toBe(true)
    expect(b.blocked(cycle.id, 13_000)).toBe(false)
    b.won(cycle.id)
    expect(b.blocked(cycle.id, 3_001)).toBe(false)
  })
})

describe('fail-fast price limit', () => {
  const p = 2n ** 96n
  it('sits beyond the edge in the direction of the trade', () => {
    // 100 bps edge -> 125 bps of price -> 62.5 bps of sqrt price
    expect(failFastLimit(p, true, 100)).toBe((p * (1_000_000n - 6_250n)) / 1_000_000n)
    expect(failFastLimit(p, false, 100)).toBe((p * (1_000_000n + 6_250n)) / 1_000_000n)
  })

  it('stays inside the protocol bounds for huge edges', () => {
    expect(failFastLimit(MIN_SQRT_PRICE + 10n, true, 1e9)).toBe(MIN_SQRT_PRICE + 1n)
    expect(failFastLimit(MAX_SQRT_PRICE - 10n, false, 1e9)).toBe(MAX_SQRT_PRICE - 1n)
  })

  it('is applied to the first leg only', () => {
    const plan = buildPlan(cycle, 1n, 1n, 1000, 12345n)
    expect(plan.legs[0]!.sqrtLimit).toBe(12345n)
    expect(plan.legs[1]!.sqrtLimit).toBe(MAX_SQRT_PRICE - 1n)
  })
})

describe('edge floors', () => {
  it('suppresses a failed cycle until its edge clearly improves', () => {
    const f = new EdgeFloors(5, 60_000)
    expect(f.get(cycle.id)).toBe(0)
    f.fail(cycle.id, 100)
    expect(f.get(cycle.id)).toBeCloseTo(110)
    f.clear(cycle.id)
    expect(f.get(cycle.id)).toBe(0)
  })

  it('expires', () => {
    const f = new EdgeFloors(5, -1)
    f.fail(cycle.id, 100)
    expect(f.get(cycle.id)).toBe(0)
  })
})

describe('payout accounting', () => {
  it('counts the PoolManager take to the signer, nothing else', async () => {
    const { encodeAbiParameters, pad } = await import('viem')
    const { payoutTo } = await import('../../src/trader.js')
    const { POOL_MANAGER } = await import('../../src/constants.js')
    const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const signer = '0x00000000000000000000000000000000000000aa'
    const transfer = (token: string, from: string, to: string, value: bigint) => ({
      address: token,
      topics: [topic, pad(from as Hex), pad(to as Hex)],
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    })
    const receipt = {
      logs: [
        transfer(USDC, POOL_MANAGER, signer, 7_000n), // profit
        transfer(USDC, POOL_MANAGER, '0x00000000000000000000000000000000000000bb', 99n), // someone else
        transfer(TOKEN, POOL_MANAGER, signer, 5n), // not USDC
      ],
    } as unknown as import('viem').TransactionReceipt
    expect(payoutTo(receipt, signer)).toBe(7_000n)
  })
})

describe('CovenProbe routes', () => {
  it('sizes a two-leg cycle on-chain and maps each leg by protocol', async () => {
    const { cycleRoute } = await import('../../src/probe.js')
    const c = cycleRoute(cycle, 5_000_000n)
    const r = c.route
    expect(r.sized).toBe(true)
    expect(r.check).toBe(true)
    expect(r.amountIn).toBe(10n ** 12n) // a cap: the contract stops at the meeting price
    expect(r.legs[0]!.v4).toBe(false)
    expect(r.legs[0]!.pool).toBe('0x1111111111111111111111111111111111111111')
    expect(r.legs[0]!.feePips).toBe(3000)
    expect(r.legs[0]!.tokenIn).toBe(usdc)
    expect(r.legs[1]!.v4).toBe(true)
    expect(r.legs[1]!.key.fee).toBe(10000)
    expect(c.pools).toEqual(cycle.legs.map((l) => l.pool.id))
  })

  it('builds a gated hook payout route that buys at the price and sells back', async () => {
    const { payoutRoute } = await import('../../src/probe.js')
    const hook = '0xc780c0f4aac690908854d351b8bfda2812daefdc'
    const pool = v4Pool({ currency0: USDC, currency1: TOKEN, fee: 0, tickSpacing: 60, hooks: hook })
    const c = payoutRoute(pool)!
    expect(c.route.firstAtPrice).toBe(true)
    expect(c.route.check).toBe(false)
    expect(c.route.legs.map((l) => l.zeroForOne)).toEqual([true, false]) // USDC is currency0: buy, then sell
    expect(c.route.gate.target).toBe(hook)
    expect(c.route.gate.word).toBe(1n) // the token is currency1
    expect(payoutRoute(v4Pool({ currency0: USDC, currency1: TOKEN, fee: 0, tickSpacing: 60, hooks: zeroAddress }))).toBeUndefined()
  })

  it('reads profit and fee from Executed events for the caller only', async () => {
    const { encodeAbiParameters, encodeEventTopics } = await import('viem')
    const { covenProbeAbi } = await import('../../src/abis.js')
    const { executedFor } = await import('../../src/trader.js')
    const { COVEN_PROBE } = await import('../../src/constants.js')
    const me = '0x00000000000000000000000000000000000000aa'
    const ev = (caller: string, profit: bigint, fee: bigint, address = COVEN_PROBE) => ({
      address,
      topics: encodeEventTopics({ abi: covenProbeAbi, eventName: 'Executed', args: { caller: caller as Hex, route: 0n } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [profit, fee]),
    })
    const receipt = {
      logs: [ev(me, 900n, 100n), ev('0x00000000000000000000000000000000000000bb', 5n, 1n), ev(me, 7n, 7n, '0x0000000000000000000000000000000000000001')],
    } as unknown as import('viem').TransactionReceipt
    expect(executedFor(receipt, me)).toEqual({ profit: 900n, fee: 100n })
  })
})
