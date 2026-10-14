import { parseAbi, parseAbiItem } from 'viem'

export const v3SwapEvent = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)
export const v3MintEvent = parseAbiItem(
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
)
export const v3BurnEvent = parseAbiItem(
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
)
export const v3PoolCreatedEvent = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
)
export const v4SwapEvent = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
)
export const v4ModifyLiquidityEvent = parseAbiItem(
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
)
export const v4InitializeEvent = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
)
export const erc20TransferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

// Everything the live loop listens to, in one eth_getLogs.
export const marketEvents = [
  v3SwapEvent,
  v3MintEvent,
  v3BurnEvent,
  v3PoolCreatedEvent,
  v4SwapEvent,
  v4ModifyLiquidityEvent,
  v4InitializeEvent,
] as const

export const v3PoolAbi = parseAbi([
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  // Only the fields every v3-style variant shares: Slipstream clones return fewer after them.
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
])

export const v3FactoryAbi = parseAbi(['function getPool(address, address, uint24) view returns (address)'])

export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
])

export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])

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
  'error InvalidPlan()',
  'error ZeroMinProfit()',
])

export const covenProbeAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Leg { bool v4; bool zeroForOne; uint24 feePips; address pool; address tokenIn; address tokenOut; PoolKey key; bytes hookData; }',
  'struct Gate { address target; bytes data; uint256 word; uint256 min; }',
  'struct Route { Leg[] legs; uint256 amountIn; uint256 minProfit; bool sized; bool firstAtPrice; bool check; Gate gate; }',
  'function probe(Route[] routes, uint16 maxFeeBps) returns (uint256[] profits)',
  'function feeBps() view returns (uint16)',
  'function feeRecipient() view returns (address)',
  'event Executed(address indexed caller, uint256 indexed route, uint256 profit, uint256 fee)',
  'error FeeAbovePlanLimit(uint16 feeBps, uint16 maxFeeBps)',
])

// Fair-launch hooks keep the swap fees they collect per pool and sell them to the next swapper.
export const fairLaunchHookAbi = parseAbi([
  'function poolFees((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint256 fees0, uint256 fees1)',
])
