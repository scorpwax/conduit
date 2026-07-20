import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage, Notification } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { IPC } from '@shared/ipc'
import type { Connection, TransferRequest, Bookmark, LogEntry, AppSettings, UiState, TreeNode, FolderTreeResult } from '@shared/types'
import { logger, log } from './logger'
import { getSettings, updateSettings } from './settings'
import { connectionStore } from './store'
import { getProvider, createProvider, invalidateProvider, closeAllProviders, getActiveConnectionIds } from './providers'
import { listDrives } from './drives'
import { mountS3, unmountAll } from './rclone'
import { transferEngine } from './transfer/engine'
import { previewFile } from './preview'
import { runOAuth } from './oauth'
import { GOOGLE_OAUTH } from './providers/gdrive'
import { MICROSOFT_OAUTH } from './providers/onedrive'
import { DROPBOX_OAUTH } from './providers/dropbox'

let mainWindow: BrowserWindow | null = null

// Forward transfer engine events to the renderer. Registered once at module
// scope so that re-opening the window (macOS dock click) doesn't stack
// duplicate listeners, which would send each event multiple times.
const sendToRenderer = (channel: string, payload: unknown): void => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, payload)
    } catch {
      // Render frame disposed mid-navigation — drop the message safely.
    }
  }
}
// Updates are already throttled by the engine's 250ms progress timer — send directly.
transferEngine.on('update', (items) => {
  sendToRenderer(IPC.evtTransferUpdate, items)
  updateSystemProgress(items)
})

let dockClearTimer: ReturnType<typeof setTimeout> | null = null
let prevAllDone = false

function updateSystemProgress(items: import('@shared/types').TransferItem[]): void {
  const active = items.filter(i => i.status === 'transferring')
  const pending = items.filter(i => i.status === 'queued')
  const done = items.filter(i => i.status === 'done' || i.status === 'error' || i.status === 'canceled')
  const total = items.length
  const allDone = total > 0 && active.length === 0 && pending.length === 0
  const win = mainWindow

  if (dockClearTimer && !allDone) {
    clearTimeout(dockClearTimer)
    dockClearTimer = null
  }

  if (active.length > 0 || pending.length > 0) {
    // Transfers in progress
    prevAllDone = false
    const progress = total > 0 ? done.length / total : 0
    if (process.platform === 'darwin') {
      app.dock?.setBadge(String(active.length + pending.length))
    } else if (process.platform === 'win32' && win) {
      win.setProgressBar(progress)
    }
  } else if (allDone && !prevAllDone) {
    // Just finished — show completion indicator briefly
    prevAllDone = true
    if (process.platform === 'darwin') {
      app.dock?.setBadge('✓')
    } else if (process.platform === 'win32' && win) {
      win.setProgressBar(1)
    }
    dockClearTimer = setTimeout(() => {
      if (process.platform === 'darwin') app.dock?.setBadge('')
      else if (process.platform === 'win32' && win) win.setProgressBar(-1)
      dockClearTimer = null
    }, 3000)
  } else if (total === 0) {
    prevAllDone = false
    if (process.platform === 'darwin') app.dock?.setBadge('')
    else if (process.platform === 'win32' && win) win.setProgressBar(-1)
  }
}

// Batch 'added' events with a 500ms window to reduce IPC pressure during
// large directory walks (e.g. 6000-file job: 120 raw events → ~24 IPC sends).
const pendingAdded: import('@shared/types').TransferItem[] = []
let addedFlushTimer: ReturnType<typeof setTimeout> | null = null
const flushAdded = (): void => {
  if (!pendingAdded.length) return
  const batch = pendingAdded.splice(0)
  addedFlushTimer = null
  sendToRenderer(IPC.evtTransferAdded, batch)
}
transferEngine.on('added', (items) => {
  pendingAdded.push(...items)
  if (addedFlushTimer === null) addedFlushTimer = setTimeout(flushAdded, 500)
})

async function createWindow(): Promise<void> {
  // Restore window bounds from the last session if available.
  let savedBounds: { x: number; y: number; width: number; height: number } | undefined
  try {
    const raw = await fs.readFile(join(app.getPath('userData'), 'conduit-ui-state.json'), 'utf-8')
    const state = JSON.parse(raw) as { windowBounds?: typeof savedBounds }
    if (state.windowBounds) savedBounds = state.windowBounds
  } catch { /* no saved state yet */ }

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1200,
    height: savedBounds?.height ?? 780,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 760,
    minHeight: 480,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Intercept window close (red X and Cmd+Q both come through here after before-quit sets quitInProgress).
  mainWindow.on('close', (e) => {
    if (quitInProgress) return // already confirmed — let it close
    e.preventDefault()
    void promptQuit()
  })

  logger.setWindow(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Engine event forwarding is wired at module scope (see below createWindow),
  // so registering it here would stack duplicate listeners on each new window.

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.connectionsGetAll, () => connectionStore.getAll())

  ipcMain.handle(IPC.connectionsSave, async (_e, conn: Connection) => {
    const saved = await connectionStore.save(conn)
    invalidateProvider(conn.id)
    return saved
  })

  ipcMain.handle(IPC.connectionsRemove, async (_e, id: string) => {
    await connectionStore.remove(id)
    invalidateProvider(id)
  })

  // Disconnect: tear down the live provider (unmounts any SMB share we mounted)
  // without deleting the saved connection.
  ipcMain.handle(IPC.connectionsDisconnect, (_e, id: string) => {
    invalidateProvider(id)
  })

  // Run the interactive OAuth flow for a cloud provider; returns a refresh token.
  ipcMain.handle(
    IPC.connectionsAuthorize,
    async (
      _e,
      args: { type: string; clientId: string; clientSecret?: string }
    ): Promise<{ ok: boolean; refreshToken?: string; message?: string }> => {
      try {
        const base =
          args.type === 'gdrive'
            ? GOOGLE_OAUTH
            : args.type === 'onedrive'
              ? MICROSOFT_OAUTH
              : args.type === 'dropbox'
                ? DROPBOX_OAUTH
                : null
        if (!base) throw new Error(`Authorization not supported for ${args.type}`)
        const tokens = await runOAuth({
          ...base,
          clientId: args.clientId,
          clientSecret: args.clientSecret
        })
        if (!tokens.refreshToken) {
          return {
            ok: false,
            message:
              'Authorized, but no refresh token was returned. Revoke the app’s access in the provider’s settings and try again.'
          }
        }
        return { ok: true, refreshToken: tokens.refreshToken }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  // Tests a connection using the config passed in (may include a fresh secret
  // that hasn't been saved yet), so the user can validate before saving.
  ipcMain.handle(IPC.connectionsTest, async (_e, conn: Connection) => {
    try {
      const result = await createProvider(conn).test()
      if (result.ok) log.success('connection', `Connected: ${conn.name} — ${result.message}`)
      else log.error('connection', `Connection failed: ${conn.name} — ${result.message}`)
      return result
    } catch (err) {
      log.error('connection', `Connection failed: ${conn.name} — ${(err as Error).message}`)
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.bookmarksGetAll, () => connectionStore.getBookmarks())
  ipcMain.handle(IPC.bookmarksAdd, (_e, bm: Bookmark) => connectionStore.addBookmark(bm))
  ipcMain.handle(IPC.bookmarksRemove, (_e, id: string) => connectionStore.removeBookmark(id))

  ipcMain.handle(IPC.fsList, async (_e, args: { connectionId: string; path: string }) => {
    const provider = await getProvider(args.connectionId)
    void connectionStore.touch(args.connectionId)
    return provider.list(args.path)
  })

  ipcMain.handle(IPC.fsStat, async (_e, args: { connectionId: string; path: string }) => {
    const provider = await getProvider(args.connectionId)
    return provider.stat(args.path)
  })

  ipcMain.handle(IPC.fsDrives, () => listDrives())

  ipcMain.handle(IPC.fsParent, async (_e, args: { connectionId: string; path: string }) => {
    const provider = await getProvider(args.connectionId)
    return provider.parent(args.path)
  })

  ipcMain.handle(
    IPC.fsMkdir,
    async (_e, args: { connectionId: string; dir: string; name: string }) => {
      const provider = await getProvider(args.connectionId)
      try {
        await provider.mkdir(provider.join(args.dir, args.name))
        log.info('fs', `Created folder "${args.name}" in "${args.dir || '/'}"`)
      } catch (err) {
        log.error('fs', `Create folder failed "${args.name}": ${(err as Error).message}`)
        throw err
      }
    }
  )

  ipcMain.handle(
    IPC.fsCreateFile,
    async (_e, args: { connectionId: string; dir: string; name: string }) => {
      const provider = await getProvider(args.connectionId)
      try {
        await provider.createFile(provider.join(args.dir, args.name))
        log.info('fs', `Created file "${args.name}" in "${args.dir || '/'}"`)
      } catch (err) {
        log.error('fs', `Create file failed "${args.name}": ${(err as Error).message}`)
        throw err
      }
    }
  )

  ipcMain.handle(
    IPC.fsDelete,
    async (_e, args: { connectionId: string; path: string; kind: 'file' | 'directory' }) => {
      const provider = await getProvider(args.connectionId)
      const name = args.path.split('/').filter(Boolean).pop() ?? args.path
      await transferEngine.trackOperation(`Delete "${name}"`, async () => {
        await provider.delete(args.path, args.kind)
        log.warn('fs', `Deleted ${args.kind} "${args.path}"`)
      }, `delete:${args.path}`)
    }
  )

  ipcMain.handle(
    IPC.fsRename,
    async (_e, args: { connectionId: string; path: string; newName: string }) => {
      const provider = await getProvider(args.connectionId)
      const oldName = args.path.split('/').filter(Boolean).pop() ?? args.path
      await transferEngine.trackOperation(`Rename "${oldName}" → "${args.newName}"`, async () => {
        await provider.rename(args.path, args.newName)
        log.info('fs', `Renamed "${args.path}" → "${args.newName}"`)
      }, `rename:${args.path}`)
    }
  )

  ipcMain.handle(IPC.fsPreview, async (_e, args: { connectionId: string; path: string }) => {
    await previewFile(args.connectionId, args.path)
  })

  // Return the basenames of source items that already exist in the destination dir.
  ipcMain.handle(
    IPC.transferCheckConflicts,
    async (_e, req: TransferRequest): Promise<string[]> => {
      const dest = await getProvider(req.destConnectionId)
      // Check all files in parallel to avoid sequential round-trips to the remote.
      const results = await Promise.all(
        req.sourcePaths.map(async (srcPath) => {
          const name = srcPath.split(/[/\\]/).filter(Boolean).pop() || ''
          if (name && (await dest.exists(dest.join(req.destDir, name)))) return name
          return null
        })
      )
      return results.filter((n): n is string => n !== null)
    }
  )

  ipcMain.handle(IPC.transferEnqueue, (_e, req: TransferRequest) => transferEngine.enqueue(req))
  ipcMain.handle(IPC.transferGetAll, () => transferEngine.getAll())
  ipcMain.handle(IPC.transferCancel, (_e, id: string) => transferEngine.cancel(id))
  ipcMain.handle(IPC.transferCancelAll, () => transferEngine.cancelAll())
  ipcMain.handle(IPC.transferClearFinished, () => transferEngine.clearFinished())

  ipcMain.handle(IPC.dialogPickFolder, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.connectionsExportProfile, async (_e, id: string) => {
    const all = await connectionStore.getAll()
    const conn = all.find((c) => c.id === id)
    if (!conn) return false
    const { canceled, filePath: savePath } = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Connection Profile',
      defaultPath: `${conn.name.replace(/[^a-z0-9 _-]/gi, '_')}.conduit`,
      filters: [{ name: 'Conduit Profile', extensions: ['conduit'] }]
    })
    if (canceled || !savePath) return false
    const payload = JSON.stringify({ conduitProfile: 1, connection: conn }, null, 2)
    await fs.writeFile(savePath, payload, 'utf-8')
    log.info('connection', `Exported connection profile: ${conn.name}`)
    return true
  })

  ipcMain.handle(IPC.connectionsImportProfile, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import Connection Profile',
      filters: [{ name: 'Conduit Profile', extensions: ['conduit', 'json'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths[0]) return null
    try {
      const raw = await fs.readFile(filePaths[0], 'utf-8')
      const parsed = JSON.parse(raw) as { conduitProfile?: number; connection?: unknown }
      if (parsed?.conduitProfile === 1 && parsed.connection && typeof parsed.connection === 'object') {
        const conn = parsed.connection as Record<string, unknown>
        return { ...conn, id: randomUUID() }
      }
    } catch {
      // invalid file — return null so the UI can show an error
    }
    return null
  })

  ipcMain.handle(
    IPC.fsFolderSize,
    async (_e, args: { connectionId: string; path: string }): Promise<{ size: number; latestModified: string | null } | null> => {
      try {
        const provider = await getProvider(args.connectionId)
        // Remote providers that implement folderSize() (e.g. S3/Wasabi)
        if (provider.folderSize) return await provider.folderSize(args.path)
        // Local providers: use OS tools for speed
        if (!provider.getLocalRoot) return null
        let size: number
        if (process.platform === 'darwin' || process.platform === 'linux') {
          const { execFile } = await import('child_process')
          const { promisify } = await import('util')
          const execFileP = promisify(execFile)
          const { stdout } = await execFileP('du', ['-sk', args.path])
          const kb = parseInt(stdout.trim().split(/\s/)[0], 10)
          size = isNaN(kb) ? 0 : kb * 1024
        } else {
          // Windows: pure-Node recursive walk.
          const { promises: fsP } = await import('fs')
          async function dirSize(dir: string): Promise<number> {
            let total = 0
            const entries = await fsP.readdir(dir, { withFileTypes: true })
            for (const e of entries) {
              const p = `${dir}\\${e.name}`
              if (e.isDirectory()) total += await dirSize(p)
              else if (e.isFile()) total += (await fsP.stat(p)).size
            }
            return total
          }
          size = await dirSize(args.path)
        }
        return { size, latestModified: null }
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(
    IPC.fsChecksum,
    async (_e, args: { connectionId: string; path: string }): Promise<string | null> => {
      try {
        const provider = await getProvider(args.connectionId)
        return provider.checksum ? await provider.checksum(args.path) : null
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(
    IPC.fsFolderContents,
    async (_e, args: { connectionId: string; path: string }): Promise<{ files: number; folders: number } | null> => {
      try {
        const provider = await getProvider(args.connectionId)
        const result = await provider.list(args.path)
        let files = 0
        let folders = 0
        for (const e of result.entries) {
          if (e.kind === 'directory') folders++
          else files++
        }
        return { files, folders }
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(IPC.connectionsRevealMount, async (_e, id: string) => {
    try {
      const all = await connectionStore.getAll()
      const conn = all.find((c) => c.id === id)
      let root: string | null = null

      if (conn?.type === 's3' || conn?.type === 'wasabi') {
        root = await mountS3(conn)
      } else {
        const provider = await getProvider(id)
        if (!provider.getLocalRoot) return { ok: false, message: 'Not supported for this connection type' }
        root = await provider.getLocalRoot()
      }

      if (!root) return { ok: false, message: 'Could not determine mount path' }
      await shell.openPath(root)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.connectionsCreateDesktopShortcut, async (_e, id: string) => {
    const { homedir } = await import('os')
    try {
      const all = await connectionStore.getAll()
      const conn = all.find((c) => c.id === id)
      if (!conn) return { ok: false, message: 'Connection not found' }
      let root: string | null = null

      if (conn.type === 's3' || conn.type === 'wasabi') {
        root = await mountS3(conn)
      } else {
        const provider = await getProvider(id)
        if (!provider.getLocalRoot) return { ok: false, message: 'Not supported for this connection type' }
        root = await provider.getLocalRoot()
      }

      if (!root) return { ok: false, message: 'Could not determine mount path' }
      const dest = join(homedir(), 'Desktop', conn.name)
      try {
        await fs.symlink(root, dest)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: true }
        throw err
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  // ---- Logs & settings ----
  ipcMain.handle(IPC.logsGetRecent, (_e, limit?: number) => logger.getRecent(limit))

  ipcMain.handle(IPC.logsWrite, (_e, entry: LogEntry) => {
    log[entry.level](entry.category, entry.message)
  })

  ipcMain.handle(IPC.logsOpenFolder, () => shell.openPath(logger.dir()))

  ipcMain.handle(IPC.logsExport, async () => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: `conduit-log-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
    })
    if (res.canceled || !res.filePath) return false
    await fs.writeFile(res.filePath, await logger.exportAll(), 'utf-8')
    return true
  })

  ipcMain.handle(IPC.logsExportText, async (_e, text: string) => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: `conduit-log-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
    })
    if (res.canceled || !res.filePath) return false
    await fs.writeFile(res.filePath, text, 'utf-8')
    return true
  })

  ipcMain.handle(IPC.logsClear, async () => {
    await logger.clear()
    log.info('app', 'Log cleared')
  })

  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())

  ipcMain.handle(IPC.settingsGet, () => getSettings())

  ipcMain.handle(IPC.settingsSet, async (_e, patch: Partial<AppSettings>) => {
    const settings = await updateSettings(patch)
    if (patch.logRetentionDays !== undefined) await logger.prune(settings.logRetentionDays)
    if (patch.transferConcurrency !== undefined) transferEngine.setConcurrency(settings.transferConcurrency)
    return settings
  })

  ipcMain.handle(
    IPC.fsFolderTree,
    async (_e, args: { connectionId: string; path: string }): Promise<FolderTreeResult> => {
      const provider = await getProvider(args.connectionId)

      // Providers with an efficient bulk-listing implementation (e.g. S3).
      if (provider.folderTree) return await provider.folderTree(args.path)

      // Generic fallback: recursive provider.list() for SFTP, FTP, WebDAV, local, etc.
      const MAX = 25000
      const state = { count: 0, truncated: false, totalFiles: 0, totalFolders: 0, totalSize: 0 }

      async function buildLevel(dirPath: string): Promise<TreeNode[]> {
        if (state.count >= MAX) { state.truncated = true; return [] }
        const result = await provider.list(dirPath)
        const nodes: TreeNode[] = []

        for (const entry of result.entries) {
          if (state.count >= MAX) { state.truncated = true; break }
          state.count++

          if (entry.kind === 'directory') {
            state.totalFolders++
            const children = await buildLevel(entry.path)
            nodes.push({ name: entry.name, kind: 'directory', size: 0, modified: entry.modified, children })
          } else {
            state.totalFiles++
            state.totalSize += entry.size ?? 0
            nodes.push({ name: entry.name, kind: 'file', size: entry.size ?? 0, modified: entry.modified, children: [] })
          }
        }

        nodes.sort((a, b) => a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : a.name.localeCompare(b.name))
        return nodes
      }

      const tree = await buildLevel(args.path)
      return { tree, totalFiles: state.totalFiles, totalFolders: state.totalFolders, totalSize: state.totalSize, truncated: state.truncated }
    }
  )

  ipcMain.handle(IPC.appNotify, (_e, args: { title: string; body: string }) => {
    if (Notification.isSupported()) {
      new Notification({ title: args.title, body: args.body }).show()
    }
  })

  const uiStatePath = (): string => join(app.getPath('userData'), 'conduit-ui-state.json')

  ipcMain.handle(IPC.appGetUiState, async (): Promise<UiState | null> => {
    try {
      const raw = await fs.readFile(uiStatePath(), 'utf-8')
      return JSON.parse(raw) as UiState
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.appSaveUiState, async (_e, state: UiState) => {
    // Merge in current window bounds so the renderer doesn't need to know them.
    if (mainWindow && !mainWindow.isDestroyed()) {
      state.windowBounds = mainWindow.getBounds()
    }
    await fs.writeFile(uiStatePath(), JSON.stringify(state, null, 2), 'utf-8')
  })
}

app.whenReady().then(async () => {
  // In dev, show the real app icon in the Dock (packaged builds get it from the
  // app bundle via electron-builder's build/icon.png).
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    try {
      const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
      if (!icon.isEmpty()) app.dock.setIcon(icon)
    } catch {
      // ignore — falls back to the default Electron icon
    }
  }

  registerIpc()
  await createWindow()

  // Apply saved settings.
  const settings = await getSettings()
  await logger.prune(settings.logRetentionDays)
  transferEngine.setConcurrency(settings.transferConcurrency)
  log.info('app', `Conduit ${app.getVersion()} started`)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Quit-confirmation: warn if there are live connections, with a "don't ask again" option.
// Intercept on the window close event (handles both Cmd+Q and red-X on macOS/Windows).
let quitInProgress = false

async function promptQuit(): Promise<void> {
  const settings = await getSettings()
  const activeIds = getActiveConnectionIds()

  if (activeIds.length > 0 && !settings.skipQuitConfirm) {
    if (!mainWindow) return
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Quit Conduit',
      message: `You have ${activeIds.length} active connection${activeIds.length !== 1 ? 's' : ''}.`,
      detail: 'Quitting will disconnect all of them.',
      checkboxLabel: "Don't ask again",
      checkboxChecked: false,
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    })

    if (response === 1) return // user cancelled
    if (checkboxChecked) await updateSettings({ skipQuitConfirm: true })
  }

  quitInProgress = true
  log.info('app', 'Quitting — disconnecting all connections')
  closeAllProviders()
  void unmountAll()
  app.quit()
}

// before-quit fires on Cmd+Q before any windows close — mark confirmed so
// the window 'close' handler below passes through.
app.on('before-quit', () => {
  quitInProgress = true
})
