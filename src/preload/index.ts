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
  SyncTask,
  SyncPreviewItem,
  SyncRunStats,
  SyncProgress,
  UpdateInfo
} from '../shared/types'

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
    folderSize: (connectionId: string, path: string): Promise<{ size: number; latestModified: string | null } | null> =>
      ipcRenderer.invoke(IPC.fsFolderSize, { connectionId, path }),
    checksum: (connectionId: string, path: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.fsChecksum, { connectionId, path }),
    folderContents: (connectionId: string, path: string): Promise<{ files: number; folders: number } | null> =>
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
  /** Resolve the absolute path of a File dropped from the OS (Finder/desktop). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** The OS platform — use to conditionally show platform-specific UI. */
  platform: process.platform
}

export type ConduitApi = typeof api

contextBridge.exposeInMainWorld('conduit', api)
