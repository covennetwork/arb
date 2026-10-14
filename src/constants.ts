import { type Address, zeroAddress } from 'viem'
import { COVEN_ARB, EURC, POOL_MANAGER, STATE_VIEW, USDC, V3_FACTORY, arc } from '@covennetwork/core'

export { COVEN_ARB, EURC, POOL_MANAGER, STATE_VIEW, USDC, V3_FACTORY, arc }

export const CHAIN_ID = arc.id

// The arbitrage contract the bot trades through: checks each route against live state, sizes
// on-chain and pays the caller the profit less a 10% fee. COVEN_ARB is its deprecated
// predecessor, kept for library users.
export const COVEN_PROBE: Address = '0x179606809c8611BebFAC04357f0B4E0Fb8b6479E'

// Factories whose pools trade through the Uniswap v3 swap interface: Uniswap v3 itself,
// Synthra V3 (its own callback name) and Slipstream-style CL clones. CovenProbe handles all
// of them; discovery accepts pools only from these.
export const V3_FACTORIES: Address[] = [
  V3_FACTORY,
  '0x6307fc239C7964942c1BfFE51930E55606619c74', // Synthra V3
  '0x84169F9aDF4F5F0e483BfC350498a85b1d7eC638', // Synthra V3
  '0xb89Df768aF2CFE637ceB352c587Fe8edAf491d03', // Slipstream-style CL
  '0xC481038C013FE96F38CE7A2dC417b2B1B78b16A4', // Slipstream-style CL
  '0xaa5865dC3A60b25D305226d66fd573021f0D8fFB', // Slipstream-style CL
]
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

// Native USDC (18 decimals) as a v4 currency. On Arc it is the same balance as the ERC-20
// (6 decimals); CovenProbe settles a cycle that starts in one and ends in the other.
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

// Gas of a CovenProbe trade, from 45 replayed and 141 shadowed trades on Arc: two v4 legs
// ~200-240k, two v3-style legs 270-460k, three v3-style legs 330-700k, a fair-launch hook
// payout ~505k. Deliberately on the high side: a send must pay for itself.
export function gasEstimate(legs: number, hookedLegs: number, v3Legs = legs): bigint {
  return 90_000n + 70_000n * BigInt(legs - v3Legs) + 150_000n * BigInt(v3Legs) + 120_000n * BigInt(hookedLegs)
}

// Unused gas is not charged, but the node requires gas limit x max fee up front.
export const gasLimitFor = (legs: number, hookedLegs: number, v3Legs = legs) => (gasEstimate(legs, hookedLegs, v3Legs) * 15n) / 10n + 50_000n

// Gas a send burns when its gap is already gone: CovenProbe's check skips the trade (~60k).
export const MISS_GAS = 65_000n
