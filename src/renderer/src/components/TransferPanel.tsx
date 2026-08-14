import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SyncRun, TransferItem } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'
import { useStore } from '../store'
import { formatBytes, formatSpeed } from '../lib/format'
import { confirmDialog } from '../lib/dialog'

interface TransferPanelProps {
	open?: boolean
	onOpenChange?: (open: boolean) => void
	transfersOpen?: boolean
	onTransfersOpenChange?: (open: boolean) => void
	syncsOpen?: boolean
	onSyncsOpenChange?: (open: boolean) => void
	initialHeight?: number
	onHeightChange?: (h: number) => void
}

export function TransferPanel({
	open, onOpenChange,
	transfersOpen = true, onTransfersOpenChange,
	syncsOpen = true, onSyncsOpenChange,
	initialHeight = 260, onHeightChange
}: TransferPanelProps): JSX.Element {
	const transfers = useStore((s) => s.transfers)
	const connections = useStore((s) => s.connections)
	const setTransfers = useStore((s) => s.setTransfers)
	const clearFinished = useStore((s) => s.clearFinishedTransfers)
	const cancelTransfer = useStore((s) => s.cancelTransfer)
	const syncRuns = useStore((s) => s.syncRuns)
	const clearFinishedSyncRuns = useStore((s) => s.clearFinishedSyncRuns)

	const [collapsed, setCollapsed] = useState(() => !(open ?? false))
	const [transfersCollapsed, setTransfersCollapsed] = useState(!transfersOpen)
	const [syncsCollapsed, setSyncsCollapsed] = useState(!syncsOpen)
	const [isOffline, setIsOffline] = useState(() => !navigator.onLine)
	// Tracks whether the user explicitly hit "Cancel All" so we can show
	// "Transfers Cancelled" even if some files finished before the cancel landed.
	const [canceledAll, setCanceledAll] = useState(false)
	useEffect(() => {
		const goOffline = (): void => setIsOffline(true)
		const goOnline = (): void => setIsOffline(false)
		window.addEventListener('offline', goOffline)
		window.addEventListener('online', goOnline)
		return () => {
			window.removeEventListener('offline', goOffline)
			window.removeEventListener('online', goOnline)
		}
	}, [])

	useEffect(() => {
		if (open !== undefined) setCollapsed(!open)
	}, [open])

	// Reset canceledAll flag when a fresh batch of transfers starts (queue clears first).
	useEffect(() => {
		if (transfers.length === 0) setCanceledAll(false)
	}, [transfers.length])
	const [height, setHeight] = useState(initialHeight)
	const dragging = useRef(false)

	// Tick every 250 ms — to keep elapsed time, speed, and per-row waiting timers live.
	const [now, setNow] = useState(() => Date.now())
	const frozenAtRef = useRef<number | null>(null)
	const byteSamplesRef = useRef<Array<[number, number]>>([])
	const doneBytesRef = useRef(0)
	const activeCountRef = useRef(0)
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 250)
		return () => clearInterval(id)
	}, [])

	useEffect(() => {
		function onMove(e: MouseEvent): void {
			if (!dragging.current) return
			const h = window.innerHeight - e.clientY
			const clamped = Math.max(120, Math.min(h, window.innerHeight - 200))
			setHeight(clamped)
			onHeightChange?.(clamped)
		}
		function onUp(): void {
			dragging.current = false
			document.body.style.cursor = ''
		}
		window.addEventListener('mousemove', onMove)
		window.addEventListener('mouseup', onUp)
		return () => {
			window.removeEventListener('mousemove', onMove)
			window.removeEventListener('mouseup', onUp)
		}
	}, [])

	// Track when each item enters "waiting for server" (bytesDone >= bytesTotal while
	// still transferring). We record the timestamp so each row can show how long
	// it has been waiting, giving the user live feedback during large file uploads.
	const waitingStartRef = useRef<Map<string, number>>(new Map())
	useEffect(() => {
		const map = waitingStartRef.current
		const liveIds = new Set<string>()
		for (const t of transfers) {
			liveIds.add(t.id)
			const isWaiting = t.status === 'transferring' && t.bytesTotal > 0 && t.bytesDone >= t.bytesTotal
			if (isWaiting) {
				if (!map.has(t.id)) map.set(t.id, Date.now())
			} else {
				map.delete(t.id)
			}
		}
		// Clean up entries for transfers that are no longer in the list.
		for (const id of map.keys()) {
			if (!liveIds.has(id)) map.delete(id)
		}
	}, [transfers])

	// All O(n) work is memoized — only reruns when the transfers array reference changes
	// (i.e. when IPC delivers an update), not on every 250ms timer tick.
	const {
		active, done, failed, canceled, allFinished,
		totalBytes, doneBytes, aggSpeed,
		earliestStart, activeFiles,
		sorted, hiddenCount, routes, summaryParts
	} = useMemo(() => {
		const MAX_FINISHED = 100
		const active = transfers.filter((t) => t.status === 'transferring' || t.status === 'queued')
		const done = transfers.filter((t) => t.status === 'done')
		const failed = transfers.filter((t) => t.status === 'error')
		const canceled = transfers.filter((t) => t.status === 'canceled')
		const allFinished = transfers.length > 0 && active.length === 0

		const counted = transfers.filter(
			(t) => t.status !== 'canceled' && t.status !== 'error' && t.kind !== 'operation'
		)
		const totalBytes = counted.reduce((s, t) => s + t.bytesTotal, 0)
		const doneBytes = counted.reduce((s, t) => s + t.bytesDone, 0)
		const aggSpeed = active
			.filter((t) => t.kind !== 'operation')
			.reduce((s, t) => s + (t.speed ?? 0), 0)

		const earliestStart = transfers.reduce(
			(min, t) => (t.startedAt ? Math.min(min, t.startedAt) : min),
			Infinity
		)
		const activeFiles = active.filter((t) => t.kind !== 'operation' && t.bytesTotal > 0)

		const finished = transfers.filter(
			(t) => t.status === 'done' || t.status === 'error' || t.status === 'canceled'
		)
		const recentFinished = finished
			.slice()
			.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
			.slice(0, MAX_FINISHED)
		const hiddenCount = finished.length - recentFinished.length

		const sortedActive = active.slice().sort((a, b) => {
			if (a.status === 'transferring' && b.status !== 'transferring') return -1
			if (b.status === 'transferring' && a.status !== 'transferring') return 1
			return (a.startedAt ?? 0) - (b.startedAt ?? 0)
		})
		const sorted = [...sortedActive, ...recentFinished]

		// Build unique "Source → Dest" route labels from finished file transfers.
		const connName = (id: string): string => {
			if (!id || id === 'local') return 'This Computer'
			return connections.find((c) => c.id === id)?.name ?? 'This Computer'
		}
		const routeSet = new Set<string>()
		for (const t of transfers) {
			if (t.kind !== 'file') continue
			const src = connName(t.source.connectionId)
			const dst = connName(t.dest.connectionId)
			routeSet.add(`${src} → ${dst}`)
		}
		const routes = [...routeSet]

		// Build "Process Complete" summary parts from done items.
		const transferred = done.filter(
			(t) => t.kind === 'file' && !(t.dest.connectionId === BUILTIN_LOCAL_ID && t.source.connectionId !== BUILTIN_LOCAL_ID)
		).length
		const downloaded = done.filter(
			(t) => t.kind === 'file' && t.dest.connectionId === BUILTIN_LOCAL_ID && t.source.connectionId !== BUILTIN_LOCAL_ID
		).length
		const renamed = done.filter((t) => t.kind === 'operation' && t.operationType === 'rename').length
		const deleted = done.filter((t) => t.kind === 'operation' && t.operationType === 'delete').length
		const summaryParts: string[] = []
		if (transferred > 0) summaryParts.push(`${transferred} File${transferred !== 1 ? 's' : ''} Transferred`)
		if (downloaded > 0) summaryParts.push(`${downloaded} File${downloaded !== 1 ? 's' : ''} Downloaded`)
		if (renamed > 0) summaryParts.push(`${renamed} Renamed`)
		if (deleted > 0) summaryParts.push(`${deleted} Deleted`)
		if (failed.length > 0) summaryParts.push(`${failed.length} Failed`)

		return { active, done, failed, canceled, allFinished, totalBytes, doneBytes, aggSpeed, earliestStart, activeFiles, sorted, hiddenCount, routes, summaryParts }
	}, [transfers, connections])

	// Freeze elapsed when complete; reset byte samples when transfers restart.
	useEffect(() => {
		if (allFinished) {
			if (frozenAtRef.current === null) frozenAtRef.current = Date.now()
		} else {
			frozenAtRef.current = null
			byteSamplesRef.current = []
		}
	}, [allFinished])

	// Keep refs in sync with memoized values so the timer effect reads fresh data.
	doneBytesRef.current = doneBytes
	activeCountRef.current = active.length

	const elapsed = earliestStart < Infinity ? (frozenAtRef.current ?? now) - earliestStart : 0

	// Sample doneBytes once per tick to compute panel-level speed.
	useEffect(() => {
		if (activeCountRef.current === 0) return
		const ts = Date.now()
		const samples = byteSamplesRef.current
		samples.push([ts, doneBytesRef.current])
		const cutoff = ts - 5000
		while (samples.length > 1 && samples[0][0] < cutoff) samples.shift()
	}, [now]) // eslint-disable-line react-hooks/exhaustive-deps

	const measuredSpeed = (() => {
		const s = byteSamplesRef.current
		if (s.length < 2) return 0
		const dt = (s[s.length - 1][0] - s[0][0]) / 1000
		const db = s[s.length - 1][1] - s[0][1]
		return dt > 1 && db >= 0 ? db / dt : 0
	})()

	const effectiveSpeed = aggSpeed > 0 ? aggSpeed : measuredSpeed
	const remaining =
		effectiveSpeed > 0 && totalBytes > doneBytes && elapsed > 2000
			? (totalBytes - doneBytes) / effectiveSpeed
			: null

	const overallPct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0

	// "Waiting for server" — all active files have sent their bytes and are now
	// waiting for the server's HTTP 200 confirmation (common for large files).
	const isWaitingForServer =
		activeFiles.length > 0 && activeFiles.every((t) => t.bytesDone >= t.bytesTotal)

	function toggleTransfers(): void {
		const next = !transfersCollapsed
		setTransfersCollapsed(next)
		onTransfersOpenChange?.(!next)
		// Expand the outer panel if it was collapsed.
		if (collapsed && !next) { setCollapsed(false); onOpenChange?.(true) }
	}

	function toggleSyncs(): void {
		const next = !syncsCollapsed
		setSyncsCollapsed(next)
		onSyncsOpenChange?.(!next)
		if (collapsed && !next) { setCollapsed(false); onOpenChange?.(true) }
	}

	return (
		<div className="transfer-panel" style={{ height: (collapsed || (transfersCollapsed && syncsCollapsed)) ? 'auto' : height }}>
			{!collapsed && (
				<div
					className="transfer-resize"
					onMouseDown={() => {
						dragging.current = true
						document.body.style.cursor = 'row-resize'
					}}
				/>
			)}

			{/* ── Overall progress strip — always visible when transfers are active ── */}
			{(active.length > 0 || (allFinished && totalBytes > 0)) && (
				<div className="overall-progress overall-progress-strip">
					<div className="overall-bar-track">
						<div
							className={`overall-bar-fill${isWaitingForServer ? ' finalizing' : ''}`}
							style={isWaitingForServer ? undefined : { width: `${overallPct}%` }}
						/>
					</div>
					<div className="overall-times">
						<span className="ot-label">
							{isWaitingForServer
								? 'Waiting for server…'
								: active.length > 0
									? (() => {
										const transferring = active.filter((t) => t.status === 'transferring')
										const queued = active.filter((t) => t.status === 'queued')
										return [
											transferring.length > 0 && `${transferring.length} uploading`,
											queued.length > 0 && `${queued.length} queued`,
											`${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}`,
											effectiveSpeed > 0 ? formatSpeed(effectiveSpeed) : ''
										].filter(Boolean).join(' · ')
									})()
									: canceledAll
										? '✕ Transfers Cancelled'
										: `✓ Process Complete${summaryParts.length > 0 ? ' · ' + summaryParts.join(' · ') : ''}`
							}
						</span>
						<span className="ot-pct">{isWaitingForServer ? '' : `${overallPct}%`}</span>
						<span className="ot-label">
							{!isWaitingForServer && remaining !== null && remaining > 1
								? `~${formatDuration(remaining * 1000)} left`
								: active.length > 0 ? `Elapsed: ${formatDuration(elapsed)}` : ''}
						</span>
					</div>
				</div>
			)}

			{/* ── Transfers drawer ──────────────────────────────────────────────── */}
			<div className="tp-drawer">
				<div className="tp-drawer-header" onClick={toggleTransfers}>
					<span className="material-symbols-outlined tp-drawer-chevron">
						{transfersCollapsed ? 'chevron_right' : 'expand_more'}
					</span>
					<span className="tp-drawer-label">Transfers</span>
					<div className="tp-drawer-actions" onClick={(e) => e.stopPropagation()}>
						{active.length > 0 && (
							<button
								className="btn ghost"
								onClick={() => {
									void (async () => {
										const ok = await confirmDialog({
											title: 'Cancel all transfers?',
											warning: 'This will stop all active and queued transfers.',
											confirmText: 'Cancel All',
											danger: true
										})
										if (!ok) return
										setCanceledAll(true)
										await window.conduit.transfer.cancelAll()
										const all = await window.conduit.transfer.getAll()
										setTransfers(all)
									})()
								}}
							>
								Cancel all
							</button>
						)}
						{(done.length > 0 || failed.length > 0) && (
							<button className="btn ghost" onClick={() => void clearFinished()}>Clear</button>
						)}
					</div>
				</div>

				{!transfersCollapsed && (
					<div className="tp-drawer-body">
						{isOffline && active.length > 0 && (
							<div className="transfer-offline-banner">
								<span className="transfer-offline-icon">⚠</span>
								<span>Connection lost — transfers paused and will resume when you're reconnected.</span>
							</div>
						)}
						<div className="transfer-list">
							{transfers.length === 0 ? (
								<div className="transfer-empty tp-empty">No active transfers. Drag files between panes to start one.</div>
							) : (
								<>
									{sorted.map((t) => {
										const rowIsWaiting = t.status === 'transferring' && t.bytesTotal > 0 && t.bytesDone >= t.bytesTotal
										const waitElapsed = rowIsWaiting
											? now - (waitingStartRef.current.get(t.id) ?? now)
											: null
										const fallbackSpeed = t.status === 'transferring' && activeFiles.length > 0
											? effectiveSpeed / activeFiles.length
											: 0
										const canReveal = t.status === 'done' && t.kind === 'file'
											&& t.dest.connectionId === BUILTIN_LOCAL_ID
											&& window.conduit.platform === 'darwin'
										return (
											<MemoRow
												key={t.id}
												item={t}
												id={t.id}
												cancelTransfer={cancelTransfer}
												waitElapsed={waitElapsed}
												fallbackSpeed={fallbackSpeed}
												canReveal={canReveal}
											/>
										)
									})}
									{hiddenCount > 0 && (
										<div className="transfer-hidden-count">
											+ {hiddenCount.toLocaleString()} more completed — click Clear to dismiss
										</div>
									)}
								</>
							)}
						</div>
					</div>
				)}
			</div>

			{/* ── Syncs drawer ──────────────────────────────────────────────────── */}
			<div className="tp-drawer tp-drawer-syncs">
				<div className="tp-drawer-header" onClick={toggleSyncs}>
					<span className="material-symbols-outlined tp-drawer-chevron">
						{syncsCollapsed ? 'chevron_right' : 'expand_more'}
					</span>
					<span className="tp-drawer-label">Syncs</span>
					<div className="tp-drawer-actions" onClick={(e) => e.stopPropagation()}>
						{syncRuns.some((r) => r.phase !== 'running') && (
							<button className="btn ghost" onClick={clearFinishedSyncRuns}>Clear</button>
						)}
					</div>
				</div>

				{!syncsCollapsed && (
					<div className="tp-drawer-body">
						{syncRuns.length === 0 ? (
							<div className="transfer-empty tp-empty">No active syncs. Start one from the Sync Tasks panel.</div>
						) : (
							<>
								<div className="sync-run-status-line">
									{(() => {
										const running = syncRuns.filter((r) => r.phase === 'running').length
										const errored = syncRuns.filter((r) => r.phase === 'error').length
										const doneRuns = syncRuns.filter((r) => r.phase === 'done').length
										if (running > 0 && syncRuns.length > 1)
											return `Sync ${doneRuns + errored + 1} of ${syncRuns.length} in progress`
										if (running > 0) return 'Sync in progress'
										if (errored > 0 && doneRuns === 0) return 'Sync failed'
										if (errored > 0) return 'Sync complete (with errors)'
										return 'Sync complete'
									})()}
								</div>
								{syncRuns.map((run) => <SyncRunRow key={run.runId} run={run} now={now} />)}
							</>
						)}
					</div>
				)}
			</div>
		</div>
	)
}

/** Stable-callback wrapper so React.memo on TransferRow actually works.
 *  waitElapsed is null for non-waiting rows (stable → memo skips them) and
 *  a live ms count for waiting rows (updates every 250ms to show elapsed time). */
function MemoRow({ item, id, cancelTransfer, waitElapsed, fallbackSpeed, canReveal }: {
	item: TransferItem
	id: string
	cancelTransfer: (id: string) => void
	waitElapsed: number | null
	fallbackSpeed: number
	canReveal: boolean
}): JSX.Element {
	const onCancel = useCallback(() => cancelTransfer(id), [cancelTransfer, id])
	const onRetry = useCallback(() => void window.conduit.transfer.retry(id), [id])
	const onReveal = useCallback(() => void window.conduit.fs.revealFile(item.dest.path), [item.dest.path])
	return <TransferRow item={item} onCancel={onCancel} onRetry={onRetry} waitElapsed={waitElapsed} fallbackSpeed={fallbackSpeed} canReveal={canReveal} onReveal={onReveal} />
}

const TransferRow = memo(function TransferRow({ item, onCancel, onRetry, waitElapsed, fallbackSpeed, canReveal, onReveal }: {
	item: TransferItem
	onCancel: () => void
	onRetry: () => void
	waitElapsed: number | null
	fallbackSpeed: number
	canReveal: boolean
	onReveal: () => void
}): JSX.Element {
	const pct = item.bytesTotal > 0 ? Math.round((item.bytesDone / item.bytesTotal) * 100) : item.status === 'done' ? 100 : 0
	const isOp = item.kind === 'operation'
	const isWaiting = waitElapsed !== null

	return (
		<div className={`transfer-item${isOp ? ' operation' : ''}`}>
			<span className={`tstatus ${item.status}`}>{statusGlyph(item.status)}</span>
			<span className="tname" title={item.name}>
				{item.name}
			</span>
			{isOp ? (
				<>
					<span className="tmeta">{item.status === 'error' ? (item.error ?? 'Failed') : ''}</span>
					<span className="tmeta" />
				</>
			) : (
				<>
					<span className="tmeta">
						{item.status === 'transferring'
							? isWaiting
								? formatBytes(item.bytesTotal)
								: `${formatBytes(item.bytesDone)} / ${formatBytes(item.bytesTotal)}`
							: item.status === 'error'
								? item.error ?? 'Failed'
								: formatBytes(item.bytesTotal)}
					</span>
					<span className="tmeta">
						{item.status === 'transferring'
							? isWaiting
								? `Waiting for server${waitElapsed >= 1000 ? ` · ${formatDuration(waitElapsed)}` : ''}`
								: formatSpeed(item.speed ?? fallbackSpeed)
							: item.status === 'queued'
								? '—'
								: `${pct}%`}
					</span>
				</>
			)}
			{item.status === 'error' && !isOp && (
				<button className="iconbtn retry-btn" title="Retry" onClick={onRetry}>↺</button>
			)}
			{canReveal && (
				<button className="iconbtn reveal-btn" title="Reveal in Finder" onClick={onReveal}>
					<span className="material-symbols-outlined">folder_open</span>
				</button>
			)}
			<button
				className="iconbtn"
				title="Cancel"
				disabled={item.status !== 'transferring' && item.status !== 'queued'}
				onClick={onCancel}
			>
				✕
			</button>
			{!isOp && (
				<div className={`pbar${isWaiting ? ' finalizing' : ''}`}>
					<span style={isWaiting ? undefined : { width: `${pct}%` }} />
				</div>
			)}
		</div>
	)
})

function statusGlyph(status: TransferItem['status']): string {
	switch (status) {
		case 'done':
			return '✓'
		case 'error':
			return '✕'
		case 'canceled':
			return '⊘'
		case 'transferring':
			return '↻'
		default:
			return '•'
	}
}

function SyncRunRow({ run, now }: { run: SyncRun; now: number }): JSX.Element {
	const pct = run.progress && run.progress.total > 0
		? Math.round((run.progress.current / run.progress.total) * 100)
		: run.phase === 'done' ? 100 : 0

	const elapsed = run.phase === 'running' ? now - run.startedAt : (run.stats?.durationMs ?? 0)

	// Estimate remaining time based on files-per-ms rate once we have progress.
	const remaining: number | null = (() => {
		if (run.phase !== 'running' || !run.progress || run.progress.current < 2) return null
		const rate = run.progress.current / (now - run.startedAt)
		if (rate <= 0) return null
		return (run.progress.total - run.progress.current) / rate
	})()

	function onCancel(): void {
		void window.conduit.sync.cancel(run.taskId)
	}

	return (
		<div className={`transfer-item sync-run-item ${run.phase}`}>
			<span className={`tstatus ${run.phase === 'running' ? 'transferring' : run.phase === 'done' ? 'done' : 'error'}`}>
				{run.phase === 'done' ? '✓' : run.phase === 'error' ? '✕' : '↻'}
			</span>
			<span className="tname" title={run.taskName}>{run.taskName}</span>
			<span className="tmeta">
				{run.phase === 'running'
					? run.progress
						? `${run.progress.current} / ${run.progress.total} files`
						: 'Scanning…'
					: run.phase === 'done'
						? run.stats
							? `${run.stats.copied} copied · ${run.stats.deleted} deleted · ${run.stats.errors > 0 ? `${run.stats.errors} errors` : 'no errors'}`
							: 'Sync complete'
						: run.error ?? 'Sync failed'}
			</span>
			<span className="tmeta">
				{run.phase === 'running'
					? remaining !== null && remaining > 1000
						? `~${formatDuration(remaining)} left`
						: elapsed > 0
							? `${formatDuration(elapsed)} elapsed`
							: `${pct}%`
					: run.phase === 'done'
						? `${formatDuration(elapsed)} · 100%`
						: ''}
			</span>
			<button
				className="iconbtn"
				title="Cancel sync"
				disabled={run.phase !== 'running'}
				onClick={onCancel}
			>
				✕
			</button>
			{!run.stats && run.phase !== 'error' && (
				<div className="pbar">
					<span style={run.phase === 'running' ? { width: `${pct}%` } : { width: '100%' }} />
				</div>
			)}
		</div>
	)
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	const m = Math.floor(s / 60)
	const h = Math.floor(m / 60)
	if (h > 0) return `${h}h ${m % 60}m`
	if (m > 0) return `${m}m ${s % 60}s`
	return `${s}s`
}
