import type { FileEntry } from '@shared/types'
import { compileQuery } from '@shared/search'
import type { SearchRequest, SearchResult, SearchProgress, SearchDone } from '@shared/search'
import { isJunkEntryName } from './junkFiles'
import { getProvider } from './providers'
import type { Provider } from './providers/types'

/** Stop listing after this many matches — the UI can't usefully show more. */
const MAX_RESULTS = 50_000
/** Largest listing worth keeping in memory (≈150 MB at this size). */
const MAX_CACHED_ENTRIES = 500_000
/** How long a cached index is trusted before a search re-scans. */
const CACHE_TTL_MS = 10 * 60_000
const EMIT_MS = 120
const STAT_CONCURRENCY = 32
const GENERIC_WALK_CONCURRENCY = 4

export interface SearchSink {
  batch(searchId: string, results: SearchResult[]): void
  progress(p: SearchProgress): void
  done(d: SearchDone): void
}

interface CachedIndex {
  root: string
  entries: FileEntry[]
  at: number
  /** Dot-folders were not descended into, so a hidden-files search can't reuse this. */
  hiddenSkipped: boolean
}

/** Per-connection listings kept in memory so repeat searches are instant. */
const indexCache = new Map<string, CachedIndex[]>()

const active = new Map<string, AbortController>()

export function cancelSearch(searchId: string): void {
  active.get(searchId)?.abort()
}

export function cancelAllSearches(): void {
  for (const c of active.values()) c.abort()
}

export function invalidateSearchCache(connectionId: string): void {
  indexCache.delete(connectionId)
}

function normRoot(root: string): string {
  // A bare '/' is a real location on SFTP (filesystem root) — keep it.
  return root === '/' ? '/' : root.replace(/\/+$/, '')
}

function isUnder(root: string, path: string): boolean {
  return root === '' || root === '/' || path === root || path.startsWith(root + '/')
}

/** A fresh cached index whose root contains the requested root, if any. */
function findCache(connectionId: string, root: string, includeHidden: boolean): CachedIndex | null {
  const list = indexCache.get(connectionId)
  if (!list) return null
  const now = Date.now()
  const fresh = list.filter((c) => now - c.at < CACHE_TTL_MS)
  if (fresh.length !== list.length) indexCache.set(connectionId, fresh)
  // Prefer the tightest root that still covers the request.
  let best: CachedIndex | null = null
  for (const c of fresh) {
    if (includeHidden && c.hiddenSkipped) continue
    if (isUnder(c.root, root) && (!best || c.root.length > best.root.length)) best = c
  }
  return best
}

function storeCache(connectionId: string, root: string, entries: FileEntry[], hiddenSkipped: boolean): void {
  const list = (indexCache.get(connectionId) ?? []).filter((c) => c.root !== root)
  list.push({ root, entries, at: Date.now(), hiddenSkipped })
  indexCache.set(connectionId, list)
}

/** Folder-by-folder walk through list() for providers without a native walk(). */
async function genericWalk(
  provider: Provider,
  root: string,
  onEntries: (entries: FileEntry[]) => void,
  opts: { signal: AbortSignal; skipHiddenDirs: boolean; onFolders: (done: number, queued: number) => void },
  failed: { count: number }
): Promise<void> {
  const queue: string[] = [root]
  let queued = 1
  let done = 0
  let activeWorkers = 0

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (opts.signal.aborted) {
        if (activeWorkers === 0) resolve()
        return
      }
      while (activeWorkers < GENERIC_WALK_CONCURRENCY && queue.length > 0) {
        const dir = queue.shift()!
        activeWorkers++
        void provider
          .list(dir)
          .then((res) => {
            for (const e of res.entries) {
              if (e.kind === 'directory' && !(e.name.startsWith('.') && opts.skipHiddenDirs)) {
                queue.push(e.path)
                queued++
              }
            }
            if (res.entries.length) onEntries(res.entries)
          })
          .catch(() => {
            failed.count++
          })
          .finally(() => {
            activeWorkers--
            done++
            opts.onFolders(done, queued)
            if (activeWorkers === 0 && queue.length === 0) resolve()
            else pump()
          })
      }
      if (activeWorkers === 0 && queue.length === 0) resolve()
    }
    pump()
  })
}

export async function runSearch(req: SearchRequest, sink: SearchSink): Promise<void> {
  const started = Date.now()
  const controller = new AbortController()
  active.get(req.searchId)?.abort()
  active.set(req.searchId, controller)
  const { signal } = controller

  const q = compileQuery(req.filters)
  const includeHidden = req.filters.includeHidden
  const root = normRoot(req.rootPath)

  let scanned = 0
  let matches = 0
  let foldersDone = 0
  let foldersQueued = 0
  let truncated = false
  let fromCache = false
  let cachedAt: number | undefined
  let error: string | undefined
  const failed = { count: 0 }

  let provider: Provider | null = null
  const out: SearchResult[] = []
  const statBacklog: FileEntry[] = []
  let statRunner: Promise<void> | null = null

  const flush = (): void => {
    if (out.length) sink.batch(req.searchId, out.splice(0, out.length))
  }
  const emitProgress = (): void => {
    sink.progress({ searchId: req.searchId, scanned, matches, foldersDone, foldersQueued, elapsedMs: Date.now() - started })
  }
  const timer = setInterval(() => {
    flush()
    emitProgress()
  }, EMIT_MS)

  const addMatch = (e: FileEntry): void => {
    matches++
    out.push({
      name: e.name,
      path: e.path,
      dir: provider?.parent(e.path) ?? '',
      kind: e.kind,
      size: Math.max(0, e.size),
      modified: e.modified
    })
    if (matches >= MAX_RESULTS) {
      truncated = true
      controller.abort()
    }
  }

  // Entries from walkers that skip stat (size === -1), or that need size/date
  // filtering, are stat'd here — only the few that already matched by name.
  const drainStats = async (): Promise<void> => {
    while (statBacklog.length > 0 && !signal.aborted) {
      const chunk = statBacklog.splice(0, STAT_CONCURRENCY)
      await Promise.all(
        chunk.map(async (e) => {
          let full = e
          if (e.size < 0) {
            try {
              full = await provider!.stat(e.path)
              full = { ...e, size: full.size, modified: full.modified }
            } catch {
              full = { ...e, size: 0 }
            }
          }
          if (signal.aborted) return
          if (q.needsStat && !q.matchesStat(full.size, full.modified, full.kind)) return
          if (matches < MAX_RESULTS) addMatch(full)
        })
      )
    }
  }
  const kickStats = (): void => {
    if (!statRunner) {
      statRunner = drainStats().finally(() => {
        statRunner = null
        if (statBacklog.length > 0 && !signal.aborted) kickStats()
      })
    }
  }

  let collected: FileEntry[] | null = []

  const onEntries = (entries: FileEntry[]): void => {
    for (const e of entries) {
      if (signal.aborted) return
      scanned++
      if (collected) {
        if (e.size < 0 || collected.length >= MAX_CACHED_ENTRIES) collected = null
        else collected.push(e)
      }
      if (!includeHidden && isJunkEntryName(e.name)) continue
      if (!q.matchesName(e)) continue
      if (e.size < 0) {
        statBacklog.push(e)
        kickStats()
      } else if (q.needsStat) {
        if (!q.matchesStat(e.size, e.modified, e.kind)) continue
        addMatch(e)
      } else {
        addMatch(e)
      }
    }
  }

  try {
    provider = await getProvider(req.connectionId)
    const cacheable = provider.connection.type !== 'local'
    const hit = !req.refresh && cacheable ? findCache(req.connectionId, root, includeHidden) : null

    if (hit) {
      fromCache = true
      cachedAt = hit.at
      collected = null
      const slice = hit.root === root ? hit.entries : null
      const all = hit.entries
      for (let i = 0; i < all.length && !signal.aborted; i += 5000) {
        const chunk = all.slice(i, i + 5000)
        onEntries(slice ? chunk : chunk.filter((e) => isUnder(root, e.path) && e.path !== root))
        // Yield so cancel + progress timers can run on huge indexes.
        await new Promise<void>((r) => setImmediate(r))
      }
    } else {
      const opts = {
        signal,
        skipHiddenDirs: !includeHidden,
        onFolders: (d: number, qd: number): void => {
          foldersDone = d
          foldersQueued = qd
        }
      }
      if (provider.walk) await provider.walk(root, onEntries, opts)
      else await genericWalk(provider, root, onEntries, opts, failed)

      // Only a walk that ran to completion is a trustworthy index.
      if (cacheable && collected && !signal.aborted) storeCache(req.connectionId, root, collected, !includeHidden && !provider.walk)
    }

    while (statRunner) await statRunner
  } catch (err) {
    if (!signal.aborted) error = err instanceof Error ? err.message : String(err)
  } finally {
    clearInterval(timer)
    active.delete(req.searchId)
  }

  // A cap-triggered abort isn't a user cancel.
  const cancelled = signal.aborted && !truncated
  flush()
  const warnings = [...q.warnings]
  if (failed.count > 0) warnings.push(`${failed.count} folder${failed.count === 1 ? '' : 's'} couldn't be read and were skipped`)
  emitProgress()
  sink.done({
    searchId: req.searchId,
    scanned,
    matches,
    elapsedMs: Date.now() - started,
    truncated,
    cancelled,
    error,
    fromCache,
    cachedAt,
    warnings
  })
}
