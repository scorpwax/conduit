import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { getProvider } from './providers'
import { isJunkEntryName } from './junkFiles'
import { S3_MULTIPART_PART_SIZE } from '@shared/transferConstants'
import type { VerifyItem, VerifyResult, VerifyMismatch, VerifyMissing } from '@shared/types'
import { log } from './logger'

/** Detects an S3-style multipart ETag (`<32-hex-md5>-<partCount>`). A multipart
 *  ETag is the MD5 of the concatenated per-part MD5s — never equal to a plain
 *  whole-file MD5 even for byte-identical content, so a flat compare against
 *  it is meaningless without recomputing the same multipart-style hash. */
function looksMultipart(value: string): boolean {
  return /^[a-f0-9]{32}-\d+$/i.test(value)
}

const CONCURRENCY = 4
const PROGRESS_THROTTLE_MS = 200

/**
 * Recursively verifies two or more folders (potentially on different
 * connections/providers) match byte-for-byte: walks each tree, matches files
 * by path relative to each folder's own root, flags anything missing from a
 * side, and checksums everything present on all sides (reconciling S3
 * multipart ETags against a locally-recomputed hash the same way Compare's
 * single-file checksum does, since large uploaded footage is exactly the
 * multipart case).
 */
class VerifyEngine extends EventEmitter {
  private canceled = new Set<string>()

  cancel(runId: string): void {
    this.canceled.add(runId)
  }

  /** Kicks off a run in the background; returns immediately with the runId.
   *  Progress and the final result are delivered via 'progress'/'done' events. */
  start(items: VerifyItem[]): string {
    const runId = randomUUID()
    void this.run(runId, items)
      .then((result) => this.emit('done', result))
      .catch((err: Error) => {
        this.emit('done', {
          runId, totalChecked: 0, matched: 0, mismatched: [], missing: [],
          canceled: false, error: err.message
        } satisfies VerifyResult)
      })
    return runId
  }

  private async run(runId: string, items: VerifyItem[]): Promise<VerifyResult> {
    log.info('fs', `Verify started: ${items.map((i) => i.label).join(' vs ')}`)

    // Build a relPath -> absPath map for each item by walking its tree.
    const trees: Array<Map<string, string>> = []
    for (const item of items) {
      const provider = await getProvider(item.connectionId)
      const map = new Map<string, string>()
      await this.walk(provider, item.path, '', map)
      trees.push(map)
    }

    const allRelPaths = new Set<string>()
    for (const t of trees) for (const p of t.keys()) allRelPaths.add(p)

    const missing: VerifyMissing[] = []
    const toCheck: string[] = []
    for (const relPath of allRelPaths) {
      const missingFrom = items
        .map((item, i) => (trees[i].has(relPath) ? null : item.label))
        .filter((l): l is string => l !== null)
      if (missingFrom.length > 0) missing.push({ relPath, missingFrom })
      else toCheck.push(relPath)
    }

    const mismatched: VerifyMismatch[] = []
    const total = toCheck.length
    let done = 0
    let lastEmit = 0
    const emitProgress = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return
      lastEmit = now
      this.emit('progress', { runId, done, total })
    }

    let idx = 0
    const worker = async (): Promise<void> => {
      while (idx < toCheck.length) {
        if (this.canceled.has(runId)) return
        const relPath = toCheck[idx++]
        try {
          const ok = await this.compareOne(items, trees, relPath)
          if (!ok) mismatched.push({ relPath, reason: 'Checksum mismatch' })
        } catch (err) {
          mismatched.push({ relPath, reason: `Error: ${(err as Error).message}` })
        }
        done++
        emitProgress()
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toCheck.length || 1) }, worker))
    emitProgress(true)

    const canceled = this.canceled.has(runId)
    this.canceled.delete(runId)
    const result: VerifyResult = {
      runId,
      totalChecked: toCheck.length,
      matched: toCheck.length - mismatched.length,
      mismatched,
      missing,
      canceled,
      error: null
    }
    log.info(
      'fs',
      `Verify ${canceled ? 'canceled' : 'complete'}: ${result.matched}/${result.totalChecked} matched, ` +
      `${mismatched.length} mismatched, ${missing.length} missing`
    )
    return result
  }

  private async walk(
    provider: Awaited<ReturnType<typeof getProvider>>,
    absPath: string,
    relPath: string,
    map: Map<string, string>
  ): Promise<void> {
    const { entries } = await provider.list(absPath)
    for (const e of entries) {
      if (isJunkEntryName(e.name)) continue // OS bookkeeping files, not real transferred content
      const entryRel = relPath ? `${relPath}/${e.name}` : e.name
      if (e.kind === 'directory') {
        await this.walk(provider, e.path, entryRel, map)
      } else {
        map.set(entryRel, e.path)
      }
    }
  }

  /** Compares one relative path across every item, reconciling a multipart
   *  S3 ETag against a locally-recomputed hash when one side looks multipart. */
  private async compareOne(items: VerifyItem[], trees: Array<Map<string, string>>, relPath: string): Promise<boolean> {
    const checksums = await Promise.all(
      items.map(async (item, i) => {
        const provider = await getProvider(item.connectionId)
        if (!provider.checksum) return null
        return provider.checksum(trees[i].get(relPath)!)
      })
    )
    if (checksums.every((c) => c !== null) && checksums.every((c) => c === checksums[0])) return true

    const multipartIdx = checksums.findIndex((c) => typeof c === 'string' && looksMultipart(c))
    if (multipartIdx === -1) return false

    const reconciled = await Promise.all(
      items.map(async (item, i) => {
        if (i === multipartIdx) return checksums[i]
        if (typeof checksums[i] !== 'string' || looksMultipart(checksums[i] as string)) return checksums[i]
        const provider = await getProvider(item.connectionId)
        if (!provider.checksum) return checksums[i]
        return provider.checksum(trees[i].get(relPath)!, { partSizeBytes: S3_MULTIPART_PART_SIZE })
      })
    )
    return reconciled.every((c) => c !== null) && reconciled.every((c) => c === reconciled[0])
  }
}

export const verifyEngine = new VerifyEngine()
