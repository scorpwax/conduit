import { useEffect, useRef, useState } from 'react'
import type { Connection } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'
import { useStore } from '../store'
import { confirmDialog } from '../lib/dialog'
import { ContextMenu } from './ContextMenu'
import { ConnIcon } from '../lib/connMeta'

interface Props {
  paneId: string
  onClose: () => void
  onAddNew: () => void
  onEdit: (conn: Connection) => void
  onImport: (conn: Connection) => void
}

export function ConnectionMenu({ paneId, onClose, onAddNew, onEdit, onImport }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const connections = useStore((s) => s.connections)
  const drives = useStore((s) => s.drives)
  const bookmarks = useStore((s) => s.bookmarks)
  const panes = useStore((s) => s.panes)
  const backgroundConnectionIds = useStore((s) => s.backgroundConnectionIds)
  const setPaneConnection = useStore((s) => s.setPaneConnection)
  const openLocation = useStore((s) => s.openLocation)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const deleteConnection = useStore((s) => s.deleteConnection)
  const removeBookmark = useStore((s) => s.removeBookmark)
  const openInNewPane = useStore((s) => s.openInNewPane)
  const addBookmark = useStore((s) => s.addBookmark)

  const [ctx, setCtx] = useState<{ x: number; y: number; connectionId: string; path: string; name: string } | null>(
    null
  )

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [onClose])

  // Derive per-connection status from pane states.
  function connStatus(id: string): 'connected' | 'loading' | 'error' | 'background' | null {
    const activePanes = panes.filter((p) => p.connectionId === id)
    if (activePanes.length > 0) {
      if (activePanes.some((p) => p.error)) return 'error'
      if (activePanes.some((p) => p.loading)) return 'loading'
      return 'connected'
    }
    if (backgroundConnectionIds.includes(id)) return 'background'
    return null
  }

  const byName = (a: Connection, b: Connection): number => a.name.localeCompare(b.name)
  const favorites = connections.filter((c) => c.favorite).sort(byName)
  const others = connections.filter((c) => !c.favorite).sort(byName)

  function pickConnection(id: string): void {
    void setPaneConnection(paneId, id)
    onClose()
  }

  function pickDrive(path: string): void {
    void openLocation(paneId, BUILTIN_LOCAL_ID, path)
    onClose()
  }

  function openBookmark(connectionId: string, path: string): void {
    void openLocation(paneId, connectionId, path)
    onClose()
  }

  function openCtx(e: React.MouseEvent, connectionId: string, path: string, name: string): void {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, connectionId, path, name })
  }

  async function handleImport(): Promise<void> {
    const conn = await window.conduit.connections.importProfile()
    if (!conn) return
    onClose()
    onImport(conn)
  }

  return (
    <div className="menu" ref={ref} style={{ top: 46, left: 0 }}>
      <div className="menu-item accent" onClick={onAddNew}>
        <div className="conn-icon" style={{ background: 'var(--accent)' }}>
          ＋
        </div>
        <div className="mi-title">
          <div className="name">New Connection…</div>
          <div className="sub">Local, S3, SFTP, SMB, and more</div>
        </div>
      </div>

      {favorites.length > 0 && (
        <>
          <div className="menu-sep" />
          <div className="menu-label">Favorites</div>
          {favorites.map((c) => (
            <ConnRow
              key={c.id}
              conn={c}
              status={connStatus(c.id)}
              onPick={pickConnection}
              onEdit={onEdit}
              onToggleFav={toggleFavorite}
              onDelete={deleteConnection}
              onContext={(e) => openCtx(e, c.id, '', c.name)}
            />
          ))}
        </>
      )}

      {others.length > 0 && (
        <>
          <div className="menu-sep" />
          {favorites.length === 0 && <div className="menu-label">Connections</div>}
          {others.map((c) => (
            <ConnRow
              key={c.id}
              conn={c}
              status={connStatus(c.id)}
              onPick={pickConnection}
              onEdit={onEdit}
              onToggleFav={toggleFavorite}
              onDelete={deleteConnection}
              onContext={(e) => openCtx(e, c.id, '', c.name)}
            />
          ))}
        </>
      )}

      {bookmarks.length > 0 && (
        <>
          <div className="menu-sep" />
          <div className="menu-label">Favorite Folders</div>
          {bookmarks.map((b) => (
            <div key={b.id} className="menu-item" onClick={() => openBookmark(b.connectionId, b.path)}>
              <ConnIcon type={b.connectionType} />
              <div className="mi-title">
                <div className="name">⭐ {b.name}</div>
                <div className="sub">{b.path || '/'}</div>
              </div>
              <span
                className="star"
                title="Remove favorite"
                onClick={(e) => {
                  e.stopPropagation()
                  void removeBookmark(b.id)
                }}
              >
                ✕
              </span>
            </div>
          ))}
        </>
      )}

      <div className="menu-sep" />
      <div className="menu-label">Drives</div>
      {drives.map((d) => (
        <div
          key={d.path}
          className="menu-item"
          onClick={() => pickDrive(d.path)}
          onContextMenu={(e) => openCtx(e, BUILTIN_LOCAL_ID, d.path, d.name)}
        >
          <ConnIcon type="local" />
          <div className="mi-title">
            <div className="name">{d.name}</div>
            <div className="sub">{d.path}</div>
          </div>
        </div>
      ))}

      <div className="menu-sep" />
      <div
        className="menu-item"
        onClick={() => { void handleImport() }}
        style={{ color: 'var(--text-faint)' }}
      >
        <div className="conn-icon" style={{ background: 'var(--bg-elev-2)', fontSize: 13 }}>↑</div>
        <div className="mi-title">
          <div className="name">Import Connection…</div>
          <div className="sub">Open a .conduit profile file</div>
        </div>
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: 'Open in New Pane',
              onClick: () => {
                void openInNewPane(ctx.connectionId, ctx.path)
                onClose()
              }
            },
            {
              label: 'Add to Favorites',
              onClick: () => void addBookmark(ctx.name, ctx.connectionId, ctx.path)
            },
            ...(isLocalBacked(ctx.connectionId, connections) && window.conduit.platform === 'darwin'
              ? [
                  {
                    label: 'Reveal in Finder',
                    onClick: async () => {
                      const r = await window.conduit.connections.revealMount(ctx.connectionId)
                      if (!r.ok) alert(`Could not reveal mount:\n${r.message}`)
                    }
                  },
                  {
                    label: 'Mount to Desktop',
                    onClick: async () => {
                      const r = await window.conduit.connections.createDesktopShortcut(ctx.connectionId)
                      if (!r.ok) alert(`Could not mount to Desktop:\n${r.message}`)
                    }
                  }
                ]
              : []),
            ...(ctx.connectionId !== BUILTIN_LOCAL_ID
              ? [
                  {
                    label: 'Export Profile…',
                    onClick: () => void window.conduit.connections.exportProfile(ctx.connectionId)
                  }
                ]
              : [])
          ]}
        />
      )}
    </div>
  )
}

type ConnStatusType = 'connected' | 'loading' | 'error' | 'background' | null

function ConnRow({
  conn,
  status,
  onPick,
  onEdit,
  onToggleFav,
  onDelete,
  onContext
}: {
  conn: Connection
  status: ConnStatusType
  onPick: (id: string) => void
  onEdit: (c: Connection) => void
  onToggleFav: (id: string) => void
  onDelete: (id: string) => void
  onContext: (e: React.MouseEvent) => void
}): JSX.Element {
  return (
    <div className="menu-item" onClick={() => onPick(conn.id)} onContextMenu={onContext}>
      <ConnIcon type={conn.type} />
      <div className="mi-title">
        <div className="name">
          {status && <span className={`conn-menu-dot ${status}`} title={statusLabel(status)} />}
          {conn.name}
        </div>
        <div className="sub">{describe(conn)}</div>
      </div>
      <span
        className={`star ${conn.favorite ? 'on' : ''}`}
        title={conn.favorite ? 'Unfavorite' : 'Favorite'}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFav(conn.id)
        }}
      >
        {conn.favorite ? '★' : '☆'}
      </span>
      <span
        className="star"
        title="Export profile"
        onClick={(e) => {
          e.stopPropagation()
          void window.conduit.connections.exportProfile(conn.id)
        }}
      >
        ↓
      </span>
      <span
        className="star"
        title="Edit"
        onClick={(e) => {
          e.stopPropagation()
          onEdit(conn)
        }}
      >
        ✎
      </span>
      <span
        className="star"
        title="Delete"
        onClick={async (e) => {
          e.stopPropagation()
          const ok = await confirmDialog({
            title: `Delete connection "${conn.name}"?`,
            warning: 'This removes the saved connection and its favorites.',
            confirmText: 'Delete',
            danger: true
          })
          if (ok) onDelete(conn.id)
        }}
      >
        🗑
      </span>
    </div>
  )
}

function statusLabel(status: ConnStatusType): string {
  switch (status) {
    case 'connected': return 'Connected (in a pane)'
    case 'loading': return 'Connecting…'
    case 'error': return 'Connection error'
    case 'background': return 'Connected in background'
    default: return ''
  }
}

function describe(conn: Connection): string {
  if (conn.type === 's3') {
    const cfg = conn.config as { bucket?: string; region?: string }
    return `S3 · ${cfg.bucket ?? ''}${cfg.region ? ' · ' + cfg.region : ''}`
  }
  if (conn.type === 'wasabi') {
    const cfg = conn.config as { bucket?: string; region?: string }
    return `Wasabi · ${cfg.bucket ?? ''}${cfg.region ? ' · ' + cfg.region : ''}`
  }
  if (conn.type === 'local') {
    const cfg = conn.config as { rootPath?: string }
    return cfg.rootPath ?? 'Home folder'
  }
  if (conn.type === 'sftp') {
    const cfg = conn.config as { host?: string; username?: string }
    return `SFTP · ${cfg.username ?? ''}@${cfg.host ?? ''}`
  }
  if (conn.type === 'smb') {
    const cfg = conn.config as { host?: string; share?: string }
    return `SMB · \\\\${cfg.host ?? ''}\\${cfg.share ?? ''}`
  }
  if (conn.type === 'ftp') {
    const cfg = conn.config as { host?: string; username?: string }
    return `FTP · ${cfg.username ?? ''}@${cfg.host ?? ''}`
  }
  if (conn.type === 'webdav') {
    const cfg = conn.config as { url?: string }
    return `WebDAV · ${cfg.url ?? ''}`
  }
  if (conn.type === 'gdrive') return 'Google Drive'
  if (conn.type === 'onedrive') return 'OneDrive'
  if (conn.type === 'dropbox') return 'Dropbox'
  return ''
}


function isLocalBacked(connectionId: string, connections: Connection[]): boolean {
  if (connectionId === BUILTIN_LOCAL_ID) return true
  const conn = connections.find((c) => c.id === connectionId)
  return (
    conn?.type === 'local' ||
    conn?.type === 'smb' ||
    conn?.type === 's3' ||
    conn?.type === 'wasabi'
  )
}
