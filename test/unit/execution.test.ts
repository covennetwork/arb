import { type Hex, encodeErrorResult, parseGwei, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { covenArbAbi } from '../../src/abis.js'
import { USDC } from '../../src/constants.js'
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, buildPlan, decodeProbe } from '../../src/covenArb.js'
import type { Cycle } from '../../src/cycles.js'
import { v4Pool } from '../../src/pools.js'
import { EdgeFloors, priorityFeeFor } from '../../src/strategy.js'

const TOKEN = '0x9999999999999999999999999999999999999999'
const usdc = USDC.toLowerCase() as `0x${string}`

const cycle: Cycle = {
  id: 'test',
  hooked: 0,
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

describe('priority fee bidding', () => {
  const policy = { baseFee: parseGwei('20'), minPriorityFee: parseGwei('1'), bidBps: 2000 }

  it('spends the bid share of profit across the gas', () => {
    // 0.10 USDC profit, 20% bid = 0.02 USDC over 200k gas = 100 gwei
    expect(priorityFeeFor(100_000n, 200_000n, policy)).toBe(parseGwei('100'))
  })

  it('never bids below the floor', () => {
    expect(priorityFeeFor(1n, 200_000n, policy)).toBe(parseGwei('1'))
    expect(priorityFeeFor(100_000n, 200_000n, { ...policy, bidBps: 0 })).toBe(parseGwei('1'))
  })
})

describe('edge floors', () => {
  it('suppresses a failed cycle until its edge clearly improves', () => {
    const f = new EdgeFloors(5, 60_000)
    expect(f.get(cycle)).toBe(0)
    f.fail(cycle, 100)
    expect(f.get(cycle)).toBeCloseTo(110)
    f.clear(cycle)
    expect(f.get(cycle)).toBe(0)
  })

  it('expires', () => {
    const f = new EdgeFloors(5, -1)
    f.fail(cycle, 100)
    expect(f.get(cycle)).toBe(0)
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
