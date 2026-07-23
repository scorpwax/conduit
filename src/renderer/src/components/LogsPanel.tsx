import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry, LogLevel, AppSettings } from '@shared/types'

const MAX_ENTRIES = 2000

const LEVELS: { key: LogLevel; label: string }[] = [
  { key: 'info', label: 'Info' },
  { key: 'success', label: 'Success' },
  { key: 'warn', label: 'Warnings' },
  { key: 'error', label: 'Errors' }
]

const DATE_RANGES = [
  { label: 'All time', value: 0 },
  { label: 'Today', value: 1 },
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
]

const RETENTION_OPTIONS = [
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 0, label: 'Never delete' }
]

interface Props {
  onClose: () => void
}

const CONCURRENCY_OPTIONS = [
  { n: 1, label: '1 — Sequential (most stable, large files)' },
  { n: 2, label: '2 — Recommended for large files (default)' },
  { n: 3, label: '3 — Balanced' },
  { n: 5, label: '5 — Fast (reliable connection)' },
  { n: 8, label: '8 — Aggressive' },
  { n: 10, label: '10 — Maximum' },
]

export function LogsPanel({ onClose }: Props): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [active, setActive] = useState<Set<LogLevel>>(new Set(['info', 'success', 'warn', 'error']))
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const [retention, setRetention] = useState<number>(180)
  const [concurrency, setConcurrency] = useState<number>(2)
  const [copied, setCopied] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.conduit.logs.getRecent(1000).then(setEntries)
    void window.conduit.settings.get().then((s: AppSettings) => {
      setRetention(s.logRetentionDays)
      setConcurrency(s.transferConcurrency ?? 2)
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
      active.has(e.level) &&
      (!q || e.message.toLowerCase().includes(q)) &&
      (cutoff === 0 || e.ts >= cutoff)
    )
  }, [entries, active, search, dateRange])

  // Auto-scroll to newest when enabled.
  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [visible, autoScroll])

  function toggleLevel(level: LogLevel): void {
    setActive((prev) => {
      const next = new Set(prev)
      next.has(level) ? next.delete(level) : next.add(level)
      return next
    })
  }

  async function changeRetention(days: number): Promise<void> {
    setRetention(days)
    await window.conduit.settings.set({ logRetentionDays: days })
  }

  async function changeConcurrency(n: number): Promise<void> {
    setConcurrency(n)
    await window.conduit.settings.set({ transferConcurrency: n })
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
                className={`chip ${l.key} ${active.has(l.key) ? 'on' : ''}`}
                onClick={() => toggleLevel(l.key)}
              >
                {l.label}
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
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="spacer" />
          {copied && <span className="logs-copied">Copied to Clipboard</span>}
          <button className="iconbtn" title="Close" onClick={onClose}>
            ✕
          </button>
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
                  const line = `${fmtTime(e.ts)}  ${e.level.toUpperCase().padEnd(7)}  ${e.category.padEnd(12)}  ${e.message}`
                  void navigator.clipboard.writeText(line)
                  setCopied(true)
                  if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
                  copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
                }}
              >
                <span className="log-time">{fmtTime(e.ts)}</span>
                <span className={`log-level ${e.level}`}>{e.level.toUpperCase()}</span>
                <span className="log-cat">{e.category}</span>
                <span className="log-msg">{e.message}</span>
              </div>
            ))
          )}
        </div>

        <div className="logs-footer">
          <label className="logs-retention">
            Keep logs:
            <select value={retention} onChange={(e) => changeRetention(Number(e.target.value))}>
              {RETENTION_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="logs-retention">
            Concurrent transfers:
            <select value={concurrency} onChange={(e) => changeConcurrency(Number(e.target.value))}>
              {CONCURRENCY_OPTIONS.map(({ n, label }) => (
                <option key={n} value={n}>{label}</option>
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
              const text = visible
                .map((e) => `${fmtTime(e.ts)}  ${e.level.toUpperCase().padEnd(7)}  ${e.category.padEnd(12)}  ${e.message}`)
                .join('\n')
              void window.conduit.logs.exportText(text)
            }}
          >
            Export…
          </button>
          <button className="btn danger" onClick={clearLog}>
            Clear
          </button>
        </div>
      </div>
    </div>
  )
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
