import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'
import type { PaneState } from '../store'
import { useStore } from '../store'
import { formatBytes, formatDate, fileIcon, fileType } from '../lib/format'
import { setDrag, clearDrag, getDrag } from '../lib/drag'
import { confirmDialog, promptDialog } from '../lib/dialog'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

interface Props {
  pane: PaneState
  filter: string
  folderSizes: Record<string, number | 'loading' | null>
  setFolderSizes: React.Dispatch<React.SetStateAction<Record<string, number | 'loading' | null>>>
}

type SortKey = 'name' | 'size' | 'type' | 'modified'
type SortDir = 'asc' | 'desc'

interface Row {
  entry: FileEntry
  depth: number
}

export function FileList({ pane, filter, folderSizes, setFolderSizes }: Props): JSX.Element {
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

  const [dropDir, setDropDir] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childCache, setChildCache] = useState<Record<string, FileEntry[]>>({})
  const [infoEntry, setInfoEntry] = useState<FileEntry | null>(null)
  const [infoFull, setInfoFull] = useState<FileEntry | null>(null)
  const [infoChecksum, setInfoChecksum] = useState<string | null | 'loading'>('loading')
  const [infoContents, setInfoContents] = useState<{ files: number; folders: number } | null | 'loading'>('loading')
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
      setFolderSizes((prev) => {
        const next = { ...prev }
        dirs.forEach((d) => { if (!(d.path in next)) next[d.path] = 'loading' })
        return next
      })
      dirs.forEach((d) => {
        if (folderSizes[d.path] !== undefined) return
        void window.conduit.fs.folderSize(pane.connectionId!, d.path).then((size) => {
          setFolderSizes((s) => ({ ...s, [d.path]: size }))
        })
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.connectionId, connections]
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
    } else if (e.key === 'ArrowRight' && pane.selection.length === 1) {
      e.preventDefault()
      const entry = rows.find((r) => r.entry.path === pane.selection[0])?.entry
      if (entry?.kind === 'directory' && !expanded.has(entry.path)) void toggleExpand(entry)
    } else if (e.key === 'ArrowLeft' && pane.selection.length === 1) {
      e.preventDefault()
      const entry = rows.find((r) => r.entry.path === pane.selection[0])?.entry
      if (entry?.kind === 'directory' && expanded.has(entry.path)) void toggleExpand(entry)
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
        // Same-pane drag: move selected files into this subfolder.
        if (!pane.connectionId) return
        void requestTransfer(pane.connectionId, pane.connectionId, payload.paths, dir.path)
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
    const name = await promptDialog({ title: `Rename “${entry.name}”`, defaultValue: entry.name, confirmText: 'Rename' })
    if (name && name !== entry.name) await renameEntry(pane.id, entry.path, name)
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

  function menuItems(entry: FileEntry): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    if (entry.kind === 'file' && window.conduit.platform === 'darwin') {
      items.push({
        label: 'Quick Look',
        onClick: () => pane.connectionId && window.conduit.fs.preview(pane.connectionId, entry.path)
      })
    }
    items.push({ label: 'Open in New Pane', onClick: () => doOpenInNewPane(entry) })
    items.push({ label: 'Copy', onClick: () => doCopy(entry) })
    items.push({ label: 'Paste', disabled: !clipboard, onClick: () => void pasteInto(pane.id) })
    items.push({
      label: 'Select All',
      onClick: () => setSelection(pane.id, rows.map((r) => r.entry.path))
    })
    items.push({
      label: 'Deselect All',
      disabled: pane.selection.length === 0,
      onClick: () => setSelection(pane.id, [])
    })
    items.push({ label: 'Add to Favorites', onClick: () => doAddFavorite(entry) })
    items.push({ label: 'Rename…', onClick: () => void doRename(entry) })
    items.push({ label: 'Delete', danger: true, onClick: () => void doDelete(entry) })
    items.push({ label: 'Copy Path', onClick: () => doCopyPath(entry) })
    items.push({ label: 'Properties', onClick: () => doGetInfo(entry) })
    return items
  }

  function doCopyPath(entry: FileEntry): void {
    void navigator.clipboard.writeText(entry.path)
    setPathCopied(true)
    if (pathCopiedTimer.current) clearTimeout(pathCopiedTimer.current)
    pathCopiedTimer.current = setTimeout(() => setPathCopied(false), 2500)
  }

  function doGetInfo(entry: FileEntry): void {
    setInfoEntry(entry)
    setInfoFull(null)
    setInfoChecksum('loading')
    setInfoContents('loading')
    if (!pane.connectionId) return
    void window.conduit.fs.stat(pane.connectionId, entry.path).then((full) => setInfoFull(full))
    if (entry.kind === 'file') {
      void window.conduit.fs.checksum(pane.connectionId, entry.path).then((c) => setInfoChecksum(c))
      setInfoContents(null)
    } else {
      setInfoChecksum(null)
      void window.conduit.fs.folderContents(pane.connectionId, entry.path).then((c) => setInfoContents(c))
    }
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

  function fetchFolderSize(entry: FileEntry): void {
    if (!pane.connectionId || folderSizes[entry.path] !== undefined) return
    setFolderSizes((s) => ({ ...s, [entry.path]: 'loading' }))
    void window.conduit.fs.folderSize(pane.connectionId, entry.path).then((size) => {
      setFolderSizes((s) => ({ ...s, [entry.path]: size }))
    })
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
      {pathCopied && (
        <div className="path-copied-toast">Path copied to clipboard</div>
      )}
      {infoEntry && (() => {
        const conn = connections.find((c) => c.id === pane.connectionId) ?? null
        const webUrl = conn ? buildWebUrl(conn, infoEntry.path) : null
        const isDir = infoEntry.kind === 'directory'
        const pathLen = infoEntry.path.length
        const pathOverLimit = pathLen > 256
        const closeInfo = () => {
          setInfoEntry(null); setInfoFull(null); setInfoChecksum('loading'); setInfoContents('loading')
        }
        const contentsLabel = (() => {
          if (!isDir) return null
          if (infoContents === 'loading') return 'Loading…'
          if (!infoContents) return 'Unavailable'
          const parts: string[] = []
          if (infoContents.folders > 0) parts.push(`${infoContents.folders} folder${infoContents.folders !== 1 ? 's' : ''}`)
          if (infoContents.files > 0) parts.push(`${infoContents.files} file${infoContents.files !== 1 ? 's' : ''}`)
          return parts.length > 0 ? parts.join(', ') : 'Empty'
        })()
        return (
          <div className="modal-overlay" onMouseDown={closeInfo}>
            <div className="info-panel" onMouseDown={(e) => e.stopPropagation()}>
              <div className="info-header">
                <span className="info-title">Properties</span>
                <button className="iconbtn" onClick={closeInfo}>✕</button>
              </div>
              <div className="info-body">
                <FileInfoRow label="Name" value={infoEntry.name} />
                <FileInfoRow label="Kind" value={isDir ? 'Folder' : 'File'} />
                {!isDir && <FileInfoRow label="Type" value={fileType(infoEntry.name, infoEntry.kind)} />}
                <FileInfoRow
                  label="Path"
                  value={infoEntry.path}
                  mono
                  warning={pathOverLimit ? `Path is ${pathLen} characters — exceeds the 256-character Windows limit` : undefined}
                  extra={`${pathLen} characters`}
                />
                {webUrl && <FileInfoRow label="URL" value={webUrl} mono />}
                <FileInfoRow
                  label="Size"
                  value={
                    isDir
                      ? (folderSizes[infoEntry.path] === 'loading'
                          ? 'Calculating…'
                          : typeof folderSizes[infoEntry.path] === 'number'
                            ? formatBytes(folderSizes[infoEntry.path] as number)
                            : 'Click to calculate')
                      : formatBytes(infoFull?.size ?? infoEntry.size ?? 0)
                  }
                  onClickOverride={
                    isDir && typeof folderSizes[infoEntry.path] !== 'number' && folderSizes[infoEntry.path] !== 'loading'
                      ? () => fetchFolderSize(infoEntry)
                      : undefined
                  }
                />
                {(infoFull?.modified ?? infoEntry.modified) && (
                  <FileInfoRow label="Modified" value={formatDate(infoFull?.modified ?? infoEntry.modified)} />
                )}
                {isDir && contentsLabel !== null && (
                  <FileInfoRow label="Contents" value={contentsLabel} />
                )}
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
                onClick={isDir ? (e) => { e.stopPropagation(); fetchFolderSize(entry) } : undefined}
                title={isDir && !folderSizes[entry.path] ? 'Click to calculate size' : undefined}
              >
                {isDir
                  ? folderSizes[entry.path] === 'loading'
                    ? '…'
                    : typeof folderSizes[entry.path] === 'number'
                      ? formatBytes(folderSizes[entry.path] as number)
                      : <span style={{ color: 'var(--text-faint)', cursor: 'pointer' }} title="Click to calculate size">—</span>
                  : formatBytes(entry.size)}
              </div>
              <div className="file-type">{fileType(entry.name, entry.kind)}</div>
              <div className="file-mod">{formatDate(entry.modified)}</div>
            </div>
          )
        })
      )}
    </div>
  )
}

function FileInfoRow({
  label, value, mono, warning, extra, onClickOverride
}: {
  label: string
  value: string
  mono?: boolean
  warning?: string
  extra?: string
  onClickOverride?: () => void
}): JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const isFaded = value === 'Loading…' || value === 'Unavailable' || value === 'Calculating…' || value === 'Click to calculate'

  function handleClick(): void {
    if (onClickOverride) { onClickOverride(); return }
    if (isFaded) return
    void navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="info-row"
      onClick={handleClick}
      title={onClickOverride ? 'Click to calculate' : isFaded ? undefined : 'Click to copy'}
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
      </span>
    </div>
  )
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
