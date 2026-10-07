import type { Abi, Address, Hex, PublicClient } from 'viem'
import { stateViewAbi, v3PoolAbi } from './abis.js'
import { STATE_VIEW } from './constants.js'
import { DYNAMIC_FEE, type Pool, type PoolState } from './pools.js'

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }

// Current price and in-range liquidity for a set of pools, in one multicall round.
export async function fetchStates(client: PublicClient, pools: Pool[], blockNumber?: bigint): Promise<Map<Hex, PoolState>> {
  const out = new Map<Hex, PoolState>()
  if (pools.length === 0) return out
  const block = blockNumber ?? (await client.getBlockNumber())
  const contracts = pools.flatMap<Call>((p) =>
    p.kind === 'v3'
      ? [
          { address: p.id, abi: v3PoolAbi, functionName: 'slot0' },
          { address: p.id, abi: v3PoolAbi, functionName: 'liquidity' },
        ]
      : [
          { address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [p.id] },
          { address: STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [p.id] },
        ],
  )
  const results = await client.multicall({ contracts, allowFailure: true, blockNumber: block })
  pools.forEach((p, i) => {
    const s0 = results[2 * i]
    const liq = results[2 * i + 1]
    if (s0?.status !== 'success' || liq?.status !== 'success') return
    const slot = s0.result as readonly [bigint, number, ...unknown[]]
    const lpFee = p.kind === 'v4' ? Number((s0.result as readonly [bigint, number, number, number])[3]) : p.fee
    out.set(p.id, { sqrtPriceX96: slot[0], tick: Number(slot[1]), liquidity: liq.result as bigint, lpFee, block })
  })
  return out
}

// Swap events carry the post-swap price, tick and in-range liquidity, so a swap updates
// state exactly without another read.
export function stateFromSwap(
  pool: Pool,
  args: { sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee?: number },
  block: bigint,
  prev?: PoolState,
): PoolState {
  const lpFee = pool.kind === 'v4' ? (args.fee ?? prev?.lpFee ?? (pool.fee === DYNAMIC_FEE ? 0 : pool.fee)) : pool.fee
  return { sqrtPriceX96: args.sqrtPriceX96, tick: args.tick, liquidity: args.liquidity, lpFee, block }
}
