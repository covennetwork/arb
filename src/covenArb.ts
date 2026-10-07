import {
  type Address,
  type Hex,
  type PublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  zeroAddress,
} from 'viem'
import { covenArbAbi, multicall3Abi } from './abis.js'
import { COVEN_ARB, MULTICALL3, USDC } from './constants.js'
import type { Cycle } from './cycles.js'
import { type PoolKey, keyOf } from './pools.js'

export const MIN_SQRT_PRICE = 4295128739n
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n
const UINT256_MAX = 2n ** 256n - 1n

export type Leg = {
  isV4: boolean
  pool: Address
  key: PoolKey
  zeroForOne: boolean
  amountIn: bigint
  sqrtLimit: bigint
  fee: number
  hookData: Hex
}

export type Plan = {
  legs: Leg[]
  profitToken: Address
  minProfit: bigint
  maxFeeBps: number
}

const EMPTY_KEY: PoolKey = { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }

// Only the first leg's amountIn is read; every later leg spends the previous leg's output.
// minProfit is the contract's own floor on profit after its fee.
export function buildPlan(c: Cycle, amountIn: bigint, minProfit: bigint, maxFeeBps: number): Plan {
  return {
    legs: c.legs.map((l, i) => ({
      isV4: l.pool.kind === 'v4',
      pool: l.pool.kind === 'v3' ? (l.pool.id as Address) : zeroAddress,
      key: l.pool.kind === 'v4' ? keyOf(l.pool) : EMPTY_KEY,
      zeroForOne: l.zeroForOne,
      amountIn: i === 0 ? amountIn : 0n,
      sqrtLimit: l.zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
      fee: l.pool.fee,
      hookData: '0x',
    })),
    profitToken: USDC,
    minProfit,
    maxFeeBps,
  }
}

export const encodeExecute = (plan: Plan): Hex => encodeFunctionData({ abi: covenArbAbi, functionName: 'execute', args: [plan] })

export type ProbeResult = { ok: true; profit: bigint } | { ok: false; reason: string }

export function decodeProbe(returnData: Hex): ProbeResult {
  try {
    const err = decodeErrorResult({ abi: covenArbAbi, data: returnData })
    const name: string = err.errorName
    const args = (err.args ?? []) as readonly unknown[]
    if (name === 'BelowMinProfit') return { ok: true, profit: args[0] as bigint }
    if (name === 'NoProfit') return { ok: false, reason: 'no profit' }
    // Error(string) from a pool or token, e.g. "TF" when a transfer fails.
    if (name === 'Error') return { ok: false, reason: String(args[0]) }
    return { ok: false, reason: name }
  } catch {
    return { ok: false, reason: returnData === '0x' ? 'reverted' : `revert ${returnData.slice(0, 10)}` }
  }
}

export type ProbeRequest = { cycle: Cycle; amountIn: bigint }

// The contract is its own exact quoter: a plan whose minProfit can never be met reverts with
// BelowMinProfit(profit, ...) when profitable and NoProfit otherwise. That accounts for every
// tick crossing, hook and fee, including CovenArb's own cut. Many plans go through Multicall3
// in a single eth_call.
export async function probe(
  client: PublicClient,
  requests: ProbeRequest[],
  opts: { maxFeeBps: number; arb?: Address; blockNumber?: bigint; chunk?: number },
): Promise<ProbeResult[]> {
  const arb = opts.arb ?? COVEN_ARB
  const chunk = opts.chunk ?? 48
  const chunks: ProbeRequest[][] = []
  for (let i = 0; i < requests.length; i += chunk) chunks.push(requests.slice(i, i + chunk))
  const results = await Promise.all(
    chunks.map(async (part) => {
      const calls = part.map((r) => ({
        target: arb,
        allowFailure: true,
        callData: encodeExecute(buildPlan(r.cycle, r.amountIn, UINT256_MAX, opts.maxFeeBps)),
      }))
      const { data } = await client.call({
        to: MULTICALL3,
        data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }),
        blockNumber: opts.blockNumber,
      })
      if (!data) throw new Error('multicall returned no data')
      return decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data }).map(
        (r): ProbeResult => (r.success ? { ok: false, reason: 'unexpected success' } : decodeProbe(r.returnData)),
      )
    }),
  )
  return results.flat()
}

export async function readArbConfig(client: PublicClient, arb: Address = COVEN_ARB) {
  const [feeBps, feeRecipient] = await Promise.all([
    client.readContract({ address: arb, abi: covenArbAbi, functionName: 'feeBps' }),
    client.readContract({ address: arb, abi: covenArbAbi, functionName: 'feeRecipient' }),
  ])
  return { feeBps: Number(feeBps), feeRecipient }
}
