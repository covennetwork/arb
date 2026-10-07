import { type Address, zeroAddress } from 'viem'
import { COVEN_ARB, EURC, POOL_MANAGER, STATE_VIEW, USDC, V3_FACTORY, arc } from '@covennetwork/core'

export { COVEN_ARB, EURC, POOL_MANAGER, STATE_VIEW, USDC, V3_FACTORY, arc }

export const CHAIN_ID = arc.id
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

// Native USDC (18 decimals) as a v4 currency. CovenArb's handling of a cycle that mixes
// native and ERC-20 USDC is unverified, so native-quoted pools are indexed but never routed.
export const NATIVE: Address = zeroAddress

// The public endpoints that serve eth_getLogs. dRPC's free tier rejects getLogs outright,
// so it is not a default.
export const DEFAULT_RPCS = [
  'https://rpc.mainnet.arc.io',
  'https://rpc.quicknode.mainnet.arc.io',
  'https://rpc.blockdaemon.mainnet.arc.io',
]

// First block with Uniswap contracts on Arc; nothing before it is worth indexing.
export const DEX_GENESIS_BLOCK = 1_948_019n

// Gas is paid in native USDC (18 decimals); USDC amounts are 6 decimals.
export const WEI_PER_USDC = 1_000_000_000_000n
// Transactions with maxFeePerGas below this are silently dropped by the mempool.
export const MIN_GAS_PRICE = 20_000_000_000n

export const gasToUsdc = (gas: bigint, priceWei: bigint) => (gas * priceWei) / WEI_PER_USDC

// Measured: a two-leg v3/v4 cycle uses ~277k gas. Hooks add their own cost.
export function gasEstimate(legs: number, hookedLegs: number): bigint {
  return 100_000n + 90_000n * BigInt(legs) + 60_000n * BigInt(hookedLegs)
}

// Generous limit: unused gas is not charged, and running out is a wasted revert.
export const gasLimitFor = (legs: number, hookedLegs: number) => (gasEstimate(legs, hookedLegs) * 2n) + 100_000n
