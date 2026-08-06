import { useEffect, useState } from 'react'
import type { Connection, SyncTask, SyncSchedule } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'

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

  useEffect(() => {
    void window.conduit.connections.getAll().then(setConnections)
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
    if (!conn || (conn.type !== 'local' && conn.type !== 'smb')) return
    const picked = await window.conduit.dialog.pickFolder()
    if (picked) setField(side === 'left' ? 'leftPath' : 'rightPath', picked)
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
                      <select
                        className="input"
                        value={connId}
                        onChange={(e) =>
                          setField(side === 'left' ? 'leftConnectionId' : 'rightConnectionId', e.target.value)
                        }
                      >
                        <option value="">— Select connection —</option>
                        {allConnections.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <div className="st-path-row">
                        <input
                          className="input"
                          value={path}
                          onChange={(e) =>
                            setField(side === 'left' ? 'leftPath' : 'rightPath', e.target.value)
                          }
                          placeholder="/"
                        />
                        {canBrowse && (
                          <button className="btn ghost st-browse-btn" onClick={() => void pickPath(side)}>
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
    </div>
  )
}

