import { EventEmitter } from 'events'
import type { TransferItem, TransferRequest } from '@shared/types'
import { getProvider, type Provider } from '../providers'
import { log } from '../logger'

function fmtBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/**
 * Queue-based transfer engine. Each enqueued item is a single file copy;
 * directories are expanded into their constituent files up front. Files are
 * streamed source→dest so large transfers never buffer fully in memory.
 *
 * Emits:
 *   'update'  (item: TransferItem)   — progress / status change for one item
 *   'added'   (items: TransferItem[]) — new items appended to the queue
 */
class TransferEngine extends EventEmitter {
  private queue: TransferItem[] = []
  private byId = new Map<string, TransferItem>()
  private canceled = new Set<string>()
  private activeStreams = new Map<string, import('stream').Readable>()
  private running = 0
  private concurrency = 5
  private seq = 0
  private progressTimer: ReturnType<typeof setInterval> | null = null

  /** Update the max simultaneous transfers at runtime (persisted by caller). */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(20, n))
    this.pump()
  }

  /** Poll active items every 250 ms and emit a batch update to the renderer.
   *  Cyberduck uses the same timer-based approach: I/O threads only update
   *  counters, a separate timer reads them and pushes to the UI. */
  private startProgressTimer(): void {
    if (this.progressTimer !== null) return
    this.progressTimer = setInterval(() => {
      const active = this.queue.filter((it) => it.status === 'transferring')
      if (active.length === 0) {
        this.stopProgressTimer()
        return
      }
      this.emit('update', active)
    }, 250)
  }

  private stopProgressTimer(): void {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer)
      this.progressTimer = null
    }
  }

  private nextId(): string {
    this.seq += 1
    return `t${Date.now().toString(36)}-${this.seq}`
  }

  getAll(): TransferItem[] {
    return [...this.queue]
  }

  /**
   * Expand a request into file-level items and start processing.
   * Returns immediately — discovery walks in the background, streaming items
   * via 'added' events so the app stays responsive with large directories.
   */
  async enqueue(req: TransferRequest): Promise<void> {
    void this.walkAndEnqueue(req)
  }

  private async walkAndEnqueue(req: TransferRequest): Promise<void> {
    let source: Provider
    let dest: Provider
    try {
      source = await getProvider(req.sourceConnectionId)
      dest = await getProvider(req.destConnectionId)
    } catch (err) {
      log.error('transfer', `Cannot resolve providers: ${(err as Error).message}`)
      return
    }

    const pending: TransferItem[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null }
      if (!pending.length) return
      const batch = pending.splice(0)

      // Dedup: skip anything whose dest path is already in the queue.
      const existingDests = new Set(
        this.queue
          .filter((it) => it.status !== 'error' && it.status !== 'canceled')
          .map((it) => it.dest.path)
      )
      const deduped = batch.filter((it) => !existingDests.has(it.dest.path))
      const skipped = batch.length - deduped.length
      if (skipped > 0) log.info('transfer', `Skipped ${skipped} already-queued/done file(s)`)
      if (!deduped.length) return

      this.queue.push(...deduped)
      for (const it of deduped) this.byId.set(it.id, it)
      this.emit('added', deduped)
      this.pump()
    }

    const add = (item: TransferItem): void => {
      pending.push(item)
      // Flush in batches of 50 or after 100 ms, whichever comes first.
      if (pending.length >= 50) {
        flush()
      } else if (flushTimer === null) {
        flushTimer = setTimeout(flush, 100)
      }
    }

    try {
      for (const srcPath of req.sourcePaths) {
        const stat = await source.stat(srcPath)
        let baseName = stat.name
        if (req.conflictPolicy === 'keepBoth') {
          baseName = await this.uniqueName(dest, req.destDir, baseName)
        }
        if (stat.kind === 'file') {
          add(this.makeItem(req, source, dest, srcPath, dest.join(req.destDir, baseName), baseName, stat.size))
        } else {
          await this.walkStream(source, dest, srcPath, dest.join(req.destDir, baseName), req, add)
        }
      }
    } catch (err) {
      log.error('transfer', `Failed to enumerate source paths: ${(err as Error).message}`)
    } finally {
      flush()
      const policy = req.conflictPolicy ? ` (${req.conflictPolicy === 'keepBoth' ? 'keep both' : 'replace'})` : ''
      log.info('transfer', `Enumeration complete → "${req.destDir || '/'}"${policy}`)
    }
  }

  private async walkStream(
    source: Provider,
    dest: Provider,
    srcDir: string,
    destDir: string,
    req: TransferRequest,
    add: (item: TransferItem) => void
  ): Promise<void> {
    const { entries } = await source.list(srcDir)
    if (entries.length === 0) {
      await dest.mkdir(destDir)
      return
    }
    for (const entry of entries) {
      const destPath = dest.join(destDir, entry.name)
      if (entry.kind === 'directory') {
        await this.walkStream(source, dest, entry.path, destPath, req, add)
      } else {
        add(this.makeItem(req, source, dest, entry.path, destPath, entry.name, entry.size))
      }
    }
  }

  private makeItem(
    req: TransferRequest,
    _source: Provider,
    _dest: Provider,
    srcPath: string,
    destPath: string,
    name: string,
    size: number
  ): TransferItem {
    return {
      id: this.nextId(),
      name,
      source: { connectionId: req.sourceConnectionId, path: srcPath },
      dest: { connectionId: req.destConnectionId, path: destPath },
      kind: 'file',
      bytesTotal: size,
      bytesDone: 0,
      status: 'queued'
    }
  }

  /** Find a destination name that doesn't collide (e.g. "clip 2.mov"). */
  private async uniqueName(dest: Provider, dir: string, name: string): Promise<string> {
    if (!(await dest.exists(dest.join(dir, name)))) return name
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} ${i}${ext}`
      if (!(await dest.exists(dest.join(dir, candidate)))) return candidate
    }
    return `${base} ${Date.now()}${ext}`
  }

  /** Remove a finished item from engine memory after a delay to bound RAM usage. */
  private scheduleEviction(id: string): void {
    setTimeout(() => {
      const item = this.byId.get(id)
      if (!item || item.status === 'queued' || item.status === 'transferring') return
      const idx = this.queue.indexOf(item)
      if (idx >= 0) this.queue.splice(idx, 1)
      this.byId.delete(id)
      this.canceled.delete(id)
    }, 90_000)
  }

  cancel(id: string): void {
    this.canceled.add(id)
    // Immediately destroy any in-flight stream so the transfer stops without
    // waiting for the next onProgress callback (which may never fire if stalled).
    this.activeStreams.get(id)?.destroy(new Error('canceled'))
    this.activeStreams.delete(id)
    const item = this.byId.get(id)
    if (item && (item.status === 'queued' || item.status === 'transferring')) {
      item.status = 'canceled'
      item.finishedAt = Date.now()
      this.emit('update', [item])
      this.scheduleEviction(id)
    }
  }

  cancelAll(): void {
    for (const it of this.queue) {
      if (it.status === 'queued' || it.status === 'transferring') this.cancel(it.id)
    }
  }

  /** Re-enqueue a failed or canceled item as a fresh transfer. */
  retry(id: string): void {
    const item = this.byId.get(id)
    if (!item || item.kind !== 'file') return
    if (item.status !== 'error' && item.status !== 'canceled') return
    void this.enqueue({
      sourceConnectionId: item.source.connectionId,
      destConnectionId: item.dest.connectionId,
      sourcePaths: [item.source.path],
      destDir: item.dest.path.includes('/') || item.dest.path.includes('\\')
        ? item.dest.path.substring(0, item.dest.path.lastIndexOf(item.dest.path.includes('/') ? '/' : '\\'))
        : '',
      conflictPolicy: 'replace'
    })
  }

  /** Remove finished/errored/canceled items from the visible queue. */
  clearFinished(): void {
    this.queue = this.queue.filter(
      (it) => it.status === 'queued' || it.status === 'transferring'
    )
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = this.queue.find((it) => it.status === 'queued' && !this.canceled.has(it.id))
      if (!next) break
      this.running += 1
      void this.run(next).finally(() => {
        this.running -= 1
        this.pump()
      })
    }
  }

  /**
   * Track a fast filesystem operation (delete, rename, mkdir) as a transfer-panel
   * item so the user can see every mutation in one place.
   *
   * @param dedupKey  Optional unique key (e.g. the source path). If an existing
   *                  non-failed operation with the same key is already in the queue,
   *                  this call is skipped to prevent duplicate entries.
   */
  async trackOperation(label: string, action: () => Promise<void>, dedupKey = ''): Promise<void> {
    if (dedupKey) {
      const already = this.queue.find(
        (it) =>
          it.kind === 'operation' &&
          it.source.path === dedupKey &&
          it.status !== 'error' &&
          it.status !== 'canceled'
      )
      if (already) {
        log.info('transfer', `Skipped duplicate operation: ${label}`)
        return
      }
    }

    const item: TransferItem = {
      id: this.nextId(),
      name: label,
      source: { connectionId: '', path: dedupKey },
      dest: { connectionId: '', path: '' },
      kind: 'operation',
      bytesTotal: 0,
      bytesDone: 0,
      status: 'transferring',
      startedAt: Date.now()
    }
    this.queue.push(item)
    this.byId.set(item.id, item)
    this.emit('added', [item])
    try {
      await action()
      item.status = 'done'
    } catch (err) {
      item.status = 'error'
      item.error = (err as Error).message
      throw err
    } finally {
      item.finishedAt = Date.now()
      this.emit('update', [item])
    }
  }

  private async run(item: TransferItem): Promise<void> {
    if (this.canceled.has(item.id)) return
    item.status = 'transferring'
    item.startedAt = Date.now()
    item.bytesDone = 0
    // Immediate emit so the row shows "transferring" without waiting for first timer tick.
    this.emit('update', [item])
    this.startProgressTimer()

    try {
      const source = await getProvider(item.source.connectionId)
      const dest = await getProvider(item.dest.connectionId)

      const { stream, size } = await source.createReadStream(item.source.path)
      // Prefer the size from createReadStream (re-stats the file) over the enqueue-time
      // stat, which can be stale or zero if the file was briefly inaccessible. This
      // prevents passing ContentLength: undefined to the S3 SDK.
      if (size) item.bytesTotal = size
      this.activeStreams.set(item.id, stream)

      // The progress callback ONLY updates counters — no emit, no downstream work.
      // The progressTimer reads these counters every 250 ms and batches the update.
      // This completely decouples I/O throughput from UI update frequency.
      const speedWindow: Array<[number, number]> = [] // [timestamp_ms, cumulative_bytes]
      const SPEED_WINDOW_MS = 5000
      const onProgress = (written: number): void => {
        if (this.canceled.has(item.id)) {
          stream.destroy(new Error('canceled'))
          return
        }
        item.bytesDone = written
        const now = Date.now()
        speedWindow.push([now, written])
        while (speedWindow.length > 1 && speedWindow[0][0] < now - SPEED_WINDOW_MS) speedWindow.shift()
        if (speedWindow.length > 1) {
          const dt = (now - speedWindow[0][0]) / 1000
          const db = written - speedWindow[0][1]
          item.speed = dt > 0.2 ? db / dt : undefined
        }
      }

      await dest.writeFile(item.dest.path, stream, item.bytesTotal, onProgress)

      if (this.canceled.has(item.id)) {
        item.status = 'canceled'
        log.warn('transfer', `Canceled "${item.name}"`)
      } else {
        // Size verification: confirm destination received exactly what we sent.
        if (item.bytesTotal > 0) {
          try {
            const destStat = await dest.stat(item.dest.path)
            if (destStat.size !== undefined && destStat.size !== item.bytesTotal) {
              log.warn('transfer', `Size mismatch for "${item.name}": sent ${fmtBytes(item.bytesTotal)}, destination reports ${fmtBytes(destStat.size)} — transfer may be incomplete`)
            }
          } catch {
            // stat after write is best-effort; don't fail the transfer
          }
        }
        item.status = 'done'
        item.bytesDone = item.bytesTotal
        log.success('transfer', `Copied "${item.name}" (${fmtBytes(item.bytesTotal)}) → "${item.dest.path}"`)
      }
    } catch (err) {
      if (this.canceled.has(item.id)) {
        item.status = 'canceled'
        log.warn('transfer', `Canceled "${item.name}"`)
      } else {
        item.status = 'error'
        item.error = (err as Error).message
        log.error('transfer', `Failed "${item.name}": ${item.error}`)
      }
    } finally {
      this.activeStreams.delete(item.id)
      item.finishedAt = Date.now()
      // Final emit so done/error/canceled status reaches the renderer immediately.
      this.emit('update', [item])
      this.scheduleEviction(item.id)
    }
  }
}

export const transferEngine = new TransferEngine()
