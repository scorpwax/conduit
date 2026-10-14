// Types + pure query logic for Advanced Search. Kept free of Node/Electron
// imports so the exact same matcher can be unit-tested and reused anywhere.

export interface SearchFilters {
  /** Raw text from the query box — may contain operators (-word, ext:, size:, …). */
  text: string
  /** Words to exclude (space-separated; quotes + wildcards allowed). */
  exclude: string
  /** File extensions from the file-type field (no dots, any case). */
  extensions: string[]
  kinds: 'both' | 'files' | 'folders'
  /** Match against just the item's name, or its whole path. */
  matchIn: 'name' | 'path'
  /** 'all' = every word must match, 'any' = at least one. */
  mode: 'all' | 'any'
  wholeWord: boolean
  caseSensitive: boolean
  includeHidden: boolean
  minSize?: number
  maxSize?: number
  /** ISO dates (YYYY-MM-DD or full ISO). */
  modifiedAfter?: string
  modifiedBefore?: string
}

export interface SearchRequest {
  searchId: string
  connectionId: string
  /** Folder to search under; '' = the whole connection. */
  rootPath: string
  filters: SearchFilters
  /** Ignore any cached index and re-scan the connection. */
  refresh?: boolean
}

export interface SearchResult {
  name: string
  path: string
  /** Folder containing this item ('' at the connection root). */
  dir: string
  kind: 'file' | 'directory'
  size: number
  modified: string | null
}

export interface SearchProgress {
  searchId: string
  scanned: number
  matches: number
  foldersDone: number
  foldersQueued: number
  elapsedMs: number
}

export interface SearchDone {
  searchId: string
  scanned: number
  matches: number
  elapsedMs: number
  /** Hit the result cap — there are more matches than are listed. */
  truncated: boolean
  cancelled: boolean
  error?: string
  /** Served from the in-memory index instead of re-scanning. */
  fromCache: boolean
  /** When the cached index was built (epoch ms), if fromCache. */
  cachedAt?: number
  warnings: string[]
}

export interface SearchContext {
  connectionId: string | null
  /** Current folder of the pane the search was launched from. */
  path: string
  query?: string
}

export interface SearchOpenInPane {
  connectionId: string
  /** Folder to show in the new pane. */
  path: string
  /** Items to pre-select once the folder loads (all live in `path`). */
  select: string[]
}

// ── Query parsing ───────────────────────────────────────────────────────────

interface Token {
  text: string
  quoted: boolean
}

function tokenize(input: string): Token[] {
  const out: Token[] = []
  let cur = ''
  let quoted = false
  let inQuotes = false
  let had = false
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes
      quoted = true
      had = true
    } else if (!inQuotes && /\s/.test(ch)) {
      if (had) out.push({ text: cur, quoted })
      cur = ''
      quoted = false
      had = false
    } else {
      cur += ch
      had = true
    }
  }
  if (had) out.push({ text: cur, quoted })
  return out.filter((t) => t.text.length > 0)
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12
}

/** Parse "500mb", "1.5gb", "2048" → bytes. Base-1000, matching the file list. */
export function parseSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(s.trim())
  if (!m) return null
  return Math.round(parseFloat(m[1]) * UNITS[(m[2] ?? 'b').toLowerCase()])
}

function parseDate(s: string): number | null {
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** Glob (* = any run, ? = one char) → anchored regex source. */
function globSource(s: string): string {
  let out = ''
  for (const ch of s) out += ch === '*' ? '.*' : ch === '?' ? '.' : escapeRegex(ch)
  return out
}

interface Term {
  test: (target: string) => boolean
  /** Match against the full path instead of the name. */
  onPath: boolean
}

function makeTerm(raw: string, f: SearchFilters, forcePath: boolean): Term {
  const onPath = forcePath || f.matchIn === 'path'
  const flags = f.caseSensitive ? '' : 'i'
  if (/[*?]/.test(raw)) {
    // Wildcard terms match the WHOLE name (or path), like a shell glob.
    const re = new RegExp(`^${globSource(raw)}$`, flags)
    return { test: (t) => re.test(t), onPath }
  }
  if (f.wholeWord) {
    // "Word" boundaries are anything that isn't a letter/digit, so
    // Jason_Interview_01 contains the whole words Jason, Interview and 01.
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(raw)}(?![A-Za-z0-9])`, flags)
    return { test: (t) => re.test(t), onPath }
  }
  if (f.caseSensitive) return { test: (t) => t.includes(raw), onPath }
  const lower = raw.toLowerCase()
  return { test: (t) => t.toLowerCase().includes(lower), onPath }
}

function normExt(e: string): string {
  return e.trim().replace(/^\.+/, '').toLowerCase()
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

export interface MatchEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
}

export interface CompiledQuery {
  /** True when nothing would filter anything (every item matches). */
  isEmpty: boolean
  /** Cheap check on name/path/kind — run before any (possibly slow) stat. */
  matchesName: (e: MatchEntry) => boolean
  /** True when size/date filters need real size + modified values. */
  needsStat: boolean
  matchesStat: (size: number, modified: string | null, kind: 'file' | 'directory') => boolean
  warnings: string[]
}

export function compileQuery(f: SearchFilters): CompiledQuery {
  const warnings: string[] = []
  const positive: Term[] = []
  const negative: Term[] = []
  const exts = new Set(f.extensions.map(normExt).filter(Boolean))
  const notExts = new Set<string>()
  let kinds = f.kinds
  let minSize = f.minSize
  let maxSize = f.maxSize
  let after = f.modifiedAfter ? parseDate(f.modifiedAfter) : null
  let before = f.modifiedBefore ? parseDate(f.modifiedBefore) : null
  let beforeRaw = f.modifiedBefore ?? ''

  const addTerm = (raw: string, neg: boolean, forcePath = false): void => {
    if (!raw) return
    ;(neg ? negative : positive).push(makeTerm(raw, f, forcePath))
  }

  for (const tok of tokenize(f.text)) {
    let text = tok.text
    let neg = false
    if (!tok.quoted && text.length > 1 && text.startsWith('-')) {
      neg = true
      text = text.slice(1)
    }
    const kv = !tok.quoted ? /^(ext|type|size|before|after|path):(.*)$/i.exec(text) : null
    if (!kv) {
      addTerm(text, neg)
      continue
    }
    const key = kv[1].toLowerCase()
    const val = kv[2]
    if (!val) {
      warnings.push(`"${text}" has no value — ignored`)
      continue
    }
    if (key === 'ext') {
      for (const e of val.split(',').map(normExt).filter(Boolean)) (neg ? notExts : exts).add(e)
    } else if (key === 'path') {
      addTerm(val, neg, true)
    } else if (key === 'type') {
      const v = val.toLowerCase()
      if (v === 'file' || v === 'files') kinds = 'files'
      else if (v === 'folder' || v === 'folders' || v === 'dir' || v === 'directory') kinds = 'folders'
      else warnings.push(`type:${val} not understood (use type:file or type:folder)`)
    } else if (key === 'size') {
      const range = /^(.+)\.\.(.+)$/.exec(val)
      const cmp = /^(>=|<=|>|<|=)?(.+)$/.exec(val)
      if (range) {
        const lo = parseSize(range[1])
        const hi = parseSize(range[2])
        if (lo === null || hi === null) warnings.push(`size:${val} not understood`)
        else {
          minSize = lo
          maxSize = hi
        }
      } else if (cmp) {
        const n = parseSize(cmp[2])
        if (n === null) warnings.push(`size:${val} not understood (try size:>500mb)`)
        else if (cmp[1] === '<' || cmp[1] === '<=') maxSize = n
        else if (cmp[1] === '=') {
          minSize = n
          maxSize = n
        } else minSize = n // '>' / '>=' / bare number all mean "at least"
      }
    } else {
      const t = parseDate(val)
      if (t === null) warnings.push(`${key}:${val} is not a valid date (use YYYY-MM-DD)`)
      else if (key === 'after') after = t
      else {
        before = t
        beforeRaw = val
      }
    }
  }

  for (const w of f.exclude.trim() ? tokenize(f.exclude) : []) addTerm(w.text, true)

  const needsStat =
    minSize !== undefined || maxSize !== undefined || after !== null || before !== null
  // Dates entered as plain YYYY-MM-DD for "before" should include that whole day.
  const beforeEnd = before !== null && /^\d{4}-\d{2}-\d{2}$/.test(beforeRaw)
    ? before + 86_400_000 - 1
    : before

  const isEmpty =
    positive.length === 0 &&
    negative.length === 0 &&
    exts.size === 0 &&
    notExts.size === 0 &&
    kinds === 'both' &&
    !needsStat &&
    f.includeHidden

  const sepRe = /[\\/]/

  function matchesName(e: MatchEntry): boolean {
    if (kinds === 'files' && e.kind !== 'file') return false
    if (kinds === 'folders' && e.kind !== 'directory') return false
    if (!f.includeHidden) {
      // Skip dotfiles and anything living inside a dot-folder.
      for (const seg of e.path.split(sepRe)) if (seg.startsWith('.') && seg.length > 1) return false
    }
    if (exts.size > 0 || notExts.size > 0) {
      const ext = e.kind === 'file' ? extensionOf(e.name) : ''
      if (exts.size > 0 && !exts.has(ext)) return false
      if (notExts.has(ext)) return false
    }
    for (const t of negative) if (t.test(t.onPath ? e.path : e.name)) return false
    if (positive.length > 0) {
      if (f.mode === 'any') {
        if (!positive.some((t) => t.test(t.onPath ? e.path : e.name))) return false
      } else {
        for (const t of positive) if (!t.test(t.onPath ? e.path : e.name)) return false
      }
    }
    return true
  }

  function matchesStat(size: number, modified: string | null, kind: 'file' | 'directory'): boolean {
    // Folders have no meaningful size, so a size filter never matches them.
    if (kind === 'directory' && (minSize !== undefined || maxSize !== undefined)) return false
    if (minSize !== undefined && size < minSize) return false
    if (maxSize !== undefined && size > maxSize) return false
    if (after !== null || beforeEnd !== null) {
      const t = modified ? Date.parse(modified) : NaN
      if (Number.isNaN(t)) return false
      if (after !== null && t < after) return false
      if (beforeEnd !== null && t > beforeEnd) return false
    }
    return true
  }

  return { isEmpty, matchesName, needsStat, matchesStat, warnings }
}
