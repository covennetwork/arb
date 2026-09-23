// Gas is USDC on Arc. Native gas is 18-decimal wei; ERC-20 USDC is 6-decimal. So the
// USDC(6dp) cost of a transaction is gasUnits * gasPriceWei / 1e12. Verified against the
// measured fact that a 350k-gas revert costs ~0.007 USDC. Because gas is denominated in
// the profit token, netProfit is an exact subtraction, never an FX estimate.
export const WEI_PER_USDC6 = 1_000_000_000_000n
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n
export const ARB_GAS_ESTIMATE = 320_000n

export function gasToUsdc(gasUnits: bigint, gasPriceWei: bigint): bigint {
  return (gasUnits * gasPriceWei) / WEI_PER_USDC6
}
