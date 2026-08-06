import { EventEmitter } from 'events'
import type { Provider } from '../providers/types'
import type {
  SyncTask,
  SyncPreviewItem,
  SyncAction,
  SyncRunStats,
  SyncConflictResolution
} from '@shared/types'
import { readSyncDb, writeSyncDb, type SyncDb, type SyncDbEntry } from './db'

interface RemoteEntry {
  size: number
  mtime: number
}

type FileMap = Map<string, RemoteEntry>

function buildAbsPath(provider: Provider, rootPath: string, relPath: string): string {
  if (!relPath) return rootPath
  const parts = relPath.split('/').filter(Boolean)
  if (!rootPath) return parts.join('/')
  return provider.join(rootPath, ...parts)
}

async function listRecursive(
  provider: Provider,
  dirPath: string,
  base: string,
  result: FileMap,
  onFile?: (rel: string) => void,
  cancelToken?: { canceled: boolean },
  syncHidden?: boolean
): Promise<void> {
  if (cancelToken?.canceled) return
  const listing = await provider.list(dirPath || '')
  for (const entry of listing.entries) {
    if (cancelToken?.canceled) return
    if (!syncHidden && entry.name.startsWith('.')) continue
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      await listRecursive(provider, entry.path, rel, result, onFile, cancelToken, syncHidden)
    } else {
      const mtime = entry.modified ? new Date(entry.modified).getTime() : 0
      result.set(rel, { size: entry.size ?? 0, mtime })
      onFile?.(rel)
    }
  }
}

function computePlan(
  leftMap: FileMap,
  rightMap: FileMap,
  db: SyncDb,
  mode: SyncTask['mode'],
  conflictResolution: SyncConflictResolution,
  propagateDeletions: boolean
): SyncPreviewItem[] {
  const items: SyncPreviewItem[] = []
  const allPaths = new Set([...leftMap.keys(), ...rightMap.keys()])

  for (const path of allPaths) {
    const left = leftMap.get(path)
    const right = rightMap.get(path)
    const dbEntry: SyncDbEntry | undefined = db[path]

    let action: SyncAction = 'unchanged'
    let conflictWinner: SyncPreviewItem['conflictWinner']

    if (mode === 'mirror' || mode === 'copy') {
      if (left && !right) {
        action = 'copy-to-right'
      } else if (left && right) {
        // +2s tolerance for filesystem clock skew
        if (left.mtime > right.mtime + 2000 || left.size !== right.size) {
          action = 'copy-to-right'
        }
      } else if (!left && right && mode === 'mirror' && propagateDeletions) {
        action = 'delete-right'
      }
    } else {
      // two-way or merge
      if (left && !right) {
        if (dbEntry) {
          // File was previously synced — now missing on right
          if (propagateDeletions && mode === 'two-way') action = 'delete-left'
        } else {
          action = 'copy-to-right'
        }
      } else if (!left && right) {
        if (dbEntry) {
          if (propagateDeletions && mode === 'two-way') action = 'delete-right'
        } else {
          action = 'copy-to-left'
        }
      } else if (left && right) {
        const leftChanged = !dbEntry || Math.abs(left.mtime - dbEntry.mtime) > 2000 || left.size !== dbEntry.size
        const rightChanged = !dbEntry || Math.abs(right.mtime - dbEntry.mtime) > 2000 || right.size !== dbEntry.size

        if (leftChanged && !rightChanged) {
          action = 'copy-to-right'
        } else if (!leftChanged && rightChanged) {
          action = 'copy-to-left'
        } else if (leftChanged && rightChanged) {
          action = 'conflict'
          if (conflictResolution === 'newer') {
            conflictWinner = left.mtime >= right.mtime ? 'left' : 'right'
            action = conflictWinner === 'left' ? 'copy-to-right' : 'copy-to-left'
          } else if (conflictResolution === 'larger') {
            conflictWinner = left.size >= right.size ? 'left' : 'right'
            action = conflictWinner === 'left' ? 'copy-to-right' : 'copy-to-left'
          } else if (conflictResolution === 'keep-both') {
            conflictWinner = 'keep-both'
          } else {
            // 'ask' — flag for user review, default to skip
            conflictWinner = 'skip'
          }
        }
      }
    }

    items.push({
      path,
      action,
      leftSize: left?.size,
      leftModified: left ? new Date(left.mtime).toISOString() : undefined,
      rightSize: right?.size,
      rightModified: right ? new Date(right.mtime).toISOString() : undefined,
      conflictWinner,
      excluded: false
    })
  }

  // Sort: conflicts first, then actionable items, then unchanged
  const order: Record<SyncAction, number> = {
    conflict: 0,
    'copy-to-right': 1,
    'copy-to-left': 2,
    'delete-right': 3,
    'delete-left': 4,
    unchanged: 5
  }
  return items.sort((a, b) => {
    const ao = order[a.action]
    const bo = order[b.action]
    if (ao !== bo) return ao - bo
    return a.path.localeCompare(b.path)
  })
}

class SyncEngine extends EventEmitter {
  async scan(
    taskId: string,
    task: SyncTask,
    leftProvider: Provider,
    rightProvider: Provider
  ): Promise<SyncPreviewItem[]> {
    const cancelToken = { canceled: false }
    const onCancel = (): void => { cancelToken.canceled = true }
    this.once(`cancel:${taskId}`, onCancel)

    try {
      // One-way modes: scan left only, then stat each right path individually.
      // This avoids listing a potentially huge destination directory that would
      // produce thousands of irrelevant "unchanged" entries.
      if (task.mode === 'copy' || task.mode === 'mirror') {
        return await this.scanOneWay(taskId, task, leftProvider, rightProvider, cancelToken)
      }

      // Two-way modes need the full picture from both sides.
      let scanned = 0
      const onFile = (path: string): void => {
        scanned++
        this.emit('progress', { taskId, phase: 'scanning', current: scanned, total: 0, currentPath: path })
      }
      const leftMap: FileMap = new Map()
      const rightMap: FileMap = new Map()
      await Promise.all([
        listRecursive(leftProvider, task.leftPath, '', leftMap, onFile, cancelToken, task.syncHiddenFiles),
        listRecursive(rightProvider, task.rightPath, '', rightMap, onFile, cancelToken, task.syncHiddenFiles)
      ])
      if (cancelToken.canceled) throw new Error('Canceled')
      const db = await readSyncDb(taskId)
      return computePlan(leftMap, rightMap, db, task.mode, task.conflictResolution, task.propagateDeletions)
    } finally {
      this.removeListener(`cancel:${taskId}`, onCancel)
    }
  }

  // For copy/mirror: scan source (left) only, then stat each corresponding
  // destination path. Only files that exist on the source appear in the result,
  // plus right-only files that mirror mode would delete.
  private async scanOneWay(
    taskId: string,
    task: SyncTask,
    leftProvider: Provider,
    rightProvider: Provider,
    cancelToken: { canceled: boolean }
  ): Promise<SyncPreviewItem[]> {
    let scanned = 0
    const onFile = (path: string): void => {
      scanned++
      this.emit('progress', { taskId, phase: 'scanning', current: scanned, total: 0, currentPath: path })
    }

    // Step 1: Full recursive scan of left (source only).
    const leftMap: FileMap = new Map()
    await listRecursive(leftProvider, task.leftPath, '', leftMap, onFile, cancelToken, task.syncHiddenFiles)
    if (cancelToken.canceled) throw new Error('Canceled')

    const db = await readSyncDb(taskId)
    const items: SyncPreviewItem[] = []

    // Step 2: For each left file, stat the corresponding right path.
    for (const [rel, leftEntry] of leftMap) {
      if (cancelToken.canceled) throw new Error('Canceled')
      let rightEntry: RemoteEntry | null = null
      try {
        const stat = await rightProvider.stat(buildAbsPath(rightProvider, task.rightPath, rel))
        rightEntry = { size: stat.size ?? 0, mtime: stat.modified ? new Date(stat.modified).getTime() : 0 }
      } catch {
        // File doesn't exist on right — that's fine, we'll copy it.
      }

      let action: SyncAction = 'unchanged'
      if (!rightEntry) {
        action = 'copy-to-right'
      } else if (leftEntry.size !== rightEntry.size || leftEntry.mtime > rightEntry.mtime + 2000) {
        // For two-way awareness in mirror mode: if left matches DB (not changed on left)
        // but right differs from DB (changed on right), don't overwrite the newer right file.
        const dbEntry = db[rel]
        const leftMatchesDb = dbEntry &&
          Math.abs(leftEntry.mtime - dbEntry.mtime) <= 2000 &&
          leftEntry.size === dbEntry.size
        const rightChangedFromDb = dbEntry &&
          (Math.abs(rightEntry.mtime - dbEntry.mtime) > 2000 || rightEntry.size !== dbEntry.size)
        if (task.mode === 'mirror' && leftMatchesDb && rightChangedFromDb) {
          action = 'unchanged' // Right was updated independently — mirror skips it
        } else {
          action = 'copy-to-right'
        }
      }

      items.push({
        path: rel,
        action,
        leftSize: leftEntry.size,
        leftModified: new Date(leftEntry.mtime).toISOString(),
        rightSize: rightEntry?.size,
        rightModified: rightEntry ? new Date(rightEntry.mtime).toISOString() : undefined,
        excluded: false
      })
    }

    // Step 3: For mirror mode, find right-only files to delete.
    // We need a partial right-side listing to find files that exist on right but not left.
    if (task.mode === 'mirror' && task.propagateDeletions) {
      const rightMap: FileMap = new Map()
      const leftPaths = new Set(leftMap.keys())
      await listRecursive(rightProvider, task.rightPath, '', rightMap, onFile, cancelToken, task.syncHiddenFiles)
      for (const [rel, rightEntry] of rightMap) {
        if (!leftPaths.has(rel)) {
          items.push({
            path: rel,
            action: 'delete-right',
            rightSize: rightEntry.size,
            rightModified: new Date(rightEntry.mtime).toISOString(),
            excluded: false
          })
        }
      }
    }

    // Sort actionable first.
    const order: Record<SyncAction, number> = {
      conflict: 0, 'copy-to-right': 1, 'copy-to-left': 2,
      'delete-right': 3, 'delete-left': 4, unchanged: 5
    }
    return items.sort((a, b) => {
      const ao = order[a.action]; const bo = order[b.action]
      if (ao !== bo) return ao - bo
      return a.path.localeCompare(b.path)
    })
  }

  async execute(
    taskId: string,
    task: SyncTask,
    items: SyncPreviewItem[],
    leftProvider: Provider,
    rightProvider: Provider
  ): Promise<SyncRunStats> {
    const cancelToken = { canceled: false }
    const onCancel = (): void => { cancelToken.canceled = true }
    this.once(`cancel:${taskId}`, onCancel)

    const stats: SyncRunStats = {
      copied: 0, deleted: 0, conflicts: 0, skipped: 0, errors: 0,
      bytesTransferred: 0, durationMs: 0
    }
    const startTime = Date.now()
    const db = await readSyncDb(taskId)
    const newDb: SyncDb = { ...db }

    const actionable = items.filter((item) => !item.excluded && item.action !== 'unchanged')
    const total = actionable.length

    try {
      for (let i = 0; i < actionable.length; i++) {
        if (cancelToken.canceled) break
        const item = actionable[i]
        this.emit('progress', { taskId, phase: 'executing', current: i, total, currentPath: item.path })

        try {
          await this.executeItem(item, task, leftProvider, rightProvider, stats)

          if (item.action === 'copy-to-right' || item.action === 'copy-to-left') {
            const winnerProvider = item.action === 'copy-to-right' ? rightProvider : leftProvider
            const winnerRoot = item.action === 'copy-to-right' ? task.rightPath : task.leftPath
            try {
              const entry = await winnerProvider.stat(buildAbsPath(winnerProvider, winnerRoot, item.path))
              newDb[item.path] = {
                size: entry.size,
                mtime: entry.modified ? new Date(entry.modified).getTime() : 0
              }
            } catch {
              const srcSize = item.action === 'copy-to-right' ? item.leftSize : item.rightSize
              const srcMod = item.action === 'copy-to-right' ? item.leftModified : item.rightModified
              newDb[item.path] = {
                size: srcSize ?? 0,
                mtime: srcMod ? new Date(srcMod).getTime() : 0
              }
            }
          } else if (item.action === 'delete-right' || item.action === 'delete-left') {
            delete newDb[item.path]
          }
        } catch (err) {
          stats.errors++
          this.emit('itemError', { taskId, path: item.path, error: (err as Error).message })
        }
      }
    } finally {
      this.removeListener(`cancel:${taskId}`, onCancel)
    }

    stats.durationMs = Date.now() - startTime
    await writeSyncDb(taskId, newDb)
    this.emit('progress', { taskId, phase: 'executing', current: total, total })
    return stats
  }

  private async executeItem(
    item: SyncPreviewItem,
    task: SyncTask,
    leftProvider: Provider,
    rightProvider: Provider,
    stats: SyncRunStats
  ): Promise<void> {
    // When includeRootFolder is on, wrap destination paths inside the source folder name.
    const leftFolderName = task.leftPath.split('/').filter(Boolean).pop() ?? ''
    const rightFolderName = task.rightPath.split('/').filter(Boolean).pop() ?? ''

    function dstRelPath(action: SyncAction, relPath: string): string {
      if (!task.includeRootFolder) return relPath
      const prefix = action === 'copy-to-right' ? leftFolderName : rightFolderName
      return prefix ? `${prefix}/${relPath}` : relPath
    }

    if (item.action === 'copy-to-right' || item.action === 'copy-to-left') {
      const srcProvider = item.action === 'copy-to-right' ? leftProvider : rightProvider
      const dstProvider = item.action === 'copy-to-right' ? rightProvider : leftProvider
      const srcRoot = item.action === 'copy-to-right' ? task.leftPath : task.rightPath
      const dstRoot = item.action === 'copy-to-right' ? task.rightPath : task.leftPath

      const srcPath = buildAbsPath(srcProvider, srcRoot, item.path)
      const dstRel = dstRelPath(item.action, item.path)

      // Ensure parent directories exist on destination
      const slashIdx = dstRel.lastIndexOf('/')
      if (slashIdx > 0) {
        const relParent = dstRel.slice(0, slashIdx)
        const dstParent = buildAbsPath(dstProvider, dstRoot, relParent)
        try { await dstProvider.mkdir(dstParent) } catch { /* may already exist */ }
      }

      if (item.conflictWinner === 'keep-both') {
        const dot = item.path.lastIndexOf('.')
        const hasExt = dot > item.path.lastIndexOf('/')
        const base = hasExt ? item.path.slice(0, dot) : item.path
        const ext = hasExt ? item.path.slice(dot) : ''
        const conflictPath = buildAbsPath(leftProvider, task.leftPath, item.path)
        const conflictDstRel = dstRelPath('copy-to-right', `${base}_left${ext}`)
        const destPath = buildAbsPath(rightProvider, task.rightPath, conflictDstRel)
        const { stream, size } = await leftProvider.createReadStream(conflictPath)
        let lastBytes = 0
        await rightProvider.writeFile(destPath, stream, size, (b) => {
          stats.bytesTransferred += b - lastBytes
          lastBytes = b
        })
        stats.conflicts++
      } else {
        const dstPath = buildAbsPath(dstProvider, dstRoot, dstRel)
        const { stream, size } = await srcProvider.createReadStream(srcPath)
        let lastBytes = 0
        await dstProvider.writeFile(dstPath, stream, size, (b) => {
          stats.bytesTransferred += b - lastBytes
          lastBytes = b
        })
        stats.copied++
      }
    } else if (item.action === 'delete-right') {
      const path = buildAbsPath(rightProvider, task.rightPath, item.path)
      await rightProvider.delete(path, 'file')
      stats.deleted++
    } else if (item.action === 'delete-left') {
      const path = buildAbsPath(leftProvider, task.leftPath, item.path)
      await leftProvider.delete(path, 'file')
      stats.deleted++
    } else if (item.action === 'conflict') {
      stats.skipped++
    }
  }

  cancel(taskId: string): void {
    this.emit(`cancel:${taskId}`)
  }
}

export const syncEngine = new SyncEngine()
