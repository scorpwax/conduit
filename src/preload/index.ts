import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  Connection,
  ListResult,
  DriveInfo,
  FileEntry,
  TransferItem,
  TransferRequest,
  ConnectionTestResult,
  Bookmark,
  LogEntry,
  LogLevel,
  LogCategory,
  AppSettings,
  UiState,
  FolderTreeResult,
  FolderContentsResult,
  SyncTask,
  SyncPreviewItem,
  SyncRunStats,
  SyncProgress,
  UpdateInfo,
  VerifyItem,
  VerifyProgress,
  VerifyResult,
  FolderSizeResult
} from '../shared/types'
import type {
  SearchRequest,
  SearchResult,
  SearchProgress,
  SearchDone,
  SearchContext,
  SearchOpenInPane
} from '../shared/search'

/** The typed API surface exposed to the renderer as window.conduit. */
const api = {
  connections: {
    getAll: (): Promise<Connection[]> => ipcRenderer.invoke(IPC.connectionsGetAll),
    save: (conn: Connection): Promise<Connection> => ipcRenderer.invoke(IPC.connectionsSave, conn),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.connectionsRemove, id),
    disconnect: (id: string): Promise<void> => ipcRenderer.invoke(IPC.connectionsDisconnect, id),
    test: (conn: Connection): Promise<ConnectionTestResult> =>
      ipcRenderer.invoke(IPC.connectionsTest, conn),
    authorize: (args: {
      type: string
      clientId: string
      clientSecret?: string
    }): Promise<{ ok: boolean; refreshToken?: string; message?: string }> =>
      ipcRenderer.invoke(IPC.connectionsAuthorize, args),
    exportProfile: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.connectionsExportProfile, id),
    importProfile: (): Promise<Connection | null> =>
      ipcRenderer.invoke(IPC.connectionsImportProfile),
    revealMount: (id: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.connectionsRevealMount, id),
    createDesktopShortcut: (id: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.connectionsCreateDesktopShortcut, id)
  },
  bookmarks: {
    getAll: (): Promise<Bookmark[]> => ipcRenderer.invoke(IPC.bookmarksGetAll),
    add: (bookmark: Bookmark): Promise<Bookmark[]> => ipcRenderer.invoke(IPC.bookmarksAdd, bookmark),
    remove: (id: string): Promise<Bookmark[]> => ipcRenderer.invoke(IPC.bookmarksRemove, id)
  },
  fs: {
    list: (connectionId: string, path: string): Promise<ListResult> =>
      ipcRenderer.invoke(IPC.fsList, { connectionId, path }),
    stat: (connectionId: string, path: string): Promise<FileEntry> =>
      ipcRenderer.invoke(IPC.fsStat, { connectionId, path }),
    drives: (): Promise<DriveInfo[]> => ipcRenderer.invoke(IPC.fsDrives),
    parent: (connectionId: string, path: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.fsParent, { connectionId, path }),
    mkdir: (connectionId: string, dir: string, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fsMkdir, { connectionId, dir, name }),
    createFile: (connectionId: string, dir: string, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fsCreateFile, { connectionId, dir, name }),
    delete: (connectionId: string, path: string, kind: 'file' | 'directory'): Promise<void> =>
      ipcRenderer.invoke(IPC.fsDelete, { connectionId, path, kind }),
    rename: (connectionId: string, path: string, newName: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fsRename, { connectionId, path, newName }),
    preview: (connectionId: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fsPreview, { connectionId, path }),
    revealFile: (path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fsRevealFile, { path }),
    folderSize: (connectionId: string, path: string): Promise<FolderSizeResult | null> =>
      ipcRenderer.invoke(IPC.fsFolderSize, { connectionId, path }),
    checksum: (connectionId: string, path: string, multipart?: { partSizeBytes: number }): Promise<string | null> =>
      ipcRenderer.invoke(IPC.fsChecksum, { connectionId, path, multipart }),
    folderContents: (connectionId: string, path: string): Promise<FolderContentsResult | null> =>
      ipcRenderer.invoke(IPC.fsFolderContents, { connectionId, path }),
    folderTree: (connectionId: string, path: string): Promise<FolderTreeResult> =>
      ipcRenderer.invoke(IPC.fsFolderTree, { connectionId, path }),
    openFile: (path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fsOpenFile, { path }),
    startDrag: (paths: string[]): void =>
      ipcRenderer.send(IPC.fsStartDrag, paths),
    duplicateEntries: (
      connectionId: string,
      entries: Array<{ path: string; name: string; kind: 'file' | 'directory' }>
    ): Promise<void> => ipcRenderer.invoke(IPC.fsDuplicateEntries, { connectionId, entries }),
    moveToDir: (connectionId: string, paths: string[], destDir: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fsMoveToDir, { connectionId, paths, destDir })
  },
  transfer: {
    checkConflicts: (req: TransferRequest): Promise<string[]> =>
      ipcRenderer.invoke(IPC.transferCheckConflicts, req),
    enqueue: (req: TransferRequest): Promise<TransferItem[]> =>
      ipcRenderer.invoke(IPC.transferEnqueue, req),
    getAll: (): Promise<TransferItem[]> => ipcRenderer.invoke(IPC.transferGetAll),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.transferCancel, id),
    cancelAll: (): Promise<void> => ipcRenderer.invoke(IPC.transferCancelAll),
    retry: (id: string): Promise<void> => ipcRenderer.invoke(IPC.transferRetry, id),
    clearFinished: (): Promise<void> => ipcRenderer.invoke(IPC.transferClearFinished),
    openSpeedGraph: (): Promise<void> => ipcRenderer.invoke(IPC.transferOpenSpeedGraph),
    onUpdate: (cb: (items: TransferItem[]) => void): (() => void) => {
      const listener = (_e: unknown, items: TransferItem[]): void => cb(items)
      ipcRenderer.on(IPC.evtTransferUpdate, listener)
      return () => ipcRenderer.removeListener(IPC.evtTransferUpdate, listener)
    },
    onAdded: (cb: (items: TransferItem[]) => void): (() => void) => {
      const listener = (_e: unknown, items: TransferItem[]): void => cb(items)
      ipcRenderer.on(IPC.evtTransferAdded, listener)
      return () => ipcRenderer.removeListener(IPC.evtTransferAdded, listener)
    }
  },
  verify: {
    start: (items: VerifyItem[]): Promise<string> => ipcRenderer.invoke(IPC.verifyStart, items),
    cancel: (runId: string): Promise<void> => ipcRenderer.invoke(IPC.verifyCancel, runId),
    onProgress: (cb: (p: VerifyProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: VerifyProgress): void => cb(p)
      ipcRenderer.on(IPC.evtVerifyProgress, listener)
      return () => ipcRenderer.removeListener(IPC.evtVerifyProgress, listener)
    },
    onDone: (cb: (result: VerifyResult) => void): (() => void) => {
      const listener = (_e: unknown, result: VerifyResult): void => cb(result)
      ipcRenderer.on(IPC.evtVerifyDone, listener)
      return () => ipcRenderer.removeListener(IPC.evtVerifyDone, listener)
    }
  },
  dialog: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickFolder)
  },
  logs: {
    getRecent: (limit?: number): Promise<LogEntry[]> => ipcRenderer.invoke(IPC.logsGetRecent, limit),
    write: (level: LogLevel, category: LogCategory, message: string): Promise<void> =>
      ipcRenderer.invoke(IPC.logsWrite, { level, category, message, ts: Date.now() }),
    openFolder: (): Promise<string> => ipcRenderer.invoke(IPC.logsOpenFolder),
    export: (): Promise<boolean> => ipcRenderer.invoke(IPC.logsExport),
    exportText: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.logsExportText, text),
    exportFileTree: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.logsExportFileTree, text),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.logsClear),
    onEntries: (cb: (entries: LogEntry[]) => void): (() => void) => {
      const listener = (_e: unknown, entries: LogEntry[]): void => cb(entries)
      ipcRenderer.on(IPC.evtLog, listener)
      return () => ipcRenderer.removeListener(IPC.evtLog, listener)
    }
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.appGetVersion),
    getVersions: (): Promise<{ app: string; electron: string; chrome: string; node: string }> =>
      ipcRenderer.invoke(IPC.appGetVersions),
    notify: (args: { title: string; body: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.appNotify, args),
    getUiState: (): Promise<UiState | null> => ipcRenderer.invoke(IPC.appGetUiState),
    saveUiState: (state: UiState): Promise<void> => ipcRenderer.invoke(IPC.appSaveUiState, state),
    checkForUpdates: (): Promise<UpdateInfo | null> => ipcRenderer.invoke(IPC.appCheckUpdates),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.appOpenExternal, url),
    onUpdateAvailable: (cb: (info: UpdateInfo) => void): (() => void) => {
      const listener = (_e: unknown, info: UpdateInfo): void => cb(info)
      ipcRenderer.on(IPC.evtUpdateAvailable, listener)
      return () => ipcRenderer.removeListener(IPC.evtUpdateAvailable, listener)
    }
  },
  sync: {
    getTasks: (): Promise<SyncTask[]> => ipcRenderer.invoke(IPC.syncGetTasks),
    saveTask: (task: SyncTask): Promise<SyncTask[]> => ipcRenderer.invoke(IPC.syncSaveTask, task),
    deleteTask: (id: string): Promise<SyncTask[]> => ipcRenderer.invoke(IPC.syncDeleteTask, id),
    runPreview: (taskId: string, task: SyncTask): Promise<SyncPreviewItem[]> =>
      ipcRenderer.invoke(IPC.syncRunPreview, { taskId, task }),
    execute: (
      taskId: string,
      task: SyncTask,
      items: SyncPreviewItem[]
    ): Promise<SyncRunStats> => ipcRenderer.invoke(IPC.syncExecute, { taskId, task, items }),
    cancel: (taskId: string): Promise<void> => ipcRenderer.invoke(IPC.syncCancel, taskId),
    getLaunchAtStartup: (): Promise<boolean> => ipcRenderer.invoke(IPC.syncGetLaunchAtStartup),
    setLaunchAtStartup: (enable: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.syncSetLaunchAtStartup, enable),
    onProgress: (cb: (progress: SyncProgress) => void): (() => void) => {
      const listener = (_e: unknown, progress: SyncProgress): void => cb(progress)
      ipcRenderer.on(IPC.evtSyncProgress, listener)
      return () => ipcRenderer.removeListener(IPC.evtSyncProgress, listener)
    }
  },
  search: {
    /** Open (or focus) the Advanced Search window, optionally pre-scoped to a pane. */
    openWindow: (ctx: SearchContext): Promise<void> => ipcRenderer.invoke(IPC.searchOpenWindow, ctx),
    getContext: (): Promise<SearchContext | null> => ipcRenderer.invoke(IPC.searchGetContext),
    start: (req: SearchRequest): Promise<void> => ipcRenderer.invoke(IPC.searchStart, req),
    cancel: (searchId: string): Promise<void> => ipcRenderer.invoke(IPC.searchCancel, searchId),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.searchPickFolder),
    openInPane: (target: SearchOpenInPane): Promise<void> => ipcRenderer.invoke(IPC.searchOpenInPane, target),
    exportCsv: (rows: SearchResult[]): Promise<boolean> => ipcRenderer.invoke(IPC.searchExportCsv, rows),
    onBatch: (cb: (searchId: string, results: SearchResult[]) => void): (() => void) => {
      const listener = (_e: unknown, searchId: string, results: SearchResult[]): void => cb(searchId, results)
      ipcRenderer.on(IPC.evtSearchBatch, listener)
      return () => ipcRenderer.removeListener(IPC.evtSearchBatch, listener)
    },
    onProgress: (cb: (p: SearchProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: SearchProgress): void => cb(p)
      ipcRenderer.on(IPC.evtSearchProgress, listener)
      return () => ipcRenderer.removeListener(IPC.evtSearchProgress, listener)
    },
    onDone: (cb: (d: SearchDone) => void): (() => void) => {
      const listener = (_e: unknown, d: SearchDone): void => cb(d)
      ipcRenderer.on(IPC.evtSearchDone, listener)
      return () => ipcRenderer.removeListener(IPC.evtSearchDone, listener)
    },
    /** Search window: the main window asked to re-scope an already-open search. */
    onContext: (cb: (ctx: SearchContext) => void): (() => void) => {
      const listener = (_e: unknown, ctx: SearchContext): void => cb(ctx)
      ipcRenderer.on(IPC.evtSearchContext, listener)
      return () => ipcRenderer.removeListener(IPC.evtSearchContext, listener)
    },
    /** Main window: a search result asked to be opened in a new pane. */
    onOpenInPane: (cb: (target: SearchOpenInPane) => void): (() => void) => {
      const listener = (_e: unknown, target: SearchOpenInPane): void => cb(target)
      ipcRenderer.on(IPC.evtSearchOpenInPane, listener)
      return () => ipcRenderer.removeListener(IPC.evtSearchOpenInPane, listener)
    }
  },
  /** Resolve the absolute path of a File dropped from the OS (Finder/desktop). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** The OS platform — use to conditionally show platform-specific UI. */
  platform: process.platform
}

export type ConduitApi = typeof api

contextBridge.exposeInMainWorld('conduit', api)
