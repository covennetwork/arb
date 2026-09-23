import type { Address } from 'viem'
import { COVEN_ARB as CORE_COVEN_ARB } from '@covennetwork/core'

// Arc mainnet, deployed 2026-09-23 with a 10% fee on realized profit. Callers may still
// pass `arb` explicitly to createCovenArb to point at a different deployment.
export const COVEN_ARB: Address = CORE_COVEN_ARB
