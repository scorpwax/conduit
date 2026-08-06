import { app, BrowserWindow } from 'electron'
import { createWriteStream, promises as fs, type WriteStream } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import type { LogEntry, LogLevel, LogCategory } from '@shared/types'

/**
 * Activity logger for Conduit.
 *
 * Design goals: never slow down transfers. So writes are batched — log lines
 * accumulate in a buffer and are flushed to disk in a single append at most a
 * few times per second (or when the buffer fills). Likewise, entries are
 * streamed to the renderer in throttled batches. Single log file (conduit.log);
 * date-separator lines mark the start of each calendar day within the file.
 *
 * Only lifecycle events are logged (transfer completed, connection opened,
 * etc.) — never per-byte progress — which keeps volume proportional to file
 * count, not transfer size.
 */

const FLUSH_MS = 500
const EMIT_MS = 250
const MAX_BUFFER = 512 // force a flush past this many pending lines

class Logger {
  private diskBuffer: string[] = []
  private emitBuffer: LogEntry[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private stream: WriteStream | null = null
  private lastLogDate = '' // 'YYYY-M-D' of the last entry written to disk
  private window: BrowserWindow | null = null

  setWindow(win: BrowserWindow): void {
    this.window = win
  }

  private logsDir(): string {
    return join(app.getPath('userData'), 'logs')
  }

  private logFile(): string {
    return join(this.logsDir(), 'conduit.log')
  }

  private ordinal(n: number): string {
    const s = String(n)
    if (n >= 11 && n <= 13) return s + 'TH'
    switch (n % 10) {
      case 1: return s + 'ST'
      case 2: return s + 'ND'
      case 3: return s + 'RD'
      default: return s + 'TH'
    }
  }

  private dateSeparator(date: Date): string {
    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    const months = [
      'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
      'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'
    ]
    const label = ` ${days[date.getDay()]}, ${months[date.getMonth()]} ${this.ordinal(date.getDate())}, ${date.getFullYear()} `
    const total = 80
    const eqCount = total - label.length
    const left = Math.floor(eqCount / 2)
    const right = eqCount - left
    return '='.repeat(left) + label + '='.repeat(right)
  }

  private format(entry: LogEntry): string {
    const d = new Date(entry.ts)
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
    const stamp =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    const base = `${stamp}  ${entry.level.toUpperCase().padEnd(7)}  ${entry.category.padEnd(10)}  ${entry.message.replace(/\s*\n\s*/g, ' ')}`
    const meta: Record<string, unknown> = {}
    if (entry.route)     meta.route = entry.route
    if (entry.bytes !== undefined) meta.bytes = entry.bytes
    if (entry.speedBps !== undefined) meta.speedBps = entry.speedBps
    if (entry.durationMs !== undefined) meta.durationMs = entry.durationMs
    return Object.keys(meta).length ? `${base}  ${JSON.stringify(meta)}` : base
  }

  /** Public entry point. Cheap: buffers and schedules async flush/emit. */
  log(level: LogLevel, category: LogCategory, message: string, meta?: Partial<Pick<LogEntry, 'route' | 'bytes' | 'speedBps' | 'durationMs'>>): void {
    const entry: LogEntry = { ts: Date.now(), level, category, message, ...meta }
    const now = new Date(entry.ts)
    const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`

    // Prepend a date separator when the calendar day changes (or on first log of session).
    if (dayKey !== this.lastLogDate) {
      this.diskBuffer.push(this.dateSeparator(now))
      this.lastLogDate = dayKey
    }

    this.diskBuffer.push(this.format(entry))
    this.emitBuffer.push(entry)

    if (this.diskBuffer.length >= MAX_BUFFER) {
      void this.flush()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS)
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => this.emit(), EMIT_MS)
    }
  }

  private ensureStream(): WriteStream {
    if (!this.stream) {
      this.stream = createWriteStream(this.logFile(), { flags: 'a' })
      this.stream.on('error', () => { this.stream = null })
    }
    return this.stream
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.diskBuffer.length === 0) return
    const lines = this.diskBuffer
    this.diskBuffer = []
    try {
      await fs.mkdir(this.logsDir(), { recursive: true })
      this.ensureStream().write(lines.join('\n') + '\n')
    } catch {
      // Logging must never throw into the app; drop on failure.
    }
  }

  private emit(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    if (this.emitBuffer.length === 0) return
    const batch = this.emitBuffer
    this.emitBuffer = []
    // The window may be gone (e.g. mid-quit); never send to a destroyed target.
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      try {
        this.window.webContents.send(IPC.evtLog, batch)
      } catch {
        // Render frame disposed mid-navigation — drop safely
      }
    }
  }

  /** Parse a formatted line back into a LogEntry (best-effort). */
  private parse(line: string): LogEntry | null {
    const m = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\w+)\s+(\w+)\s+(.*)$/)
    if (!m) return null
    const ts = new Date(m[1].replace(' ', 'T')).getTime()
    let message = m[4]
    let meta: Partial<Pick<LogEntry, 'route' | 'bytes' | 'speedBps' | 'durationMs'>> = {}
    const jsonIdx = message.lastIndexOf('  {')
    if (jsonIdx !== -1) {
      try {
        meta = JSON.parse(message.slice(jsonIdx + 2)) as typeof meta
        message = message.slice(0, jsonIdx)
      } catch { /* malformed meta — keep full message */ }
    }
    return {
      ts: isNaN(ts) ? Date.now() : ts,
      level: m[2].toLowerCase() as LogLevel,
      category: m[3].toLowerCase() as LogCategory,
      message,
      ...meta
    }
  }

  /** Read the tail of conduit.log for populating the viewer on open. */
  async getRecent(limit = 500): Promise<LogEntry[]> {
    await this.flush() // include anything buffered
    try {
      const content = await fs.readFile(this.logFile(), 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      const tail = lines.slice(-limit)
      return tail.map((l) => this.parse(l)).filter((e): e is LogEntry => e !== null)
    } catch {
      return []
    }
  }

  /**
   * Delete conduit.log if it's older than retentionDays (0 = keep forever).
   * Also removes any legacy conduit-YYYY-MM-DD.log daily files.
   */
  async prune(retentionDays: number): Promise<void> {
    if (!retentionDays || retentionDays <= 0) return
    try {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

      // Prune the single log file by mtime.
      try {
        const stat = await fs.stat(this.logFile())
        if (stat.mtimeMs < cutoff) {
          this.stream?.end()
          this.stream = null
          await fs.unlink(this.logFile()).catch(() => {})
        }
      } catch {
        // file doesn't exist — nothing to do
      }

      // Clean up any leftover legacy daily files.
      try {
        const files = await fs.readdir(this.logsDir())
        for (const f of files) {
          if (/^conduit-\d{4}-\d\d-\d\d\.log$/.test(f)) {
            await fs.unlink(join(this.logsDir(), f)).catch(() => {})
          }
        }
      } catch {
        // no logs dir
      }
    } catch {
      // no logs dir yet
    }
  }

  async clear(): Promise<void> {
    await this.flush()
    this.stream?.end()
    this.stream = null
    this.lastLogDate = ''
    try {
      await fs.unlink(this.logFile()).catch(() => {})
    } catch {
      // nothing to clear
    }
  }

  /** Return the full content of conduit.log for export. */
  async exportAll(): Promise<string> {
    await this.flush()
    try {
      return await fs.readFile(this.logFile(), 'utf-8')
    } catch {
      return ''
    }
  }

  dir(): string {
    return this.logsDir()
  }
}

export const logger = new Logger()

type LogMeta = Partial<Pick<LogEntry, 'route' | 'bytes' | 'speedBps' | 'durationMs'>>

/** Convenience wrappers. */
export const log = {
  info:    (c: LogCategory, m: string, meta?: LogMeta) => logger.log('info',    c, m, meta),
  success: (c: LogCategory, m: string, meta?: LogMeta) => logger.log('success', c, m, meta),
  warn:    (c: LogCategory, m: string, meta?: LogMeta) => logger.log('warn',    c, m, meta),
  error:   (c: LogCategory, m: string, meta?: LogMeta) => logger.log('error',   c, m, meta),
}
