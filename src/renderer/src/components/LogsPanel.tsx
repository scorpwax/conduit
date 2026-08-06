import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry, LogLevel, LogCategory, AppSettings } from '@shared/types'

const MAX_ENTRIES = 2000

const LEVELS: { key: LogLevel; label: string }[] = [
  { key: 'info',    label: 'Info' },
  { key: 'success', label: 'Success' },
  { key: 'warn',    label: 'Warnings' },
  { key: 'error',   label: 'Errors' },
]

const CATEGORIES: { key: LogCategory; label: string }[] = [
  { key: 'transfer',   label: 'Transfer' },
  { key: 'sync',       label: 'Sync' },
  { key: 'connection', label: 'Connection' },
  { key: 'fs',         label: 'File System' },
  { key: 'app',        label: 'App' },
]

const DATE_RANGES = [
  { label: 'All time', value: 0 },
  { label: 'Today',    value: 1 },
  { label: '7 days',   value: 7 },
  { label: '30 days',  value: 30 },
]

const RETENTION_OPTIONS = [
  { days: 90,  label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 0,   label: 'Never delete' },
]

const CAT_COLORS: Record<LogCategory, string> = {
  transfer:   '#3b82f6',
  sync:       '#a855f7',
  connection: '#10b981',
  fs:         '#f59e0b',
  app:        '#6b7280',
}

interface Props {
  onClose: () => void
}

export function LogsPanel({ onClose }: Props): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(new Set(['info', 'success', 'warn', 'error']))
  const [activeCats, setActiveCats] = useState<Set<LogCategory>>(new Set(CATEGORIES.map((c) => c.key)))
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const [retention, setRetention] = useState<number>(180)
  const [copied, setCopied] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.conduit.logs.getRecent(1000).then(setEntries)
    void window.conduit.settings.get().then((s: AppSettings) => {
      setRetention(s.logRetentionDays)
    })
    const off = window.conduit.logs.onEntries((batch) => {
      setEntries((prev) => {
        const next = [...prev, ...batch]
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
      })
    })
    return off
  }, [])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const cutoff = dateRange > 0 ? Date.now() - dateRange * 24 * 60 * 60 * 1000 : 0
    return entries.filter((e) =>
      activeLevels.has(e.level) &&
      activeCats.has(e.category) &&
      (!q || e.message.toLowerCase().includes(q) || (e.route ?? '').toLowerCase().includes(q)) &&
      (cutoff === 0 || e.ts >= cutoff)
    )
  }, [entries, activeLevels, activeCats, search, dateRange])

  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [visible, autoScroll])

  function toggleLevel(level: LogLevel): void {
    setActiveLevels((prev) => {
      const next = new Set(prev)
      next.has(level) ? next.delete(level) : next.add(level)
      return next
    })
  }

  function toggleCat(cat: LogCategory): void {
    setActiveCats((prev) => {
      const next = new Set(prev)
      next.has(cat) ? next.delete(cat) : next.add(cat)
      return next
    })
  }

  async function changeRetention(days: number): Promise<void> {
    setRetention(days)
    await window.conduit.settings.set({ logRetentionDays: days })
  }

  async function clearLog(): Promise<void> {
    if (!confirm('Clear all log files? This cannot be undone.')) return
    await window.conduit.logs.clear()
    setEntries([])
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="logs-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="logs-header">
          <span className="logs-title">Activity Log</span>

          <div className="logs-chips">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                className={`chip ${l.key} ${activeLevels.has(l.key) ? 'on' : ''}`}
                onClick={() => toggleLevel(l.key)}
              >
                {l.label}
              </button>
            ))}
          </div>

          <div className="logs-chips">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                className={`chip cat-chip ${activeCats.has(c.key) ? 'on' : ''}`}
                style={{ '--cat-color': CAT_COLORS[c.key] } as React.CSSProperties}
                onClick={() => toggleCat(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="logs-chips">
            {DATE_RANGES.map((r) => (
              <button
                key={r.value}
                className={`chip ${dateRange === r.value ? 'on' : ''}`}
                onClick={() => setDateRange(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>

          <input
            className="logs-search"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="spacer" />
          {copied && <span className="logs-copied">Copied to Clipboard</span>}
          <button className="iconbtn" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="logs-list" ref={listRef} onWheel={() => setAutoScroll(false)}>
          {visible.length === 0 ? (
            <div className="transfer-empty">No matching log entries.</div>
          ) : (
            visible.map((e, i) => (
              <div
                key={i}
                className={`log-row ${e.level}`}
                title="Click to copy"
                onClick={() => {
                  const parts = [fmtTime(e.ts), e.level.toUpperCase(), e.category, e.message]
                  if (e.route) parts.push(`[${e.route}]`)
                  if (e.speedBps) parts.push(`@ ${fmtSpeed(e.speedBps)}`)
                  void navigator.clipboard.writeText(parts.join('  '))
                  setCopied(true)
                  if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
                  copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
                }}
              >
                <span className="log-date">{fmtDate(e.ts)}</span>
                <span className="log-time">{fmtTimeOnly(e.ts)}</span>
                <span
                  className="log-cat"
                  style={{ '--cat-color': CAT_COLORS[e.category] } as React.CSSProperties}
                >
                  {e.category}
                </span>
                <span className={`log-level ${e.level}`}>{e.level.toUpperCase()}</span>
                <span className="log-route">{e.route ?? '—'}</span>
                <span className="log-msg">
                  {e.message}
                  {e.speedBps != null && (
                    <span className="log-speed"> @ {fmtSpeed(e.speedBps)}</span>
                  )}
                  {e.durationMs != null && (
                    <span className="log-duration"> ({fmtDuration(e.durationMs)})</span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="logs-footer">
          <label className="logs-retention">
            Keep logs:
            <select value={retention} onChange={(e) => changeRetention(Number(e.target.value))}>
              {RETENTION_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="logs-auto">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
          <div className="spacer" />
          <span className="logs-count">{visible.length} shown</span>
          <button className="btn" onClick={() => window.conduit.logs.openFolder()}>
            Open Folder
          </button>
          <button
            className="btn"
            onClick={() => {
              const text = visible.map((e) => {
                const parts = [fmtTime(e.ts), e.level.toUpperCase().padEnd(7), e.category.padEnd(12), e.message]
                if (e.route)     parts.push(`[${e.route}]`)
                if (e.speedBps)  parts.push(`@ ${fmtSpeed(e.speedBps)}`)
                if (e.durationMs) parts.push(`(${fmtDuration(e.durationMs)})`)
                return parts.join('  ')
              }).join('\n')
              void window.conduit.logs.exportText(text)
            }}
          >
            Export…
          </button>
          <button className="btn danger" onClick={clearLog}>Clear</button>
        </div>
      </div>
    </div>
  )
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}`
}

function fmtTimeOnly(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function fmtTime(ts: number): string {
  return `${fmtDate(ts)} ${fmtTimeOnly(ts)}`
}

function fmtSpeed(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} GB/s`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`
  return `${bps} B/s`
}

function fmtDuration(ms: number): string {
  if (ms < 1000)  return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m ${s}s`
}
