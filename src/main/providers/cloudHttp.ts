import type { Readable } from 'stream'

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])
const RATE_LIMIT_403 = /rateLimitExceeded|userRateLimitExceeded|too_many_requests/i

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function retryDelay(res: Response | null, attempt: number): number {
  const ra = res?.headers.get('retry-after')
  const secs = ra ? Number(ra) : NaN
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 120) * 1000
  return Math.min(1000 * 2 ** (attempt - 1), 30_000) + Math.random() * 250
}

/**
 * Run `doFetch` with retries for network errors, 429/5xx, and rate-limit 403s
 * (honoring Retry-After). With `rateLimitOnly`, only 429s are retried (safe for
 * POST/PATCH/DELETE). A 401 triggers `onUnauthorized` (drop the cached
 * access token) and one immediate retry. `doFetch` must build a fresh request
 * each call (fresh token, fresh body) — streams cannot be replayed.
 */
export async function withRetry(
  doFetch: () => Promise<Response>,
  opts: { onUnauthorized?: () => void; maxAttempts?: number; rateLimitOnly?: boolean } = {}
): Promise<Response> {
  const max = opts.maxAttempts ?? 6
  let refreshed = false
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null
    try {
      res = await doFetch()
    } catch (err) {
      // rateLimitOnly (non-idempotent writes): a network error may mean the request
      // was processed, so never replay it.
      if (opts.rateLimitOnly || attempt >= max) throw err
      await sleep(retryDelay(null, attempt))
      continue
    }
    if (res.status === 401 && opts.onUnauthorized && !refreshed) {
      refreshed = true
      opts.onUnauthorized()
      await res.arrayBuffer().catch(() => undefined)
      continue
    }
    // A 429 means the request was rejected unprocessed, so it is always safe to replay.
    let retry = opts.rateLimitOnly ? res.status === 429 : RETRYABLE.has(res.status)
    if (!retry && !opts.rateLimitOnly && res.status === 403) retry = RATE_LIMIT_403.test(await res.clone().text().catch(() => ''))
    if (!retry || attempt >= max) return res
    await res.arrayBuffer().catch(() => undefined)
    await sleep(retryDelay(res, attempt))
  }
}

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/**
 * Yield fixed-size buffers from a stream, flagging the final one. Looks ahead
 * by one chunk so callers know which chunk is last (needed for final-chunk
 * commit/total-size semantics). Yields nothing for an empty stream.
 */
export async function* chunkWithLast(
  stream: Readable,
  size: number
): AsyncGenerator<{ chunk: Buffer; isLast: boolean }> {
  let parts: Buffer[] = []
  let buffered = 0
  let pending: Buffer | null = null
  for await (const c of stream) {
    parts.push(c as Buffer)
    buffered += (c as Buffer).length
    if (buffered < size) continue
    let buf = Buffer.concat(parts)
    while (buf.length >= size) {
      if (pending) yield { chunk: pending, isLast: false }
      pending = Buffer.from(buf.subarray(0, size))
      buf = buf.subarray(size)
    }
    parts = buf.length ? [buf] : []
    buffered = buf.length
  }
  if (buffered > 0) {
    if (pending) yield { chunk: pending, isLast: false }
    pending = Buffer.concat(parts)
  }
  if (pending) yield { chunk: pending, isLast: true }
}
