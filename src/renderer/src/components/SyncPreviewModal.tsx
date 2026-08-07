import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { SyncPreviewItem, SyncProgress, SyncRunStats, SyncTask } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'
import { useStore } from '../store'

interface Props {
  task: SyncTask
  onClose: () => void
  onComplete: (stats: SyncRunStats) => void
  onExecuteInBackground?: () => void
}

type Phase = 'scanning' | 'preview' | 'executing' | 'done' | 'error'
type Filter = 'all' | 'changes' | 'conflicts' | 'unchanged'

function fmtBytes(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++ }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const ACTION_ICONS: Record<SyncPreviewItem['action'], string> = {
  'copy-to-right': '→',
  'copy-to-left': '←',
  'delete-right': '🗑R',
  'delete-left': '🗑L',
  conflict: '⚡',
  unchanged: '='
}

const ACTION_LABELS: Record<SyncPreviewItem['action'], string> = {
  'copy-to-right': 'Copy →',
  'copy-to-left': 'Copy ←',
  'delete-right': 'Delete right',
  'delete-left': 'Delete left',
  conflict: 'Conflict',
  unchanged: 'Unchanged'
}

export function SyncPreviewModal({ task, onClose, onComplete, onExecuteInBackground }: Props): JSX.Element {
  const executeSyncInBackground = useStore((s) => s.executeSyncInBackground)
  const [phase, setPhase] = useState<Phase>('scanning')
  const [items, setItems] = useState<SyncPreviewItem[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [stats, setStats] = useState<SyncRunStats | null>(null)
  const [error, setError] = useState('')
  const taskIdRef = useRef(task.id)
  const sentToBackgroundRef = useRef(false)
  const [leftLabel, setLeftLabel] = useState<{ name: string; path: string }>({ name: 'Left', path: task.leftPath })
  const [rightLabel, setRightLabel] = useState<{ name: string; path: string }>({ name: 'Right', path: task.rightPath })
  const isOneWay = task.mode === 'copy' || task.mode === 'mirror'

  useEffect(() => {
    void window.conduit.connections.getAll().then((conns) => {
      const resolve = (id: string): string => {
        if (id === BUILTIN_LOCAL_ID) return 'This Computer'
        return conns.find((c) => c.id === id)?.name ?? id
      }
      setLeftLabel({ name: resolve(task.leftConnectionId), path: task.leftPath })
      setRightLabel({ name: resolve(task.rightConnectionId), path: task.rightPath })
    })
  }, [task.leftConnectionId, task.rightConnectionId, task.leftPath, task.rightPath])

  useEffect(() => {
    const unsub = window.conduit.sync.onProgress((p) => {
      if (p.taskId !== taskIdRef.current) return
      setProgress(p)
    })

    void (async () => {
      try {
        const result = await window.conduit.sync.runPreview(task.id, task)
        setItems(result)
        setPhase('preview')
      } catch (err) {
        setError((err as Error).message)
        setPhase('error')
      }
    })()

    return () => {
      unsub()
      if (!sentToBackgroundRef.current) void window.conduit.sync.cancel(task.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateItem = useCallback((path: string, patch: Partial<SyncPreviewItem>): void => {
    setItems((prev) => prev.map((it) => (it.path === path ? { ...it, ...patch } : it)))
  }, [])

  const toggleExclude = useCallback((path: string): void => {
    setItems((prev) => prev.map((it) => it.path === path ? { ...it, excluded: !it.excluded } : it))
  }, [])

  const flipDirection = useCallback((item: SyncPreviewItem): void => {
    const flipped = item.action === 'copy-to-right' ? 'copy-to-left' : 'copy-to-right'
    updateItem(item.path, { action: flipped })
  }, [updateItem])

  const setConflictWinner = useCallback((path: string, winner: SyncPreviewItem['conflictWinner']): void => {
    updateItem(path, { conflictWinner: winner, excluded: winner === 'skip' })
  }, [updateItem])

  async function handleExecute(): Promise<void> {
    setPhase('executing')
    try {
      const result = await window.conduit.sync.execute(task.id, task, items)
      setStats(result)
      setPhase('done')
      onComplete(result)
    } catch (err) {
      setError((err as Error).message)
      setPhase('error')
    }
  }

  function handleExecuteInBackground(): void {
    sentToBackgroundRef.current = true
    executeSyncInBackground(task, items)
    onExecuteInBackground?.()
    onClose()
  }

  const counts = useMemo(() => {
    const active = items.filter((i) => !i.excluded)
    return {
      toRight: active.filter((i) => i.action === 'copy-to-right').length,
      toLeft: active.filter((i) => i.action === 'copy-to-left').length,
      conflicts: active.filter((i) => i.action === 'conflict').length,
      deletes: active.filter((i) => i.action === 'delete-right' || i.action === 'delete-left').length,
      unchanged: active.filter((i) => i.action === 'unchanged').length,
      total: items.filter((i) => !i.excluded && i.action !== 'unchanged').length
    }
  }, [items])

  // No filtered array — CSS handles visibility so tab switching has zero React overhead.

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && phase !== 'executing' && onClose()}>
      <div className="modal sp-modal">
        <div className="modal-header">
          <div>
            <h2>Sync Preview</h2>
            <span className="sp-task-name">{task.name}</span>
          </div>
          <button className="iconbtn" onClick={onClose} disabled={phase === 'executing'}>✕</button>
        </div>

        {phase === 'scanning' && (
          <div className="sp-scanning">
            <div className="sp-spinner" />
            <div className="sp-scan-text">
              Scanning…{progress ? ` ${progress.current} files` : ''}
            </div>
            {progress?.currentPath && (
              <div className="sp-scan-path">{progress.currentPath}</div>
            )}
            <button className="btn ghost sp-cancel-btn" onClick={onClose}>Cancel</button>
          </div>
        )}

        {(phase === 'preview' || phase === 'executing' || phase === 'done') && (
          <>
            <div className="sp-summary">
              <span className="sp-badge sp-badge-right" title="Files to copy left → right">→ {counts.toRight}</span>
              <span className="sp-badge sp-badge-left" title="Files to copy right → left">← {counts.toLeft}</span>
              {counts.conflicts > 0 && (
                <span className="sp-badge sp-badge-conflict" title="Conflicts">⚡ {counts.conflicts}</span>
              )}
              {counts.deletes > 0 && (
                <span className="sp-badge sp-badge-delete" title="Deletions">🗑 {counts.deletes}</span>
              )}
              <span className="sp-badge sp-badge-unchanged" title="Unchanged">= {counts.unchanged}</span>
            </div>

            <div className="br-tabs sp-filter-tabs">
              {(['all', 'changes', 'conflicts', 'unchanged'] as Filter[]).map((f) => (
                <button
                  key={f}
                  className={`br-tab${filter === f ? ' active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                  {f === 'conflicts' && counts.conflicts > 0 && (
                    <span className="sp-tab-count">{counts.conflicts}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="sp-col-headers">
              <div />
              <div className="sp-col-src">
                <div className="sp-col-label">{isOneWay ? 'SOURCE' : 'LEFT'}</div>
                <div className="sp-col-conn">{leftLabel.name}</div>
                <div className="sp-col-path">{leftLabel.path || '/'}</div>
              </div>
              <button className="iconbtn sp-flip-btn sp-col-arrow" title="Flip direction" disabled>
                {isOneWay ? '→' : '⇄'}
              </button>
              <div className="sp-col-dst">
                <div className="sp-col-label">{isOneWay ? 'DESTINATION' : 'RIGHT'}</div>
                <div className="sp-col-conn">{rightLabel.name}</div>
                <div className="sp-col-path">{rightLabel.path || '/'}</div>
              </div>
            </div>

            <div className="sp-list" data-filter={filter}>
              {items.length === 0 && (
                <div className="sp-empty">No items in this category.</div>
              )}
              {items.map((item) => {
                const canFlip = !isOneWay &&
                  (item.action === 'copy-to-right' || item.action === 'copy-to-left') &&
                  phase === 'preview'
                return (
                  <div
                    key={item.path}
                    className={`sp-row${item.excluded ? ' excluded' : ''} action-${item.action}`}
                    data-action={item.action}
                  >
                    {/* Checkbox */}
                    <label className="sp-check" title={item.excluded ? 'Excluded' : 'Included'}>
                      <input
                        type="checkbox"
                        checked={!item.excluded}
                        onChange={() => toggleExclude(item.path)}
                        disabled={phase !== 'preview'}
                      />
                    </label>

                    {/* SOURCE cell — file path + left size/date */}
                    <div className="sp-src-cell">
                      <span className="sp-path" title={item.path}>{item.path}</span>
                      <span className="sp-src-meta">
                        {item.leftSize != null ? fmtBytes(item.leftSize) : '—'}
                        <span className="sp-date">{fmtDate(item.leftModified)}</span>
                      </span>
                    </div>

                    {/* CENTER — flip button (two-way) or static action icon */}
                    <div className="sp-center-cell">
                      {canFlip ? (
                        <button
                          className={`iconbtn sp-flip-btn action-${item.action}`}
                          title="Flip direction"
                          onClick={() => flipDirection(item)}
                        >
                          {ACTION_ICONS[item.action]}
                        </button>
                      ) : (
                        <span className={`sp-action-icon action-${item.action}`}>
                          {ACTION_ICONS[item.action]}
                        </span>
                      )}
                    </div>

                    {/* DESTINATION cell — right size/date or conflict controls */}
                    <div className="sp-dst-cell">
                      {item.action === 'conflict' && phase === 'preview' ? (
                        <div className="sp-conflict-res">
                          {(['left', 'right', 'keep-both', 'skip'] as const).map((w) => (
                            <label key={w} className={`sp-cr-opt${item.conflictWinner === w ? ' active' : ''}`}>
                              <input
                                type="radio"
                                name={`cr-${item.path}`}
                                value={w}
                                checked={item.conflictWinner === w}
                                onChange={() => setConflictWinner(item.path, w)}
                              />
                              {w === 'left' ? '← Left' : w === 'right' ? 'Right →' : w === 'keep-both' ? 'Keep Both' : 'Skip'}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <span className="sp-dst-meta">
                          {item.rightSize != null ? fmtBytes(item.rightSize) : '—'}
                          <span className="sp-date">{fmtDate(item.rightModified)}</span>
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {phase === 'executing' && progress && (
              <div className="sp-exec-progress">
                <div className="sp-exec-bar">
                  <div
                    className="sp-exec-fill"
                    style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                  />
                </div>
                <span className="sp-exec-label">
                  {progress.current}/{progress.total} — {progress.currentPath ?? ''}
                </span>
              </div>
            )}

            {phase === 'done' && stats && (
              <div className="sp-done-bar">
                ✓ Sync complete — {stats.copied} copied, {stats.deleted} deleted
                {stats.errors > 0 && <span className="sp-done-err">, {stats.errors} errors</span>}
              </div>
            )}

            <div className="modal-footer">
              <button className="btn ghost" onClick={onClose} disabled={phase === 'executing'}>
                {phase === 'done' ? 'Close' : 'Cancel'}
              </button>
              {phase === 'preview' && counts.total > 0 && (
                <button
                  className="btn ghost"
                  onClick={handleExecuteInBackground}
                  title="Run sync in the background — track progress in the Transfers panel"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16, verticalAlign: 'middle' }}>send_to_mobile</span>
                  {' '}Run in Background
                </button>
              )}
              {phase === 'preview' && (
                <button
                  className="btn primary"
                  onClick={() => void handleExecute()}
                  disabled={counts.total === 0}
                >
                  Execute {counts.total > 0 ? `${counts.total} change${counts.total !== 1 ? 's' : ''}` : '(no changes)'}
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'error' && (
          <div className="sp-error-body">
            <p className="sp-error-msg">Sync failed: {error}</p>
            <div className="modal-footer">
              <button className="btn ghost" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
