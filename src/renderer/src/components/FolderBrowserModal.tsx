import { useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'

interface Props {
  connectionId: string
  connectionName: string
  initialPath: string
  onSelect: (path: string) => void
  onClose: () => void
}

export function FolderBrowserModal({ connectionId, connectionName, initialPath, onSelect, onClose }: Props): JSX.Element {
  const [path, setPath] = useState(initialPath || '/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef(false)

  useEffect(() => {
    abortRef.current = false
    setLoading(true)
    setError('')
    void window.conduit.fs.list(connectionId, path).then((result) => {
      if (abortRef.current) return
      const folders = (result.entries ?? []).filter((e) => e.kind === 'directory')
      folders.sort((a, b) => a.name.localeCompare(b.name))
      setEntries(folders)
      setLoading(false)
    }).catch((err: Error) => {
      if (abortRef.current) return
      setError(err.message)
      setLoading(false)
    })
    return () => { abortRef.current = true }
  }, [connectionId, path])

  function navigateTo(newPath: string): void {
    setPath(newPath)
  }

  function navigateUp(): void {
    void window.conduit.fs.parent(connectionId, path).then((parent) => {
      if (parent !== null) setPath(parent)
    })
  }

  const breadcrumbs = buildBreadcrumbs(path)

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal fb-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Browse Folder</h2>
            <span className="fb-conn-name">{connectionName}</span>
          </div>
          <button className="iconbtn" onClick={onClose}>✕</button>
        </div>

        <div className="fb-breadcrumbs">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="fb-crumb-wrap">
              {i > 0 && <span className="fb-crumb-sep">/</span>}
              <button
                className={`fb-crumb${i === breadcrumbs.length - 1 ? ' active' : ''}`}
                onClick={() => i < breadcrumbs.length - 1 && navigateTo(crumb.path)}
              >
                {crumb.label || connectionName}
              </button>
            </span>
          ))}
        </div>

        <div className="fb-toolbar">
          <button
            className="btn ghost fb-up-btn"
            onClick={navigateUp}
            disabled={isRoot(path, connectionId)}
          >
            <span className="material-symbols-outlined">arrow_upward</span>
            Up
          </button>
          <span className="fb-current-path">{path || '/'}</span>
        </div>

        <div className="fb-list">
          {loading && <div className="fb-loading"><div className="sp-spinner" />Loading…</div>}
          {error && <div className="fb-error">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="fb-empty">No subfolders in this location.</div>
          )}
          {!loading && entries.map((entry) => (
            <button
              key={entry.path}
              className="fb-row"
              onDoubleClick={() => navigateTo(entry.path)}
              onClick={() => navigateTo(entry.path)}
            >
              <span className="material-symbols-outlined fb-folder-icon">folder</span>
              <span className="fb-name">{entry.name}</span>
              <span className="material-symbols-outlined fb-row-arrow">chevron_right</span>
            </button>
          ))}
        </div>

        <div className="modal-footer">
          <span className="fb-selected-path">{path || '/'}</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { onSelect(path); onClose() }}>
            Select This Folder
          </button>
        </div>
      </div>
    </div>
  )
}

function isRoot(path: string, connectionId: string): boolean {
  if (connectionId === BUILTIN_LOCAL_ID) return path === '/' || /^[A-Z]:\\?$/.test(path)
  return !path || path === '/'
}

function buildBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  if (!path || path === '/') return [{ label: '', path: '/' }]
  // Handle Windows paths like C:\foo\bar
  const isWin = /^[A-Z]:\\/.test(path)
  const sep = isWin ? '\\' : '/'
  const parts = path.split(sep).filter(Boolean)
  const crumbs: Array<{ label: string; path: string }> = [{ label: '', path: isWin ? '' : '/' }]
  let current = isWin ? '' : ''
  for (const part of parts) {
    current = current ? `${current}${sep}${part}` : (isWin ? part : `/${part}`)
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}
