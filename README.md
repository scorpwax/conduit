# Conduit

A dual-pane file transfer app in the spirit of Transmit and GoodSync. Browse two
locations side by side in a Finder-style view and drag-and-drop files between them.

Supports **Local / External drives**, **Amazon S3** (plus any S3-compatible
service), **SFTP/SSH** (including computer-to-computer transfers), and **SMB**
network shares — all interchangeable as either side of a transfer.

## Features

- **Dual (or more) resizable panes** — drag the divider between panes to resize.
  Add extra panes with **+ Add Pane**.
- **Finder-style browsing** — folders and files with sizes and modified dates,
  multi-select (⌘-click / shift-click), breadcrumb navigation.
- **Drag & drop transfers** — drag a selection from one pane onto another pane, or
  directly onto a folder in the other pane.
- **Live transfer progress** — a resizable, collapsible panel shows per-file
  progress, speed, and totals; cancel individual transfers or all at once.
- **Saved connections & favorites** — connections are remembered; star the ones
  you use most. S3 secret keys are encrypted at rest via the OS keychain.
- **Built-in drive access** — jump straight to your Home folder, internal disk, or
  any mounted external volume without saving a connection first.

## Tech stack

- **Electron** (desktop shell) + **React** + **TypeScript**, bundled with
  **electron-vite**.
- **AWS SDK v3** for S3, with multipart uploads and streamed downloads.
- A **provider abstraction** (`src/main/providers`) means adding a new backend
  (SFTP, SMB, computer-to-computer) is implementing one interface.

## Project layout

```
src/
  shared/            Types & IPC channel names shared across processes
  main/              Electron main process (Node)
    providers/       local.ts, s3.ts — one class per connection type
    transfer/        engine.ts — streaming transfer queue with progress
    store.ts         Saved connections (secrets encrypted via safeStorage)
    drives.ts        Drive/volume enumeration
    index.ts         Window + IPC handlers
  preload/           Secure bridge exposing window.conduit to the renderer
  renderer/src/      React UI
    components/       Pane, FileList, ConnectionMenu, ConnectionModal,
                      TransferPanel, Logo
    store.ts          Zustand app state
build/
  icon.svg / icon.png  App icon
```

## Develop

```bash
npm install
npm run dev        # launches the app with hot reload
```

## Build a distributable

```bash
npm run dist:mac   # .dmg (macOS)
npm run dist:win   # .exe installer (Windows) — build from/for Windows
```

## Connecting to another computer (SFTP)

1. On the **other** Mac: System Settings → General → Sharing → enable **Remote Login**.
   (Windows: install/enable the OpenSSH Server feature. Linux: `sshd`.)
2. In Conduit, add a **Computer (SFTP)** connection with that machine's IP or
   `name.local`, and its username + password (or a private key).
3. Browse and drag files between it and any other pane.

## Roadmap

- Sync mode (mirror / two-way) like GoodSync
- Conflict handling & resume for interrupted transfers
- Windows packaging & testing
- SFTP connection pooling for faster many-file transfers
