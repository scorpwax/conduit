import { useEffect, useRef, useState } from 'react'
import type { SyncTask } from '@shared/types'
import { useStore } from '../store'
import { SyncTaskModal } from './SyncTaskModal'
import { SyncPreviewModal } from './SyncPreviewModal'

interface Props {
  onClose: () => void
  onOpenTransferPanel?: () => void
}

function fmtRelTime(iso: string | null): string {
  if (!iso) return 'Never'
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'Just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0; let n = bytes
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++ }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

const MODE_LABELS: Record<string, string> = {
  mirror: 'Mirror (one-way, delete extras)',
  copy: 'One-Way Copy',
  'two-way': 'Two-Way Sync',
  merge: 'Two-Way Merge'
}

const CONFLICT_LABELS: Record<string, string> = {
  newer: 'Newer wins',
  larger: 'Larger wins',
  'keep-both': 'Keep both',
  ask: 'Ask me'
}

const SCHEDULE_LABELS: Record<string, string> = {
  'on-launch': 'On launch',
  interval: 'Every',
  daily: 'Daily at',
  weekly: 'Weekly on',
  monthly: 'Monthly on day'
}

function formatSchedule(task: SyncTask): string {
  if (!task.schedule) return 'Manual only'
  const s = task.schedule
  if (s.type === 'on-launch') return 'On app launch'
  if (s.type === 'interval') return `Every ${s.intervalMinutes ?? 60} min`
  if (s.type === 'daily') return `Daily at ${s.time ?? '00:00'}`
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  if (s.type === 'weekly') return `Every ${days[s.weekDay ?? 1]} at ${s.time ?? '00:00'}`
  if (s.type === 'monthly') return `Monthly day ${s.monthDay ?? 1} at ${s.time ?? '00:00'}`
  return s.type
}

void SCHEDULE_LABELS // suppress unused warning

export function SyncPanel({ onClose, onOpenTransferPanel }: Props): JSX.Element {
  const [tasks, setTasks] = useState<SyncTask[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [taskModal, setTaskModal] = useState<{ task: SyncTask | null } | null>(null)
  const [previewTask, setPreviewTask] = useState<SyncTask | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const syncQueue = useStore((s) => s.syncQueue)
  const addToSyncQueue = useStore((s) => s.addToSyncQueue)
  const removeFromSyncQueue = useStore((s) => s.removeFromSyncQueue)
  const clearSyncQueue = useStore((s) => s.clearSyncQueue)
  const runSyncQueue = useStore((s) => s.runSyncQueue)
  const syncRuns = useStore((s) => s.syncRuns)
  const seenRunIds = useRef(new Set<string>())

  useEffect(() => {
    void window.conduit.sync.getTasks().then((t) => {
      setTasks(t)
      if (t.length > 0) setSelectedId(t[0].id)
    })
  }, [])

  // Refresh task list whenever a sync run finishes (updates lastRun/lastRunResult on the task).
  useEffect(() => {
    for (const run of syncRuns) {
      if (run.phase !== 'running' && !seenRunIds.current.has(run.runId)) {
        seenRunIds.current.add(run.runId)
        void window.conduit.sync.getTasks().then(setTasks)
      }
    }
  }, [syncRuns])

  const selected = tasks.find((t) => t.id === selectedId) ?? null

  function handleSaved(updated: SyncTask[]): void {
    setTasks(updated)
    if (taskModal?.task === null) {
      // New task — select the one just added (last in list)
      const newest = updated[updated.length - 1]
      if (newest) setSelectedId(newest.id)
    }
    setTaskModal(null)
  }

  async function handleDelete(id: string): Promise<void> {
    const updated = await window.conduit.sync.deleteTask(id)
    setTasks(updated)
    if (selectedId === id) setSelectedId(updated[0]?.id ?? null)
    setDeleteConfirm(null)
  }

  async function toggleEnabled(task: SyncTask): Promise<void> {
    const updated = await window.conduit.sync.saveTask({ ...task, enabled: !task.enabled })
    setTasks(updated)
  }

  async function duplicateTask(task: SyncTask): Promise<void> {
    const now = new Date().toISOString()
    const copy: SyncTask = {
      ...task,
      id: crypto.randomUUID(),
      name: `${task.name} (Copy)`,
      createdAt: now,
      lastRun: null,
      lastRunResult: null,
      lastRunStats: null
    }
    const updated = await window.conduit.sync.saveTask(copy)
    setTasks(updated)
    setSelectedId(copy.id)
  }

  return (
    <div className="sync-panel">
      <div className="sync-header">
        {window.conduit.platform === 'darwin' && <div className="titlebar-mac-pad" />}
        <div className="sync-header-left">
          <span className="material-symbols-outlined sync-header-icon">sync</span>
          <span className="sync-header-title">Sync Tasks</span>
          {syncRuns.some((r) => r.phase === 'running') && (
            <button
              className="sync-active-badge"
              onClick={onOpenTransferPanel}
              title="View sync progress in the Transfers panel"
            >
              <span className="sync-active-dot" />
              {syncRuns.filter((r) => r.phase === 'running').length === 1
                ? syncRuns.find((r) => r.phase === 'running')!.taskName
                : `${syncRuns.filter((r) => r.phase === 'running').length} syncs running`}
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
            </button>
          )}
        </div>
        <div className="sync-header-right">
          <button
            className="btn ghost toolbtn"
            onClick={() => setTaskModal({ task: null })}
          >
            <span className="material-symbols-outlined">add</span> New Task
          </button>
          <button className="iconbtn sync-close-btn" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      <div className="sync-body">
        <div className="sync-sidebar">
          {tasks.length === 0 && (
            <div className="sync-sidebar-empty">
              No sync tasks yet.<br />Click <strong>+ New Task</strong> to get started.
            </div>
          )}
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`sync-task-row${selectedId === task.id ? ' active' : ''}${!task.enabled ? ' disabled' : ''}`}
              onClick={() => setSelectedId(task.id)}
            >
              <span className={`sync-task-dot ${task.lastRunResult ?? 'none'}`} />
              <div className="sync-task-info">
                <span className="sync-task-name">{task.name}</span>
                <span className="sync-task-meta">
                  {task.lastRun ? fmtRelTime(task.lastRun) : 'Never run'}
                  {!task.enabled && ' · Disabled'}
                </span>
              </div>
            </button>
          ))}
        </div>

        <div className="sync-main">
          {!selected && (
            <div className="sync-empty-state">
              <span className="material-symbols-outlined sync-empty-icon">sync</span>
              <p>Select a sync task or create a new one.</p>
              <button className="btn primary" onClick={() => setTaskModal({ task: null })}>
                + New Task
              </button>
            </div>
          )}

          {selected && (
            <div className="sync-detail">
              <div className="sync-detail-header">
                <h2 className="sync-detail-name">{selected.name}</h2>
                <div className="sync-detail-actions">
                  <button className="btn ghost" onClick={() => void toggleEnabled(selected)}>
                    {selected.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn ghost" onClick={() => void duplicateTask(selected)}>
                    Duplicate
                  </button>
                  <button className="btn ghost" onClick={() => setTaskModal({ task: selected })}>
                    Edit
                  </button>
                  <button
                    className="btn ghost"
                    title={syncQueue.find((t) => t.id === selected.id) ? 'Remove from queue' : 'Add to sync queue'}
                    onClick={() =>
                      syncQueue.find((t) => t.id === selected.id)
                        ? removeFromSyncQueue(selected.id)
                        : addToSyncQueue(selected)
                    }
                  >
                    {syncQueue.find((t) => t.id === selected.id) ? '− Queue' : '+ Queue'}
                  </button>
                  <button
                    className="btn ghost danger"
                    onClick={() => setDeleteConfirm(selected.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="sync-detail-paths">
                <div className="sync-path-row st-side-left">
                  <span className="sync-path-label st-side-label">LEFT</span>
                  <span className="sync-path-value none">{selected.leftConnectionId}</span>
                  <span className="sync-path-dir">{selected.leftPath || '/'}</span>
                </div>
                
                <span className="material-symbols-outlined sync-arrow">sync_alt</span>
                
                <div className="sync-path-row st-side-right">
                  <span className="sync-path-label st-side-label">RIGHT</span>
                  <span className="sync-path-value none">{selected.rightConnectionId}</span>
                  <span className="sync-path-dir">{selected.rightPath || '/'}</span>
                </div>
              </div>

              <div className="sync-detail-props">
                <div className="sync-prop">
                  <span className="sync-prop-key">Mode</span>
                  <span className="sync-prop-val">{MODE_LABELS[selected.mode] ?? selected.mode}</span>
                </div>
                <div className="sync-prop">
                  <span className="sync-prop-key">Conflicts</span>
                  <span className="sync-prop-val">{CONFLICT_LABELS[selected.conflictResolution] ?? selected.conflictResolution}</span>
                </div>
                <div className="sync-prop">
                  <span className="sync-prop-key">Deletions</span>
                  <span className="sync-prop-val">{selected.propagateDeletions ? 'Propagated' : 'Not propagated'}</span>
                </div>
                <div className="sync-prop">
                  <span className="sync-prop-key">Hidden files</span>
                  <span className="sync-prop-val">{selected.syncHiddenFiles ? 'Included' : 'Skipped'}</span>
                </div>
                <div className="sync-prop">
                  <span className="sync-prop-key">Schedule</span>
                  <span className="sync-prop-val">{formatSchedule(selected)}</span>
                </div>
              </div>

              {selected.lastRun && (
                <div className="sync-last-run">
                  <span className={`sync-result-badge ${selected.lastRunResult ?? ''}`}>
                    {selected.lastRunResult === 'success' ? '✓' : selected.lastRunResult === 'error' ? '✗' : '~'}
                  </span>
                  Last run {fmtRelTime(selected.lastRun)}
                  {selected.lastRunStats && (
                    <span className="sync-last-stats">
                      {' '}—{' '}
                      {selected.lastRunStats.copied} copied,{' '}
                      {selected.lastRunStats.deleted} deleted,{' '}
                      {fmtBytes(selected.lastRunStats.bytesTransferred)}
                    </span>
                  )}
                </div>
              )}

              <button
                className="btn primary sync-run-btn"
                onClick={() => setPreviewTask(selected)}
                disabled={!selected.enabled}
              >
                <span className="material-symbols-outlined">play_arrow</span>
                Run Preview
              </button>
            </div>
          )}
        </div>
      </div>

      {syncQueue.length > 0 && (
        <div className="sync-queue-bar">
          <span className="sync-queue-label">
            <span className="material-symbols-outlined">queue</span>
            Queue: {syncQueue.map((t) => t.name).join(' → ')}
          </span>
          <div className="sync-queue-actions">
            <button className="btn ghost" onClick={clearSyncQueue}>Clear</button>
            <button className="btn primary" onClick={() => { runSyncQueue(); onClose() }}>
              <span className="material-symbols-outlined">play_arrow</span>
              Run Queue
            </button>
          </div>
        </div>
      )}

      {taskModal !== null && (
        <SyncTaskModal
          task={taskModal.task}
          onClose={() => setTaskModal(null)}
          onSaved={handleSaved}
        />
      )}

      {previewTask && (
        <SyncPreviewModal
          task={previewTask}
          onClose={() => setPreviewTask(null)}
          onExecuteInBackground={() => {
            setPreviewTask(null)
            onOpenTransferPanel?.()
          }}
        />
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Delete Sync Task?</h2>
            </div>
            <div style={{ padding: '0 20px 8px' }}>
              <p>This will remove the task and its sync history. The files themselves are not affected.</p>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="btn danger" onClick={() => void handleDelete(deleteConfirm)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
