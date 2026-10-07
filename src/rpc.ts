import {
  type AbiEvent,
  type Address,
  type EIP1193RequestFn,
  type Hex,
  type Log,
  type PublicClient,
  type Transport,
  createPublicClient,
  createTransport,
  http,
  keccak256,
} from 'viem'
import { arc } from './constants.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function errorText(e: unknown): string {
  const err = e as { details?: string; shortMessage?: string; message?: string; status?: number }
  return [err.details, err.shortMessage, err.message, err.status].filter(Boolean).join(' ').toLowerCase()
}

// Errors that are about the endpoint rather than the request: try another endpoint.
export function isEndpointError(e: unknown): boolean {
  const t = errorText(e)
  if (t.includes('revert')) return false
  return /rate limit|limit exceeded|too many requests|429|timed out|timeout|fetch failed|econn|socket|network|50[0-9]|bad gateway|unavailable|pruned|free plan|internal error/.test(t)
}

// Errors that mean "ask for fewer blocks".
export function isRangeError(e: unknown): boolean {
  return /range|max results|too many|exceed|body exceeded|response size/.test(errorText(e)) && !errorText(e).includes('revert')
}

// Spreads requests across endpoints and moves on to the next one when an endpoint is
// rate-limited or down. Request errors (reverts, bad params) surface immediately.
export function roundRobin(urls: string[]): Transport {
  if (urls.length === 0) throw new Error('no RPC endpoints configured')
  const transports = urls.map((u) => http(u, { retryCount: 0, timeout: 15_000 }))
  return (params) => {
    const inner = transports.map((t) => t({ ...params, retryCount: 0 }))
    let next = 0
    return createTransport({
      key: 'roundRobin',
      name: 'Round robin',
      type: 'roundRobin',
      retryCount: 0,
      request: (async (args) => {
        let last: unknown
        const attempts = Math.max(3, inner.length * 2)
        for (let i = 0; i < attempts; i++) {
          const t = inner[next++ % inner.length]!
          try {
            return await t.request(args)
          } catch (e) {
            if (!isEndpointError(e)) throw e
            last = e
            if ((i + 1) % inner.length === 0) await sleep(250 * (i + 1))
          }
        }
        throw last
      }) as EIP1193RequestFn,
    })
  }
}

export type Rpc = {
  client: PublicClient
  urls: string[]
  // Per-endpoint clients, for broadcasting a signed transaction everywhere at once.
  endpoints: PublicClient[]
}

export function createRpc(urls: string[]): Rpc {
  return {
    client: createPublicClient({ chain: arc, transport: roundRobin(urls), batch: { multicall: { batchSize: 4096 } } }),
    urls,
    endpoints: urls.map((u) => createPublicClient({ chain: arc, transport: http(u, { retryCount: 0, timeout: 10_000 }) })),
  }
}

// Broadcast a signed transaction to every endpoint; succeed if any endpoint accepts it.
export async function broadcast(rpc: Rpc, raw: Hex): Promise<Hex> {
  const results = await Promise.allSettled(rpc.endpoints.map((c) => c.sendRawTransaction({ serializedTransaction: raw })))
  const ok = results.find((r): r is PromiseFulfilledResult<Hex> => r.status === 'fulfilled')
  if (ok) return ok.value
  const reasons = results.map((r) => (r as PromiseRejectedResult).reason)
  // "already known" from one endpoint means another already has it.
  if (reasons.some((r) => /already known|known transaction/.test(errorText(r)))) return keccak256(raw)
  throw reasons[0]
}

const hintedSpan = (e: unknown): bigint | undefined => {
  const m = /retry with the range (\d+)-(\d+)/.exec(errorText(e))
  return m ? BigInt(m[2]!) - BigInt(m[1]!) + 1n : undefined
}

export type LogQuery = {
  address?: Address | Address[]
  events: readonly AbiEvent[]
  fromBlock: bigint
  toBlock: bigint
  maxSpan?: bigint
}

// eth_getLogs over an arbitrary range. Public Arc endpoints cap a query at 1000 blocks and
// 2000 results, so ranges are split on demand and widened again after successes.
export async function getLogsChunked(
  client: PublicClient,
  q: LogQuery,
  onChunk?: (logs: Log[], from: bigint, to: bigint) => void | Promise<void>,
): Promise<Log[]> {
  const maxSpan = q.maxSpan ?? 1000n
  const out: Log[] = []
  let span = maxSpan
  let from = q.fromBlock
  while (from <= q.toBlock) {
    const to = from + span - 1n > q.toBlock ? q.toBlock : from + span - 1n
    try {
      const logs = (await client.getLogs({
        address: q.address,
        events: q.events,
        fromBlock: from,
        toBlock: to,
        strict: true,
      })) as Log[]
      await onChunk?.(logs, from, to)
      if (!onChunk) out.push(...logs)
      from = to + 1n
      span = span * 2n > maxSpan ? maxSpan : span * 2n
    } catch (e) {
      if (!isRangeError(e) || span === 1n) throw e
      const hint = hintedSpan(e)
      span = hint && hint < span ? hint : span / 2n
    }
  }
  return out
}
