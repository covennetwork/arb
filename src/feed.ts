import { type Log, type PublicClient, type RpcLog, encodeEventTopics, formatLog, parseEventLogs } from 'viem'
import { marketEvents } from './abis.js'
import { getLogsChunked, isRangeError } from './rpc.js'

const topics = marketEvents.map((e) => encodeEventTopics({ abi: [e] })[0]!)
const keyOf = (l: Log) => `${l.blockNumber}:${l.logIndex}`

export type FeedBatch = { logs: Log[]; head: bigint }

// Market events, as early as possible and without gaps.
//
// HTTP eth_getLogs from a cursor is the source of truth: it never skips a block. A websocket
// subscription, when available, delivers the same logs as they are produced, so the bot can
// react before the next poll; the poll then slows down and the duplicates it returns are
// dropped. If the socket drops, polling speeds up again until it reconnects.
export class MarketFeed {
  private cursor: bigint
  private buffer: Log[] = []
  private seen = new Set<string>()
  private socket?: WebSocket
  private socketUp = false
  private wake?: () => void
  private lastPoll = 0
  private catchingUp = true
  private closed = false

  constructor(
    private client: PublicClient,
    from: bigint,
    private wsUrl?: string,
    private onNote: (msg: string) => void = () => {},
  ) {
    this.cursor = from - 1n
  }

  get live(): boolean {
    return this.socketUp
  }

  // Every block up to here has been delivered in full.
  get synced(): bigint {
    return this.cursor
  }

  start(): void {
    if (this.wsUrl) this.connect(0)
  }

  close(): void {
    this.closed = true
    this.socket?.close()
    this.wake?.()
  }

  private connect(attempt: number): void {
    if (this.closed || !this.wsUrl) return
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!WS) {
      this.onNote('websocket needs Node 22+; polling only')
      return
    }
    const ws = new WS(this.wsUrl)
    this.socket = ws
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { topics: [topics] }] }))
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; error?: { message: string }; result?: string; params?: { result: RpcLog } }
      if (msg.id === 1) {
        if (msg.error) {
          this.onNote(`websocket subscription refused (${msg.error.message}); polling only`)
          ws.close()
          this.wsUrl = undefined
          return
        }
        if (!this.socketUp) this.onNote(`websocket live: ${this.wsUrl}`)
        this.socketUp = true
        attempt = 0
        return
      }
      if (!msg.params) return
      try {
        const [log] = parseEventLogs({ abi: marketEvents, logs: [formatLog(msg.params.result)], strict: true })
        if (log) this.push([log as Log])
      } catch {
        // a log matching our topics but not our event shapes
      }
    }
    ws.onclose = () => {
      const wasUp = this.socketUp
      this.socketUp = false
      if (this.closed || !this.wsUrl) return
      if (wasUp) this.onNote('websocket dropped; polling until it reconnects')
      setTimeout(() => this.connect(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt))
    }
    ws.onerror = () => ws.close()
  }

  private push(logs: Log[]): void {
    let added = false
    for (const l of logs) {
      // Blocks up to the cursor were delivered whole by the HTTP poll.
      if (l.blockNumber === null || l.blockNumber < this.cursor) continue
      const k = keyOf(l)
      if (this.seen.has(k)) continue
      this.seen.add(k)
      this.buffer.push(l)
      added = true
    }
    if (added) this.wake?.()
  }

  // The next batch of new market events, in chain order. `head` is the newest block seen.
  async next(pollMs = 150): Promise<FeedBatch> {
    const interval = this.socketUp ? 2000 : pollMs
    const due = this.lastPoll + interval - Date.now()
    if (this.buffer.length === 0 && due > 0 && !this.catchingUp) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, due)
        this.wake = () => {
          clearTimeout(t)
          r()
        }
      })
      this.wake = undefined
    }
    if (this.buffer.length === 0 || Date.now() - this.lastPoll >= interval) await this.poll()
    const logs = this.buffer.sort((a, b) =>
      a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber! < b.blockNumber! ? -1 : 1,
    )
    this.buffer = []
    const head = logs.reduce((m, l) => (l.blockNumber! > m ? l.blockNumber! : m), this.cursor)
    if (this.seen.size > 50_000) this.prune()
    return { logs, head }
  }

  private async poll(): Promise<void> {
    this.lastPoll = Date.now()
    if (this.catchingUp) {
      const head = await this.client.getBlockNumber()
      if (head > this.cursor) {
        this.push(await getLogsChunked(this.client, { events: marketEvents, fromBlock: this.cursor + 1n, toBlock: head }))
        this.cursor = head
      }
      this.catchingUp = false
      return
    }
    let logs: Log[]
    try {
      logs = (await this.client.getLogs({ events: marketEvents, fromBlock: this.cursor + 1n, toBlock: 'latest', strict: true })) as Log[]
    } catch (e) {
      if (isRangeError(e)) {
        this.catchingUp = true
        return
      }
      // Endpoints answer a bare "invalid params" when fromBlock is past their head: a
      // load-balanced backend has not seen the latest block yet.
      if (/invalid param/i.test(String((e as Error).message))) return
      throw e
    }
    this.push(logs)
    // Blocks after the last one with events are covered again by the next poll.
    for (const l of logs) if (l.blockNumber! > this.cursor) this.cursor = l.blockNumber!
  }

  // Ask for a full catch-up from the cursor on the next call, e.g. after falling behind.
  resync(): void {
    this.catchingUp = true
  }

  private prune(): void {
    const floor = this.cursor - 200n
    for (const k of this.seen) if (BigInt(k.split(':')[0]!) < floor) this.seen.delete(k)
  }
}
