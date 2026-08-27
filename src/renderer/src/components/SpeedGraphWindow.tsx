import { useEffect, useMemo, useRef, useState } from 'react'
import type { TransferItem } from '@shared/types'
import { formatBytes, formatSpeed } from '../lib/format'

type RangeKey = '1m' | '5m' | '15m'

const RANGES: { key: RangeKey; label: string; seconds: number }[] = [
	{ key: '1m', label: '1 min', seconds: 60 },
	{ key: '5m', label: '5 min', seconds: 300 },
	{ key: '15m', label: '15 min', seconds: 900 }
]

const HISTORY_MAX_SECONDS = RANGES[RANGES.length - 1].seconds

/** Standalone pop-out window (a second BrowserWindow, see main/index.ts
 *  openSpeedGraphWindow): a detailed, resizable live throughput graph, kept
 *  intentionally independent of the main app's zustand store — it only needs
 *  the transfer feed, not panes/connections/bookmarks. */
export function SpeedGraphWindow(): JSX.Element {
	const [transfers, setTransfers] = useState<TransferItem[]>([])
	const transfersRef = useRef<TransferItem[]>([])
	transfersRef.current = transfers

	const [history, setHistory] = useState<Array<{ t: number; speed: number }>>([])
	const [range, setRange] = useState<RangeKey>('1m')

	useEffect(() => {
		document.title = 'Conduit — Transfer Speed'
		const theme =
			typeof localStorage !== 'undefined' && localStorage.getItem('conduit.theme') === 'light' ? 'light' : 'dark'
		document.documentElement.setAttribute('data-theme', theme)
	}, [])

	useEffect(() => {
		void window.conduit.transfer.getAll().then(setTransfers)
		const offUpdate = window.conduit.transfer.onUpdate((items) => {
			setTransfers((prev) => {
				const map = new Map(items.map((i) => [i.id, i]))
				return prev.map((t) => map.get(t.id) ?? t)
			})
		})
		const offAdded = window.conduit.transfer.onAdded((items) => {
			setTransfers((prev) => [...prev, ...items])
		})
		return () => {
			offUpdate()
			offAdded()
		}
	}, [])

	// Sample aggregate throughput once per second — plenty of resolution given
	// each item's own `speed` is already a 5s rolling average from the engine.
	useEffect(() => {
		const id = setInterval(() => {
			const active = transfersRef.current.filter((t) => t.status === 'transferring' && t.kind !== 'operation')
			const speed = active.reduce((s, t) => s + (t.speed ?? 0), 0)
			const now = Date.now()
			setHistory((prev) => {
				const next = [...prev, { t: now, speed }]
				const cutoff = now - HISTORY_MAX_SECONDS * 1000
				let start = 0
				while (start < next.length - 1 && next[start].t < cutoff) start++
				return start > 0 ? next.slice(start) : next
			})
		}, 1000)
		return () => clearInterval(id)
	}, [])

	const activeFiles = useMemo(
		() => transfers.filter((t) => t.status === 'transferring' && t.kind !== 'operation'),
		[transfers]
	)
	const currentSpeed = activeFiles.reduce((s, t) => s + (t.speed ?? 0), 0)

	const rangeSeconds = RANGES.find((r) => r.key === range)!.seconds
	const cutoff = Date.now() - rangeSeconds * 1000
	const visibleHistory = useMemo(() => history.filter((p) => p.t >= cutoff), [history, cutoff])

	return (
		<div className="speedgraph-window">
			<div className="speedgraph-header">
				<div className="speedgraph-current">
					<span className="speedgraph-current-value">{currentSpeed > 0 ? formatSpeed(currentSpeed) : '—'}</span>
					<span className="speedgraph-current-label">
						{activeFiles.length > 0
							? `${activeFiles.length} file${activeFiles.length !== 1 ? 's' : ''} transferring`
							: 'Idle'}
					</span>
				</div>
				<div className="speedgraph-ranges">
					{RANGES.map((r) => (
						<button
							key={r.key}
							className={`speedgraph-range-btn${range === r.key ? ' active' : ''}`}
							onClick={() => setRange(r.key)}
						>
							{r.label}
						</button>
					))}
				</div>
			</div>

			<div className="speedgraph-body">
				<SpeedChart points={visibleHistory} rangeSeconds={rangeSeconds} />
				{activeFiles.length > 0 && (
					<div className="speedgraph-filelist">
						<div className="speedgraph-filelist-title">Active Transfers</div>
						{activeFiles
							.slice()
							.sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0))
							.map((t) => (
								<div key={t.id} className="speedgraph-file-row">
									<span className="speedgraph-file-name" title={t.name}>{t.name}</span>
									<span className="speedgraph-file-speed">{formatSpeed(t.speed)}</span>
								</div>
							))}
					</div>
				)}
			</div>
		</div>
	)
}

const CHART_PADDING = { top: 16, right: 16, bottom: 26, left: 60 }

function SpeedChart({ points, rangeSeconds }: { points: Array<{ t: number; speed: number }>; rangeSeconds: number }): JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null)
	const [size, setSize] = useState({ width: 480, height: 260 })

	useEffect(() => {
		const el = containerRef.current
		if (!el) return
		const ro = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (!entry) return
			const { width, height } = entry.contentRect
			setSize({ width: Math.max(200, width), height: Math.max(120, height) })
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	const plotW = Math.max(10, size.width - CHART_PADDING.left - CHART_PADDING.right)
	const plotH = Math.max(10, size.height - CHART_PADDING.top - CHART_PADDING.bottom)

	const maxSpeed = Math.max(...points.map((p) => p.speed), 1_000_000) * 1.2
	const now = Date.now()
	const startT = now - rangeSeconds * 1000

	const xFor = (t: number): number => CHART_PADDING.left + ((t - startT) / (rangeSeconds * 1000)) * plotW
	const yFor = (speed: number): number => CHART_PADDING.top + plotH - (speed / maxSpeed) * plotH
	const baseline = CHART_PADDING.top + plotH

	const coords = points.map((p): [number, number] => [xFor(p.t), yFor(p.speed)])
	const linePath = coords.length > 1 ? catmullRomPath(coords) : ''
	const areaPath = linePath
		? `${linePath} L${coords[coords.length - 1][0].toFixed(2)},${baseline.toFixed(2)} L${coords[0][0].toFixed(2)},${baseline.toFixed(2)} Z`
		: ''

	const Y_TICKS = 4
	const yTickValues = Array.from({ length: Y_TICKS + 1 }, (_, i) => (maxSpeed / Y_TICKS) * i)
	const X_TICKS = 4
	const xTickValues = Array.from({ length: X_TICKS + 1 }, (_, i) => startT + ((rangeSeconds * 1000) / X_TICKS) * i)

	return (
		<div className="speedgraph-chart" ref={containerRef}>
			<svg width={size.width} height={size.height}>
				{yTickValues.map((v, i) => {
					const y = yFor(v)
					return (
						<g key={i}>
							<line x1={CHART_PADDING.left} x2={size.width - CHART_PADDING.right} y1={y} y2={y} className="speedgraph-gridline" />
							<text x={CHART_PADDING.left - 8} y={y} className="speedgraph-axis-label" textAnchor="end" dominantBaseline="middle">
								{formatBytes(v)}/s
							</text>
						</g>
					)
				})}
				{xTickValues.map((t, i) => (
					<text
						key={i}
						x={xFor(t)}
						y={size.height - CHART_PADDING.bottom + 18}
						className="speedgraph-axis-label"
						textAnchor={i === 0 ? 'start' : i === X_TICKS ? 'end' : 'middle'}
					>
						{i === X_TICKS ? 'now' : `-${Math.round((rangeSeconds / X_TICKS) * (X_TICKS - i))}s`}
					</text>
				))}
				<line x1={CHART_PADDING.left} x2={CHART_PADDING.left} y1={CHART_PADDING.top} y2={baseline} className="speedgraph-axis-line" />
				<line x1={CHART_PADDING.left} x2={size.width - CHART_PADDING.right} y1={baseline} y2={baseline} className="speedgraph-axis-line" />
				{areaPath && <path d={areaPath} className="speedgraph-area" />}
				{linePath && <path d={linePath} className="speedgraph-line" />}
			</svg>
			{points.length < 2 && <div className="speedgraph-empty">No transfer activity yet</div>}
		</div>
	)
}

/** Catmull-Rom → cubic Bezier smoothing so the throughput curve reads as a
 *  fluid line through the sampled points rather than a jagged polyline. */
function catmullRomPath(points: Array<[number, number]>): string {
	if (points.length < 2) return ''
	let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i - 1] ?? points[i]
		const p1 = points[i]
		const p2 = points[i + 1]
		const p3 = points[i + 2] ?? p2
		const c1x = p1[0] + (p2[0] - p0[0]) / 6
		const c1y = p1[1] + (p2[1] - p0[1]) / 6
		const c2x = p2[0] - (p3[0] - p1[0]) / 6
		const c2y = p2[1] - (p3[1] - p1[1]) / 6
		d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
	}
	return d
}
