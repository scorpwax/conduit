import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TransferItem } from '@shared/types'
import { useStore } from '../store'
import { formatBytes, formatSpeed } from '../lib/format'
import { confirmDialog } from '../lib/dialog'

export function TransferPanel({ open, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void }): JSX.Element {
	const transfers = useStore((s) => s.transfers)
	const setTransfers = useStore((s) => s.setTransfers)
	const clearFinished = useStore((s) => s.clearFinishedTransfers)
	const cancelTransfer = useStore((s) => s.cancelTransfer)

	const [collapsed, setCollapsed] = useState(() => !(open ?? false))
	const [isOffline, setIsOffline] = useState(() => !navigator.onLine)
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
	const [height, setHeight] = useState(190)
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
			setHeight(Math.max(120, Math.min(h, window.innerHeight - 200)))
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
		active, done, failed, canceled, allFinished, allCanceled,
		totalBytes, doneBytes, aggSpeed,
		earliestStart, activeFiles,
		sorted, hiddenCount
	} = useMemo(() => {
		const MAX_FINISHED = 100
		const active = transfers.filter((t) => t.status === 'transferring' || t.status === 'queued')
		const done = transfers.filter((t) => t.status === 'done')
		const failed = transfers.filter((t) => t.status === 'error')
		const canceled = transfers.filter((t) => t.status === 'canceled')
		const allFinished = transfers.length > 0 && active.length === 0
		const allCanceled = allFinished && done.length === 0 && failed.length === 0 && canceled.length > 0

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

		return { active, done, failed, canceled, allFinished, allCanceled, totalBytes, doneBytes, aggSpeed, earliestStart, activeFiles, sorted, hiddenCount }
	}, [transfers])

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

	return (
		<div className="transfer-panel" style={{ height: collapsed ? 'auto' : height }}>
			{!collapsed && (
				<div
					className={`transfer-resize ${dragging.current ? 'dragging' : ''}`}
					onMouseDown={() => {
						dragging.current = true
						document.body.style.cursor = 'row-resize'
					}}
				/>
			)}
			<div className="transfer-header">
				{/* Left toggle zone — clicking this collapses/expands the panel */}
				<div className="transfer-header-toggle" onClick={() => { setCollapsed((v) => { onOpenChange?.(v); return !v }) }}>
					<span style={{ color: 'var(--text-faint)' }}>{collapsed ? '▸' : '▾'}</span>
					<span className="title">Transfers</span>
					<span className="count">
						{active.length > 0
							? (() => {
								const transferring = active.filter((t) => t.status === 'transferring')
								const queued = active.filter((t) => t.status === 'queued')
								if (isWaitingForServer) {
									return `${transferring.length} file${transferring.length !== 1 ? 's' : ''} · ${formatBytes(totalBytes)} · Waiting for server…`
								}
								return [
									transferring.length > 0 && `${transferring.length} uploading`,
									queued.length > 0 && `${queued.length} queued`,
									`${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}`,
									aggSpeed ? formatSpeed(aggSpeed) : ''
								].filter(Boolean).join(' · ')
							})()
							: allCanceled
								? <span className="transfers-cancelled">✕ Transfers Cancelled</span>
								: allFinished
								? <span className="transfers-complete">
									✓ Transfers Complete · {done.length} completed{failed.length > 0 ? <span className="transfers-failed"> · {failed.length} failed</span> : ''}
								</span>
								: transfers.length === 0
									? 'No Transfers'
									: `${done.length} done${failed.length ? ` · ${failed.length} failed` : ''}${canceled.length ? ` · ${canceled.length} cancelled` : ''}`}
					</span>
				</div>
				{/* Right action buttons — isolated from the toggle zone */}
				<div className="transfer-header-actions">
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
						<button
							className="btn ghost"
							onClick={() => void clearFinished()}
						>
							Clear
						</button>
					)}
				</div>
			</div>

			{(active.length > 0 || (allFinished && totalBytes > 0)) && (
				<div className="overall-progress">
					<div className="overall-bar-track">
						<div
							className={`overall-bar-fill${isWaitingForServer ? ' finalizing' : ''}`}
							style={isWaitingForServer ? undefined : { width: `${overallPct}%` }}
						/>
					</div>
					<div className="overall-times">
						<span className="ot-label">Elapsed: {formatDuration(elapsed)}</span>
						<span className="ot-pct">
							{isWaitingForServer ? 'Waiting for server…' : `${overallPct}%`}
						</span>
						<span className="ot-label">
							{!isWaitingForServer && remaining !== null && remaining > 1
								? `~${formatDuration(remaining * 1000)} left`
								: ''}
						</span>
					</div>
				</div>
			)}

			{!collapsed && isOffline && active.length > 0 && (
				<div className="transfer-offline-banner">
					<span className="transfer-offline-icon">⚠</span>
					<span>Connection lost — transfers paused and will resume when you're reconnected.</span>
				</div>
			)}

			{!collapsed && (
				<div className="transfer-list">
					{transfers.length === 0 ? (
						<div className="transfer-empty">
							Drag files between panes to start a transfer. Progress shows here.
						</div>
					) : (
						<>
							{sorted.map((t) => {
								// Only pass a live elapsed value to rows that are waiting for the server.
								// Non-waiting rows receive null — React.memo sees null===null and skips
								// re-rendering those rows on every 250ms tick.
								const rowIsWaiting = t.status === 'transferring' && t.bytesTotal > 0 && t.bytesDone >= t.bytesTotal
								const waitElapsed = rowIsWaiting
									? now - (waitingStartRef.current.get(t.id) ?? now)
									: null
								return (
									<MemoRow
										key={t.id}
										item={t}
										id={t.id}
										cancelTransfer={cancelTransfer}
										waitElapsed={waitElapsed}
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
			)}
		</div>
	)
}

/** Stable-callback wrapper so React.memo on TransferRow actually works.
 *  waitElapsed is null for non-waiting rows (stable → memo skips them) and
 *  a live ms count for waiting rows (updates every 250ms to show elapsed time). */
function MemoRow({ item, id, cancelTransfer, waitElapsed }: {
	item: TransferItem
	id: string
	cancelTransfer: (id: string) => void
	waitElapsed: number | null
}): JSX.Element {
	const onCancel = useCallback(() => cancelTransfer(id), [cancelTransfer, id])
	return <TransferRow item={item} onCancel={onCancel} waitElapsed={waitElapsed} />
}

const TransferRow = memo(function TransferRow({ item, onCancel, waitElapsed }: {
	item: TransferItem
	onCancel: () => void
	waitElapsed: number | null
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
								: formatSpeed(item.speed)
							: item.status === 'queued'
								? '—'
								: `${pct}%`}
					</span>
				</>
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

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	const m = Math.floor(s / 60)
	const h = Math.floor(m / 60)
	if (h > 0) return `${h}h ${m % 60}m`
	if (m > 0) return `${m}m ${s % 60}s`
	return `${s}s`
}
