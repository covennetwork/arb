# coven-arb

Capital-free atomic arbitrage on [Arc](https://arc.io) through the CovenArb contract.

`coven-arb run` watches every block, finds USDC cycles across Uniswap v3 and v4 pools
(hooked, dynamic-fee and launchpad pools included), measures each one's exact profit
on-chain, and sends the profitable ones. A trade either makes money or reverts; you never
hold inventory.

```sh
npm i -g @covennetwork/arb
coven-arb doctor
coven-arb scan
COVEN_PRIVATE_KEY=0x... coven-arb run --log trades.jsonl
```

## How it works

1. **Discovery.** At startup the bot replays ~3 hours of swap and liquidity events to find
   every pool that is actually trading. v3 pools are reconstructed from their own getters and
   kept only if the canonical factory created them. v4 pools only reveal their key in their
   `Initialize` event, usually far older than public RPCs will serve, so the key is recovered
   from a transaction that swapped the pool: currencies from the PoolManager's transfers, and
   fee, tick spacing and hook from the router calldata. For every token found, it then checks
   the other venues it could trade on (v3 fee tiers, common v4 fee/spacing pairs, hooks the
   token already uses). Everything is cached in `~/.cache/coven-arb`, so later starts take
   seconds.
2. **Cycles.** Every `USDC → X → USDC` and `USDC → X → Y → USDC` loop through distinct pools.
3. **Live state.** One `eth_getLogs` per poll. Swap events carry the pool's new price and
   liquidity, so state stays exact without extra reads. Liquidity changes trigger a re-read.
4. **Screen.** Cycles touched by the new events are priced at the margin from spot prices
   and LP fees. Survivors get a size estimate from a constant-product model of the current
   tick range.
5. **Verify and size on-chain.** CovenArb reverts with `BelowMinProfit(profit, …)` when a
   plan is profitable but under its floor. Calling it with an unreachable floor therefore
   returns the exact profit after every tick crossing, hook and fee, including CovenArb's own
   cut. Sixteen sizes around the estimate go through Multicall3 in one `eth_call`, and the
   best one is the trade.
6. **Execute.** The transaction is signed locally (no `estimateGas`, nonce or fee lookups on
   the hot path) and broadcast to every configured endpoint. Its priority fee is a share of
   the expected profit (`--bid`). The plan's `maxFeeBps` is pinned to CovenArb's current fee,
   so a fee increase after signing makes the trade revert instead of paying more.
7. **Account.** Each receipt is matched to the USDC actually paid to the signer (CovenArb pays through a PoolManager `take`). Every
   opportunity, trade and outcome goes to the `--log` file as JSON lines.

## Commands

| command | what it does |
| --- | --- |
| `run` | The live bot. `--dry-run` runs everything except signing and sending. |
| `scan` | One pass over the current market. Prints every cycle that is profitable on-chain right now and whether it clears the floor after gas. `--json` for machines. |
| `index` | Optional. Indexes every pool ever created (resumable, newest first), so dormant venues of a token are known before they first trade. Needs an RPC that serves historical logs. |
| `doctor` | Checks each RPC endpoint, the CovenArb contract and its fee, gas price, the signer's balance, and the pool cache. Exits non-zero if anything fails. |

## Options

| flag | default | |
| --- | --- | --- |
| `--rpc <url,...>` | `$ARC_RPC_URL`, else the public Arc endpoints | Requests are spread across all endpoints; a rate-limited endpoint is skipped. Transactions go to all of them. |
| `--min-profit <usdc>` | `0.01` | Smallest profit worth sending, **after** CovenArb's fee, base gas and the priority bid. |
| `--bid <percent>` | `20` | Share of expected profit paid as priority fee (floor 1 gwei). |
| `--log <file>` | none | JSON-lines log of opportunities, trades, outcomes and status. |
| `--dry-run` | off | `run` only. |
| `--json` | off | `scan` only. |
| `--from <block>` | first DEX block | `index` only. |

The signer comes only from the environment, never a flag, since flags end up in shell
history and pasted logs:

```sh
COVEN_PRIVATE_KEY=0x...                                   # raw key
COVEN_KEYSTORE=key.json COVEN_KEYSTORE_PASSWORD=...       # v3 keystore (geth, cast, MetaMask)
```

`COVEN_ARB_CACHE` moves the pool cache.

## Economics

- **No capital.** CovenArb settles each cycle within one transaction and reverts unless it
  profits. The signer only pays gas.
- **Gas is cheap.** It is paid in USDC: about 280k gas for a two-leg cycle, roughly 0.006
  USDC at the 20 gwei base fee.
- **CovenArb takes 10%** of each trade's profit. The profit figures shown are after that cut.
- **Arc orders transactions by priority fee.** When two bots race for the same cycle, the
  higher bid lands and the other reverts. A lost race costs about the gas plus the bid, so
  `--bid` trades win rate against the cost of losing. Other bots on Arc currently bid around
  20 gwei on small trades and far more on large ones.

### What decides whether this makes money

- **Latency.** Competing bots react within one block (0.5 s). Over public endpoints each
  round trip takes 0.5–0.8 s and the bot needs three per trade (poll, verify, send), so
  expect to lose most contested races. Run it against your own node, or a paid endpoint near
  the validators. `doctor` prints per-endpoint latency, and `sent` lines report the
  milliseconds from seeing the trigger to broadcasting.
- **Gas efficiency.** CovenArb uses roughly 3–4× the gas of the leanest competing contract.
  So for the same priority fee per gas it pays more per trade, and matching their bid costs
  more.
- **Opportunity size.** Most cycles that are profitable at any given moment are dust pools
  worth a fraction of a cent, below gas. Real opportunities appear right after large swaps on
  pools that share a token with another venue. `scan` shows the current state; a dry run
  with `--log` for an hour or two shows how often worthwhile ones appear, before you put a
  key in.

## Limits

- **Native-USDC pools are not traded.** Many launchpad pools are quoted in native USDC
  (`address(0)` in v4, 18 decimals) rather than the ERC-20. CovenArb's handling of a cycle
  that mixes the two is unverified, so these pools are indexed but never routed.
- **Hook fees are invisible to the spot screen.** Hooked pools can look profitable and still
  lose on-chain. The on-chain check catches this before anything is sent, and the cycle is
  then only re-checked once its edge improves.
- **Some v4 pools can't be recovered.** 10–20% of v4 pools seen trading cannot have
  their key reconstructed from a single transaction. They are skipped unless `index` finds
  their `Initialize` event.

## Library

Everything the CLI uses is exported:

```ts
import { Market, PoolRegistry, createRpc, evaluate, DEFAULT_RPCS } from '@covennetwork/arb'

const rpc = createRpc(DEFAULT_RPCS)
const market = new Market(rpc, PoolRegistry.load())
const head = await rpc.client.getBlockNumber()
await market.bootstrap(head, 20_000n)
const candidates = market.screen(market.cycles).slice(0, 32)
const { opportunities } = await evaluate(rpc.client, candidates, {
  maxFeeBps: 1000,
  fees: { baseFee: 20_000_000_000n, minPriorityFee: 1_000_000_000n, bidBps: 2000 },
})
```

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js scan
```
