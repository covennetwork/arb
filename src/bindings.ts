import { type Address, type Hex, type PublicClient, type WalletClient, parseAbi, zeroAddress } from 'viem'
import { USDC } from '@covennetwork/core'

export const MIN_SQRT_PRICE = 4295128739n
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n

export const covenArbAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Leg { bool isV4; address pool; PoolKey key; bool zeroForOne; uint256 amountIn; uint160 sqrtLimit; uint24 fee; bytes hookData; }',
  'struct Plan { Leg[] legs; address profitToken; uint256 minProfit; uint16 maxFeeBps; }',
  'function execute(Plan plan) returns (uint256 profit)',
  'function feeBps() view returns (uint16)',
  'function feeRecipient() view returns (address)',
  'error BelowMinProfit(uint256 profit, uint256 minProfit)',
  'error FeeAbovePlanLimit(uint16 feeBps, uint16 maxFeeBps)',
  'error NoProfit()',
  'error UnexpectedCallback()',
])

export type PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

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

// The contract's own cap. A plan that names this accepts whatever the owner has set;
// name something lower to refuse a fee raised after the transaction was signed.
export const MAX_ARB_FEE_BPS = 2000

export const emptyKey = (): PoolKey => ({
  currency0: zeroAddress,
  currency1: zeroAddress,
  fee: 0,
  tickSpacing: 0,
  hooks: zeroAddress,
})

const limitFor = (zeroForOne: boolean) => (zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n)

export type PlanLegInput = {
  isV4: boolean
  pool: Address
  key?: PoolKey
  zeroForOne: boolean
  amountIn: bigint
  fee: number
  sqrtLimit?: bigint
}

export function buildPlan(
  legs: PlanLegInput[],
  minProfit: bigint,
  profitToken: Address = USDC,
  maxFeeBps: number = MAX_ARB_FEE_BPS,
): Plan {
  return {
    legs: legs.map((l) => ({
      isV4: l.isV4,
      pool: l.isV4 ? zeroAddress : l.pool,
      key: l.key ?? emptyKey(),
      zeroForOne: l.zeroForOne,
      amountIn: l.amountIn,
      sqrtLimit: l.sqrtLimit ?? limitFor(l.zeroForOne),
      fee: l.fee,
      hookData: '0x',
    })),
    profitToken,
    minProfit,
    maxFeeBps,
  }
}

export async function simulatePlan(client: PublicClient, arb: Address, plan: Plan, caller: Address) {
  const block = await client.getBlockNumber()
  const { result } = await client.simulateContract({
    address: arb,
    abi: covenArbAbi,
    functionName: 'execute',
    args: [plan],
    account: caller,
    blockNumber: block,
  })
  return { profit: result, asOfBlock: block }
}

export async function executePlan(wallet: WalletClient, arb: Address, plan: Plan): Promise<Hex> {
  const account = wallet.account
  if (!account) throw new Error('wallet has no account')
  return wallet.writeContract({
    address: arb,
    abi: covenArbAbi,
    functionName: 'execute',
    args: [plan],
    account,
    chain: wallet.chain,
  })
}
