import React, { useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'

interface Props {
  connectionId: string
  connectionName: string
  initialPath: string
  onSelect: (path: string) => void
  onClose: () => void
  /** When true, shows files alongside folders and lets the user select a file directly. */
  showFiles?: boolean
  onSelectEntry?: (entry: FileEntry) => void
  /** Optional node rendered below the connection name in the modal header (e.g. a connection picker). */
  headerSlot?: React.ReactNode
  /** Optional node rendered above the built-in footer (e.g. a warning + action buttons). */
  headerFooter?: React.ReactNode
}

export function FolderBrowserModal({ connectionId, connectionName, initialPath, onSelect, onClose, showFiles, onSelectEntry, headerSlot, headerFooter }: Props): JSX.Element {
  const [path, setPath] = useState(initialPath || '/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef(false)

  // Tell parent the current path on first render so headerFooter can use it immediately.
  useEffect(() => { onSelect(path) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    abortRef.current = false
    setLoading(true)
    setError('')
    void window.conduit.fs.list(connectionId, path).then((result) => {
      if (abortRef.current) return
      let list = result.entries ?? []
      if (!showFiles) list = list.filter((e) => e.kind === 'directory')
      list.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setEntries(list)
      setLoading(false)
    }).catch((err: Error) => {
      if (abortRef.current) return
      setError(err.message)
      setLoading(false)
    })
    return () => { abortRef.current = true }
  }, [connectionId, path, showFiles])

  function navigateTo(newPath: string): void {
    setPath(newPath)
    // Notify parent of current path on every navigation so headerFooter can use it.
    onSelect(newPath)
  }

  function navigateUp(): void {
    void window.conduit.fs.parent(connectionId, path).then((parent) => {
      if (parent !== null) { setPath(parent); onSelect(parent) }
    })
  }

  const breadcrumbs = buildBreadcrumbs(path)

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal fb-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Browse Folder</h2>
            {headerSlot ?? <span className="fb-conn-name">{connectionName}</span>}
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
              onDoubleClick={() => entry.kind === 'directory' ? navigateTo(entry.path) : onSelectEntry?.(entry)}
              onClick={() => entry.kind === 'directory' ? navigateTo(entry.path) : onSelectEntry?.(entry)}
            >
              <span className="material-symbols-outlined fb-folder-icon">
                {entry.kind === 'directory' ? 'folder' : 'draft'}
              </span>
              <span className="fb-name">{entry.name}</span>
              {entry.kind === 'directory'
                ? <span className="material-symbols-outlined fb-row-arrow">chevron_right</span>
                : onSelectEntry && <span className="fb-file-select-hint">Select</span>
              }
            </button>
          ))}
        </div>

        {headerFooter ?? (
          <div className="modal-footer">
            <span className="fb-selected-path">{path || '/'}</span>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={() => { onSelect(path); onClose() }}>
              Select This Folder
            </button>
          </div>
        )}
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
