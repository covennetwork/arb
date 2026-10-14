# coven-arb

Capital-free atomic arbitrage on [Arc](https://arc.io) through the CovenProbe contract.

`coven-arb run` watches every block, finds USDC cycles across Uniswap v3 and v4 pools and
v3-style forks (hooked, dynamic-fee, launchpad and native-USDC pools included), plus the
payouts of fair-launch hooks, and simulates each route through CovenProbe against live
state. It sends only the routes that pay for their own gas, at zero priority fee. A trade
either makes money or is skipped on-chain; you never hold inventory.

```sh
npm i -g @covennetwork/arb
coven-arb doctor
coven-arb scan
COVEN_PRIVATE_KEY=0x... coven-arb run --log trades.jsonl
```

## How it works

1. **Discovery.** At startup the bot replays ~3 hours of swap and liquidity events to find
   every pool that is actually trading. v3-style pools are reconstructed from their own
   getters and kept if a known factory created them: Uniswap v3, Synthra V3 and
   Slipstream-style CL clones. v4 pools only reveal their key in their `Initialize` event,
   usually far older than public RPCs will serve, so the key is recovered from a transaction
   that swapped the pool. For every token found, it checks the other venues it could trade
   on, against USDC, EURC and native USDC. Hooks that keep a per-pool fee inventory
   (`poolFees(key)`, the fair-launch kind) are noted too. Everything is cached in
   `~/.cache/coven-arb`, so later starts take seconds.
2. **Routes.** Every `USDC → X → USDC` and `USDC → X → Y → USDC` loop through distinct
   pools, where either end can be ERC-20 or native USDC (one balance on Arc). And for each
   fair-launch hook pool, a payout route: buy the hook's fee inventory at the pool price,
   sell it back into the pool.
3. **Live state.** Market events arrive over a websocket subscription as they are produced,
   with an `eth_getLogs` poll behind it as the source of truth. Swap events carry the pool's
   new price and liquidity, so state stays exact without extra reads.
4. **Screen.** Cycles touched by new events (all of them every 30 s) are priced at the margin
   from spot prices and LP fees; survivors get a size estimate from a constant-product model
   of the current tick range. Payout routes of touched hook pools are always included.
5. **Simulate.** Every candidate goes through `CovenProbe.probe` in one round of `eth_call`s
   against the latest block. The contract checks each route's prices, sizes two-leg cycles
   on-chain at the price where both pools meet, trades and settles, so the simulated profit
   includes every tick crossing, hook and fee, after CovenProbe's 10%.
6. **Send.** A route whose simulated profit beats its gas cost plus `--min-profit` is sent
   alone, signed locally and broadcast to every endpoint, at `--tip` (default 0). The send
   carries that cost as the contract's profit floor: if someone else takes the gap first, the
   contract skips the trade and the send costs ~60k gas (~0.0013 USDC). A payout route also
   carries a gate: the hook must still hold at least half the inventory the bot saw.
7. **Account and back off.** Each receipt is matched to CovenProbe's `Executed` event for the
   signer: profit paid and fee taken. After a miss, every pool the route used sits out for 30 s,
   doubling with each consecutive miss up to 30 minutes, since many cycles share the same
   contested pools. Hook payout routes are exempt: their gate makes a miss cheap. Every
   opportunity, send, outcome and status line goes to the `--log` file as JSON lines.

## Commands

| command | what it does |
| --- | --- |
| `run` | The live bot. `--dry-run` runs everything except signing and sending. |
| `scan` | One pass over the current market. Prints every route that is profitable on-chain right now and whether it clears the floor after gas. `--json` for machines. |
| `index` | Optional. Indexes every pool ever created (resumable, newest first), so dormant venues of a token are known before they first trade. Needs an RPC that serves historical logs. |
| `doctor` | Checks each RPC endpoint, the CovenProbe contract and its fee, gas price, the signer's balance, and the pool cache. Exits non-zero if anything fails. |

## Options

| flag | default | |
| --- | --- | --- |
| `--rpc <url,...>` | `$ARC_RPC_URL`, else the public Arc endpoints | Requests are spread across all endpoints; a rate-limited endpoint is skipped. Transactions go to all of them. |
| `--min-profit <usdc>` | `0` | Smallest profit worth sending, **after** CovenProbe's fee and gas. Enforced on-chain. |
| `--tip <gwei>` | `0` | Priority fee per gas. See [Economics](#economics) for why the default is zero. |
| `--max-loss <usdc>` | none | Stop once gas spent exceeds profit by this much. |
| `--ws <url\|off>` | `$ARC_WS_URL`, else the first `--rpc` as `wss://` | Websocket for pushed market events. Needs Node 22+; otherwise polling only. |
| `--log <file>` | none | JSON-lines log of opportunities, sends, outcomes and status. |
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

- **No capital.** CovenProbe settles each route within one transaction against PoolManager
  flash accounting, and pays out only when it profits. The signer only pays gas.
- **Gas is cheap.** It is paid in USDC at a 20 gwei base fee: a trade uses 200–700k gas
  (0.004–0.014 USDC) depending on its legs, a send whose gap has gone ~60k. Each send needs
  about 0.02 USDC free up front (gas limit × max fee).
- **CovenProbe takes 10%** of each trade's profit, as PoolManager claims to the fee
  recipient. The profit figures shown are after that cut.
- **Zero tip by default.** Arc orders transactions by priority fee, so bidding wins races,
  but measured over a week of Arc arbitrage, bidders gave a median 81% of contested profit
  away as fees. Bots that send only what pays, at no tip, kept most of theirs. A tip still
  helps land in the block right after a gap opens: over a 20-hour simulation, sends landing
  two blocks after a gap opened earned about a ninth of what sends landing in the next
  block did.

### What decides whether this makes money

- **Latency.** Whether a send lands in the next block or the one after is most of the
  result. Run the bot close to the RPC: a VPS next to the endpoint, or your own node.
  `doctor` prints per-endpoint latency, and `sent` lines report the milliseconds from the
  block to the broadcast.
- **Payout hooks.** On Arc the largest repeatable source has been fair-launch hooks that sell
  their collected fees to the next swapper. Others harvest them too; whoever lands first
  after a payout grows takes it.
- **Opportunity size.** Most price gaps at any moment are dust, below gas. `scan` shows the
  current state; a dry run with `--log` for an hour or two shows how often worthwhile ones
  appear, before you put a key in.

## Limits

- **Fee-on-transfer tokens** paid into a v3-style pool fail the pool's balance check; such
  routes simulate at no profit and are never sent.
- **Some v4 pools can't be recovered.** 10–20% of v4 pools seen trading cannot have their
  key reconstructed from a single transaction. They are skipped unless `index` finds their
  `Initialize` event.
- **Routes of up to three legs** are enumerated; CovenProbe itself takes up to four.

## Library

Everything the CLI uses is exported:

```ts
import { Market, PoolRegistry, createRpc, cycleCandidates, price, DEFAULT_RPCS } from '@covennetwork/arb'

const rpc = createRpc(DEFAULT_RPCS)
const market = new Market(rpc, PoolRegistry.load())
const head = await rpc.client.getBlockNumber()
await market.bootstrap(head, 20_000n)
const candidates = cycleCandidates(market.screen(market.cycles), 20_000_000_000n, 32)
const priced = await price(rpc.client, candidates, { maxFeeBps: 1000, gasPrice: 20_000_000_000n })
```

`COVEN_PROBE` is the contract's address; `simulate` and `encodeProbe` work on raw routes.
The CovenArb helpers (`buildPlan`, `probe`, `readArbConfig`, `COVEN_ARB`) are deprecated
and kept for 0.4 users.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js scan
```
