import { useEffect, useRef, useState } from 'react'
import type { Connection, SyncTask, SyncSchedule } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'
import { FolderBrowserModal } from './FolderBrowserModal'
import { ConnectionModal } from './ConnectionModal'
import { ConnIcon } from '../lib/connMeta'
import { useStore } from '../store'

interface Props {
  task: SyncTask | null
  onClose: () => void
  onSaved: (tasks: SyncTask[]) => void
}

const MODES = [
  { value: 'mirror', label: 'Mirror', desc: 'Left → Right, delete extras on right' },
  { value: 'copy', label: 'Copy', desc: 'Left → Right, never delete' },
  { value: 'two-way', label: 'Two-Way', desc: 'Both directions, newer wins' },
  { value: 'merge', label: 'Merge', desc: 'Both directions, never delete' }
] as const

const CONFLICT_RES = [
  { value: 'newer', label: 'Newer wins' },
  { value: 'larger', label: 'Larger wins' },
  { value: 'keep-both', label: 'Keep both' },
  { value: 'ask', label: 'Ask me' }
] as const

const SCHEDULE_TYPES = [
  { value: 'none', label: 'None (manual only)' },
  { value: 'on-launch', label: 'On app launch' },
  { value: 'interval', label: 'Every N minutes' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
] as const

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function makeBlank(): Omit<SyncTask, 'id' | 'createdAt'> {
  return {
    name: '',
    leftConnectionId: BUILTIN_LOCAL_ID,
    leftPath: '',
    rightConnectionId: '',
    rightPath: '',
    mode: 'copy',
    conflictResolution: 'newer',
    propagateDeletions: false,
    syncHiddenFiles: false,
    includeRootFolder: false,
    schedule: null,
    enabled: true,
    lastRun: null,
    lastRunResult: null,
    lastRunStats: null
  }
}

export function SyncTaskModal({ task, onClose, onSaved }: Props): JSX.Element {
  const [connections, setConnections] = useState<Connection[]>([])
  const [tab, setTab] = useState<'general' | 'schedule'>('general')
  const [form, setForm] = useState(task ? { ...task } : { ...makeBlank(), id: '', createdAt: '' })
  const [scheduleType, setScheduleType] = useState<string>(task?.schedule?.type ?? 'none')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [browsingFor, setBrowsingFor] = useState<'left' | 'right' | null>(null)
  const [newConnSide, setNewConnSide] = useState<'left' | 'right' | null>(null)

  function refreshConnections(): Promise<Connection[]> {
    return window.conduit.connections.getAll().then((c) => { setConnections(c); return c })
  }

  useEffect(() => {
    void refreshConnections()
  }, [])

  const allConnections = [
    { id: BUILTIN_LOCAL_ID, name: 'This Computer', type: 'local' as const },
    ...connections
  ]

  function setField<K extends keyof typeof form>(key: K, value: typeof form[K]): void {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function buildSchedule(): SyncSchedule | null {
    if (scheduleType === 'none') return null
    const sched = form.schedule ?? {}
    if (scheduleType === 'on-launch') return { type: 'on-launch' }
    if (scheduleType === 'interval') return { type: 'interval', intervalMinutes: sched.intervalMinutes ?? 60 }
    if (scheduleType === 'daily') return { type: 'daily', time: sched.time ?? '02:00' }
    if (scheduleType === 'weekly')
      return { type: 'weekly', time: sched.time ?? '02:00', weekDay: sched.weekDay ?? 1 }
    if (scheduleType === 'monthly')
      return { type: 'monthly', time: sched.time ?? '02:00', monthDay: sched.monthDay ?? 1 }
    return null
  }

  async function handleSave(): Promise<void> {
    if (!form.name.trim()) { setError('Task name is required.'); return }
    if (!form.leftConnectionId) { setError('Left connection is required.'); return }
    if (!form.rightConnectionId) { setError('Right connection is required.'); return }

    setSaving(true)
    setError('')
    try {
      const now = new Date().toISOString()
      const saved: SyncTask = {
        ...form,
        id: form.id || crypto.randomUUID(),
        name: form.name.trim(),
        schedule: buildSchedule(),
        createdAt: form.createdAt || now
      }
      const tasks = await window.conduit.sync.saveTask(saved)
      onSaved(tasks)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  async function pickPath(side: 'left' | 'right'): Promise<void> {
    const connId = side === 'left' ? form.leftConnectionId : form.rightConnectionId
    const conn = allConnections.find((c) => c.id === connId)
    if (!conn) return
    if (conn.type === 'local' || conn.type === 'smb') {
      const picked = await window.conduit.dialog.pickFolder()
      if (picked) setField(side === 'left' ? 'leftPath' : 'rightPath', picked)
    } else {
      setBrowsingFor(side)
    }
  }

  const sched = form.schedule ?? {}

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal st-modal">
        <div className="modal-header">
          <h2>{task ? 'Edit Sync Task' : 'New Sync Task'}</h2>
          <button className="iconbtn" onClick={onClose}>✕</button>
        </div>

        <div className="br-tabs">
          <button className={`br-tab${tab === 'general' ? ' active' : ''}`} onClick={() => setTab('general')}>General</button>
          <button className={`br-tab${tab === 'schedule' ? ' active' : ''}`} onClick={() => setTab('schedule')}>Schedule</button>
        </div>

        <div className="st-body">
          {tab === 'general' && (
            <>
              <div className="st-field">
                <label>Task Name</label>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                  placeholder="My Sync Task"
                  autoFocus
                />
              </div>
                    
              <div class="menu-sep sync-task"></div>

              <div className="st-sides">
                {(['left', 'right'] as const).map((side) => {
                  const connId = side === 'left' ? form.leftConnectionId : form.rightConnectionId
                  const path = side === 'left' ? form.leftPath : form.rightPath
                  const label = side === 'left' ? 'LEFT' : 'RIGHT'
                  const conn = allConnections.find((c) => c.id === connId)
                  const canBrowse = conn && (conn.type === 'local' || conn.type === 'smb')

                  return (
                    <div key={side} className={`st-side st-side-${side}`}>
                      <div className="st-side-label">{label}</div>
                      <SyncConnPicker
                        connections={connections}
                        value={connId}
                        onChange={(id, rootPath) => {
                          setField(side === 'left' ? 'leftConnectionId' : 'rightConnectionId', id)
                          if (rootPath !== undefined) setField(side === 'left' ? 'leftPath' : 'rightPath', rootPath)
                        }}
                        onAddNew={() => setNewConnSide(side)}
                      />
                      <div className="st-path-row">
                        <input
                          className="input"
                          value={path}
                          onChange={(e) =>
                            setField(side === 'left' ? 'leftPath' : 'rightPath', e.target.value)
                          }
                          placeholder="/"
                        />
                        {conn && (
                          <button className="btn ghost st-browse-btn" title="Browse…" onClick={() => void pickPath(side)}>
                            <span className="material-symbols-outlined">folder_open</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
                    
                <div class="menu-sep sync-task"></div>

              <div className="st-field">
                <label>Sync Mode</label>
                <div className="st-mode-grid">
                  {MODES.map((m) => (
                    <label key={m.value} className={`st-mode-card${form.mode === m.value ? ' selected' : ''}`}>
                      <input
                        type="radio"
                        name="mode"
                        value={m.value}
                        checked={form.mode === m.value}
                        onChange={() => setField('mode', m.value)}
                      />
                      <span className="st-mode-label">{m.label}</span>
                      <span className="st-mode-desc">{m.desc}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="st-field st-toggle-row">
                <label>Include root folder</label>
                <label className="st-toggle">
                  <input
                    type="checkbox"
                    checked={form.includeRootFolder ?? false}
                    onChange={(e) => setField('includeRootFolder', e.target.checked)}
                  />
                  <span className="st-toggle-slider" />
                </label>
                <span className="st-toggle-hint">
                  {form.includeRootFolder
                    ? 'Destination will contain the source folder itself'
                    : "Destination will contain the source folder's contents"}
                </span>
              </div>

                    <div class="menu-sep sync-task"></div>

              <div className="st-field">
                <label>Conflict Resolution</label>
                <div className="br-radios">
                  {CONFLICT_RES.map((r) => (
                    <label key={r.value} className="br-radio">
                      <input
                        type="radio"
                        name="conflict"
                        value={r.value}
                        checked={form.conflictResolution === r.value}
                        onChange={() => setField('conflictResolution', r.value)}
                      />
                      {r.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="st-field st-toggle-row">
                <label>Propagate deletions</label>
                <label className="st-toggle">
                  <input
                    type="checkbox"
                    checked={form.propagateDeletions}
                    onChange={(e) => setField('propagateDeletions', e.target.checked)}
                  />
                  <span className="st-toggle-slider" />
                </label>
                <span className="st-toggle-hint">
                  {form.propagateDeletions ? 'Deletions will sync to the other side' : 'Deletions will not be synced'}
                </span>
              </div>

              <div className="st-field st-toggle-row">
                <label>Include hidden files</label>
                <label className="st-toggle">
                  <input
                    type="checkbox"
                    checked={form.syncHiddenFiles ?? false}
                    onChange={(e) => setField('syncHiddenFiles', e.target.checked)}
                  />
                  <span className="st-toggle-slider" />
                </label>
                <span className="st-toggle-hint">
                  {form.syncHiddenFiles ? 'Hidden files (dotfiles) will be synced' : 'Hidden files (dotfiles) will be skipped'}
                </span>
              </div>
            </>
          )}

          {tab === 'schedule' && (
            <>
              <div className="st-field">
                <label>Schedule Type</label>
                <select
                  className="input"
                  value={scheduleType}
                  onChange={(e) => {
                    setScheduleType(e.target.value)
                    setField('schedule', null)
                  }}
                >
                  {SCHEDULE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>

              {scheduleType === 'interval' && (
                <div className="st-field">
                  <label>Interval (minutes)</label>
                  <input
                    type="number"
                    className="input st-narrow"
                    min={1}
                    max={10080}
                    value={sched.intervalMinutes ?? 60}
                    onChange={(e) =>
                      setField('schedule', { ...sched, type: 'interval', intervalMinutes: Number(e.target.value) })
                    }
                  />
                </div>
              )}

              {(scheduleType === 'daily' || scheduleType === 'weekly' || scheduleType === 'monthly') && (
                <div className="st-field">
                  <label>Time</label>
                  <input
                    type="time"
                    className="input st-narrow"
                    value={sched.time ?? '02:00'}
                    onChange={(e) =>
                      setField('schedule', { ...sched, type: scheduleType as SyncSchedule['type'], time: e.target.value })
                    }
                  />
                </div>
              )}

              {scheduleType === 'weekly' && (
                <div className="st-field">
                  <label>Day of week</label>
                  <select
                    className="input"
                    value={sched.weekDay ?? 1}
                    onChange={(e) =>
                      setField('schedule', { ...sched, type: 'weekly', weekDay: Number(e.target.value) })
                    }
                  >
                    {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                  </select>
                </div>
              )}

              {scheduleType === 'monthly' && (
                <div className="st-field">
                  <label>Day of month</label>
                  <input
                    type="number"
                    className="input st-narrow"
                    min={1}
                    max={28}
                    value={sched.monthDay ?? 1}
                    onChange={(e) =>
                      setField('schedule', { ...sched, type: 'monthly', monthDay: Number(e.target.value) })
                    }
                  />
                </div>
              )}

            </>
          )}

          {error && <div className="st-error">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save Task'}
          </button>
        </div>
      </div>

      {browsingFor && (() => {
        const connId = browsingFor === 'left' ? form.leftConnectionId : form.rightConnectionId
        const conn = allConnections.find((c) => c.id === connId)
        const currentPath = browsingFor === 'left' ? form.leftPath : form.rightPath
        return conn ? (
          <FolderBrowserModal
            connectionId={connId}
            connectionName={conn.name}
            initialPath={currentPath}
            showFiles
            onSelect={(p) => setField(browsingFor === 'left' ? 'leftPath' : 'rightPath', p)}
            onClose={() => setBrowsingFor(null)}
          />
        ) : null
      })()}

      {newConnSide && (
        <ConnectionModal
          existing={null}
          onClose={() => setNewConnSide(null)}
          onSaved={(conn) => {
            void refreshConnections().then(() => {
              setField(newConnSide === 'left' ? 'leftConnectionId' : 'rightConnectionId', conn.id)
              setNewConnSide(null)
            })
          }}
        />
      )}
    </div>
  )
}

// ── SyncConnPicker ────────────────────────────────────────────────────────────

interface SyncConnPickerProps {
  connections: Connection[]
  value: string
  /** Called with the connection id and its rootPath (if any) so callers can auto-populate the path field. */
  onChange: (id: string, rootPath?: string) => void
  onAddNew: () => void
}

function SyncConnPicker({ connections, value, onChange, onAddNew }: SyncConnPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const storeConns = useStore((s) => s.connections)

  // Use store connections (kept in sync with toggleFavorite) for live favorite state.
  const liveConns = storeConns.length > 0 ? storeConns : connections

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const byName = (a: Connection, b: Connection): number => a.name.localeCompare(b.name)
  const favorites = liveConns.filter((c) => c.favorite).sort(byName)
  const others = liveConns.filter((c) => !c.favorite).sort(byName)

  const builtinLocal = { id: BUILTIN_LOCAL_ID, name: 'This Computer', type: 'local' as const, favorite: false, config: {}, createdAt: '' }
  const selected = value === BUILTIN_LOCAL_ID
    ? builtinLocal
    : liveConns.find((c) => c.id === value) ?? null

  function pick(id: string): void {
    if (id === BUILTIN_LOCAL_ID) {
      onChange(id, '')
    } else {
      const conn = liveConns.find((c) => c.id === id)
      const rootPath = (conn?.config as { rootPath?: string })?.rootPath ?? ''
      onChange(id, rootPath)
    }
    setOpen(false)
  }

  return (
    <div className="sync-conn-picker" ref={ref}>
      <button
        className={`sync-conn-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        {selected ? (
          <>
            <ConnIcon type={selected.type} size={18} />
            <span className="scp-name">{selected.name}</span>
          </>
        ) : (
          <span className="scp-placeholder">— Select connection —</span>
        )}
        <span className="material-symbols-outlined scp-chevron">expand_more</span>
      </button>

      {open && (
        <div className="sync-conn-menu">
          {/* This Computer */}
          <div className="menu-item" onClick={() => pick(BUILTIN_LOCAL_ID)}>
            <ConnIcon type="local" size={22} />
            <div className="mi-title">
              <div className="name">This Computer</div>
              <div className="sub">Local filesystem</div>
            </div>
            {value === BUILTIN_LOCAL_ID && <span className="scp-check">✓</span>}
          </div>

          {favorites.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">Favorites</div>
              {favorites.map((c) => (
                <div key={c.id} className="menu-item" onClick={() => pick(c.id)}>
                  <ConnIcon type={c.type} size={22} />
                  <div className="mi-title">
                    <div className="name">{c.name}</div>
                    <div className="sub">{describeConn(c)}</div>
                  </div>
                  {value === c.id && <span className="scp-check">✓</span>}
                </div>
              ))}
            </>
          )}

          {others.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">Connections</div>
              {others.map((c) => (
                <div key={c.id} className="menu-item" onClick={() => pick(c.id)}>
                  <ConnIcon type={c.type} size={22} />
                  <div className="mi-title">
                    <div className="name">{c.name}</div>
                    <div className="sub">{describeConn(c)}</div>
                  </div>
                  {value === c.id && <span className="scp-check">✓</span>}
                </div>
              ))}
            </>
          )}

          <div className="menu-sep" />
          <div
            className="menu-item accent"
            onClick={() => { setOpen(false); onAddNew() }}
          >
            <div className="conn-icon" style={{ background: 'var(--accent)' }}>＋</div>
            <div className="mi-title">
              <div className="name">New Connection…</div>
              <div className="sub">Local, S3, SFTP, SMB, and more</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function describeConn(conn: Connection): string {
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

