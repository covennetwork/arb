import { type Address, type PublicClient, parseAbi } from 'viem'
import { COVEN_LENS, USDC } from '@covennetwork/core'
import type { ArbPool } from './solver.js'

const discoverAbi = parseAbi([
  'struct Pool { uint8 protocol; address token0; address token1; uint24 fee; int24 tickSpacing; address hooks; address pool; bytes32 poolId; uint128 liquidity; uint160 sqrtPriceX96; }',
  'function discoverPools(address[] tokens) view returns (Pool[])',
])

// Read every canonical-tier USDC pool for a token straight from CovenLens, with exact
// on-chain sqrtPrice and liquidity. The lens is the shared discovery/state asset; the
// solver never maintains its own pool index.
export async function poolsForToken(client: PublicClient, token: Address, usdc: Address = USDC): Promise<ArbPool[]> {
  const raw = await client.readContract({ address: COVEN_LENS, abi: discoverAbi, functionName: 'discoverPools', args: [[usdc, token]] })
  return raw
    .filter((p) => p.sqrtPriceX96 > 0n && p.liquidity > 0n)
    .map((p) => {
      const protocol = p.protocol === 0 ? 'v3' : 'v4'
      return {
        protocol: protocol as 'v3' | 'v4',
        sqrtPriceX96: p.sqrtPriceX96,
        liquidity: p.liquidity,
        fee: p.fee,
        token0: p.token0,
        token1: p.token1,
        tickSpacing: p.tickSpacing,
        hooks: p.hooks,
        id: protocol === 'v3' ? p.pool : (p.poolId as unknown as Address),
        poolKey:
          protocol === 'v4'
            ? { currency0: p.token0, currency1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks }
            : undefined,
      }
    })
}
