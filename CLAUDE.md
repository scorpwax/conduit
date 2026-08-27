# Conduit — Claude Code Guide

Conduit is a dual-pane file transfer desktop app built with Electron + React + TypeScript.
It connects local drives, external disks, S3/Wasabi, SFTP, SMB, FTP, WebDAV, Google Drive,
OneDrive, and Dropbox in a side-by-side file manager, similar to Transmit or Cyberduck.

---

## Stack

| Layer | Tech |
|---|---|
| Framework | Electron 32 + electron-vite |
| UI | React 18 + TypeScript, Zustand for state |
| Build/package | electron-builder (DMG for Mac, NSIS installer for Windows) |
| S3/Wasabi | `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` |
| SFTP | `ssh2` |
| FTP | `basic-ftp` |
| WebDAV | `webdav` |
| CI | GitHub Actions (`.github/workflows/build.yml`) |

---

## Project structure

```
src/
  main/                   # Electron main process (Node.js)
    index.ts              # App entry, IPC handler registration, window creation
    logger.ts             # File-based activity log (logs/ dir in userData)
    settings.ts           # Persisted app settings (JSON in userData)
    store.ts              # Connection storage (safeStorage encryption for secrets)
    drives.ts             # Enumerate local drives (macOS /Volumes, Windows A-Z)
    preview.ts            # macOS Quick Look via qlmanage (no-op on Windows)
    rclone.ts             # macOS-only: mount S3/Wasabi as local filesystem via rclone+macFUSE
    transfer/
      engine.ts           # Transfer queue, concurrency, progress, size verification
    providers/
      types.ts            # Provider interface (all backends implement this)
      index.ts            # getProvider() factory — resolves connectionId → Provider
      local.ts            # Local filesystem
      s3.ts               # S3 + Wasabi (multipart upload/copy for large files)
      sftp.ts             # SFTP / SSH
      smb.ts              # SMB (macOS: mount_smbfs, Windows: UNC paths)
      ftp.ts              # FTP via basic-ftp
      webdav.ts           # WebDAV
      gdrive.ts           # Google Drive (OAuth)
      onedrive.ts         # OneDrive (OAuth)
      dropbox.ts          # Dropbox (OAuth)
  preload/
    index.ts              # contextBridge API exposed to renderer as window.conduit
    index.d.ts            # Type declaration (derives from ConduitApi in index.ts)
  renderer/src/
    App.tsx               # Root component, pane layout, transfer/log panel toggle
    store.ts              # Zustand store (panes, connections, transfers, clipboard)
    components/
      Pane.tsx            # Single pane: connection bar, breadcrumbs, drag-and-drop
      FileList.tsx        # File rows, sorting, selection, context menu, info modal
      ConnectionMenu.tsx  # Connection picker dropdown
      ConnectionModal.tsx # New/edit connection form (all provider types)
      TransferPanel.tsx   # Transfer queue sidebar
      LogsPanel.tsx       # Activity log modal with filters and export
      ConflictModal.tsx   # Overwrite / keep-both / skip conflict resolution
      ContextMenu.tsx     # Generic right-click menu component
      DialogHost.tsx      # Portal for confirm/prompt dialogs
      Logo.tsx            # App logo SVG
    lib/
      format.ts           # formatBytes, formatDate, fileIcon, fileType
      drag.ts             # Cross-pane drag state (getDrag/setDrag/clearDrag)
      paneDrag.ts         # Pane reorder drag state
      connMeta.tsx        # ConnIcon component + connColor per provider type
  shared/
    types.ts              # Shared TypeScript types (FileEntry, Connection, TransferItem, etc.)
    ipc.ts                # IPC channel name constants
    builtin.ts            # BUILTIN_LOCAL_ID constant
scripts/
  patch-wasabi-compat.js  # postinstall: patches @smithy/core to accept ISO 8601 Expires headers
build/
  icon.png                # 1024×1024 app icon (macOS)
  icon.ico                # Multi-resolution icon (Windows installer)
electron-builder.yml      # electron-builder config (DMG + NSIS targets)
```

---

## Key concepts

### Provider interface
Every connection type implements `Provider` (`src/main/providers/types.ts`).
The transfer engine and all IPC handlers talk only to this interface — adding a new
backend means implementing one class with: `list`, `stat`, `createReadStream`,
`writeFile`, `mkdir`, `createFile`, `delete`, `rename`, `exists`, `join`, `parent`, `test`.
Optional: `getLocalRoot` (local-backed providers), `checksum` (S3 returns ETag).

### IPC pattern
- Channel names are constants in `src/shared/ipc.ts`
- `src/preload/index.ts` wraps each channel in a typed function, exposed as `window.conduit`
- `src/main/index.ts` registers all `ipcMain.handle` listeners in `registerIpc()`
- The renderer never calls `ipcRenderer` directly — always goes through `window.conduit`

### Transfer engine (`src/main/transfer/engine.ts`)
- Queue-based with configurable concurrency (default 5, user-adjustable in log panel)
- `run()` method: `createReadStream` from source → `writeFile` to dest → size-verify via `stat`
- Emits `update` events batched at 250ms for UI progress updates
- After every successful transfer, stats the destination to confirm byte count matches source

### Wasabi compatibility patch
Wasabi returns `Expires` headers as ISO 8601 (`2026-07-22T18:18:46Z`) instead of RFC 7231.
The AWS SDK v3's `_parseRfc7231DateTime` throws on this format. `scripts/patch-wasabi-compat.js`
patches `@smithy/core` (all dist variants) to fall back to RFC 3339 parsing before throwing.
Runs automatically via `postinstall`. If the SDK is updated and the patch stops applying,
the script logs a warning but does not fail the install.

### S3 large file operations
- **Upload**: files >50 MB use `@aws-sdk/lib-storage` `Upload` (multipart)
- **Rename/copy**: files >5 GB use `UploadPartCopy` in 128 MB chunks (S3's `CopyObject` limit is 5 GB)
- Both have abort/cleanup on failure

### Drag and drop
- Internal cross-pane drag: `setDrag()` stores payload in `src/renderer/src/lib/drag.ts`
- Folder drop targets: works for cross-pane, same-pane, and native OS (Finder/Explorer) drags
- Pane reorder drag: separate state in `paneDrag.ts`
- `e.stopPropagation()` on folder row drop prevents the pane-level handler from also firing

### Platform differences
- `window.conduit.platform` — `'darwin'` | `'win32'` | `'linux'`, use for conditional UI
- Quick Look (spacebar / right-click): macOS only — guarded by `platform === 'darwin'`
- "Reveal in Finder" / "Mount to Desktop": macOS only — hidden on Windows
- rclone S3 mount: macOS only (macFUSE required)
- Folder size: `du -sk` on macOS/Linux, pure-Node recursive stat walk on Windows
- Titlebar spacer (traffic lights): macOS only

---

## Common tasks

### Add a new IPC handler
1. Add the channel name to `src/shared/ipc.ts`
2. Add the typed wrapper to `src/preload/index.ts`
3. Add `ipcMain.handle(IPC.yourChannel, ...)` in `registerIpc()` in `src/main/index.ts`

### Add a new connection type
1. Add config interface to `src/shared/types.ts`, add to the `ConnectionConfig` union
2. Create `src/main/providers/yourtype.ts` implementing `Provider`
3. Register it in `src/main/providers/index.ts` `getProvider()` switch
4. Add a form tab in `src/renderer/src/components/ConnectionModal.tsx`
5. Add icon + color in `src/renderer/src/lib/connMeta.tsx`

### Add a context menu item
In `src/renderer/src/components/FileList.tsx`, add to the `menuItems()` function.
Use `window.conduit.platform === 'darwin'` to guard macOS-only items.

### Versioning
Bump `version` in `package.json` and add an entry to `CHANGELOG.md` on every change.
Follow semver: patch for fixes, minor for new features.

When a change ships something tracked in `ROADMAP.md`, mark that bullet done instead
of deleting it: prefix it with `COMPLETE vX.Y.Z – ` (the version it shipped in), right
before the bolded item name.

---

## Building

```bash
npm run dev          # Start in development mode
npm run dist:mac     # Build macOS DMG (run on a Mac)
npm run dist:win     # Build Windows NSIS installer (run on a Windows machine)
```

### CI (GitHub Actions)
`.github/workflows/build.yml` builds both platforms in parallel on every push to `main`.
Artifacts (DMG + EXE) are downloadable from the Actions tab for 90 days.
No code signing configured — unsigned builds for internal testing.

To trigger a manual build without pushing code:
Actions tab → Build → Run workflow → Run workflow

---

## Owner / context
- Built for Scorpion (scorpion.co) internal use — production / studio file management
- Primary use case: transferring large video/audio files (BRAW, R3D, WAV, MOV) to/from Wasabi S3
- GitHub repo: https://github.com/scorpwax/conduit (private)
- User email: Mike.Wax@scorpion.co
