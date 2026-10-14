import { type Hex, type Log, type PublicClient, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { USDC } from '../../src/constants.js'
import { MarketFeed } from '../../src/feed.js'
import { Market } from '../../src/market.js'
import { type Pool, PoolRegistry } from '../../src/pools.js'
import type { Rpc } from '../../src/rpc.js'

const usdc = USDC.toLowerCase() as Hex
const TOKEN = '0x9999999999999999999999999999999999999999' as Hex

const log = (block: number, index: number, extra: Partial<Log> & Record<string, unknown> = {}) =>
  ({ blockNumber: BigInt(block), logIndex: index, transactionHash: `0x${block.toString(16).padStart(64, '0')}`, address: zeroAddress, ...extra }) as unknown as Log

describe('MarketFeed', () => {
  it('catches up, then returns each log once even when polls overlap', async () => {
    let head = 10n
    const chain: Log[] = [log(5, 0), log(9, 0), log(9, 1)]
    const client = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint | 'latest' }) => {
        const to = toBlock === 'latest' ? head : toBlock
        return chain.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= to)
      },
    } as unknown as PublicClient
    const feed = new MarketFeed(client, 1n)
    const first = await feed.next(0)
    expect(first.logs.map((l) => `${l.blockNumber}:${l.logIndex}`)).toEqual(['5:0', '9:0', '9:1'])
    expect(first.head).toBe(10n)
    chain.push(log(11, 0), log(12, 3))
    head = 12n
    const second = await feed.next(0)
    expect(second.logs.map((l) => `${l.blockNumber}:${l.logIndex}`)).toEqual(['11:0', '12:3'])
    const third = await feed.next(0)
    expect(third.logs).toHaveLength(0)
    expect(feed.synced).toBe(12n)
  })
})

describe('Market event handling', () => {
  const pa: Pool = { kind: 'v3', id: '0x00000000000000000000000000000000000000a1', token0: usdc, token1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress }
  const pb: Pool = { kind: 'v3', id: '0x00000000000000000000000000000000000000b2', token0: usdc, token1: TOKEN, fee: 10000, tickSpacing: 200, hooks: zeroAddress }
  const swap = (pool: Pool, block: number, index: number, price: bigint, tx?: Hex) =>
    log(block, index, {
      address: pool.id,
      eventName: 'Swap',
      args: { sqrtPriceX96: price, liquidity: 1n, tick: 0, amount0: 0n, amount1: 0n, sender: zeroAddress, recipient: zeroAddress },
      ...(tx ? { transactionHash: tx } : {}),
    })

  function market() {
    const reg = new PoolRegistry()
    reg.add(pa)
    reg.add(pb)
    return new Market({ client: {} as PublicClient, urls: [], endpoints: [] } as Rpc, reg)
  }

  it('never lets an older event roll a price back', () => {
    const m = market()
    m.applyLogs([swap(pa, 10, 5, 200n)])
    m.applyLogs([swap(pa, 10, 2, 100n), swap(pa, 10, 5, 100n)])
    expect(m.states.get(pa.id)!.sqrtPriceX96).toBe(200n)
    m.applyLogs([swap(pa, 11, 0, 300n)])
    expect(m.states.get(pa.id)!.sqrtPriceX96).toBe(300n)
  })

  it('flags a transaction that swaps a closed loop of tracked pools as an arb', () => {
    const m = market()
    const arb = '0x00000000000000000000000000000000000000000000000000000000000000aa' as Hex
    const trade = '0x00000000000000000000000000000000000000000000000000000000000000bb' as Hex
    m.applyLogs([swap(pa, 20, 0, 1n, arb), swap(pb, 20, 1, 1n, arb), swap(pa, 20, 2, 2n, trade)])
    const arbs = m.drainArbTxs()
    expect([...arbs.keys()]).toEqual([arb])
    expect(arbs.get(arb)).toEqual([pa.id, pb.id])
    expect(m.drainArbTxs().size).toBe(0)
  })
})
