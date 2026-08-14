import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, TreeNode, FolderTreeResult } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'
import type { PaneState } from '../store'
import { useStore } from '../store'
import { formatBytes, formatDate, fileIcon, fileType } from '../lib/format'
import { setDrag, clearDrag, getDrag } from '../lib/drag'
import { confirmDialog, promptDialog, choiceDialog } from '../lib/dialog'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { BatchRenameModal } from './BatchRenameModal'
import { FolderBrowserModal } from './FolderBrowserModal'

interface Props {
  pane: PaneState
  filter: string
  folderSizes: Record<string, { size: number; latestModified: string | null } | 'loading' | null>
  setFolderSizes: React.Dispatch<React.SetStateAction<Record<string, { size: number; latestModified: string | null } | 'loading' | null>>>
  fetchFolderSize: (path: string) => void
}

type SortKey = 'name' | 'size' | 'type' | 'modified'
type SortDir = 'asc' | 'desc'

interface Row {
  entry: FileEntry
  depth: number
}

export function FileList({ pane, filter, folderSizes, setFolderSizes, fetchFolderSize }: Props): JSX.Element {
  const navigate = useStore((s) => s.navigate)
  const setSelection = useStore((s) => s.setSelection)
  const panes = useStore((s) => s.panes)
  const requestTransfer = useStore((s) => s.requestTransfer)
  const renameEntry = useStore((s) => s.renameEntry)
  const deleteEntries = useStore((s) => s.deleteEntries)
  const openInNewPane = useStore((s) => s.openInNewPane)
  const addBookmark = useStore((s) => s.addBookmark)
  const showHidden = useStore((s) => s.showHidden)
  const copyEntries = useStore((s) => s.copyEntries)
  const pasteInto = useStore((s) => s.pasteInto)
  const clipboard = useStore((s) => s.clipboard)
  const connections = useStore((s) => s.connections)
  const refreshPane = useStore((s) => s.refreshPane)

  const [dropDir, setDropDir] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childCache, setChildCache] = useState<Record<string, FileEntry[]>>({})
  const [infoEntries, setInfoEntries] = useState<FileEntry[] | null>(null)
  const [infoFull, setInfoFull] = useState<FileEntry | null>(null)
  const [infoChecksum, setInfoChecksum] = useState<string | null | 'loading'>('loading')
  const [infoContents, setInfoContents] = useState<{ files: number; folders: number } | null | 'loading'>('loading')
  const [moveToEntry, setMoveToEntry] = useState<FileEntry[] | null>(null)
  const [compareEntries, setCompareEntries] = useState<Array<{ entry: FileEntry; connectionId: string }> | null>(null)

  const [batchRenameOpen, setBatchRenameOpen] = useState(false)
  const [batchRenameEntries, setBatchRenameEntries] = useState<FileEntry[]>([])

  const [treeEntry, setTreeEntry] = useState<FileEntry | null>(null)
  const [treeResult, setTreeResult] = useState<FolderTreeResult | null>(null)
  const [treeLoading, setTreeLoading] = useState(false)
  const [pathCopied, setPathCopied] = useState(false)
  const pathCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const raw = pane.result?.entries ?? []

  // Collapse the tree and clear cached children when the folder/connection changes.
  useEffect(() => {
    setExpanded(new Set())
    setChildCache({})
  }, [pane.path, pane.connectionId])

  // Auto-fetch folder sizes for local/SMB connections (both use real OS paths).
  const fetchDirSizes = useCallback(
    (dirs: FileEntry[]) => {
      if (!pane.connectionId || dirs.length === 0) return
      const connType = connections.find((c) => c.id === pane.connectionId)?.type ?? 'local'
      if (connType !== 'local' && connType !== 'smb') return
      dirs.forEach((d) => fetchFolderSize(d.path))
    },
    [pane.connectionId, connections, fetchFolderSize]
  )

  useEffect(() => {
    if (!pane.result) return
    fetchDirSizes(pane.result.entries.filter((e) => e.kind === 'directory'))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.result, pane.connectionId])

  // Also auto-fetch sizes for subdirectories revealed by expanding a folder.
  useEffect(() => {
    const allCached = Object.values(childCache).flat()
    fetchDirSizes(allCached.filter((e) => e.kind === 'directory'))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childCache])

  // Filter (hidden + search) and sort a list — reused for every tree level.
  const arrange = useCallback(
    (list: FileEntry[]): FileEntry[] => {
      const q = filter.trim().toLowerCase()
      let out = showHidden ? list : list.filter((e) => !e.name.startsWith('.'))
      if (q) out = out.filter((e) => e.name.toLowerCase().includes(q))
      const mult = sort.dir === 'asc' ? 1 : -1
      return [...out].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        let cmp = 0
        if (sort.key === 'name') cmp = a.name.localeCompare(b.name)
        else if (sort.key === 'size') cmp = a.size - b.size
        else if (sort.key === 'type') cmp = fileType(a.name, a.kind).localeCompare(fileType(b.name, b.kind))
        else cmp = (a.modified ?? '').localeCompare(b.modified ?? '')
        return cmp * mult
      })
    },
    [filter, sort, showHidden]
  )

  // Flatten the visible tree into rows with depth, expanding open folders.
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const walk = (list: FileEntry[], depth: number): void => {
      for (const entry of list) {
        out.push({ entry, depth })
        if (entry.kind === 'directory' && expanded.has(entry.path) && childCache[entry.path]) {
          walk(arrange(childCache[entry.path]), depth + 1)
        }
      }
    }
    walk(arrange(raw), 0)
    return out
  }, [raw, arrange, expanded, childCache])

  const selected = new Set(pane.selection)
  const lastIndex = pane.selection.length
    ? rows.findIndex((r) => r.entry.path === pane.selection[pane.selection.length - 1])
    : -1

  async function toggleExpand(entry: FileEntry): Promise<void> {
    const next = new Set(expanded)
    if (next.has(entry.path)) {
      next.delete(entry.path)
      setExpanded(next)
      return
    }
    next.add(entry.path)
    setExpanded(next)
    if (!childCache[entry.path] && pane.connectionId) {
      try {
        const result = await window.conduit.fs.list(pane.connectionId, entry.path)
        setChildCache((c) => ({ ...c, [entry.path]: result.entries }))
      } catch {
        // leave expanded but empty on error
        setChildCache((c) => ({ ...c, [entry.path]: [] }))
      }
    }
  }

  function toggleSort(key: SortKey): void {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  function onRowClick(e: React.MouseEvent, entry: FileEntry, index: number): void {
    listRef.current?.focus()
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path)
      setSelection(pane.id, [...next])
    } else if (e.shiftKey && lastIndex >= 0) {
      const [a, b] = [lastIndex, index].sort((x, y) => x - y)
      setSelection(
        pane.id,
        rows.slice(a, b + 1).map((r) => r.entry.path)
      )
    } else {
      setSelection(pane.id, [entry.path])
    }
  }

  function onRowDoubleClick(entry: FileEntry): void {
    if (entry.kind === 'directory') void navigate(pane.id, entry.path)
    else {
      const connType = connections.find((c) => c.id === pane.connectionId)?.type ?? 'local'
      if (connType === 'local' || connType === 'smb') void window.conduit.fs.openFile(entry.path)
    }
  }

  function selectedEntries(): FileEntry[] {
    return rows.filter((r) => pane.selection.includes(r.entry.path)).map((r) => r.entry)
  }

  function doCopy(entry: FileEntry): void {
    const targets = pane.selection.includes(entry.path) ? selectedEntries() : [entry]
    if (pane.connectionId) {
      copyEntries(
        pane.connectionId,
        targets.map((t) => t.path),
        targets.map((t) => t.name)
      )
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey
    if (e.key === ' ' && pane.selection.length === 1 && pane.connectionId && window.conduit.platform === 'darwin') {
      const entry = rows.find((r) => r.entry.path === pane.selection[0])?.entry
      if (entry && entry.kind === 'file') {
        e.preventDefault()
        void window.conduit.fs.preview(pane.connectionId, entry.path)
      }
    } else if (e.key === 'Enter' && pane.selection.length === 1) {
      e.preventDefault()
      const entry = rows.find((r) => r.entry.path === pane.selection[0])?.entry
      if (entry) void doRename(entry)
    } else if (meta && e.key === 'ArrowDown' && pane.selection.length === 1) {
      e.preventDefault()
      const entry = rows.find((r) => r.entry.path === pane.selection[0])?.entry
      if (entry?.kind === 'directory') void navigate(pane.id, entry.path)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const nextIdx = lastIndex >= 0 ? Math.min(lastIndex + 1, rows.length - 1) : 0
      if (rows[nextIdx]) setSelection(pane.id, [rows[nextIdx].entry.path])
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prevIdx = lastIndex > 0 ? lastIndex - 1 : 0
      if (rows[prevIdx]) setSelection(pane.id, [rows[prevIdx].entry.path])
    } else if (e.key === 'ArrowRight' && pane.selection.length > 0) {
      e.preventDefault()
      const selSet = new Set(pane.selection)
      const dirs = rows.filter((r) => selSet.has(r.entry.path) && r.entry.kind === 'directory').map((r) => r.entry)
      const toOpen = dirs.filter((d) => !expanded.has(d.path))
      if (toOpen.length > 0) {
        setExpanded((prev) => { const next = new Set(prev); toOpen.forEach((d) => next.add(d.path)); return next })
        if (pane.connectionId) {
          for (const dir of toOpen) {
            if (!childCache[dir.path]) {
              void window.conduit.fs.list(pane.connectionId, dir.path).then((result) => {
                setChildCache((c) => ({ ...c, [dir.path]: result.entries }))
              }).catch(() => setChildCache((c) => ({ ...c, [dir.path]: [] })))
            }
          }
        }
      }
    } else if (e.key === 'ArrowLeft' && pane.selection.length > 0) {
      e.preventDefault()
      const selSet = new Set(pane.selection)
      const dirs = rows.filter((r) => selSet.has(r.entry.path) && r.entry.kind === 'directory').map((r) => r.entry)
      const toClose = dirs.filter((d) => expanded.has(d.path))
      if (toClose.length > 0) {
        setExpanded((prev) => { const next = new Set(prev); toClose.forEach((d) => next.delete(d.path)); return next })
      }
    } else if (meta && (e.key === 'c' || e.key === 'C') && pane.selection.length > 0) {
      e.preventDefault()
      const first = rows.find((r) => r.entry.path === pane.selection[0])?.entry
      if (first) doCopy(first)
    } else if (meta && (e.key === 'v' || e.key === 'V') && clipboard) {
      e.preventDefault()
      void pasteInto(pane.id)
    } else if (meta && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      setSelection(pane.id, rows.map((r) => r.entry.path))
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && meta && pane.selection.length > 0) {
      e.preventDefault()
      const first = rows.find((r) => r.entry.path === pane.selection[0])?.entry
      if (first) void doDelete(first)
    }
  }

  function onDragStart(e: React.DragEvent, entry: FileEntry): void {
    let paths = pane.selection
    if (!selected.has(entry.path)) {
      paths = [entry.path]
      setSelection(pane.id, paths)
    }
    const names = rows.filter((r) => paths.includes(r.entry.path)).map((r) => r.entry.name)
    setDrag({ fromPaneId: pane.id, paths, names })
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', names.join(', '))

    // For local/SMB panes, trigger native OS file drag so files can be dropped
    // onto Finder, Desktop, or other apps without creating a text clipping.
    const connType = connections.find((c) => c.id === pane.connectionId)?.type ?? 'local'
    if (connType === 'local' || connType === 'smb') {
      window.conduit.fs.startDrag(paths)
    }

    if (paths.length > 1) {
      const badge = document.createElement('div')
      badge.textContent = `${paths.length} items`
      Object.assign(badge.style, {
        position: 'fixed', top: '-200px', left: '-200px',
        background: '#4f8ef7', color: 'white',
        padding: '4px 12px', borderRadius: '12px',
        fontSize: '12px', fontWeight: '600',
        fontFamily: 'system-ui, sans-serif', whiteSpace: 'nowrap',
        pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
      })
      document.body.appendChild(badge)
      e.dataTransfer.setDragImage(badge, -12, 12)
      setTimeout(() => document.body.removeChild(badge), 0)
    }
  }

  function onDirDrop(e: React.DragEvent, dir: FileEntry): void {
    e.preventDefault()
    e.stopPropagation()
    setDropDir(null)
    const payload = getDrag()
    if (payload) {
      if (payload.fromPaneId === pane.id) {
        // Same-pane drag: MOVE (not copy) into the subfolder.
        if (!pane.connectionId) return
        void window.conduit.fs.moveToDir(pane.connectionId, payload.paths, dir.path)
          .then(() => refreshPane(pane.id))
        clearDrag()
      } else {
        void transferInto(dir.path)
      }
      return
    }
    // Native OS file drag (from Finder/desktop) onto a specific folder.
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length === 0 || !pane.connectionId) return
    const paths = files.map((f) => window.conduit.getPathForFile(f)).filter(Boolean)
    if (paths.length > 0) void requestTransfer(BUILTIN_LOCAL_ID, pane.connectionId, paths, dir.path)
  }

  async function transferInto(dir: string): Promise<void> {
    const payload = getDrag()
    if (!payload) return
    const from = panes.find((p) => p.id === payload.fromPaneId)
    if (!from?.connectionId || !pane.connectionId) return
    await requestTransfer(from.connectionId, pane.connectionId, payload.paths, dir)
    clearDrag()
  }

  function openContextMenu(e: React.MouseEvent, entry: FileEntry): void {
    e.preventDefault()
    if (!pane.selection.includes(entry.path)) setSelection(pane.id, [entry.path])
    setCtxMenu({ x: e.clientX, y: e.clientY, entry })
  }

  async function doRename(entry: FileEntry): Promise<void> {
    // For files, pre-select only the stem (not the extension) so the user
    // doesn't accidentally overwrite the extension when typing a new name.
    let selectUpTo: number | undefined
    if (entry.kind === 'file') {
      const dot = entry.name.lastIndexOf('.')
      if (dot > 0) selectUpTo = dot
    }
    const name = await promptDialog({ title: `Rename “${entry.name}”`, defaultValue: entry.name, confirmText: 'Rename', selectUpTo })
    if (!name || name === entry.name) return

    // Check if the name already exists in the current listing.
    const existing = pane.result?.entries.find(
      (e) => e.name.toLowerCase() === name.toLowerCase() && e.path !== entry.path
    )
    if (existing) {
      const choice = await choiceDialog({
        title: 'Name Already Exists',
        fileName: name,
        message: `”${name}” already exists in this location. What would you like to do?`,
        choices: [
          ...(existing.kind === 'directory' && entry.kind === 'directory'
            ? [{ label: 'Merge', value: 'merge', primary: true }]
            : [{ label: 'Overwrite', value: 'overwrite', danger: true }]),
          { label: 'Rename Again', value: 'rename' },
        ],
      })
      if (!choice) return
      if (choice === 'rename') { void doRename(entry); return }
      if (choice === 'overwrite') {
        await window.conduit.fs.delete(pane.connectionId!, existing.path, existing.kind)
      }
      // 'merge' falls through — rename proceeds (OS/provider handles folder merge)
    }

    await renameEntry(pane.id, entry.path, name)
  }

  async function doDuplicate(entry: FileEntry): Promise<void> {
    if (!pane.connectionId) return
    const targets = pane.selection.includes(entry.path) ? selectedEntries() : [entry]
    await window.conduit.fs.duplicateEntries(
      pane.connectionId,
      targets.map((t) => ({ path: t.path, name: t.name, kind: t.kind }))
    )
    await refreshPane(pane.id)
  }

  async function doDelete(entry: FileEntry): Promise<void> {
    const targets = pane.selection.includes(entry.path) ? selectedEntries() : [entry]
    const multi = targets.length > 1
    const kindWord = targets[0].kind === 'directory' ? 'folder' : 'file'
    const ok = await confirmDialog({
      title: multi
        ? `Are you sure you want to delete these ${targets.length} items?`
        : `Are you sure you want to delete this ${kindWord}?`,
      fileName: multi ? `${targets.length} items` : targets[0].name,
      warning: 'This action cannot be undone.',
      confirmText: 'Delete',
      danger: true
    })
    if (!ok) return
    await deleteEntries(
      pane.id,
      targets.map((t) => ({ path: t.path, kind: t.kind }))
    )
  }

  async function doDownload(entry: FileEntry): Promise<void> {
    if (!pane.connectionId) return
    const targets = pane.selection.includes(entry.path) ? selectedEntries() : [entry]
    let settings = await window.conduit.settings.get()
    let dir = settings.downloadDir
    if (!dir) {
      dir = await window.conduit.dialog.pickFolder() ?? undefined
      if (!dir) return
      await window.conduit.settings.set({ downloadDir: dir })
      settings = { ...settings, downloadDir: dir }
    }
    await requestTransfer(pane.connectionId, BUILTIN_LOCAL_ID, targets.map((t) => t.path), dir)
  }

  function menuItems(entry: FileEntry): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    const connType = connections.find((c) => c.id === pane.connectionId)?.type ?? 'local'
    const isLocalConn = pane.connectionId === BUILTIN_LOCAL_ID || connType === 'local'

    // Group 1: primary actions
    if (entry.kind === 'file' && isLocalConn) {
      items.push({ label: 'Open', onClick: () => void window.conduit.fs.openFile(entry.path) })
    }
    if (entry.kind === 'file' && window.conduit.platform === 'darwin') {
      items.push({ label: 'Quick Look', onClick: () => pane.connectionId && window.conduit.fs.preview(pane.connectionId, entry.path) })
    }
    items.push({ label: 'Open in New Pane', onClick: () => doOpenInNewPane(entry) })
    if (isLocalConn && window.conduit.platform === 'darwin') {
      items.push({ label: 'Reveal in Finder', onClick: () => void window.conduit.fs.revealFile(entry.path) })
    }
    items.push({ label: 'Add to Favorites', onClick: () => doAddFavorite(entry) })

    // Group 2: edit actions
    items.push({ separator: true })
    items.push({ label: 'Select All', onClick: () => setSelection(pane.id, rows.map((r) => r.entry.path)) })
    items.push({ label: 'Deselect All', disabled: pane.selection.length === 0, onClick: () => setSelection(pane.id, []) })
    items.push({ label: 'Copy', onClick: () => doCopy(entry) })
    items.push({ label: 'Paste', disabled: !clipboard, onClick: () => void pasteInto(pane.id) })
    items.push({ label: 'Duplicate', onClick: () => void doDuplicate(entry) })
    items.push({ label: 'Rename…', onClick: () => void doRename(entry) })
    items.push({
      label: 'Batch Rename…',
      onClick: () => {
        const targets = pane.selection.includes(entry.path) ? selectedEntries() : [entry]
        setBatchRenameEntries(targets)
        setBatchRenameOpen(true)
      }
    })

    // Group 3: info / export
    items.push({ separator: true })
    items.push({ label: 'Download…', onClick: () => void doDownload(entry) })
    items.push({ label: 'Move to…', onClick: () => doMoveTo(entry) })
    items.push({ label: 'Copy Path', onClick: () => doCopyPath(entry) })
    const crossPaneTotal = panes.reduce((n, p) => n + (p.selection.length > 0 && p.connectionId ? p.selection.length : 0), 0)
    const samePaneSel = pane.selection.includes(entry.path) ? pane.selection : [entry.path]
    if (crossPaneTotal >= 2 || samePaneSel.length >= 2) {
      items.push({ label: 'Compare', onClick: () => doCompare(entry) })
    }
    items.push({ label: 'Properties', onClick: () => doGetInfo(entry) })
    if (entry.kind === 'directory') {
      items.push({ label: 'File Tree…', onClick: () => doViewTree(entry) })
    }

    // Group 4: destructive
    items.push({ separator: true })
    items.push({ label: 'Delete', danger: true, onClick: () => void doDelete(entry) })

    return items
  }

  function doCopyPath(entry: FileEntry): void {
    void navigator.clipboard.writeText(entry.path)
    setPathCopied(true)
    if (pathCopiedTimer.current) clearTimeout(pathCopiedTimer.current)
    pathCopiedTimer.current = setTimeout(() => setPathCopied(false), 2500)
  }

  function doGetInfo(entry: FileEntry): void {
    const targets = pane.selection.includes(entry.path) ? selectedEntries() : [entry]
    setInfoEntries(targets)
    setInfoFull(null)
    setInfoChecksum('loading')
    setInfoContents('loading')
    if (!pane.connectionId || targets.length !== 1) return
    const single = targets[0]
    void window.conduit.fs.stat(pane.connectionId, single.path).then((full) => setInfoFull(full))
    if (single.kind === 'file') {
      void window.conduit.fs.checksum(pane.connectionId, single.path).then((c) => setInfoChecksum(c))
      setInfoContents(null)
    } else {
      setInfoChecksum(null)
      void window.conduit.fs.folderContents(pane.connectionId, single.path).then((c) => setInfoContents(c))
      fetchFolderSize(single.path)
    }
  }

  function doMoveTo(entry: FileEntry): void {
    const targets = pane.selection.includes(entry.path) ? selectedEntries() : [entry]
    setMoveToEntry(targets)
  }

  function doCompare(entry: FileEntry): void {
    // Collect selections from every pane that has something selected,
    // tagging each entry with its connection. This enables cross-connection compare.
    const items: Array<{ entry: FileEntry; connectionId: string }> = []
    for (const p of panes) {
      if (!p.connectionId || p.selection.length === 0) continue
      const paneEntries = p.result?.entries ?? []
      for (const path of p.selection) {
        const e = paneEntries.find((en) => en.path === path)
        if (e) items.push({ entry: e, connectionId: p.connectionId })
      }
    }
    // Fall back to the right-clicked entry if nothing useful across panes
    if (items.length === 0 && pane.connectionId) {
      const targets = pane.selection.includes(entry.path) ? selectedEntries() : [entry]
      for (const e of targets) items.push({ entry: e, connectionId: pane.connectionId })
    }
    if (items.length >= 1) setCompareEntries(items)
  }

  function doViewTree(entry: FileEntry): void {
    if (!pane.connectionId) return
    setTreeEntry(entry)
    setTreeResult(null)
    setTreeLoading(true)
    void window.conduit.fs.folderTree(pane.connectionId, entry.path).then((result) => {
      setTreeResult(result)
      setTreeLoading(false)
    }).catch(() => setTreeLoading(false))
  }

  function doOpenInNewPane(entry: FileEntry): void {
    if (!pane.connectionId) return
    const target = entry.kind === 'directory' ? entry.path : pane.path
    void openInNewPane(pane.connectionId, target)
  }

  function doAddFavorite(entry: FileEntry): void {
    if (!pane.connectionId) return
    if (entry.kind === 'directory') void addBookmark(entry.name, pane.connectionId, entry.path)
    else {
      const folderName = pane.path.split(/[/\\]/).filter(Boolean).pop() || 'Folder'
      void addBookmark(folderName, pane.connectionId, pane.path)
    }
  }


  if (pane.error) {
    return (
      <div className="pane-empty">
        <h3>Couldn’t open this location</h3>
        <p>{pane.error}</p>
      </div>
    )
  }

  if (pane.loading && raw.length === 0) {
    return (
      <div className="pane-empty">
        <p>Loading…</p>
      </div>
    )
  }

  if (raw.length === 0) {
    return (
      <div className="pane-empty">
        <p>This folder is empty.</p>
      </div>
    )
  }

  const caret = (key: SortKey): string => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')

  return (
    <div
      className="file-list"
      tabIndex={0}
      ref={listRef}
      onKeyDown={onKeyDown}
      onScroll={() => setCtxMenu(null)}
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (
          !target.closest('.file-row') &&
          !target.closest('.file-head') &&
          !target.closest('.ctx-menu') &&
          !target.closest('.ctx-backdrop')
        ) {
          setSelection(pane.id, [])
        }
      }}
    >
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={menuItems(ctxMenu.entry)} onClose={() => setCtxMenu(null)} />
      )}
      {batchRenameOpen && pane.connectionId && (
        <BatchRenameModal
          entries={batchRenameEntries}
          allEntries={raw}
          connectionId={pane.connectionId}
          onClose={() => setBatchRenameOpen(false)}
          onRename={(path, newName) => renameEntry(pane.id, path, newName)}
          onComplete={() => setBatchRenameOpen(false)}
        />
      )}
      {pathCopied && (
        <div className="path-copied-toast">Path copied to clipboard</div>
      )}
      {infoEntries && (() => {
        const conn = connections.find((c) => c.id === pane.connectionId) ?? null
        const closeInfo = () => {
          setInfoEntries(null); setInfoFull(null); setInfoChecksum('loading'); setInfoContents('loading')
        }
        const multi = infoEntries.length > 1
        const single = !multi ? infoEntries[0] : null

        if (multi) {
          return (
            <div className="modal-overlay" onMouseDown={closeInfo}>
              <div className="info-panel" onMouseDown={(e) => e.stopPropagation()}>
                <div className="info-header">
                  <span className="info-title">Properties — {infoEntries.length} items</span>
                  <button className="iconbtn" onClick={closeInfo}>✕</button>
                </div>
                <div className="info-body">
                  {infoEntries.map((e, i) => {
                    const webUrl = conn ? buildWebUrl(conn, e.path) : null
                    const pathLen = e.path.length
                    const pathOverLimit = pathLen > 256
                    const fsz = folderSizes[e.path]
                    const sizeVal = (() => {
                      if (e.kind === 'directory') {
                        if (!fsz || fsz === 'loading') return 'Calculating…'
                        if (typeof fsz === 'object') {
                          const human = formatBytes(fsz.size)
                          const raw = fsz.size.toLocaleString()
                          return fsz.size >= 1000 ? `${human} (${raw} bytes)` : human
                        }
                        return 'Unavailable'
                      }
                      const bytes = e.size ?? 0
                      if (!bytes) return '—'
                      const human = formatBytes(bytes)
                      const raw = bytes.toLocaleString()
                      return bytes >= 1000 ? `${human} (${raw} bytes)` : human
                    })()
                    return (
                      <div key={e.path}>
                        {i > 0 && <div className="info-divider" />}
                        <FileInfoRow label="Name" value={e.name} />
                        <FileInfoRow label="Kind" value={e.kind === 'directory' ? 'Folder' : 'File'} />
                        <FileInfoRow label="Type" value={e.kind === 'directory' ? 'Folder' : fileType(e.name, e.kind)} />
                        <FileInfoRow
                          label="Path"
                          value={e.path}
                          mono
                          warning={pathOverLimit ? `Path is ${pathLen} characters — exceeds the 256-character Windows limit` : undefined}
                          extra={`${pathLen} characters`}
                        />
                        {webUrl && <FileInfoRow label="URL" value={webUrl} mono />}
                        <FileInfoRow label="Size" value={sizeVal} />
                        {e.modified && <FileInfoRow label="Modified" value={formatDate(e.modified)} />}
                        {e.kind === 'file' && <FileInfoRow label="Checksum" value="—" />}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        }

        if (!single) return null
        const webUrl = conn ? buildWebUrl(conn, single.path) : null
        const isDir = single.kind === 'directory'
        const pathLen = single.path.length
        const pathOverLimit = pathLen > 256
        return (
          <div className="modal-overlay" onMouseDown={closeInfo}>
            <div className="info-panel" onMouseDown={(e) => e.stopPropagation()}>
              <div className="info-header">
                <span className="info-title">Properties</span>
                <button className="iconbtn" onClick={closeInfo}>✕</button>
              </div>
              <div className="info-body">
                <FileInfoRow label="Name" value={single.name} />
                <FileInfoRow label="Kind" value={isDir ? 'Folder' : 'File'} />
                {!isDir && <FileInfoRow label="Type" value={fileType(single.name, single.kind)} />}
                <FileInfoRow
                  label="Path"
                  value={single.path}
                  mono
                  warning={pathOverLimit ? `Path is ${pathLen} characters — exceeds the 256-character Windows limit` : undefined}
                  extra={`${pathLen} characters`}
                />
                {webUrl && <FileInfoRow label="URL" value={webUrl} mono />}
                <FileInfoRow
                  label="Size"
                  value={(() => {
                    if (!isDir) {
                      const bytes = infoFull?.size ?? single.size ?? 0
                      if (!bytes) return '—'
                      const human = formatBytes(bytes)
                      const raw = bytes.toLocaleString()
                      return bytes >= 1000 ? `${human} (${raw} bytes)` : human
                    }
                    const fsz = folderSizes[single.path]
                    if (fsz === 'loading' || fsz === undefined) return 'Calculating…'
                    if (fsz && typeof fsz === 'object') {
                      const human = formatBytes(fsz.size)
                      const raw = fsz.size.toLocaleString()
                      return fsz.size >= 1000 ? `${human} (${raw} bytes)` : human
                    }
                    return 'Unavailable'
                  })()}
                />
                {(() => {
                  const fsz = folderSizes[single.path]
                  const folderModified = (fsz && typeof fsz === 'object') ? fsz.latestModified : null
                  const modDate = infoFull?.modified ?? single.modified ?? folderModified
                  return modDate ? <FileInfoRow label="Modified" value={formatDate(modDate)} /> : null
                })()}
                {isDir && (() => {
                  if (infoContents === 'loading') return <FileInfoRow label="Item Count" value="Counting…" />
                  if (!infoContents) return null
                  const total = infoContents.files + infoContents.folders
                  const parts = [`${total.toLocaleString()} Items`]
                  if (infoContents.files > 0) parts.push(`${infoContents.files.toLocaleString()} Files`)
                  if (infoContents.folders > 0) parts.push(`${infoContents.folders.toLocaleString()} Folders`)
                  return <FileInfoRow label="Item Count" value={parts.join(' · ')} />
                })()}
                {!isDir && (
                  <FileInfoRow
                    label="Checksum"
                    value={infoChecksum === 'loading' ? 'Loading…' : (infoChecksum ?? 'Unavailable')}
                    mono
                  />
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {treeEntry && (
        <div className="modal-overlay" onMouseDown={() => { setTreeEntry(null); setTreeResult(null) }}>
          <div className="tree-panel" onMouseDown={(e) => e.stopPropagation()}>
            <div className="tree-header">
              <div className="tree-header-left">
                <span className="tree-title">File Tree</span>
                <span className="tree-folder-name">{treeEntry.path}</span>
              </div>
              <button className="iconbtn" onClick={() => { setTreeEntry(null); setTreeResult(null) }}>✕</button>
            </div>

            {treeLoading && (
              <div className="tree-loading">
                <span className="tree-loading-spinner" />
                Building file tree… this may take a moment for large folders.
              </div>
            )}

            {treeResult && (
              <>
                <div className="tree-summary">
                  <span>{treeResult.totalFiles.toLocaleString()} file{treeResult.totalFiles !== 1 ? 's' : ''}</span>
                  <span className="tree-summary-dot">·</span>
                  <span>{treeResult.totalFolders.toLocaleString()} folder{treeResult.totalFolders !== 1 ? 's' : ''}</span>
                  <span className="tree-summary-dot">·</span>
                  <span>{formatBytes(treeResult.totalSize)}</span>
                  {treeResult.truncated && (
                    <span className="tree-truncated">⚠ Large folder — showing first 25,000 items</span>
                  )}
                </div>

                <div className="tree-body">
                  <div className="tree-root-name">{treeEntry.name}/</div>
                  {flattenTree(treeResult.tree).map((line, i) => (
                    <div key={i} className="tree-line">
                      <span className="tree-prefix">{line.prefix}</span>
                      <span className={`tree-name ${line.kind === 'directory' ? 'tree-dir' : ''}`}>
                        {line.name}
                      </span>
                      {(line.size > 0 || line.modified) && (
                        <span className="tree-meta">
                          {line.kind === 'file' && line.size > 0 && formatBytes(line.size)}
                          {line.kind === 'file' && line.size > 0 && line.modified && ' · '}
                          {line.modified && formatDate(line.modified)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="tree-footer">
                  <button
                    className="btn ghost"
                    onClick={() => {
                      const text = buildTreeText(treeEntry.name, treeResult)
                      void window.conduit.logs.exportFileTree(text)
                    }}
                  >
                    Export as .txt
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="file-head">
        <div className="sortable" onClick={() => toggleSort('name')}>
          Name{caret('name')}
        </div>
        <div className="sortable" onClick={() => toggleSort('size')}>
          Size{caret('size')}
        </div>
        <div className="sortable" onClick={() => toggleSort('type')}>
          Type{caret('type')}
        </div>
        <div className="sortable" onClick={() => toggleSort('modified')}>
          Modified{caret('modified')}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="pane-empty" style={{ paddingTop: 40 }}>
          <p>{filter ? `No files match “${filter}”.` : 'Nothing to show here (hidden files are off).'}</p>
        </div>
      ) : (
        rows.map(({ entry, depth }, i) => {
          const isDir = entry.kind === 'directory'
          return (
            <div
              key={entry.path}
              className={[
                'file-row',
                isDir ? 'dir' : '',
                selected.has(entry.path) ? 'selected' : '',
                entry.hidden ? 'hidden' : '',
                dropDir === entry.path ? 'selected' : ''
              ].join(' ')}
              draggable
              onClick={(e) => onRowClick(e, entry, i)}
              onDoubleClick={() => onRowDoubleClick(entry)}
              onContextMenu={(e) => openContextMenu(e, entry)}
              onDragStart={(e) => onDragStart(e, entry)}
              onDragEnd={clearDrag}
              onDragOver={
                isDir
                  ? (e) => {
                      const payload = getDrag()
                      const isNative = !payload && e.dataTransfer.types.includes('Files')
                      const isCrossPaneDrag = payload && payload.fromPaneId !== pane.id
                      const isSamePaneDrag = payload && payload.fromPaneId === pane.id
                      if (isCrossPaneDrag || isNative || isSamePaneDrag) {
                        e.preventDefault()
                        e.stopPropagation()
                        e.dataTransfer.dropEffect = 'copy'
                        setDropDir(entry.path)
                      }
                    }
                  : undefined
              }
              onDragLeave={isDir ? () => setDropDir(null) : undefined}
              onDrop={isDir ? (e) => onDirDrop(e, entry) : undefined}
            >
              <div className="file-name" style={{ paddingLeft: depth * 16 }}>
                {isDir ? (
                  <span
                    className="disclosure"
                    onClick={(e) => {
                      e.stopPropagation()
                      void toggleExpand(entry)
                    }}
                  >
                    {expanded.has(entry.path) ? '▼' : '▶'}
                  </span>
                ) : (
                  <span className="disclosure spacer">▶</span>
                )}
                <span className="ficon">{fileIcon(entry.name, entry.kind)}</span>
                <span className="label">{entry.name}</span>
              </div>
              <div
                className="file-size"
                onClick={isDir ? (e) => { e.stopPropagation(); fetchFolderSize(entry.path) } : undefined}
                title={isDir && !folderSizes[entry.path] ? 'Click to calculate size' : undefined}
              >
                {isDir
                  ? (() => {
                      const fsz = folderSizes[entry.path]
                      if (fsz === 'loading') return '…'
                      if (fsz && typeof fsz === 'object') return formatBytes(fsz.size)
                      return <span style={{ color: 'var(--text-faint)', cursor: 'pointer' }} title="Click to calculate size">—</span>
                    })()
                  : formatBytes(entry.size)}
              </div>
              <div className="file-type">{fileType(entry.name, entry.kind)}</div>
              <div className="file-mod">{(() => {
                if (entry.modified) return formatDate(entry.modified)
                if (isDir) {
                  const fsz = folderSizes[entry.path]
                  if (fsz && typeof fsz === 'object' && fsz.latestModified) return formatDate(fsz.latestModified)
                }
                return '—'
              })()}</div>
            </div>
          )
        })
      )}

      {moveToEntry && pane.connectionId && (
        <MoveToModal
          sourceConnectionId={pane.connectionId}
          entries={moveToEntry}
          onMove={async (destConnectionId, destDir) => {
            if (!pane.connectionId) return
            const srcPaths = moveToEntry.map((e) => e.path)
            if (destConnectionId === pane.connectionId) {
              await window.conduit.fs.moveToDir(pane.connectionId, srcPaths, destDir)
            } else {
              await requestTransfer(pane.connectionId, destConnectionId, srcPaths, destDir, true)
            }
            setMoveToEntry(null)
            await refreshPane(pane.id)
          }}
          onClose={() => setMoveToEntry(null)}
        />
      )}

      {compareEntries && (
        <CompareModal
          items={compareEntries}
          folderSizes={folderSizes}
          fetchFolderSize={fetchFolderSize}
          onClose={() => setCompareEntries(null)}
        />
      )}
    </div>
  )
}

function FileInfoRow({
  label, value, mono, warning, extra, note
}: {
  label: string
  value: string
  mono?: boolean
  warning?: string
  extra?: string
  note?: string
}): JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const isFaded = value === 'Loading…' || value === 'Unavailable' || value === 'Calculating…'

  function handleClick(): void {
    if (isFaded) return
    void navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="info-row"
      onClick={handleClick}
      title={isFaded ? undefined : 'Click to copy'}
    >
      <span className="info-label">{label}</span>
      <span className="info-value-wrap">
        <span
          className="info-value"
          style={mono ? { fontFamily: 'monospace', wordBreak: 'break-all' } : undefined}
        >
          {copied ? <span style={{ color: 'var(--success, #22c55e)' }}>Copied!</span> : value}
        </span>
        {extra && !copied && (
          <span className="info-extra">{extra}</span>
        )}
        {warning && (
          <span className="info-warning">⚠ {warning}</span>
        )}
        {note && (
          <span className="info-note">{note}</span>
        )}
      </span>
    </div>
  )
}

function flattenTree(
  nodes: TreeNode[],
  parentPrefix = ''
): Array<{ prefix: string; name: string; kind: 'file' | 'directory'; size: number; modified: string | null }> {
  const lines: Array<{ prefix: string; name: string; kind: 'file' | 'directory'; size: number; modified: string | null }> = []
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = parentPrefix + (isLast ? '    ' : '│   ')
    lines.push({
      prefix: parentPrefix + connector,
      name: node.name + (node.kind === 'directory' ? '/' : ''),
      kind: node.kind,
      size: node.size,
      modified: node.modified
    })
    if (node.children.length) lines.push(...flattenTree(node.children, childPrefix))
  })
  return lines
}

function buildTreeText(rootName: string, result: FolderTreeResult): string {
  const lines: string[] = [`${rootName}/`]
  for (const line of flattenTree(result.tree)) {
    const meta: string[] = []
    if (line.kind === 'file' && line.size > 0) {
      // inline formatBytes since we can't call the renderer helper from here
      const bytes = line.size
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let u = 0, v = bytes
      while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
      meta.push(`${u === 0 ? v : v.toFixed(1)} ${units[u]}`)
    }
    if (line.modified) meta.push(new Date(line.modified).toLocaleDateString())
    const suffix = meta.length ? `  [${meta.join(' · ')}]` : ''
    lines.push(`${line.prefix}${line.name}${suffix}`)
  }
  lines.push('')
  lines.push(`${result.totalFiles.toLocaleString()} file${result.totalFiles !== 1 ? 's' : ''}, ${result.totalFolders.toLocaleString()} folder${result.totalFolders !== 1 ? 's' : ''}`)
  if (result.truncated) lines.push('(truncated at 25,000 items)')
  return lines.join('\n')
}

function buildWebUrl(conn: { type: string; config: unknown }, path: string): string | null {
  if (conn.type !== 's3' && conn.type !== 'wasabi') return null
  const cfg = conn.config as { bucket?: string; region?: string; endpoint?: string }
  const bucket = cfg.bucket
  const region = cfg.region
  if (!bucket) return null
  const key = path.replace(/^\/+/, '')
  if (cfg.endpoint) {
    const host = cfg.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '')
    return `https://${bucket}.${host}/${key}`
  }
  if (!region) return null
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`
}

// ── Move To Modal ─────────────────────────────────────────────────────────────
function MoveToModal({ sourceConnectionId, entries, onMove, onClose }: {
  sourceConnectionId: string
  entries: FileEntry[]
  onMove: (destConnectionId: string, destDir: string) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const connections = useStore((s) => s.connections)
  const [destConnId, setDestConnId] = React.useState(sourceConnectionId)
  const [moving, setMoving] = React.useState(false)
  const [pickedPath, setPickedPath] = React.useState<string | null>(null)

  const destConn = connections.find((c) => c.id === destConnId) ?? connections[0]
  const crossConnection = destConnId !== sourceConnectionId
  const label = entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`

  async function handleMove(): Promise<void> {
    if (!pickedPath || !destConn) return
    setMoving(true)
    try {
      await onMove(destConn.id, pickedPath)
    } finally {
      setMoving(false)
    }
  }

  const connPickerSlot = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Destination:</span>
      <select
        className="compare-conn-picker"
        value={destConnId}
        onChange={(ev) => { setDestConnId(ev.target.value); setPickedPath(null) }}
        onClick={(ev) => ev.stopPropagation()}
      >
        {connections.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </div>
  )

  return destConn ? (
    <FolderBrowserModal
      connectionId={destConn.id}
      connectionName={destConn.name}
      initialPath=""
      headerSlot={connPickerSlot}
      onSelect={(path) => setPickedPath(path)}
      onClose={onClose}
      headerFooter={
        <>
          {pickedPath && (
            <div className="move-to-warning" style={{ margin: '0 16px 0' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>warning</span>
              <span>
                {crossConnection
                  ? <>This will <strong>transfer</strong> {label} to <strong>{destConn.name}</strong> and delete the original.</>
                  : <>This will <strong>move</strong> {label} — it will be removed from the source location.</>
                }
              </span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 16px 16px' }}>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!pickedPath || moving} onClick={() => void handleMove()}>
              {moving ? (crossConnection ? 'Transferring…' : 'Moving…') : (crossConnection ? 'Transfer & Delete Original' : 'Move Here')}
            </button>
          </div>
        </>
      }
    />
  ) : null
}

// ── Compare Modal ─────────────────────────────────────────────────────────────
function CompareModal({ items: initialItems, folderSizes, fetchFolderSize, onClose }: {
  items: Array<{ entry: FileEntry; connectionId: string }>
  folderSizes: Record<string, { size: number; latestModified: string | null } | 'loading' | null>
  fetchFolderSize: (path: string) => void
  onClose: () => void
}): JSX.Element {
  const connections = useStore((s) => s.connections)
  const [items, setItems] = React.useState(initialItems)
  const [stats, setStats] = React.useState<Record<string, FileEntry | null>>({})
  const [checksums, setChecksums] = React.useState<Record<string, string | null | 'loading'>>({})
  const [contents, setContents] = React.useState<Record<string, { files: number; folders: number } | null | 'loading'>>({})
  const [addingItem, setAddingItem] = React.useState(false)
  const [addConnId, setAddConnId] = React.useState(connections[0]?.id ?? '')
  const [pendingAddPath, setPendingAddPath] = React.useState('')

  function loadItem(entry: FileEntry, connId: string): void {
    void window.conduit.fs.stat(connId, entry.path).then((s) =>
      setStats((prev) => ({ ...prev, [entry.path]: s }))
    )
    if (entry.kind === 'file') {
      setChecksums((prev) => ({ ...prev, [entry.path]: 'loading' }))
      void window.conduit.fs.checksum(connId, entry.path).then((c) =>
        setChecksums((prev) => ({ ...prev, [entry.path]: c }))
      )
    } else {
      setContents((prev) => ({ ...prev, [entry.path]: 'loading' }))
      void window.conduit.fs.folderContents(connId, entry.path).then((c) =>
        setContents((prev) => ({ ...prev, [entry.path]: c }))
      )
      fetchFolderSize(entry.path)
    }
  }

  React.useEffect(() => {
    for (const { entry, connectionId } of items) loadItem(entry, connectionId)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived comparison values ──────────────────────────────────────────────
  const entries = items.map((i) => i.entry)

  const sizes = entries.map((e) => {
    if (e.kind === 'file') return stats[e.path]?.size ?? e.size ?? 0
    const fsz = folderSizes[e.path]
    return (fsz && typeof fsz === 'object') ? fsz.size : null
  })
  const allSizesLoaded = sizes.every((s) => s !== null)
  const sizesMatch = allSizesLoaded && sizes.every((s) => s === sizes[0])

  const itemCounts = entries.map((e) => {
    if (e.kind === 'file') return null
    const c = contents[e.path]
    if (!c || c === 'loading') return null
    return c.files + c.folders
  })
  const allCountsLoaded = itemCounts.every((c) => c !== null)
  const countsMatch = allCountsLoaded && itemCounts.every((c) => c === itemCounts[0])

  const filesLoaded = entries.map((e) => {
    if (e.kind === 'file') return null
    const c = contents[e.path]
    if (!c || c === 'loading') return null
    return c.files
  })
  const allFilesLoaded = filesLoaded.every((c) => c !== null)
  const filesMatch = allFilesLoaded && filesLoaded.every((c) => c === filesLoaded[0])

  const foldersLoaded = entries.map((e) => {
    if (e.kind === 'file') return null
    const c = contents[e.path]
    if (!c || c === 'loading') return null
    return c.folders
  })
  const allFoldersLoaded = foldersLoaded.every((c) => c !== null)
  const foldersMatch = allFoldersLoaded && foldersLoaded.every((c) => c === foldersLoaded[0])

  const checksumValues = entries.map((e) => checksums[e.path])
  const checksumsLoaded = checksumValues.every((c) => c !== undefined && c !== 'loading')
  const checksumsMatch = checksumsLoaded && checksumValues.every((c) => c && c === checksumValues[0])

  const modValues = entries.map((e) => stats[e.path]?.modified ?? e.modified ?? null)
  const allModLoaded = modValues.every((m) => m !== null)
  const modMatch = allModLoaded && modValues.every((m) => m === modValues[0])

  const kindValues = entries.map((e) => e.kind)
  const kindsMatch = kindValues.every((k) => k === kindValues[0])

  const typeValues = entries.map((e) => fileType(e.name, e.kind))
  const typesMatch = typeValues.every((t) => t === typeValues[0])

  // ── Helpers ────────────────────────────────────────────────────────────────
  function legendBadge(match: boolean, loaded: boolean): JSX.Element {
    if (!loaded) return <span className="compare-badge loading">Checking…</span>
    return match
      ? <span className="compare-badge match">✓ Match</span>
      : <span className="compare-badge mismatch">✗ Mismatch</span>
  }

  function matchIcon(match: boolean, loaded: boolean): JSX.Element | null {
    if (!loaded) return null
    return match
      ? <span className="compare-check match" title="Matches across all items">✓</span>
      : <span className="compare-check mismatch" title="Does not match across all items">✗</span>
  }

  if (addingItem) {
    const addConn = connections.find((c) => c.id === addConnId) ?? connections[0]
    const connPickerSlot = (
      <select
        className="compare-conn-picker"
        value={addConnId}
        onChange={(ev) => { setAddConnId(ev.target.value); setPendingAddPath('') }}
        onClick={(ev) => ev.stopPropagation()}
      >
        {connections.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    )
    function confirmAdd(path: string, kind: 'file' | 'directory', size = 0, modified: string | null = null): void {
      if (!addConn) return
      const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path
      const entry: FileEntry = { path, name, kind, size, modified }
      setItems((prev) => [...prev, { entry, connectionId: addConn.id }])
      loadItem(entry, addConn.id)
      setAddingItem(false)
    }
    return addConn ? (
      <FolderBrowserModal
        connectionId={addConn.id}
        connectionName={addConn.name}
        initialPath=""
        showFiles
        headerSlot={connPickerSlot}
        onSelectEntry={(entry) => confirmAdd(entry.path, entry.kind, entry.size, entry.modified)}
        onSelect={(path) => setPendingAddPath(path)}
        headerFooter={
          <div className="modal-footer">
            <span className="fb-selected-path">{pendingAddPath || '/'}</span>
            <button className="btn ghost" onClick={() => setAddingItem(false)}>Cancel</button>
            <button className="btn primary" onClick={() => confirmAdd(pendingAddPath || '/', 'directory')}>
              Add to Compare
            </button>
          </div>
        }
        onClose={() => setAddingItem(false)}
      />
    ) : null
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="compare-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="info-header">
          <div>
            <div className="info-title">Compare {items.length} items</div>
            <div className="compare-paths">
              {items.map(({ entry, connectionId }) => {
                const connName = connections.find((c) => c.id === connectionId)?.name ?? connectionId
                return (
                  <span key={entry.path} className="compare-path-chip" title={entry.path}>
                    <span className="compare-path-conn">{connName}:</span> {entry.path}
                  </span>
                )
              })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => setAddingItem(true)}>+ Add item</button>
            <button className="iconbtn" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Legend / summary */}
        <div className="compare-summary">
          <span className="compare-legend-label">Legend:</span>
          <span className="compare-badge match">✓ Match</span>
          <span className="compare-badge mismatch">✗ Mismatch</span>
          <div className="compare-summary-divider" />
          <div className="compare-summary-item">
            <span className="compare-summary-label">Size</span>
            {legendBadge(sizesMatch, allSizesLoaded)}
          </div>
          {entries[0].kind === 'directory' && <>
            <div className="compare-summary-item">
              <span className="compare-summary-label">Total Items</span>
              {legendBadge(countsMatch, allCountsLoaded)}
            </div>
            <div className="compare-summary-item">
              <span className="compare-summary-label">Files</span>
              {legendBadge(filesMatch, allFilesLoaded)}
            </div>
            <div className="compare-summary-item">
              <span className="compare-summary-label">Folders</span>
              {legendBadge(foldersMatch, allFoldersLoaded)}
            </div>
          </>}
          {entries[0].kind === 'file' && (
            <div className="compare-summary-item">
              <span className="compare-summary-label">Checksum</span>
              {legendBadge(checksumsMatch, checksumsLoaded)}
            </div>
          )}
        </div>

        {/* Per-item columns */}
        <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
          {items.map(({ entry: e, connectionId }) => {
            const conn = connections.find((c) => c.id === connectionId) ?? null
            const connName = conn?.name ?? connectionId
            const fsz = folderSizes[e.path]
            const itemSize = e.kind === 'file'
              ? (stats[e.path]?.size ?? e.size ?? 0)
              : (fsz && typeof fsz === 'object') ? fsz.size : null
            const itemCount = contents[e.path]
            const checksum = checksums[e.path]
            const webUrl = conn ? buildWebUrl(conn, e.path) : null

            return (
              <div key={`${connectionId}:${e.path}`} className="compare-col">
                <div className="compare-col-conn">{connName}</div>
                <div className="compare-col-name" title={e.path}>{e.name}</div>

                <CompareField label="Kind" matchIcon={matchIcon(kindsMatch, true)}>
                  {e.kind === 'directory' ? 'Folder' : 'File'}
                </CompareField>

                <CompareField label="Type" matchIcon={matchIcon(typesMatch, true)}>
                  {fileType(e.name, e.kind)}
                </CompareField>

                <CompareField label="Path" mono>
                  {e.path}
                </CompareField>

                {webUrl && (
                  <CompareField label="URL" mono>
                    {webUrl}
                  </CompareField>
                )}

                <CompareField label="Size" matchIcon={matchIcon(sizesMatch, allSizesLoaded)}>
                  {itemSize === null ? 'Calculating…' : (e.kind === 'file' && itemSize === 0 && stats[e.path] === undefined) ? 'Loading…' : itemSize === 0 ? '—' : formatBytes(itemSize)}
                </CompareField>

                <CompareField label="Bytes" mono matchIcon={matchIcon(sizesMatch, allSizesLoaded)}>
                  {itemSize === null ? '—' : (e.kind === 'file' && itemSize === 0 && stats[e.path] === undefined) ? 'Loading…' : itemSize.toLocaleString()}
                </CompareField>

                <CompareField label="Modified" matchIcon={matchIcon(modMatch, allModLoaded)}>
                  {(() => { const m = stats[e.path]?.modified ?? e.modified; return m ? formatDate(m) : stats[e.path] === undefined ? 'Loading…' : '—' })()}
                </CompareField>

                {e.kind === 'directory' && <>
                  <CompareField label="Total Items" matchIcon={matchIcon(countsMatch, allCountsLoaded)}>
                    {!itemCount || itemCount === 'loading'
                      ? 'Counting…'
                      : (itemCount.files + itemCount.folders).toLocaleString()}
                  </CompareField>
                  <CompareField label="Files" matchIcon={matchIcon(filesMatch, allFilesLoaded)}>
                    {!itemCount || itemCount === 'loading' ? 'Counting…' : itemCount.files.toLocaleString()}
                  </CompareField>
                  <CompareField label="Folders" matchIcon={matchIcon(foldersMatch, allFoldersLoaded)}>
                    {!itemCount || itemCount === 'loading' ? 'Counting…' : itemCount.folders.toLocaleString()}
                  </CompareField>
                </>}

                {e.kind === 'file' && (
                  <CompareField label="Checksum" mono matchIcon={matchIcon(checksumsMatch, checksumsLoaded)}>
                    {checksum === 'loading' ? 'Loading…' : (checksum ?? 'N/A')}
                  </CompareField>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CompareField({ label, children, mono, matchIcon }: {
  label: string
  children: React.ReactNode
  mono?: boolean
  matchIcon?: JSX.Element | null
}): JSX.Element {
  return (
    <div className="compare-field">
      <div className="compare-field-header">
        <span className="compare-field-label">{label}</span>
        {matchIcon}
      </div>
      <span className={mono ? 'compare-mono' : ''}>{children}</span>
    </div>
  )
}
