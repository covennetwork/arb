// Deprecated: CovenArb (0xFFAEFEA0…) is superseded by CovenProbe (see probe.ts), which the CLI
// now trades through. These helpers stay exported for library users of 0.4 and will be
// removed in a later release.
import {
  type Address,
  type Hex,
  type PublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
} from 'viem'
import { covenArbAbi } from './abis.js'
import { COVEN_ARB, USDC } from './constants.js'
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

// Price limit for the first leg at the point where the cycle's edge would be used up. When
// another bot has already taken the opportunity, the pool's price is past it and the trade
// reverts at the first swap (PriceLimitAlreadyExceeded, ~50k gas) instead of after every
// leg (~200-340k). The limit sits 25% beyond the edge so it never cuts our own trade short.
/** @deprecated CovenArb is superseded by CovenProbe. */
export function failFastLimit(sqrtPriceX96: bigint, zeroForOne: boolean, edgeBps: number): bigint {
  const move = Math.min(0.9, (Math.max(edgeBps, 1) * 1.25) / 10_000) / 2
  const scale = 1_000_000n
  const f = BigInt(Math.round(move * 1e6))
  if (zeroForOne) {
    const lim = (sqrtPriceX96 * (scale - f)) / scale
    return lim > MIN_SQRT_PRICE ? lim : MIN_SQRT_PRICE + 1n
  }
  const lim = (sqrtPriceX96 * (scale + f)) / scale
  return lim < MAX_SQRT_PRICE ? lim : MAX_SQRT_PRICE - 1n
}

// Only the first leg's amountIn is read; every later leg spends the previous leg's output.
// minProfit is the contract's own floor on profit after its fee. firstLimit, when given,
// is the first leg's price limit (see failFastLimit); other legs trade to the extreme.
/** @deprecated CovenArb is superseded by CovenProbe. */
export function buildPlan(c: Cycle, amountIn: bigint, minProfit: bigint, maxFeeBps: number, firstLimit?: bigint): Plan {
  return {
    legs: c.legs.map((l, i) => ({
      isV4: l.pool.kind === 'v4',
      pool: l.pool.kind === 'v3' ? (l.pool.id as Address) : zeroAddress,
      key: l.pool.kind === 'v4' ? keyOf(l.pool) : EMPTY_KEY,
      zeroForOne: l.zeroForOne,
      amountIn: i === 0 ? amountIn : 0n,
      sqrtLimit: i === 0 && firstLimit !== undefined ? firstLimit : l.zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
      fee: l.pool.fee,
      hookData: '0x',
    })),
    profitToken: USDC,
    minProfit,
    maxFeeBps,
  }
}

/** @deprecated CovenArb is superseded by CovenProbe. */
export const encodeExecute = (plan: Plan): Hex => encodeFunctionData({ abi: covenArbAbi, functionName: 'execute', args: [plan] })

export type ProbeResult = { ok: true; profit: bigint } | { ok: false; reason: string }

/** @deprecated CovenArb is superseded by CovenProbe. */
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

export type ProbeRequest = { cycle: Cycle; amountIn: bigint; firstLimit?: bigint }

// Runtime code of contracts/CappedMulticall.sol (solc 0.8.26, optimizer 200 runs). It is
// never deployed: probes inject it at PROBE_HELPER through eth_call state override. Unlike
// Multicall3 it gives every call a fixed gas allowance, so one cycle through a pool or hook
// that burns all the gas it is given cannot starve the rest of the batch (the node rejects
// an eth_call that runs out of its gas cap as a whole).
export const CAPPED_MULTICALL_CODE: Hex =
  '0x608060405234801561000f575f80fd5b5060043610610029575f3560e01c8063d5b5e6a81461002d575b5f80fd5b61004061003b36600461025a565b610057565b60405161004e9291906102cf565b60405180910390f35b6060808367ffffffffffffffff81111561007357610073610391565b60405190808252806020026020018201604052801561009c578160200160208202803683370190505b5091508367ffffffffffffffff8111156100b8576100b8610391565b6040519080825280602002602001820160405280156100eb57816020015b60608152602001906001900390816100d65790505b5090505f5b8481101561025157610104846175306103a5565b5a101561014d57604051806040016040528060078152602001661cdada5c1c195960ca1b81525082828151811061013d5761013d6103ca565b6020026020010181905250610249565b85858281811061015f5761015f6103ca565b905060200281019061017191906103de565b61017f9060208101906103fc565b6001600160a01b03168487878481811061019b5761019b6103ca565b90506020028101906101ad91906103de565b6101bb906020810190610429565b6040516101c9929190610473565b5f604051808303815f8787f1925050503d805f8114610203576040519150601f19603f3d011682016040523d82523d5f602084013e610208565b606091505b5084838151811061021b5761021b6103ca565b60200260200101848481518110610234576102346103ca565b60200260200101829052821515151581525050505b6001016100f0565b50935093915050565b5f805f6040848603121561026c575f80fd5b833567ffffffffffffffff811115610282575f80fd5b8401601f81018613610292575f80fd5b803567ffffffffffffffff8111156102a8575f80fd5b8660208260051b84010111156102bc575f80fd5b6020918201979096509401359392505050565b604080825283519082018190525f9060208501906060840190835b8181101561030a57835115158352602093840193909201916001016102ea565b50508381036020850152809150845180825260208201925060208160051b830101602087015f5b8381101561038357601f19858403018652815180518085528060208301602087015e5f602082870101526020601f19601f83011686010194505050602082019150602086019550600181019050610331565b509098975050505050505050565b634e487b7160e01b5f52604160045260245ffd5b808201808211156103c457634e487b7160e01b5f52601160045260245ffd5b92915050565b634e487b7160e01b5f52603260045260245ffd5b5f8235603e198336030181126103f2575f80fd5b9190910192915050565b5f6020828403121561040c575f80fd5b81356001600160a01b0381168114610422575f80fd5b9392505050565b5f808335601e1984360301811261043e575f80fd5b83018035915067ffffffffffffffff821115610458575f80fd5b60200191503681900382131561046c575f80fd5b9250929050565b818382375f910190815291905056fea2646970667358221220cdbd90777f5272242485db3bd8f3b31f6893021ec84eb917bc7028a9fd864e9064736f6c634300081a0033'
export const PROBE_HELPER: Address = '0x000000000000000000000000000000000c0ffee1'
const cappedMulticallAbi = parseAbi([
  'struct Call { address target; bytes data; }',
  'function run(Call[] calls, uint256 gasEach) returns (bool[] ok, bytes[] ret)',
])
// A cycle needs 160-430k gas; anything over this allowance is a hook or token burning gas.
const PROBE_GAS_EACH = 1_000_000n
const SKIPPED = '0x736b6970706564' // "skipped": the batch ran short of gas before this call

// The contract is its own exact quoter: a plan whose minProfit can never be met reverts with
// BelowMinProfit(profit, ...) when profitable and NoProfit otherwise. That accounts for every
// tick crossing, hook and fee, including CovenArb's own cut. Many plans go through the capped
// multicall in a single eth_call.
/** @deprecated CovenArb is superseded by CovenProbe. */
export async function probe(
  client: PublicClient,
  requests: ProbeRequest[],
  opts: { maxFeeBps: number; arb?: Address; blockNumber?: bigint; chunk?: number },
): Promise<ProbeResult[]> {
  const arb = opts.arb ?? COVEN_ARB
  // 24 x 1M stays under the 30M eth_call gas cap of the public endpoints.
  const chunk = opts.chunk ?? 24
  const chunks: ProbeRequest[][] = []
  for (let i = 0; i < requests.length; i += chunk) chunks.push(requests.slice(i, i + chunk))
  const results = await Promise.all(
    chunks.map(async (part) => {
      const calls = part.map((r) => ({
        target: arb,
        data: encodeExecute(buildPlan(r.cycle, r.amountIn, UINT256_MAX, opts.maxFeeBps, r.firstLimit)),
      }))
      const { data } = await client.call({
        to: PROBE_HELPER,
        data: encodeFunctionData({ abi: cappedMulticallAbi, functionName: 'run', args: [calls, PROBE_GAS_EACH] }),
        stateOverride: [{ address: PROBE_HELPER, code: CAPPED_MULTICALL_CODE }],
        blockNumber: opts.blockNumber,
      })
      if (!data) throw new Error('probe returned no data')
      const [ok, ret] = decodeFunctionResult({ abi: cappedMulticallAbi, functionName: 'run', data })
      return ret.map((r, i): ProbeResult => {
        if (ok[i]) return { ok: false, reason: 'unexpected success' }
        if (r === SKIPPED) return { ok: false, reason: 'skipped' }
        // An empty revert under the allowance is a call that ran out of gas.
        if (r === '0x') return { ok: false, reason: 'out of gas' }
        return decodeProbe(r)
      })
    }),
  )
  return results.flat()
}

/** @deprecated CovenArb is superseded by CovenProbe. */
export async function readArbConfig(client: PublicClient, arb: Address = COVEN_ARB) {
  const [feeBps, feeRecipient] = await Promise.all([
    client.readContract({ address: arb, abi: covenArbAbi, functionName: 'feeBps' }),
    client.readContract({ address: arb, abi: covenArbAbi, functionName: 'feeRecipient' }),
  ])
  return { feeBps: Number(feeBps), feeRecipient }
}
