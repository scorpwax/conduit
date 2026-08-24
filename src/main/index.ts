import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage, Notification, Tray, Menu, powerSaveBlocker } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { IPC } from '@shared/ipc'
import type { Connection, TransferRequest, Bookmark, LogEntry, AppSettings, UiState, TreeNode, FolderTreeResult, SyncTask, SyncPreviewItem } from '@shared/types'
import { BUILTIN_LOCAL, BUILTIN_LOCAL_ID } from '@shared/builtin'
import { syncStore } from './syncStore'
import { syncEngine } from './sync/engine'
import { logger, log } from './logger'
import { getSettings, updateSettings } from './settings'
import { connectionStore } from './store'
import { getProvider, createProvider, invalidateProvider, closeAllProviders, getActiveConnectionIds } from './providers'
import { listDrives } from './drives'
import { mountS3, unmountAll } from './rclone'
import { transferEngine } from './transfer/engine'
import { previewFile } from './preview'
import { runOAuth, runOAuthInWindow, handleCustomSchemeCallback } from './oauth'
import { GOOGLE_OAUTH } from './providers/gdrive'
import { MICROSOFT_OAUTH } from './providers/onedrive'
import { DROPBOX_OAUTH } from './providers/dropbox'
import { FRAMEIO_OAUTH, FRAMEIO_REDIRECT_URI, FRAMEIO_PROTOCOL_SCHEME } from './providers/frameio'
import { checkForUpdates } from './updater'

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
// The engine's own 250ms progress timer already throttles steady-state byte
// progress, but 'update' is also emitted immediately outside that timer (item
// start/finish, trackOperation's per-batch progress) — and if anything ever
// causes those immediate emits to fire in a tight loop (a stuck retry, a
// runaway pump()), each one used to go straight to an IPC send and a fresh
// getAll()/updateSystemProgress() pass, pegging both processes and the
// renderer's re-render rate along with them. Coalesce at the IPC boundary as
// a hard backstop: no matter how fast the engine emits internally, the
// renderer never receives more than ~10 updates/sec, each carrying the latest
// state of every item that changed since the last flush.
const pendingUpdates = new Map<string, import('@shared/types').TransferItem>()
let updateFlushTimer: ReturnType<typeof setTimeout> | null = null
const flushUpdates = (): void => {
  updateFlushTimer = null
  if (!pendingUpdates.size) return
  const items = [...pendingUpdates.values()]
  pendingUpdates.clear()
  sendToRenderer(IPC.evtTransferUpdate, items)
  const all = transferEngine.getAll()
  // Use full queue (not just changed items) so a single-file completion event
  // doesn't incorrectly flip the dock badge to "all done" mid-batch.
  updateSystemProgress(all)
  syncPowerBlocker(all)
}
transferEngine.on('update', (items: import('@shared/types').TransferItem[]) => {
  for (const item of items) pendingUpdates.set(item.id, item)
  if (updateFlushTimer === null) updateFlushTimer = setTimeout(flushUpdates, 100)
})

let dockClearTimer: ReturnType<typeof setTimeout> | null = null
let powerBlockerId: number | null = null

function syncPowerBlocker(items: import('@shared/types').TransferItem[]): void {
  const hasActive = items.some(i => i.status === 'transferring' || i.status === 'queued')
  if (hasActive && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!hasActive && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId)
    powerBlockerId = null
  }
}
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
      contextIsolation: true,
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  if (process.platform === 'win32') {
    mainWindow.on('restore', () => mainWindow?.webContents.invalidate())
    // Keep active transfers running while the window is minimized on Windows.
    // Without this the OS can throttle the process and pause uploads/downloads.
    mainWindow.on('minimize', () => {
      const hasActive = transferEngine.getAll().some(
        (i) => i.status === 'transferring' || i.status === 'queued'
      )
      if (hasActive && powerBlockerId === null) {
        powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      }
    })
  }

  // Intercept the red-X close button. Cmd+Q / the app-menu Quit item go through
  // 'before-quit' first (see below) and never reach here unconfirmed, but this
  // still runs afterward as part of that same confirmed quit sequence.
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

  // The transfer engine lives entirely in the main process, so a renderer crash
  // or freeze (e.g. from rendering a huge transfer queue) never stops transfers
  // in flight — it just leaves the user staring at a dead window. Recover
  // automatically instead of requiring a manual relaunch.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('app', `Renderer process gone (${details.reason}) — reloading window`)
    if (Notification.isSupported()) {
      new Notification({
        title: 'Conduit recovered from a display glitch',
        body: 'The window reloaded. Any active transfers kept running the whole time.'
      }).show()
    }
    mainWindow?.reload()
  })

  // NOTE: a blocking confirmation dialog here was tried and reverted — a
  // dialog.showMessageBox attached to this window is a modal sheet, and it
  // locks out the ENTIRE window (Cancel All, the transfers drawer, everything)
  // for as long as it sits unanswered. Worse, this event can fire from nothing
  // more than a brief render-thread stall — exactly what happens right as a
  // transfer starts and the panel begins re-rendering — so it was turning a
  // harmless hiccup into a real lockup. Just log it; the only automatic
  // recovery action is reserved for an actual crash (render-process-gone, above).
  mainWindow.webContents.on('unresponsive', () => {
    log.warn('app', 'Renderer briefly unresponsive (no dialog shown — transfers and the window are unaffected)')
  })
  mainWindow.webContents.on('responsive', () => {
    log.info('app', 'Renderer responsive again — cycling focus to re-sync input routing')
    // Known Electron/Chromium-on-macOS failure mode: once a webContents has been
    // flagged unresponsive, the OS-level input routing to its content view can
    // get stuck even after the process itself recovers and goes fully idle —
    // native window chrome (dragging, traffic lights) keeps working since
    // that's handled by AppKit directly, but mouse events bound for the page
    // stop being delivered, with no error and no CPU usage to show for it.
    // A blur/focus cycle is the standard workaround (same effect as the user
    // manually minimizing and restoring the window) — do it automatically so
    // a brief hang never turns into an unrecoverable dead window.
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.blur()
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
    }, 50)
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
        // Frame.io has a baked-in client ID — run OAuth directly without user-supplied credentials.
        if (args.type === 'frameio') {
          const tokens = await runOAuthInWindow(FRAMEIO_OAUTH, FRAMEIO_REDIRECT_URI)
          if (!tokens.refreshToken) {
            return { ok: false, message: 'Authorized, but no refresh token returned. Try revoking app access in Adobe and re-authorizing.' }
          }
          return { ok: true, refreshToken: tokens.refreshToken }
        }
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
      await transferEngine.trackOperation(`Delete "${name}"`, async (onProgress) => {
        await provider.delete(args.path, args.kind, onProgress)
        log.warn('fs', `Deleted ${args.kind} "${args.path}"`)
      }, `delete:${args.path}`, 'delete')
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
      }, `rename:${args.path}`, 'rename')
    }
  )

  ipcMain.handle(IPC.fsPreview, async (_e, args: { connectionId: string; path: string }) => {
    await previewFile(args.connectionId, args.path)
  })

  ipcMain.handle(IPC.fsRevealFile, (_e, args: { path: string }) => {
    shell.showItemInFolder(args.path)
  })

  ipcMain.handle(IPC.fsOpenFile, async (_e, args: { path: string }) => {
    const err = await shell.openPath(args.path)
    if (err) throw new Error(err)
  })

  ipcMain.handle(
    IPC.fsDuplicateEntries,
    async (_e, { connectionId, entries }: { connectionId: string; entries: Array<{ path: string; name: string; kind: 'file' | 'directory' }> }) => {
      const provider = await getProvider(connectionId)

      async function copyName(dir: string, baseName: string): Promise<string> {
        const dot = baseName.lastIndexOf('.')
        const hasExt = dot > 0
        const stem = hasExt ? baseName.slice(0, dot) : baseName
        const ext = hasExt ? baseName.slice(dot) : ''
        let candidate = `${stem} (copy)${ext}`
        let n = 2
        while (await provider.exists(provider.join(dir, candidate))) {
          candidate = `${stem} (copy ${n})${ext}`
          n++
        }
        return candidate
      }

      async function copyDir(srcPath: string, destPath: string): Promise<void> {
        await provider.mkdir(provider.parent(destPath), destPath.split(/[/\\]/).pop() ?? '')
        const listing = await provider.list(srcPath)
        for (const entry of listing.entries) {
          const childDest = provider.join(destPath, entry.name)
          if (entry.kind === 'directory') {
            await copyDir(entry.path, childDest)
          } else {
            const stream = await provider.createReadStream(entry.path)
            await provider.writeFile(childDest, stream, entry.size ?? 0)
          }
        }
      }

      for (const entry of entries) {
        await transferEngine.trackOperation(`Duplicate "${entry.name}"`, async () => {
          const dir = provider.parent(entry.path)
          const newName = await copyName(dir, entry.name)
          const destPath = provider.join(dir, newName)
          if (entry.kind === 'file') {
            const stream = await provider.createReadStream(entry.path)
            const stat = await provider.stat(entry.path)
            await provider.writeFile(destPath, stream, stat.size ?? 0)
          } else {
            await copyDir(entry.path, destPath)
          }
          log.info('fs', `Duplicated "${entry.path}" → "${destPath}"`)
        }, `duplicate:${entry.path}`, 'duplicate').catch(() => {
          // One failed duplicate shouldn't abort the rest of the batch — it's
          // already visible as an errored row in the Transfers panel.
        })
      }
    }
  )

  ipcMain.handle(
    IPC.fsMoveToDir,
    async (_e, { connectionId, paths, destDir }: { connectionId: string; paths: string[]; destDir: string }) => {
      const provider = await getProvider(connectionId)
      const connType = provider.connection.type

      async function moveDir(srcPath: string, destPath: string): Promise<void> {
        await provider.mkdir(provider.parent(destPath) ?? destDir, destPath.split(/[/\\]/).pop() ?? '')
        const listing = await provider.list(srcPath)
        for (const entry of listing.entries) {
          const childDest = provider.join(destPath, entry.name)
          if (entry.kind === 'directory') {
            await moveDir(entry.path, childDest)
          } else {
            const { stream, size } = await provider.createReadStream(entry.path)
            await provider.writeFile(childDest, stream, size)
            await provider.delete(entry.path, 'file')
          }
        }
        await provider.delete(srcPath, 'directory')
      }

      for (const srcPath of paths) {
        const name = srcPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? srcPath
        const destPath = provider.join(destDir, name)

        // Dropping a folder onto itself (or one of its own descendants) resolves to
        // a destination inside the source — e.g. dragging "Foo" onto its own row
        // makes destDir === srcPath, so destPath becomes "Foo/Foo". The OS rejects
        // that rename with a bare EINVAL, and since this handler had no validation
        // or try/catch, that exception was escaping ipcMain.handle uncaught.
        const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
        if (norm(destDir) === norm(srcPath) || norm(destDir).startsWith(norm(srcPath) + '/')) {
          throw new Error(`Can't move "${name}" into itself`)
        }
        if (norm(destPath) === norm(srcPath)) continue // already at the destination — no-op

        const entry = await provider.stat(srcPath)

        if (connType === 'local' || connType === 'smb') {
          // OS-level rename handles cross-directory moves atomically on the same filesystem.
          const { rename } = await import('fs/promises')
          await rename(srcPath, destPath)
        } else if (entry.kind === 'file') {
          const { stream, size } = await provider.createReadStream(srcPath)
          await provider.writeFile(destPath, stream, size)
          await provider.delete(srcPath, 'file')
        } else {
          // Remote folder: recursive copy then delete
          await moveDir(srcPath, destPath)
        }

        log.info('fs', `Moved "${srcPath}" → "${destPath}"`)
      }
    }
  )

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
  ipcMain.handle(IPC.transferRetry, (_e, id: string) => transferEngine.retry(id))

  // Drag local files out to the OS (Finder, Desktop, etc.).
  // Must use ipcMain.on (not handle) so startDrag fires synchronously during the drag event.
  ipcMain.on(IPC.fsStartDrag, (event, paths: string[]) => {
    if (!paths.length) return
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png')).resize({ width: 32, height: 32 })
    // startDrag only accepts a single file in the current Electron typing.
    // For multi-file drag, use the first path — the user can drag individual files
    // or use Download/transfer for bulk operations.
    event.sender.startDrag({ file: paths[0], icon })
  })

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
        let files = 0
        let folders = 0
        const walk = async (path: string): Promise<void> => {
          const result = await provider.list(path)
          for (const e of result.entries) {
            if (e.kind === 'directory') {
              folders++
              await walk(e.path)
            } else {
              files++
            }
          }
        }
        await walk(args.path)
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

  ipcMain.handle(IPC.logsExportFileTree, async (_e, text: string) => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: `File Tree ${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }]
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

  // ---- Sync ----
  ipcMain.handle(IPC.syncGetTasks, () => syncStore.getAll())

  ipcMain.handle(IPC.syncSaveTask, async (_e, task: SyncTask) => {
    const tasks = await syncStore.save(task)
    scheduleSync()
    return tasks
  })

  ipcMain.handle(IPC.syncDeleteTask, (_e, id: string) => syncStore.remove(id))

  ipcMain.handle(IPC.syncRunPreview, async (_e, args: { taskId: string; task: SyncTask }) => {
    const { taskId, task } = args
    const leftConn = task.leftConnectionId === BUILTIN_LOCAL_ID
      ? BUILTIN_LOCAL
      : await connectionStore.getResolved(task.leftConnectionId)
    const rightConn = task.rightConnectionId === BUILTIN_LOCAL_ID
      ? BUILTIN_LOCAL
      : await connectionStore.getResolved(task.rightConnectionId)
    if (!leftConn || !rightConn) throw new Error('Connection not found')

    const leftProvider = createProvider(leftConn)
    const rightProvider = createProvider(rightConn)

    const onProgress = (p: unknown): void => sendToRenderer(IPC.evtSyncProgress, p)
    syncEngine.on('progress', onProgress)
    try {
      return await syncEngine.scan(taskId, task, leftProvider, rightProvider)
    } finally {
      syncEngine.removeListener('progress', onProgress)
    }
  })

  ipcMain.handle(
    IPC.syncExecute,
    async (_e, args: { taskId: string; task: SyncTask; items: SyncPreviewItem[] }) => {
      const { taskId, task, items } = args
      const leftConn = task.leftConnectionId === BUILTIN_LOCAL_ID
        ? BUILTIN_LOCAL
        : await connectionStore.getResolved(task.leftConnectionId)
      const rightConn = task.rightConnectionId === BUILTIN_LOCAL_ID
        ? BUILTIN_LOCAL
        : await connectionStore.getResolved(task.rightConnectionId)
      if (!leftConn || !rightConn) throw new Error('Connection not found')

      const leftProvider = createProvider(leftConn)
      const rightProvider = createProvider(rightConn)

      const onProgress = (p: unknown): void => sendToRenderer(IPC.evtSyncProgress, p)
      syncEngine.on('progress', onProgress)
      try {
        const stats = await syncEngine.execute(taskId, task, items, leftProvider, rightProvider)
        const result =
          stats.errors > 0
            ? stats.errors >= stats.copied + stats.deleted
              ? 'error'
              : 'partial'
            : 'success'
        await syncStore.updateTaskResult(taskId, result, stats)
        log.info('sync', `Sync "${task.name}" — ${stats.copied} copied, ${stats.deleted} deleted, ${stats.errors} errors`)
        return stats
      } finally {
        syncEngine.removeListener('progress', onProgress)
      }
    }
  )

  ipcMain.handle(IPC.syncCancel, (_e, taskId: string) => syncEngine.cancel(taskId))

  ipcMain.handle(IPC.syncGetLaunchAtStartup, () => app.getLoginItemSettings().openAtLogin)

  ipcMain.handle(IPC.syncSetLaunchAtStartup, (_e, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable })
  })

  ipcMain.handle(IPC.appCheckUpdates, async () => {
    return checkForUpdates()
  })

  ipcMain.handle(IPC.appOpenExternal, (_e, url: string) => {
    void shell.openExternal(url)
  })
}

// Suppress Chromium GPU/EGL process log noise (EGL driver warnings) in dev mode.
// Tells Chromium to use Metal instead of probing EGL, eliminating the
// "[ERROR:gl_display.cc] eglQueryDeviceAttribEXT: Bad attribute" stderr spam.
if (!app.isPackaged && process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-angle', 'metal')
}

// Prevent Windows from throttling the renderer process when the window is
// minimized — without these, active transfers can stall or slow to a crawl.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}

// Register Adobe's custom URI scheme so the OS delivers OAuth callbacks to this app.
// Must be called before app.whenReady() to take effect on first launch.
app.setAsDefaultProtocolClient(FRAMEIO_PROTOCOL_SCHEME)

// macOS delivers custom-scheme URLs via open-url (even when the app is already running).
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (url.startsWith(FRAMEIO_PROTOCOL_SCHEME + '://')) {
    handleCustomSchemeCallback(url)
  }
})

// Windows delivers the URL as a second-instance argv when the app is already running.
app.on('second-instance', (_event, argv) => {
  const url = argv.find((arg) => arg.startsWith(FRAMEIO_PROTOCOL_SCHEME + '://'))
  if (url) handleCustomSchemeCallback(url)
  // Re-focus the main window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// ── Sync scheduler ────────────────────────────────────────────────────────────
// Maps taskId → timer handle for interval-scheduled tasks.
const syncTimers = new Map<string, ReturnType<typeof setInterval>>()

async function runScheduledSync(task: SyncTask): Promise<void> {
  try {
    const leftConn = task.leftConnectionId === BUILTIN_LOCAL_ID
      ? BUILTIN_LOCAL
      : await connectionStore.getResolved(task.leftConnectionId)
    const rightConn = task.rightConnectionId === BUILTIN_LOCAL_ID
      ? BUILTIN_LOCAL
      : await connectionStore.getResolved(task.rightConnectionId)
    if (!leftConn || !rightConn) return

    const leftProvider = createProvider(leftConn)
    const rightProvider = createProvider(rightConn)

    const onProgress = (p: unknown): void => sendToRenderer(IPC.evtSyncProgress, p)
    syncEngine.on('progress', onProgress)
    try {
      const items = await syncEngine.scan(task.id, task, leftProvider, rightProvider)
      const stats = await syncEngine.execute(task.id, task, items, leftProvider, rightProvider)
      const result = stats.errors > 0 ? (stats.errors >= stats.copied + stats.deleted ? 'error' : 'partial') : 'success'
      await syncStore.updateTaskResult(task.id, result, stats)
      log.info('sync', `Scheduled sync "${task.name}" — ${stats.copied} copied, ${stats.errors} errors`)

      const title = result === 'success' ? `Sync Complete: ${task.name}` : `Sync Issues: ${task.name}`
      const body = `${stats.copied} copied, ${stats.deleted} deleted${stats.errors > 0 ? `, ${stats.errors} errors` : ''}`
      if (Notification.isSupported()) new Notification({ title, body }).show()
    } finally {
      syncEngine.removeListener('progress', onProgress)
    }
  } catch (err) {
    log.error('sync', `Scheduled sync "${task.name}" failed: ${(err as Error).message}`)
  }
}

function scheduleSync(): void {
  // Clear all existing timers and rebuild from current task list.
  for (const timer of syncTimers.values()) clearInterval(timer)
  syncTimers.clear()

  void (async () => {
    const tasks = await syncStore.getAll()
    const now = new Date()

    for (const task of tasks) {
      if (!task.enabled || !task.schedule) continue
      const { type, intervalMinutes } = task.schedule

      if (type === 'on-launch') {
        // Run immediately (slight delay so the app finishes loading)
        setTimeout(() => void runScheduledSync(task), 5000)
      } else if (type === 'interval' && intervalMinutes && intervalMinutes > 0) {
        const ms = intervalMinutes * 60 * 1000
        const timer = setInterval(() => void runScheduledSync(task), ms)
        syncTimers.set(task.id, timer)
      } else if (type === 'daily' || type === 'weekly' || type === 'monthly') {
        // Check every minute if it's time to run
        const timer = setInterval(() => {
          const n = new Date()
          const [hh, mm] = (task.schedule?.time ?? '00:00').split(':').map(Number)
          if (n.getHours() !== hh || n.getMinutes() !== mm) return
          if (type === 'weekly' && n.getDay() !== (task.schedule?.weekDay ?? 0)) return
          if (type === 'monthly' && n.getDate() !== (task.schedule?.monthDay ?? 1)) return
          void runScheduledSync(task)
        }, 60_000)
        syncTimers.set(task.id, timer)
        void now // suppress unused warning
      }
    }
  })()
}

// ── Application menu ─────────────────────────────────────────────────────────
// Explicitly registered (rather than relying on Electron's implicit default
// menu) so Quit — and its Cmd+Q / Ctrl+Q accelerator — reliably routes through
// promptQuit() instead of whatever fallback quit behavior Electron would
// otherwise wire up.
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { label: 'Quit Conduit', accelerator: 'Cmd+Q', click: () => void promptQuit() }
            ]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: isMac
        ? [{ role: 'close' }]
        : [{ label: 'Exit', accelerator: 'Ctrl+Q', click: () => void promptQuit() }]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── System tray ───────────────────────────────────────────────────────────────
let tray: Tray | null = null

function buildTrayMenu(): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Conduit',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          void createWindow()
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Conduit',
      click: () => void promptQuit()
    }
  ])
  tray.setContextMenu(menu)
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

  // System tray
  try {
    const iconPath = join(app.getAppPath(), 'build', 'icon.png')
    let trayIcon = nativeImage.createFromPath(iconPath)
    if (!trayIcon.isEmpty()) trayIcon = trayIcon.resize({ width: 16, height: 16 })
    tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon)
    tray.setToolTip('Conduit')
    buildTrayMenu()
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) mainWindow.focus()
        else mainWindow.show()
      } else {
        void createWindow()
      }
    })
  } catch {
    // tray is optional — ignore failures
  }

  buildAppMenu()
  registerIpc()
  await createWindow()

  // Apply saved settings.
  const settings = await getSettings()
  await logger.prune(settings.logRetentionDays)
  transferEngine.setConcurrency(settings.transferConcurrency)
  log.info('app', `Conduit ${app.getVersion()} started`)

  // Start scheduled syncs
  scheduleSync()

  // Check for updates in the background; push to renderer if a newer version is found.
  setTimeout(async () => {
    const info = await checkForUpdates()
    if (info) sendToRenderer(IPC.evtUpdateAvailable, info)
  }, 5000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
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
  const activeTransfers = transferEngine
    .getAll()
    .filter((t) => t.status === 'transferring' || t.status === 'queued')

  // Always warn on in-progress transfers, regardless of the "don't ask again"
  // connections setting — quitting mid-transfer can leave a partial/incomplete
  // file at the destination, which is a bigger deal than just disconnecting.
  if (activeTransfers.length > 0) {
    if (!mainWindow) return
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Quit Conduit',
      message: `${activeTransfers.length} transfer${activeTransfers.length !== 1 ? 's are' : ' is'} still in progress.`,
      detail: 'Quitting now will stop them before they finish, and any in-flight file may be left incomplete at the destination.',
      buttons: ['Cancel', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0
    })
    if (response === 0) return // user cancelled
  }

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

// before-quit fires on Cmd+Q and the app-menu Quit item, BEFORE any window's
// 'close' event — so it's the first (and for Cmd+Q, only) chance to prompt.
// It used to unconditionally set quitInProgress = true here, which made the
// window 'close' handler below think quitting had already been confirmed —
// in reality nothing had asked the user anything, so Cmd+Q silently killed
// active transfers with no warning. Route through the same promptQuit() the
// red-X close path uses instead.
app.on('before-quit', (e) => {
  if (quitInProgress) return // already confirmed — let it proceed
  e.preventDefault()
  void promptQuit()
})
