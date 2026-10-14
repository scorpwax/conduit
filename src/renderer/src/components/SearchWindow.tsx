import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Connection } from '@shared/types'
import type {
	SearchContext,
	SearchDone,
	SearchFilters,
	SearchProgress,
	SearchResult
} from '@shared/search'
import { parseSize } from '@shared/search'
import { BUILTIN_LOCAL, BUILTIN_LOCAL_ID } from '@shared/builtin'
import { formatBytes, formatDate, fileIcon, fileType } from '../lib/format'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { FolderBrowserModal } from './FolderBrowserModal'

const ROW_H = 26
const COLS = 'minmax(180px, 2fr) minmax(200px, 3fr) 90px 150px 90px'

type SortKey = 'name' | 'dir' | 'size' | 'modified' | 'kind'

const FILE_TYPE_PRESETS: Array<{ label: string; exts: string }> = [
	{ label: 'Camera RAW', exts: 'braw r3d ari arx dng' },
	{ label: 'Video', exts: 'braw r3d mov mp4 mxf mkv avi m4v mpg' },
	{ label: 'Audio', exts: 'wav aif aiff bwf mp3 flac m4a' },
	{ label: 'Images', exts: 'jpg jpeg png tif tiff heic gif psd exr cr2 cr3 arw dng' },
	{ label: 'Documents', exts: 'pdf doc docx xls xlsx ppt pptx txt rtf md csv' },
	{ label: 'Project files', exts: 'prproj aep drp fcpxml xml edl' },
	{ label: 'Archives', exts: 'zip rar 7z tar gz' }
]

const CHEATS: Array<{ title: string; example: string; text: string }> = [
	{ title: 'Several words', example: 'jason interview', text: 'Names containing ALL the words. Switch to "Any word" to match either.' },
	{ title: 'Exact phrase', example: '"jason interview"', text: 'Quotes keep words together, in order, with the same spacing.' },
	{ title: 'Exclude a word', example: 'jason -proxy', text: 'A leading minus drops anything containing that word. There is also an Exclude box.' },
	{ title: 'Wildcards', example: '*.braw', text: '* = any characters, ? = exactly one. A wildcard term must match the WHOLE name, so use *Jason*01* (not Jason*01) to match "My_Jason_Interview_01.mov".' },
	{ title: 'File type', example: 'ext:braw,r3d', text: 'One or more extensions. Use -ext:tmp to hide a type. The File types box does the same.' },
	{ title: 'Files or folders only', example: 'type:folder', text: 'type:file or type:folder.' },
	{ title: 'Size', example: 'size:>1gb', text: 'size:>500mb, size:<2gb, or a range size:1gb..5gb. Applies to files only.' },
	{ title: 'Modified date', example: 'after:2026-01-01', text: 'after: / before: with YYYY-MM-DD (before: includes that whole day).' },
	{ title: 'Folder path', example: 'path:interviews', text: 'Matches anywhere in the item\'s folder path, not just its name.' }
]

interface Prefs {
	kinds: SearchFilters['kinds']
	matchIn: SearchFilters['matchIn']
	mode: SearchFilters['mode']
	wholeWord: boolean
	caseSensitive: boolean
	includeHidden: boolean
}

const DEFAULT_PREFS: Prefs = {
	kinds: 'both',
	matchIn: 'name',
	mode: 'all',
	wholeWord: false,
	caseSensitive: false,
	includeHidden: false
}

function loadPrefs(): Prefs {
	try {
		const raw = localStorage.getItem('conduit.search.prefs')
		if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) }
	} catch {
		// storage unavailable — fall back to defaults
	}
	return DEFAULT_PREFS
}

function fmtElapsed(ms: number): string {
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

function ago(ms: number): string {
	const m = Math.round((Date.now() - ms) / 60_000)
	return m < 1 ? 'less than a minute ago' : `${m} min ago`
}

/** Advanced Search — a standalone window (second BrowserWindow, hash `#search`).
 *  Searches everything under a connection, streaming results as they're found. */
export function SearchWindow(): JSX.Element {
	const [connections, setConnections] = useState<Connection[]>([BUILTIN_LOCAL])
	const [connectionId, setConnectionId] = useState<string>(BUILTIN_LOCAL_ID)
	const [scope, setScope] = useState<'whole' | 'folder'>('whole')
	const [folderPath, setFolderPath] = useState('')

	const [text, setText] = useState('')
	const [exclude, setExclude] = useState('')
	const [useExclude, setUseExclude] = useState(false)
	const [browsing, setBrowsing] = useState(false)
	const pickedRef = useRef('')
	const [notice, setNotice] = useState('')
	const [extText, setExtText] = useState('')
	const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
	const [showMore, setShowMore] = useState(false)
	const [minSize, setMinSize] = useState('')
	const [maxSize, setMaxSize] = useState('')
	const [sizeUnit, setSizeUnit] = useState('mb')
	const [after, setAfter] = useState('')
	const [before, setBefore] = useState('')
	const [showHelp, setShowHelp] = useState(false)

	const [running, setRunning] = useState(false)
	const [progress, setProgress] = useState<SearchProgress | null>(null)
	const [done, setDone] = useState<SearchDone | null>(null)
	const [version, setVersion] = useState(0)
	const resultsRef = useRef<SearchResult[]>([])
	const currentId = useRef<string>('')

	const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const lastClicked = useRef<number>(-1)
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

	const listRef = useRef<HTMLDivElement>(null)
	const [scrollTop, setScrollTop] = useState(0)
	const [viewH, setViewH] = useState(400)
	const queryRef = useRef<HTMLInputElement>(null)

	const connection = connections.find((c) => c.id === connectionId)
	const isLocal = connection?.type === 'local'

	useEffect(() => {
		document.title = 'Conduit — Advanced Search'
		const theme =
			typeof localStorage !== 'undefined' && localStorage.getItem('conduit.theme') === 'light' ? 'light' : 'dark'
		document.documentElement.setAttribute('data-theme', theme)
	}, [])

	useEffect(() => {
		try {
			localStorage.setItem('conduit.search.prefs', JSON.stringify(prefs))
		} catch {
			// ignore
		}
	}, [prefs])

	const applyContext = useCallback((ctx: SearchContext | null) => {
		if (!ctx) return
		setConnectionId(ctx.connectionId ?? BUILTIN_LOCAL_ID)
		if (ctx.path) {
			setScope('folder')
			setFolderPath(ctx.path)
		} else {
			setScope('whole')
			setFolderPath('')
		}
		if (ctx.query !== undefined) setText(ctx.query)
		setTimeout(() => queryRef.current?.focus(), 0)
	}, [])

	useEffect(() => {
		void window.conduit.connections.getAll().then((all) => setConnections([BUILTIN_LOCAL, ...all]))
		void window.conduit.search.getContext().then(applyContext)
		return window.conduit.search.onContext(applyContext)
	}, [applyContext])

	// Stream results in from the main process.
	useEffect(() => {
		const offBatch = window.conduit.search.onBatch((id, batch) => {
			if (id !== currentId.current) return
			for (const r of batch) resultsRef.current.push(r)
		})
		const offProgress = window.conduit.search.onProgress((p) => {
			if (p.searchId !== currentId.current) return
			setProgress(p)
			setVersion((v) => v + 1)
		})
		const offDone = window.conduit.search.onDone((d) => {
			if (d.searchId !== currentId.current) return
			setDone(d)
			setRunning(false)
			setVersion((v) => v + 1)
		})
		const cancelOnClose = (): void => {
			if (currentId.current) void window.conduit.search.cancel(currentId.current)
		}
		window.addEventListener('beforeunload', cancelOnClose)
		return () => {
			offBatch()
			offProgress()
			offDone()
			window.removeEventListener('beforeunload', cancelOnClose)
		}
	}, [])

	useEffect(() => {
		const el = listRef.current
		if (!el) return
		const ro = new ResizeObserver(() => setViewH(el.clientHeight))
		ro.observe(el)
		setViewH(el.clientHeight)
		return () => ro.disconnect()
	}, [])

	function buildFilters(): SearchFilters {
		const unit = sizeUnit
		const toBytes = (v: string): number | undefined => {
			if (!v.trim()) return undefined
			const n = parseSize(`${v.trim()}${unit}`)
			return n === null ? undefined : n
		}
		return {
			text,
			exclude: useExclude ? exclude : '',
			extensions: extText.split(/[\s,]+/).filter(Boolean),
			kinds: prefs.kinds,
			matchIn: prefs.matchIn,
			mode: prefs.mode,
			wholeWord: prefs.wholeWord,
			caseSensitive: prefs.caseSensitive,
			includeHidden: prefs.includeHidden,
			minSize: toBytes(minSize),
			maxSize: toBytes(maxSize),
			modifiedAfter: after || undefined,
			modifiedBefore: before || undefined
		}
	}

	function startSearch(refresh = false): void {
		if (!connectionId) return
		if (currentId.current && running) void window.conduit.search.cancel(currentId.current)
		const id = crypto.randomUUID()
		currentId.current = id
		resultsRef.current = []
		setSelected(new Set())
		lastClicked.current = -1
		setDone(null)
		setProgress(null)
		setRunning(true)
		setVersion((v) => v + 1)
		listRef.current?.scrollTo({ top: 0 })
		void window.conduit.search.start({
			searchId: id,
			connectionId,
			rootPath: scope === 'folder' ? folderPath : '',
			filters: buildFilters(),
			refresh
		})
	}

	function stopSearch(): void {
		if (currentId.current) void window.conduit.search.cancel(currentId.current)
	}

	const sorted = useMemo(() => {
		const arr = resultsRef.current.slice()
		const dir = sort.dir === 'asc' ? 1 : -1
		const cmpStr = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
		arr.sort((a, b) => {
			let c = 0
			switch (sort.key) {
				case 'name':
					c = cmpStr(a.name, b.name)
					break
				case 'dir':
					c = cmpStr(a.dir, b.dir)
					break
				case 'size':
					c = a.size - b.size
					break
				case 'modified':
					c = (a.modified ?? '').localeCompare(b.modified ?? '')
					break
				case 'kind':
					c = cmpStr(fileType(a.name, a.kind), fileType(b.name, b.kind))
					break
			}
			return c * dir || cmpStr(a.name, b.name)
		})
		return arr
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [version, sort])

	function toggleSort(key: SortKey): void {
		setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
	}

	function onRowClick(e: React.MouseEvent, index: number): void {
		const r = sorted[index]
		if (e.shiftKey && lastClicked.current >= 0) {
			const [lo, hi] = [Math.min(lastClicked.current, index), Math.max(lastClicked.current, index)]
			setSelected(new Set(sorted.slice(lo, hi + 1).map((x) => x.path)))
		} else if (e.metaKey || e.ctrlKey) {
			setSelected((prev) => {
				const next = new Set(prev)
				if (next.has(r.path)) next.delete(r.path)
				else next.add(r.path)
				return next
			})
			lastClicked.current = index
		} else {
			setSelected(new Set([r.path]))
			lastClicked.current = index
		}
	}

	function selectedResults(): SearchResult[] {
		return sorted.filter((r) => selected.has(r.path))
	}

	function openInNewPane(items: SearchResult[] = selectedResults()): void {
		const first = items[0]
		if (!first) return
		if (first.kind === 'directory') {
			void window.conduit.search.openInPane({ connectionId, path: first.path, select: [] })
			return
		}
		// Open the first item's folder and pre-select every picked file in it.
		const sameDir = items.filter((r) => r.dir === first.dir && r.kind === 'file').map((r) => r.path)
		void window.conduit.search.openInPane({ connectionId, path: first.dir, select: sameDir })
	}

	function onListKey(e: React.KeyboardEvent): void {
		if (sorted.length === 0) return
		if (e.key === 'Enter') {
			e.preventDefault()
			openInNewPane()
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault()
			const next = Math.max(0, Math.min(sorted.length - 1, lastClicked.current + (e.key === 'ArrowDown' ? 1 : -1)))
			lastClicked.current = next
			setSelected(new Set([sorted[next].path]))
			const el = listRef.current
			if (el) {
				const top = next * ROW_H
				if (top < el.scrollTop) el.scrollTop = top
				else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
			}
		} else if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
			e.preventDefault()
			setSelected(new Set(sorted.map((r) => r.path)))
		}
	}

	const menuItems = (): ContextMenuItem[] => {
		const items = selectedResults()
		const one = items.length === 1 ? items[0] : null
		const out: ContextMenuItem[] = [{ label: 'Open in New Pane', onClick: () => openInNewPane(items) }]
		if (isLocal && window.conduit.platform === 'darwin' && one) {
			out.push({ label: 'Reveal in Finder', onClick: () => void window.conduit.fs.revealFile(one.path) })
		}
		out.push({ label: 'Download', onClick: () => void download(items) })
		out.push({ label: 'Download to…', onClick: () => void download(items, true) })
		out.push({ separator: true })
		out.push({
			label: items.length > 1 ? 'Copy Paths' : 'Copy Path',
			onClick: () => void navigator.clipboard.writeText(items.map((r) => r.path).join('\n'))
		})
		out.push({
			label: items.length > 1 ? 'Copy Names' : 'Copy Name',
			onClick: () => void navigator.clipboard.writeText(items.map((r) => r.name).join('\n'))
		})
		return out
	}

	function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
		setPrefs((p) => ({ ...p, [key]: value }))
	}

	function addPreset(exts: string): void {
		const have = new Set(extText.split(/[\s,]+/).filter(Boolean).map((e) => e.toLowerCase()))
		for (const e of exts.split(' ')) have.add(e)
		setExtText([...have].join(' '))
	}

	async function pickFolder(): Promise<void> {
		// Local disks get the native picker; remote connections browse their own tree.
		if (!isLocal) {
			pickedRef.current = folderPath
			setBrowsing(true)
			return
		}
		const dir = await window.conduit.search.pickFolder()
		if (dir) {
			setScope('folder')
			setFolderPath(dir)
		}
	}

	/** Queue the given results for download to the app's download folder. */
	async function download(items: SearchResult[], chooseDestination = false): Promise<void> {
		if (items.length === 0) return
		const settings = await window.conduit.settings.get()
		let dir = chooseDestination ? undefined : settings.downloadDir
		if (!dir) {
			dir = (await window.conduit.search.pickFolder()) ?? undefined
			if (!dir) return
			if (!settings.downloadDir) await window.conduit.settings.set({ downloadDir: dir })
		}
		// 'keepBoth' so a search-driven download can never overwrite existing files.
		await window.conduit.transfer.enqueue({
			sourceConnectionId: connectionId,
			destConnectionId: BUILTIN_LOCAL_ID,
			sourcePaths: items.map((r) => r.path),
			destDir: dir,
			conflictPolicy: 'keepBoth'
		})
		const folder = dir.split(/[/\\]/).filter(Boolean).pop() ?? dir
		setNotice(`Added ${items.length.toLocaleString()} item${items.length === 1 ? '' : 's'} to the transfer queue → ${folder}. Track progress in the main window.`)
		setTimeout(() => setNotice(''), 8000)
	}

	// Virtualised rows.
	const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8)
	const last = Math.min(sorted.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8)
	const visible = sorted.slice(first, last)

	const pct =
		running && progress && progress.foldersQueued > 0
			? Math.min(99, Math.round((progress.foldersDone / progress.foldersQueued) * 100))
			: null
	const matchCount = running ? (progress?.matches ?? 0) : (done?.matches ?? sorted.length)

	function statusLine(): string {
		if (running) {
			const p = progress
			if (!p) return 'Starting…'
			return `Searching… ${p.scanned.toLocaleString()} items scanned · ${p.matches.toLocaleString()} found · ${fmtElapsed(p.elapsedMs)}`
		}
		if (!done) return 'Enter a search above. Searches everything under the chosen location, not just one folder.'
		if (done.error) return `Search failed: ${done.error}`
		const base = `${done.matches.toLocaleString()} found · ${done.scanned.toLocaleString()} items ${done.fromCache ? 'checked' : 'scanned'} in ${fmtElapsed(done.elapsedMs)}`
		if (done.cancelled) return `Stopped — ${base}`
		if (done.truncated) return `${base} — showing the first ${done.matches.toLocaleString()}; narrow your search to see the rest`
		return base
	}

	const enterToSearch = (e: React.KeyboardEvent): void => {
		if (e.key === 'Enter') {
			e.preventDefault()
			startSearch()
		}
	}

	return (
		<div className="sw-root">
			<div className="sw-top">
				<div className="sw-row">
					<label className="sw-label">Search in</label>
					<select
						className="input sw-select"
						value={connectionId}
						onChange={(e) => {
							setConnectionId(e.target.value)
							setScope('whole')
							setFolderPath('')
						}}
					>
						{connections.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
					<select className="input sw-select" value={scope} onChange={(e) => setScope(e.target.value as 'whole' | 'folder')}>
						<option value="whole">{isLocal ? 'Entire disk' : 'Entire connection'}</option>
						<option value="folder">Only this folder</option>
					</select>
					{scope === 'folder' && (
						<input
							className="input sw-folder"
							value={folderPath}
							placeholder="Folder path"
							spellCheck={false}
							onChange={(e) => setFolderPath(e.target.value)}
							onKeyDown={enterToSearch}
						/>
					)}
					<button className="btn" onClick={() => void pickFolder()}>
						<span className="material-symbols-outlined">folder_open</span> Choose…
					</button>
				</div>
				{isLocal && scope === 'whole' && (
					<div className="sw-warn">
						Searching an entire disk can take a while — pick a folder with “Choose…” to go faster.
					</div>
				)}

				<div className="sw-row">
					<input
						ref={queryRef}
						autoFocus
						className="input sw-query"
						placeholder='Words to find — e.g.  jason interview   "exact phrase"   -proxy   *.braw'
						value={text}
						spellCheck={false}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={enterToSearch}
					/>
					{running ? (
						<button className="btn danger-solid" onClick={stopSearch}>
							<span className="material-symbols-outlined">stop</span> Stop
						</button>
					) : (
						<button className="btn primary" onClick={() => startSearch()}>
							<span className="material-symbols-outlined">search</span> Search
						</button>
					)}
					<button
						className={`btn ${showHelp ? 'active' : ''}`}
						title="Search tips & cheat sheet"
						onClick={() => setShowHelp((v) => !v)}
					>
						<span className="material-symbols-outlined">help</span> Cheat sheet
					</button>
				</div>

				<div className="sw-row">
					<label className="sw-label">File types</label>
					<input
						className="input sw-ext"
						placeholder="braw r3d wav  (blank = any)"
						value={extText}
						spellCheck={false}
						onChange={(e) => setExtText(e.target.value)}
						onKeyDown={enterToSearch}
					/>
					<select
						className="input sw-preset"
						value=""
						onChange={(e) => {
							if (e.target.value) addPreset(e.target.value)
						}}
					>
						<option value="">Add preset…</option>
						{FILE_TYPE_PRESETS.map((p) => (
							<option key={p.label} value={p.exts}>
								{p.label}
							</option>
						))}
					</select>
					{extText && (
						<button className="btn ghost" onClick={() => setExtText('')}>
							Clear
						</button>
					)}
					<label className="sw-check sw-gap">
						<input type="checkbox" checked={useExclude} onChange={(e) => setUseExclude(e.target.checked)} /> Exclude words
					</label>
					{useExclude && (
						<input
							autoFocus
							className="input sw-exclude"
							placeholder="proxy temp  (hide these)"
							value={exclude}
							spellCheck={false}
							onChange={(e) => setExclude(e.target.value)}
							onKeyDown={enterToSearch}
						/>
					)}
				</div>

				<div className="sw-row sw-opts">
					<select className="input sw-mini" value={prefs.kinds} onChange={(e) => setPref('kinds', e.target.value as Prefs['kinds'])}>
						<option value="both">Files &amp; folders</option>
						<option value="files">Files only</option>
						<option value="folders">Folders only</option>
					</select>
					<select className="input sw-mini" value={prefs.matchIn} onChange={(e) => setPref('matchIn', e.target.value as Prefs['matchIn'])}>
						<option value="name">Match in name</option>
						<option value="path">Match in full path</option>
					</select>
					<select className="input sw-mini" value={prefs.mode} onChange={(e) => setPref('mode', e.target.value as Prefs['mode'])}>
						<option value="all">All words</option>
						<option value="any">Any word</option>
					</select>
					<label className="sw-check">
						<input type="checkbox" checked={prefs.wholeWord} onChange={(e) => setPref('wholeWord', e.target.checked)} /> Whole word
					</label>
					<label className="sw-check">
						<input type="checkbox" checked={prefs.caseSensitive} onChange={(e) => setPref('caseSensitive', e.target.checked)} /> Case sensitive
					</label>
					<label className="sw-check">
						<input type="checkbox" checked={prefs.includeHidden} onChange={(e) => setPref('includeHidden', e.target.checked)} /> Hidden files
					</label>
					<button className="btn ghost" onClick={() => setShowMore((v) => !v)}>
						{showMore ? '▾' : '▸'} Size &amp; date
					</button>
				</div>

				{showMore && (
					<div className="sw-row">
						<label className="sw-label">Size</label>
						<input className="input sw-num" type="number" min="0" placeholder="min" value={minSize} onChange={(e) => setMinSize(e.target.value)} onKeyDown={enterToSearch} />
						<span className="sw-dash">to</span>
						<input className="input sw-num" type="number" min="0" placeholder="max" value={maxSize} onChange={(e) => setMaxSize(e.target.value)} onKeyDown={enterToSearch} />
						<select className="input sw-unit" value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value)}>
							<option value="kb">KB</option>
							<option value="mb">MB</option>
							<option value="gb">GB</option>
							<option value="tb">TB</option>
						</select>
						<label className="sw-label sw-gap">Modified</label>
						<input className="input sw-date" type="date" value={after} onChange={(e) => setAfter(e.target.value)} />
						<span className="sw-dash">to</span>
						<input className="input sw-date" type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
						{(minSize || maxSize || after || before) && (
							<button
								className="btn ghost"
								onClick={() => {
									setMinSize('')
									setMaxSize('')
									setAfter('')
									setBefore('')
								}}
							>
								Clear
							</button>
						)}
					</div>
				)}
			</div>

			<div className="sw-progress" title={pct !== null ? 'Estimate — folders are discovered as the scan goes' : undefined}>
				<div
					className={`sw-progress-bar ${running && pct === null ? 'indeterminate' : ''}`}
					style={{ width: running ? (pct === null ? '35%' : `${pct}%`) : done ? '100%' : '0%', opacity: running || done ? 1 : 0 }}
				/>
			</div>
			<div className="sw-status">
				<span>{statusLine()}</span>
				{done?.fromCache && done.cachedAt && (
					<span className="sw-cache">
						Used saved index from {ago(done.cachedAt)} ·{' '}
						<button className="sw-link" onClick={() => startSearch(true)}>
							Re-scan
						</button>
					</span>
				)}
				{notice && <span className="sw-notice">✓ {notice}</span>}
				{done?.warnings.map((w, i) => (
					<span key={i} className="sw-warn-inline">
						⚠ {w}
					</span>
				))}
			</div>

			<div className="sw-body">
				<div className="sw-table">
					<div className="sw-head" style={{ gridTemplateColumns: COLS }}>
						{(
							[
								['name', 'Name'],
								['dir', 'Folder'],
								['size', 'Size'],
								['modified', 'Modified'],
								['kind', 'Kind']
							] as Array<[SortKey, string]>
						).map(([key, label]) => (
							<button key={key} className="sw-th" onClick={() => toggleSort(key)}>
								{label}
								{sort.key === key && <span className="sw-arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
							</button>
						))}
					</div>
					<div
						className="sw-list"
						ref={listRef}
						tabIndex={0}
						onKeyDown={onListKey}
						onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
					>
						{sorted.length === 0 && !running && done && !done.error && (
							<div className="sw-empty">No matches. Try fewer words, “Any word”, or a wildcard like *name*.</div>
						)}
						<div style={{ height: sorted.length * ROW_H, position: 'relative' }}>
							<div style={{ position: 'absolute', top: first * ROW_H, left: 0, right: 0 }}>
								{visible.map((r, i) => {
									const index = first + i
									return (
										<div
											key={r.path}
											className={`sw-rowitem ${selected.has(r.path) ? 'selected' : ''}`}
											style={{ gridTemplateColumns: COLS, height: ROW_H }}
											onClick={(e) => onRowClick(e, index)}
											onDoubleClick={() => openInNewPane([r])}
											onContextMenu={(e) => {
												e.preventDefault()
												if (!selected.has(r.path)) {
													setSelected(new Set([r.path]))
													lastClicked.current = index
												}
												setMenu({ x: e.clientX, y: e.clientY })
											}}
										>
											<span className="sw-cell sw-name" title={r.name}>
												<span className="sw-icon">{fileIcon(r.name, r.kind)}</span>
												{r.name}
											</span>
											<span className="sw-cell sw-dim" title={r.path}>
												{r.dir || '/'}
											</span>
											<span className="sw-cell sw-dim sw-right">{r.kind === 'directory' ? '—' : formatBytes(r.size)}</span>
											<span className="sw-cell sw-dim">{formatDate(r.modified)}</span>
											<span className="sw-cell sw-dim">{fileType(r.name, r.kind)}</span>
										</div>
									)
								})}
							</div>
						</div>
					</div>
				</div>

				{showHelp && (
					<aside className="sw-help">
						<div className="sw-help-head">
							<strong>Search cheat sheet</strong>
							<button className="iconbtn" onClick={() => setShowHelp(false)} title="Close">
								✕
							</button>
						</div>
						<p className="sw-help-intro">Click any example to try it. Mix and match them in one search.</p>
						{CHEATS.map((c) => (
							<div key={c.title} className="sw-cheat">
								<div className="sw-cheat-title">{c.title}</div>
								<button
									className="sw-cheat-ex"
									title="Use this example"
									onClick={() => {
										setText(c.example)
										queryRef.current?.focus()
									}}
								>
									{c.example}
								</button>
								<div className="sw-cheat-text">{c.text}</div>
							</div>
						))}
						<div className="sw-cheat">
							<div className="sw-cheat-title">Putting it together</div>
							<button className="sw-cheat-ex" onClick={() => setText('jason interview ext:braw size:>1gb')}>
								jason interview ext:braw size:&gt;1gb
							</button>
							<div className="sw-cheat-text">BRAW files with both words in the name, over 1 GB.</div>
						</div>
					</aside>
				)}
			</div>

			<div className="sw-footer">
				<span className="sw-dim">
					{selected.size > 0 ? `${selected.size.toLocaleString()} selected of ` : ''}
					{matchCount.toLocaleString()} result{matchCount === 1 ? '' : 's'}
				</span>
				<div className="spacer" />
				<button className="btn" disabled={sorted.length === 0} onClick={() => void window.conduit.search.exportCsv(sorted)}>
					<span className="material-symbols-outlined">download</span> Export CSV
				</button>
				<button
					className="btn"
					disabled={selected.size === 0}
					title="Download the selected items to your download folder (right-click for Download to…)"
					onClick={() => void download(selectedResults())}
				>
					<span className="material-symbols-outlined">cloud_download</span> Download
				</button>
				<button
					className="btn"
					disabled={selected.size === 0}
					onClick={() => void navigator.clipboard.writeText(selectedResults().map((r) => r.path).join('\n'))}
				>
					<span className="material-symbols-outlined">content_copy</span> Copy Path
				</button>
				<button className="btn primary" disabled={selected.size === 0} onClick={() => openInNewPane()} title="Double-click a result or press Return">
					<span className="material-symbols-outlined">open_in_new</span> Open in New Pane
				</button>
			</div>

			{browsing && connection && (
				<FolderBrowserModal
					connectionId={connection.id}
					connectionName={connection.name}
					initialPath={folderPath}
					onSelect={(p) => {
						pickedRef.current = p
					}}
					onClose={() => setBrowsing(false)}
					headerFooter={
						<div className="modal-footer">
							<span className="fb-selected-path">Search only inside the folder you’re viewing</span>
							<button className="btn ghost" onClick={() => setBrowsing(false)}>
								Cancel
							</button>
							<button
								className="btn primary"
								onClick={() => {
									setScope('folder')
									setFolderPath(pickedRef.current)
									setBrowsing(false)
								}}
							>
								Search This Folder
							</button>
						</div>
					}
				/>
			)}

			{menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
		</div>
	)
}
