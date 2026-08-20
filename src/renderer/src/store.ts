import { create } from 'zustand'

// Cleanup functions for IPC listeners registered in init().
// Stored outside the store so a re-call to init() can tear down the old ones.
let removeAddedListener: (() => void) | null = null
let removeUpdateListener: (() => void) | null = null
// Track which done-transfer IDs have already triggered a pane refresh so we
// don't re-refresh on every subsequent update event for the same item.
const seenDoneIds = new Set<string>()
import type {
  Connection,
  ConnectionType,
  DriveInfo,
  ListResult,
  TransferItem,
  TransferRequest,
  Bookmark,
  SyncTask,
  SyncPreviewItem,
  SyncProgress,
  SyncRun
} from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'

export type ConflictPolicy = 'replace' | 'skip' | 'keepBoth' | 'cancel'

export interface ConflictPrompt {
  request: TransferRequest
  /** Basenames that already exist at the destination. */
  names: string[]
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || ''
}

export interface PaneState {
  id: string
  connectionId: string | null
  path: string
  result: ListResult | null
  loading: boolean
  error: string | null
  /** Selected entry paths within the current listing. */
  selection: string[]
}

interface AppState {
  connections: Connection[]
  drives: DriveInfo[]
  panes: PaneState[]
  transfers: TransferItem[]
  conflict: ConflictPrompt | null
  bookmarks: Bookmark[]
  /** In-app clipboard for copy/paste of files & folders. */
  clipboard: { connectionId: string; paths: string[]; names: string[] } | null
  /** Whether dotfiles (.DS_Store, .localized, …) are shown. Persisted. */
  showHidden: boolean
  /** File-list font scale (1 = default). Persisted. */
  fontScale: number
  /** UI color theme. Persisted. */
  theme: 'dark' | 'light'
  /**
   * ConnectionIds that had an active pane closed without disconnecting.
   * The provider is still cached on the main process — these are "background"
   * connections that remain live until explicitly disconnected or app quit.
   */
  backgroundConnectionIds: string[]

  init: () => Promise<void>
  toggleShowHidden: () => void
  adjustFontScale: (delta: number) => void
  toggleTheme: () => void
  reloadConnections: () => Promise<void>

  addPane: () => void
  removePane: (paneId: string) => void
  movePane: (fromIndex: number, toIndex: number) => void
  openInNewPane: (connectionId: string, path: string) => Promise<void>

  addBookmark: (name: string, connectionId: string, path: string) => Promise<void>
  removeBookmark: (id: string) => Promise<void>

  setPaneConnection: (paneId: string, connectionId: string | null) => Promise<void>
  disconnectPane: (paneId: string) => Promise<void>
  openLocation: (paneId: string, connectionId: string, path: string) => Promise<void>
  navigate: (paneId: string, path: string) => Promise<void>
  navigateUp: (paneId: string) => Promise<void>
  refreshPane: (paneId: string) => Promise<void>
  setSelection: (paneId: string, selection: string[]) => void

  saveConnection: (conn: Connection) => Promise<Connection>
  deleteConnection: (id: string) => Promise<void>
  toggleFavorite: (id: string) => Promise<void>

  startTransfer: (fromPaneId: string, toPaneId: string, sourcePaths: string[]) => Promise<void>
  /** Check for destination conflicts, prompting if any, then enqueue. */
  requestTransfer: (
    sourceConnectionId: string,
    destConnectionId: string,
    sourcePaths: string[],
    destDir: string,
    deleteSourceAfter?: boolean
  ) => Promise<void>
  resolveConflict: (policy: ConflictPolicy) => Promise<void>
  setTransfers: (items: TransferItem[]) => void
  clearFinishedTransfers: () => Promise<void>
  cancelTransfer: (id: string) => Promise<void>

  copyEntries: (connectionId: string, paths: string[], names: string[]) => void
  pasteInto: (paneId: string) => Promise<void>

  createFolderInPane: (paneId: string, name: string) => Promise<void>
  createFileInPane: (paneId: string, name: string) => Promise<void>
  renameEntry: (paneId: string, path: string, newName: string) => Promise<void>
  deleteEntries: (
    paneId: string,
    entries: { path: string; kind: 'file' | 'directory' }[],
    onItemSettled?: (path: string) => void
  ) => Promise<void>

  // Sync runs (background sync execution tracked in TransferPanel)
  syncRuns: SyncRun[]
  executeSyncInBackground: (task: SyncTask, items: SyncPreviewItem[]) => string
  updateSyncRun: (runId: string, patch: Partial<SyncRun>) => void
  clearFinishedSyncRuns: () => void

  // Sync queue
  syncQueue: SyncTask[]
  addToSyncQueue: (task: SyncTask) => void
  removeFromSyncQueue: (taskId: string) => void
  clearSyncQueue: () => void
  runSyncQueue: () => void
}

function newPane(): PaneState {
  return {
    id: crypto.randomUUID(),
    connectionId: null,
    path: '',
    result: null,
    loading: false,
    error: null,
    selection: []
  }
}

// Module-level sync progress listener (torn down on re-init).
let removeSyncProgressListener: (() => void) | null = null

export const useStore = create<AppState>((set, get) => ({
  connections: [],
  drives: [],
  panes: [newPane(), newPane()],
  transfers: [],
  conflict: null,
  bookmarks: [],
  clipboard: null,
  showHidden:
    typeof localStorage !== 'undefined' && localStorage.getItem('conduit.showHidden') === 'true',
  fontScale:
    typeof localStorage !== 'undefined' ? Number(localStorage.getItem('conduit.fontScale')) || 1 : 1,
  theme:
    typeof localStorage !== 'undefined' && localStorage.getItem('conduit.theme') === 'light' ? 'light' : 'dark',
  backgroundConnectionIds: [],
  syncRuns: [],
  syncQueue: [],

  async init() {
    const [connections, drives, transfers, bookmarks] = await Promise.all([
      window.conduit.connections.getAll(),
      window.conduit.fs.drives(),
      window.conduit.transfer.getAll(),
      window.conduit.bookmarks.getAll()
    ])
    set({ connections, drives, transfers, bookmarks })

    // Remove any listeners left over from a previous init() call (e.g. React
    // StrictMode double-invoke, or future window remounts) before registering new ones.
    removeAddedListener?.()
    removeUpdateListener?.()
    removeAddedListener = window.conduit.transfer.onAdded((items) => {
      set((s) => ({ transfers: [...s.transfers, ...items] }))
    })
    removeUpdateListener = window.conduit.transfer.onUpdate((items) => {
      if (!items.length) return
      const map = new Map(items.map((i) => [i.id, i]))

      // Detect newly-done items and refresh any pane pointing at their destination.
      // Done here (not in App.tsx) so App never needs to subscribe to transfers.
      const destConns = new Set<string>()
      for (const item of items) {
        if (item.status === 'done' && !seenDoneIds.has(item.id)) {
          seenDoneIds.add(item.id)
          destConns.add(item.dest.connectionId)
        }
      }
      if (destConns.size) {
        for (const p of get().panes) {
          if (p.connectionId && destConns.has(p.connectionId)) {
            void get().refreshPane(p.id)
          }
        }
      }

      set((s) => ({
        transfers: s.transfers.map((t) => map.get(t.id) ?? t)
      }))
    })

    removeSyncProgressListener?.()
    removeSyncProgressListener = window.conduit.sync.onProgress((p: SyncProgress) => {
      set((s) => ({
        syncRuns: s.syncRuns.map((r) =>
          r.taskId === p.taskId ? { ...r, progress: p } : r
        )
      }))
    })
  },

  async reloadConnections() {
    set({ connections: await window.conduit.connections.getAll() })
  },

  addPane() {
    set((s) => (s.panes.length >= 5 ? s : { panes: [...s.panes, newPane()] }))
  },

  removePane(paneId) {
    set((s) => {
      if (s.panes.length <= 1) return s
      const pane = s.panes.find((p) => p.id === paneId)
      const bg = [...s.backgroundConnectionIds]
      // If this pane had a live (non-local) connection, keep it in the background pool.
      if (
        pane?.connectionId &&
        pane.connectionId !== BUILTIN_LOCAL_ID &&
        !bg.includes(pane.connectionId)
      ) {
        bg.push(pane.connectionId)
      }
      return { panes: s.panes.filter((p) => p.id !== paneId), backgroundConnectionIds: bg }
    })
  },

  movePane(fromIndex, toIndex) {
    set((s) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= s.panes.length ||
        toIndex >= s.panes.length
      ) {
        return s
      }
      const panes = [...s.panes]
      const [moved] = panes.splice(fromIndex, 1)
      panes.splice(toIndex, 0, moved)
      return { panes }
    })
  },

  toggleShowHidden() {
    set((s) => {
      const showHidden = !s.showHidden
      if (typeof localStorage !== 'undefined') localStorage.setItem('conduit.showHidden', String(showHidden))
      return { showHidden }
    })
  },

  adjustFontScale(delta) {
    set((s) => {
      const fontScale = Math.min(1.6, Math.max(0.8, Math.round((s.fontScale + delta) * 10) / 10))
      if (typeof localStorage !== 'undefined') localStorage.setItem('conduit.fontScale', String(fontScale))
      return { fontScale }
    })
  },

  toggleTheme() {
    set((s) => {
      const theme = s.theme === 'dark' ? 'light' : 'dark'
      if (typeof localStorage !== 'undefined') localStorage.setItem('conduit.theme', theme)
      document.documentElement.setAttribute('data-theme', theme)
      return { theme }
    })
  },

  async openInNewPane(connectionId, path) {
    const pane = newPane()
    set((s) => ({ panes: [...s.panes, pane] }))
    await get().openLocation(pane.id, connectionId, path)
  },

  async addBookmark(name, connectionId, path) {
    const connectionType: ConnectionType =
      connectionId === BUILTIN_LOCAL_ID
        ? 'local'
        : get().connections.find((c) => c.id === connectionId)?.type ?? 'local'
    const bookmark: Bookmark = { id: crypto.randomUUID(), name, connectionId, connectionType, path }
    const bookmarks = await window.conduit.bookmarks.add(bookmark)
    set({ bookmarks })
  },

  async removeBookmark(id) {
    const bookmarks = await window.conduit.bookmarks.remove(id)
    set({ bookmarks })
  },

  async setPaneConnection(paneId, connectionId) {
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId ? { ...p, connectionId, path: '', selection: [], result: null, error: null } : p
      ),
      // Opening a connection in a pane moves it out of the background pool.
      backgroundConnectionIds: s.backgroundConnectionIds.filter((id) => id !== connectionId)
    }))
    if (connectionId) await get().navigate(paneId, '')
  },

  async disconnectPane(paneId) {
    const pane = get().panes.find((p) => p.id === paneId)
    if (pane?.connectionId) {
      // builtin local has no live connection to tear down
      if (pane.connectionId !== BUILTIN_LOCAL_ID) {
        await window.conduit.connections.disconnect(pane.connectionId)
      }
    }
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId
          ? { ...p, connectionId: null, path: '', result: null, error: null, selection: [] }
          : p
      ),
      // Remove from background pool — it's been explicitly disconnected.
      backgroundConnectionIds: s.backgroundConnectionIds.filter(
        (id) => id !== pane?.connectionId
      )
    }))
  },

  async openLocation(paneId, connectionId, path) {
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId
          ? { ...p, connectionId, path, selection: [], result: null, error: null }
          : p
      ),
      backgroundConnectionIds: s.backgroundConnectionIds.filter((id) => id !== connectionId)
    }))
    await get().navigate(paneId, path)
  },

  async navigate(paneId, path) {
    const pane = get().panes.find((p) => p.id === paneId)
    if (!pane || !pane.connectionId) return
    set((s) => ({
      panes: s.panes.map((p) => (p.id === paneId ? { ...p, loading: true, error: null } : p))
    }))
    try {
      const result = await window.conduit.fs.list(pane.connectionId, path)
      set((s) => ({
        panes: s.panes.map((p) =>
          p.id === paneId ? { ...p, path: result.path, result, loading: false, selection: [] } : p
        )
      }))
    } catch (err) {
      set((s) => ({
        panes: s.panes.map((p) =>
          p.id === paneId ? { ...p, loading: false, error: (err as Error).message } : p
        )
      }))
    }
  },

  async navigateUp(paneId) {
    const pane = get().panes.find((p) => p.id === paneId)
    if (!pane || !pane.connectionId) return
    const parent = await window.conduit.fs.parent(pane.connectionId, pane.path)
    if (parent !== null) await get().navigate(paneId, parent)
  },

  async refreshPane(paneId) {
    const pane = get().panes.find((p) => p.id === paneId)
    if (pane && pane.connectionId) await get().navigate(paneId, pane.path)
  },

  setSelection(paneId, selection) {
    set((s) => ({
      panes: s.panes.map((p) => (p.id === paneId ? { ...p, selection } : p))
    }))
  },

  async saveConnection(conn) {
    const saved = await window.conduit.connections.save(conn)
    await get().reloadConnections()
    return saved
  },

  async deleteConnection(id) {
    await window.conduit.connections.remove(id)
    set((s) => ({
      panes: s.panes.map((p) =>
        p.connectionId === id ? { ...p, connectionId: null, result: null, path: '' } : p
      ),
      backgroundConnectionIds: s.backgroundConnectionIds.filter((bgId) => bgId !== id)
    }))
    await get().reloadConnections()
  },

  async toggleFavorite(id) {
    const conn = get().connections.find((c) => c.id === id)
    if (!conn) return
    await window.conduit.connections.save({ ...conn, favorite: !conn.favorite })
    await get().reloadConnections()
  },

  async startTransfer(fromPaneId, toPaneId, sourcePaths) {
    const from = get().panes.find((p) => p.id === fromPaneId)
    const to = get().panes.find((p) => p.id === toPaneId)
    if (!from?.connectionId || !to?.connectionId || sourcePaths.length === 0) return
    await window.conduit.transfer.enqueue({
      sourceConnectionId: from.connectionId,
      destConnectionId: to.connectionId,
      sourcePaths,
      destDir: to.path
    })
  },

  async requestTransfer(sourceConnectionId, destConnectionId, sourcePaths, destDir, deleteSourceAfter?) {
    // Auto-clear finished transfers when starting fresh work.
    const { transfers } = get()
    const hasActive = transfers.some((t) => t.status === 'transferring' || t.status === 'queued')
    if (!hasActive && transfers.length > 0) {
      await get().clearFinishedTransfers()
    }

    const request: TransferRequest = { sourceConnectionId, destConnectionId, sourcePaths, destDir, deleteSourceAfter }
    const names = await window.conduit.transfer.checkConflicts(request)
    if (names.length === 0) {
      await window.conduit.transfer.enqueue(request)
      return
    }
    set({ conflict: { request, names } })
  },

  async resolveConflict(policy) {
    const c = get().conflict
    set({ conflict: null })
    if (!c || policy === 'cancel') return

    let request = c.request
    if (policy === 'skip') {
      const conflicting = new Set(c.names)
      const paths = request.sourcePaths.filter((p) => !conflicting.has(basename(p)))
      if (paths.length === 0) return
      request = { ...request, sourcePaths: paths }
    } else if (policy === 'keepBoth') {
      request = { ...request, conflictPolicy: 'keepBoth' }
    } else {
      request = { ...request, conflictPolicy: 'replace' }
    }
    await window.conduit.transfer.enqueue(request)
  },

  setTransfers(items) {
    set({ transfers: items })
  },

  async clearFinishedTransfers() {
    set((s) => {
      const kept = s.transfers.filter((t) => t.status === 'queued' || t.status === 'transferring')
      // Clean up the refresh-tracking set for items we're removing.
      for (const t of s.transfers) {
        if (t.status !== 'queued' && t.status !== 'transferring') seenDoneIds.delete(t.id)
      }
      return { transfers: kept }
    })
    void window.conduit.transfer.clearFinished()
  },

  async cancelTransfer(id) {
    await window.conduit.transfer.cancel(id)
  },

  copyEntries(connectionId, paths, names) {
    set({ clipboard: { connectionId, paths, names } })
  },

  async pasteInto(paneId) {
    const clip = get().clipboard
    const pane = get().panes.find((p) => p.id === paneId)
    if (!clip || !pane?.connectionId || clip.paths.length === 0) return
    await get().requestTransfer(clip.connectionId, pane.connectionId, clip.paths, pane.path)
  },

  async createFolderInPane(paneId, name) {
    const pane = get().panes.find((p) => p.id === paneId)
    if (!pane?.connectionId) return
    await window.conduit.fs.mkdir(pane.connectionId, pane.path, name)
    await get().refreshPane(paneId)
  },

  async createFileInPane(paneId, name) {
    const pane = get().panes.find((p) => p.id === paneId)
    if (!pane?.connectionId) return
    await window.conduit.fs.createFile(pane.connectionId, pane.path, name)
    await get().refreshPane(paneId)
  },

  async renameEntry(paneId, path, newName) {
    const pane = get().panes.find((p) => p.id === paneId)
    if (!pane?.connectionId) return
    await window.conduit.fs.rename(pane.connectionId, path, newName)
    await get().refreshPane(paneId)
  },

  async deleteEntries(paneId, entries, onItemSettled) {
    const pane = get().panes.find((p) => p.id === paneId)
    if (!pane?.connectionId) return
    try {
      for (const e of entries) {
        try {
          await window.conduit.fs.delete(pane.connectionId, e.path, e.kind)
        } catch {
          // One failed delete (permissions, in-use file, etc.) shouldn't abort
          // the rest of the batch — it's already visible as an errored row in
          // the Transfers panel; keep going so sibling items still get deleted.
        } finally {
          onItemSettled?.(e.path)
        }
      }
    } finally {
      await get().refreshPane(paneId)
    }
  },

  executeSyncInBackground(task, items) {
    const runId = crypto.randomUUID()
    const run: SyncRun = {
      runId,
      taskId: task.id,
      taskName: task.name,
      phase: 'running',
      progress: null,
      stats: null,
      error: null,
      startedAt: Date.now()
    }
    set((s) => ({ syncRuns: [...s.syncRuns, run] }))
    void window.conduit.sync.execute(task.id, task, items).then((stats) => {
      set((s) => ({
        syncRuns: s.syncRuns.map((r) =>
          r.runId === runId ? { ...r, phase: 'done', stats, progress: null } : r
        )
      }))
    }).catch((err: Error) => {
      set((s) => ({
        syncRuns: s.syncRuns.map((r) =>
          r.runId === runId ? { ...r, phase: 'error', error: err.message, progress: null } : r
        )
      }))
    })
    return runId
  },

  updateSyncRun(runId, patch) {
    set((s) => ({
      syncRuns: s.syncRuns.map((r) => r.runId === runId ? { ...r, ...patch } : r)
    }))
  },

  clearFinishedSyncRuns() {
    set((s) => ({ syncRuns: s.syncRuns.filter((r) => r.phase === 'running') }))
  },

  addToSyncQueue(task) {
    set((s) => {
      if (s.syncQueue.find((t) => t.id === task.id)) return s
      return { syncQueue: [...s.syncQueue, task] }
    })
  },

  removeFromSyncQueue(taskId) {
    set((s) => ({ syncQueue: s.syncQueue.filter((t) => t.id !== taskId) }))
  },

  clearSyncQueue() {
    set({ syncQueue: [] })
  },

  runSyncQueue() {
    const queue = get().syncQueue
    if (!queue.length) return
    set({ syncQueue: [] })
    const runNext = (index: number): void => {
      if (index >= queue.length) return
      const task = queue[index]
      const runId = crypto.randomUUID()
      const run: SyncRun = {
        runId, taskId: task.id, taskName: task.name,
        phase: 'running', progress: null, stats: null, error: null, startedAt: Date.now()
      }
      set((s) => ({ syncRuns: [...s.syncRuns, run] }))
      void window.conduit.sync.runPreview(task.id, task).then((items) =>
        window.conduit.sync.execute(task.id, task, items)
      ).then((stats) => {
        set((s) => ({
          syncRuns: s.syncRuns.map((r) =>
            r.runId === runId ? { ...r, phase: 'done', stats, progress: null } : r
          )
        }))
        runNext(index + 1)
      }).catch((err: Error) => {
        set((s) => ({
          syncRuns: s.syncRuns.map((r) =>
            r.runId === runId ? { ...r, phase: 'error', error: err.message, progress: null } : r
          )
        }))
        runNext(index + 1)
      })
    }
    runNext(0)
  }
}))
