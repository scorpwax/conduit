import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Connection } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'
import { useStore, type PaneState } from '../store'
import { formatBytes } from '../lib/format'
import { ConnectionMenu } from './ConnectionMenu'
import { FileList } from './FileList'
import { ContextMenu } from './ContextMenu'
import { getDrag, clearDrag } from '../lib/drag'
import { setPaneDrag, getPaneDrag, clearPaneDrag } from '../lib/paneDrag'
import { promptDialog } from '../lib/dialog'
import { ConnIcon, connColor } from '../lib/connMeta'

interface Props {
  pane: PaneState
  index: number
  isOnly: boolean
  onNewConnection: (paneId: string) => void
  onEditConnection: (conn: Connection) => void
  onImportConnection: (conn: Connection) => void
}

export function Pane({ pane, index, isOnly, onNewConnection, onEditConnection, onImportConnection }: Props): JSX.Element {
  const connections = useStore((s) => s.connections)
  const panes = useStore((s) => s.panes)
  const navigate = useStore((s) => s.navigate)
  const navigateUp = useStore((s) => s.navigateUp)
  const refreshPane = useStore((s) => s.refreshPane)
  const removePane = useStore((s) => s.removePane)
  const disconnectPane = useStore((s) => s.disconnectPane)
  const movePane = useStore((s) => s.movePane)
  const requestTransfer = useStore((s) => s.requestTransfer)
  const createFolderInPane = useStore((s) => s.createFolderInPane)
  const createFileInPane = useStore((s) => s.createFileInPane)
  const openLocation = useStore((s) => s.openLocation)
  const openInNewPane = useStore((s) => s.openInNewPane)
  const addBookmark = useStore((s) => s.addBookmark)

  const [menuOpen, setMenuOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [reorderOver, setReorderOver] = useState(false)
  const [crumbMenu, setCrumbMenu] = useState<{ x: number; y: number; path: string; label: string } | null>(null)
  const [showFilter, setShowFilter] = useState(false)
  const [filter, setFilter] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)
  const [folderSizes, setFolderSizes] = useState<Record<string, { size: number; latestModified: string | null } | 'loading' | null>>({})

  // Reset the filter + folder sizes whenever the pane navigates or switches connection.
  useEffect(() => {
    setFilter('')
    setShowFilter(false)
    setFolderSizes({})
  }, [pane.path, pane.connectionId])

  const fetchFolderSize = useCallback((path: string): void => {
    if (!pane.connectionId) return
    setFolderSizes((s) => {
      if (s[path] !== undefined) return s
      return { ...s, [path]: 'loading' }
    })
    void window.conduit.fs.folderSize(pane.connectionId, path).then((result) => {
      setFolderSizes((s) => ({ ...s, [path]: result }))
    })
  }, [pane.connectionId])

  const fetchAllFolderSizes = useCallback((): void => {
    const dirs = pane.result?.entries.filter((e) => e.kind === 'directory') ?? []
    for (const dir of dirs) fetchFolderSize(dir.path)
  }, [pane.result, fetchFolderSize])

  const connection: Connection | null = useMemo(() => {
    if (!pane.connectionId) return null
    if (pane.connectionId === BUILTIN_LOCAL_ID) {
      return { id: BUILTIN_LOCAL_ID, name: 'This Computer', type: 'local', config: {}, favorite: false, createdAt: '' }
    }
    return connections.find((c) => c.id === pane.connectionId) ?? null
  }, [pane.connectionId, connections])

  const crumbs = useMemo(() => buildCrumbs(pane.path, connection), [pane.path, connection])

  const status: ConnStatus = !connection
    ? 'none'
    : pane.loading
      ? 'loading'
      : pane.error
        ? 'error'
        : 'connected'

  async function onDrop(e: React.DragEvent): Promise<void> {
    // Pane reorder?
    const paneDrag = getPaneDrag()
    if (paneDrag !== null) {
      e.preventDefault()
      setReorderOver(false)
      if (paneDrag !== index) movePane(paneDrag, index)
      clearPaneDrag()
      return
    }
    e.preventDefault()
    setDragOver(false)

    // Internal pane-to-pane transfer?
    const payload = getDrag()
    if (payload) {
      if (payload.fromPaneId === pane.id || !pane.connectionId) return
      const from = panes.find((p) => p.id === payload.fromPaneId)
      if (!from?.connectionId) return
      await requestTransfer(from.connectionId, pane.connectionId, payload.paths, pane.path)
      clearDrag()
      return
    }

    // Otherwise, a drop from the OS (Finder/desktop).
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length === 0) return
    const paths = files.map((f) => window.conduit.getPathForFile(f)).filter(Boolean)
    if (paths.length === 0) return
    await handleNativeDrop(paths)
  }

  async function handleNativeDrop(paths: string[]): Promise<void> {
    if (!pane.connectionId) {
      // Empty pane: open the dropped folder (or the file's containing folder).
      const first = paths[0]
      let target = first
      try {
        const stat = await window.conduit.fs.stat(BUILTIN_LOCAL_ID, first)
        if (stat.kind !== 'directory') target = first.slice(0, first.lastIndexOf('/')) || '/'
      } catch {
        target = first.slice(0, first.lastIndexOf('/')) || '/'
      }
      await openLocation(pane.id, BUILTIN_LOCAL_ID, target)
      return
    }
    // Connected pane: upload the dropped items to the current location.
    await requestTransfer(BUILTIN_LOCAL_ID, pane.connectionId, paths, pane.path)
  }

  async function newFolder(): Promise<void> {
    if (!pane.connectionId) return
    const name = await promptDialog({ title: 'New Folder', placeholder: 'Folder name', confirmText: 'Create' })
    if (name) await createFolderInPane(pane.id, name)
  }

  async function newFile(): Promise<void> {
    if (!pane.connectionId) return
    const name = await promptDialog({ title: 'New File', placeholder: 'File name', confirmText: 'Create' })
    if (name) await createFileInPane(pane.id, name)
  }

  const showHidden = useStore((s) => s.showHidden)
  const selCount = pane.selection.length
  const total = useMemo(() => {
    const entries = pane.result?.entries ?? []
    return showHidden ? entries.length : entries.filter((e) => !e.name.startsWith('.')).length
  }, [pane.result, showHidden])

  const selectedBytes = useMemo(() => {
    if (!pane.selection.length || !pane.result) return null
    const selSet = new Set(pane.selection)
    return pane.result.entries
      .filter((e) => selSet.has(e.path))
      .reduce((sum, e) => {
        if (e.kind === 'file') return sum + (e.size ?? 0)
        const fsz = folderSizes[e.path]
        return sum + (fsz && typeof fsz === 'object' ? fsz.size : 0)
      }, 0)
  }, [pane.selection, pane.result, folderSizes])

  const paneColor = useMemo(() => {
    if (!pane.connectionId) return null
    const conn = connections.find((c) => c.id === pane.connectionId)
    return conn ? connColor(conn.type) : null
  }, [pane.connectionId, connections])

  return (
    <div
      className={`pane ${dragOver ? 'drop-target' : ''} ${reorderOver ? 'reorder-target' : ''}`}
      style={paneColor ? { '--pane-accent': paneColor } as React.CSSProperties : undefined}
      onDragOver={(e) => {
        // A pane-reorder drag takes priority over a file-transfer drag.
        const paneDrag = getPaneDrag()
        if (paneDrag !== null) {
          if (paneDrag !== index) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setReorderOver(true)
          }
          return
        }
        const payload = getDrag()
        if (payload && payload.fromPaneId !== pane.id && pane.connectionId) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
          return
        }
        // Native OS file drag (from Finder/desktop).
        if (!payload && e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false)
          setReorderOver(false)
        }
      }}
      onDrop={onDrop}
    >
      <div className="conn-bar">
        <div className="conn-row" style={{ position: 'relative' }}>
          <div
            className="pane-grip"
            title="Drag to reorder pane"
            draggable
            onDragStart={(e) => {
              setPaneDrag(index)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', 'pane')
            }}
            onDragEnd={clearPaneDrag}
          >
            ⠿
          </div>
          <div className="conn-picker" onClick={() => setMenuOpen((v) => !v)}>
            {connection ? (
              <>
                <ConnIcon type={connection.type} />
                <div className="conn-title">
                  <span className="name">
                    <span className={`status-dot ${status}`} title={statusLabel(status)} />
                    {connection.name}
                  </span>
                  <span className="sub">{subtitle(connection, pane.path)}</span>
                </div>
              </>
            ) : (
              <>
                <div className="conn-icon" style={{ background: 'var(--border-strong)', display: 'grid', placeItems: 'center', fontSize: 14 }}>?</div>
                <div className="conn-title">
                  <span className="name">Choose a connection…</span>
                  <span className="sub">Drives, S3, or saved connections</span>
                </div>
              </>
            )}
            <span style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}>▾</span>
          </div>

          <button className="iconbtn" title="Up one level" disabled={!connection} onClick={() => navigateUp(pane.id)}>
            ↑
          </button>
          <button
            className={`iconbtn ${showFilter ? 'active' : ''}`}
            title="Search / filter"
            disabled={!connection}
            onClick={() => {
              setShowFilter((v) => !v)
              setTimeout(() => filterRef.current?.focus(), 0)
            }}
          >
            🔍
          </button>
          <button className="iconbtn" title="Refresh" disabled={!connection} onClick={() => refreshPane(pane.id)}>
            ⟳
          </button>
          <button className="iconbtn" title="New folder" disabled={!connection} onClick={newFolder}>
            📁
          </button>
          <button className="iconbtn" title="New file" disabled={!connection} onClick={newFile}>
            📄
          </button>
          {connection && (
            <button
              className="iconbtn"
              title="Disconnect"
              onClick={() => disconnectPane(pane.id)}
            >
              ⏏
            </button>
          )}
          {!isOnly && (
            <button className="iconbtn" title="Close pane" onClick={() => removePane(pane.id)}>
              ✕
            </button>
          )}

          {menuOpen && (
            <ConnectionMenu
              paneId={pane.id}
              onClose={() => setMenuOpen(false)}
              onAddNew={() => {
                setMenuOpen(false)
                onNewConnection(pane.id)
              }}
              onEdit={(c) => {
                setMenuOpen(false)
                onEditConnection(c)
              }}
              onImport={(conn) => {
                setMenuOpen(false)
                onImportConnection(conn)
              }}
            />
          )}
        </div>

        {connection && (
          <div className="breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                {i > 0 && <span className="crumb-sep">›</span>}
                <span
                  className="crumb"
                  onClick={() => navigate(pane.id, c.path)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCrumbMenu({ x: e.clientX, y: e.clientY, path: c.path, label: c.label })
                  }}
                >
                  {c.label}
                </span>
              </span>
            ))}
          </div>
        )}

        {connection && showFilter && (
          <input
            ref={filterRef}
            className="filter-input"
            placeholder="Filter files in this folder…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilter('')
                setShowFilter(false)
              }
            }}
          />
        )}
      </div>

      {connection ? (
        <FileList pane={pane} filter={filter} folderSizes={folderSizes} setFolderSizes={setFolderSizes} fetchFolderSize={fetchFolderSize} />
      ) : (
        <div className="pane-empty">
          <div style={{ fontSize: 40 }}>🔌</div>
          <h3>No connection</h3>
          <p>Pick a drive or connection above, or create a new one to start browsing files.</p>
          <button className="btn primary" onClick={() => onNewConnection(pane.id)}>
            New Connection…
          </button>
        </div>
      )}

      <div className="status-line">
        <span>
          {total} item{total === 1 ? '' : 's'}
          {selCount > 0 && ` · ${selCount} selected`}
          {selCount > 0 && selectedBytes !== null && ` · ${formatBytes(selectedBytes)}`}
        </span>
        {Object.values(folderSizes).some((v) => v === 'loading')
          ? <span className="status-calculating">Calculating size…</span>
          : (() => {
              const dirs = pane.result?.entries.filter((e) => e.kind === 'directory') ?? []
              const hasUncalculated = dirs.some((d) => folderSizes[d.path] === undefined)
              return hasUncalculated && connection ? (
                <button className="status-calc-all" title="Calculate size of all folders" onClick={fetchAllFolderSizes}>
                  Calculate all sizes
                </button>
              ) : null
            })()
        }
        <span>{connection ? typeLabel(connection) : ''}</span>
      </div>

      {crumbMenu && pane.connectionId && (
        <ContextMenu
          x={crumbMenu.x}
          y={crumbMenu.y}
          onClose={() => setCrumbMenu(null)}
          items={[
            {
              label: 'Open in New Pane',
              onClick: () => openInNewPane(pane.connectionId!, crumbMenu.path)
            },
            {
              label: 'Add to Favorites',
              onClick: () => addBookmark(crumbMenu.label, pane.connectionId!, crumbMenu.path)
            },
            {
              label: 'Copy Path',
              onClick: () => void navigator.clipboard.writeText(crumbMenu.path)
            }
          ]}
        />
      )}
    </div>
  )
}

type ConnStatus = 'none' | 'loading' | 'error' | 'connected'

function statusLabel(status: ConnStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'loading':
      return 'Connecting…'
    case 'error':
      return 'Connection error'
    default:
      return 'Not connected'
  }
}

interface Crumb {
  label: string
  path: string
}

function buildCrumbs(path: string, connection: Connection | null): Crumb[] {
  if (!connection) return []
  const rootLabel = connection.name
  const crumbs: Crumb[] = [{ label: rootLabel, path: '' }]
  if (!path) return crumbs

  // Local absolute paths begin with '/'; S3 keys use '/' separators too.
  const isLocal = connection.type === 'local'
  const segments = path.split('/').filter(Boolean)
  let acc = isLocal ? '' : ''
  segments.forEach((seg) => {
    acc = isLocal ? `${acc}/${seg}` : acc ? `${acc}/${seg}` : seg
    crumbs.push({ label: seg, path: acc })
  })
  return crumbs
}


function subtitle(conn: Connection, path: string): string {
  if (conn.type === 's3' || conn.type === 'wasabi') {
    const cfg = conn.config as { bucket?: string }
    return cfg.bucket ? `${cfg.bucket}${path ? '/' + path : ''}` : path
  }
  if (conn.type === 'sftp') {
    const cfg = conn.config as { host?: string }
    return `${cfg.host ?? ''}${path ? ' · ' + path : ''}`
  }
  if (conn.type === 'smb') {
    const cfg = conn.config as { share?: string }
    return `${cfg.share ?? ''}${path ? '/' + path : ''}`
  }
  if (conn.type === 'ftp') {
    const cfg = conn.config as { host?: string }
    return `${cfg.host ?? ''}${path ? ' · ' + path : ''}`
  }
  if (conn.type === 'webdav') {
    try {
      const host = conn.config && (conn.config as { url?: string }).url
      return `${host ? new URL(host).hostname : ''}${path ? ' · ' + path : ''}`
    } catch {
      return path
    }
  }
  return path || 'Home'
}


function typeLabel(conn: Connection): string {
  if (conn.type === 's3') return 'Amazon S3'
  if (conn.type === 'wasabi') return 'Wasabi'
  if (conn.type === 'local') return 'Local'
  if (conn.type === 'sftp') return 'SFTP / SSH'
  if (conn.type === 'smb') return 'SMB'
  if (conn.type === 'ftp') return 'FTP'
  if (conn.type === 'webdav') return 'WebDAV'
  if (conn.type === 'gdrive') return 'Google Drive'
  if (conn.type === 'onedrive') return 'OneDrive'
  if (conn.type === 'dropbox') return 'Dropbox'
  return ''
}
