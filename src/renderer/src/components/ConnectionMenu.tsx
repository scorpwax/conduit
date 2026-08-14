import { useEffect, useRef, useState, useCallback } from 'react'
import type { Connection } from '@shared/types'
import { BUILTIN_LOCAL_ID } from '@shared/builtin'
import { useStore } from '../store'
import { confirmDialog } from '../lib/dialog'
import { ContextMenu } from './ContextMenu'
import { ConnIcon } from '../lib/connMeta'

interface Props {
	paneId: string
	onClose: () => void
	onAddNew: () => void
	onEdit: (conn: Connection) => void
	onImport: (conn: Connection) => void
}

export function ConnectionMenu({ paneId, onClose, onAddNew, onEdit, onImport }: Props): JSX.Element {
	const ref = useRef<HTMLDivElement>(null)
	const connections = useStore((s) => s.connections)
	const panes = useStore((s) => s.panes)
	const backgroundConnectionIds = useStore((s) => s.backgroundConnectionIds)
	const setPaneConnection = useStore((s) => s.setPaneConnection)
	const openLocation = useStore((s) => s.openLocation)
	const toggleFavorite = useStore((s) => s.toggleFavorite)
	const deleteConnection = useStore((s) => s.deleteConnection)
	const openInNewPane = useStore((s) => s.openInNewPane)
	const addBookmark = useStore((s) => s.addBookmark)

	const [ctx, setCtx] = useState<{ x: number; y: number; connectionId: string; path: string; name: string } | null>(null)
	const [coffeeOpen, setCoffeeOpen] = useState(false)

	useEffect(() => {
		function onDoc(e: MouseEvent): void {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose()
		}
		document.addEventListener('mousedown', onDoc)
		return () => document.removeEventListener('mousedown', onDoc)
	}, [onClose])

	// Derive per-connection status from pane states.
	function connStatus(id: string): 'connected' | 'loading' | 'error' | 'background' | null {
		const activePanes = panes.filter((p) => p.connectionId === id)
		if (activePanes.length > 0) {
			if (activePanes.some((p) => p.error)) return 'error'
			if (activePanes.some((p) => p.loading)) return 'loading'
			return 'connected'
		}
		if (backgroundConnectionIds.includes(id)) return 'background'
		return null
	}

	const byName = (a: Connection, b: Connection): number => a.name.localeCompare(b.name)
	const favorites = connections.filter((c) => c.favorite).sort(byName)
	const others = connections.filter((c) => !c.favorite).sort(byName)

	function pickConnection(id: string): void {
		void setPaneConnection(paneId, id)
		onClose()
	}

	function openCtx(e: React.MouseEvent, connectionId: string, path: string, name: string): void {
		e.preventDefault()
		e.stopPropagation()
		setCtx({ x: e.clientX, y: e.clientY, connectionId, path, name })
	}

	async function handleImport(): Promise<void> {
		const conn = await window.conduit.connections.importProfile()
		if (!conn) return
		onClose()
		onImport(conn)
	}

	return (
		<div className="menu" ref={ref} style={{ top: 46, left: 0 }}>
			<div className="menu-item accent" onClick={onAddNew}>
				<div className="conn-icon" style={{ background: 'var(--accent)' }}>
					＋
				</div>
				<div className="mi-title">
					<div className="name">New Connection…</div>
					<div className="sub">Local, S3, SFTP, SMB, and more</div>
				</div>
			</div>

			{favorites.length > 0 && (
				<>
					<div className="menu-sep" />
					<div className="menu-label">Favorites</div>
					{favorites.map((c) => (
						<ConnRow
							key={c.id}
							conn={c}
							status={connStatus(c.id)}
							onPick={pickConnection}
							onEdit={onEdit}
							onToggleFav={toggleFavorite}
							onDelete={deleteConnection}
							onContext={(e) => openCtx(e, c.id, '', c.name)}
						/>
					))}
				</>
			)}

			{others.length > 0 && (
				<>
					<div className="menu-sep" />
					<div className="menu-label">Connections</div>
					{favorites.length === 0 && <div className="menu-label">Active Connections</div>}
					{others.map((c) => (
						<ConnRow
							key={c.id}
							conn={c}
							status={connStatus(c.id)}
							onPick={pickConnection}
							onEdit={onEdit}
							onToggleFav={toggleFavorite}
							onDelete={deleteConnection}
							onContext={(e) => openCtx(e, c.id, '', c.name)}
						/>
					))}
				</>
			)}

			<div className="menu-sep" />
			<div
				className="menu-item"
				onClick={() => { void handleImport() }}
				style={{ color: 'var(--text-faint)' }}
			>
				<div className="conn-icon" style={{ background: 'var(--bg-elev-2)', fontSize: 13 }}><span className="material-symbols-outlined">upload</span></div>
				<div className="mi-title">
					<div className="name">Import Connection…</div>
					<div className="sub">Open a .conduit profile file</div>
				</div>
			</div>

			<div className="menu-sep" />
			<div className="menu-item coffee-menu-item" onClick={() => { setCoffeeOpen(true) }}>
				<div className="conn-icon" style={{ background: '#4a2c0a', fontSize: 18 }}>☕</div>
				<div className="mi-title">
					<div className="name">Coffee Maker</div>
					<div className="sub">brewing… please wait</div>
				</div>
			</div>

			{coffeeOpen && <CoffeeMakerModal onClose={() => setCoffeeOpen(false)} />}

			{ctx && (
				<ContextMenu
					x={ctx.x}
					y={ctx.y}
					onClose={() => setCtx(null)}
					items={[
						{
							label: 'Open in New Pane',
							onClick: () => {
								void openInNewPane(ctx.connectionId, ctx.path)
								onClose()
							}
						},
						{
							label: 'Add to Favorites',
							onClick: () => void addBookmark(ctx.name, ctx.connectionId, ctx.path)
						},
						...(isLocalBacked(ctx.connectionId, connections) && window.conduit.platform === 'darwin'
							? [
								{
									label: 'Reveal in Finder',
									onClick: async () => {
										const r = await window.conduit.connections.revealMount(ctx.connectionId)
										if (!r.ok) alert(`Could not reveal mount:\n${r.message}`)
									}
								},
								{
									label: 'Mount to Desktop',
									onClick: async () => {
										const r = await window.conduit.connections.createDesktopShortcut(ctx.connectionId)
										if (!r.ok) alert(`Could not mount to Desktop:\n${r.message}`)
									}
								}
							]
							: []),
						...(ctx.connectionId !== BUILTIN_LOCAL_ID
							? [
								{
									label: 'Export Profile…',
									onClick: () => void window.conduit.connections.exportProfile(ctx.connectionId)
								}
							]
							: [])
					]}
				/>
			)}
		</div>
	)
}

type ConnStatusType = 'connected' | 'loading' | 'error' | 'background' | null

function ConnRow({
	conn,
	status,
	onPick,
	onEdit,
	onToggleFav,
	onDelete,
	onContext
}: {
	conn: Connection
	status: ConnStatusType
	onPick: (id: string) => void
	onEdit: (c: Connection) => void
	onToggleFav: (id: string) => void
	onDelete: (id: string) => void
	onContext: (e: React.MouseEvent) => void
}): JSX.Element {
	return (
		<div className="menu-item" onClick={() => onPick(conn.id)} onContextMenu={onContext}>
			<ConnIcon type={conn.type} />
			<div className="mi-title">
				<div className="name">
					{status && <span className={`conn-menu-dot ${status}`} title={statusLabel(status)} />}
					{conn.name}
				</div>
				<div className="sub">{describe(conn)}</div>
			</div>
			<span
				className={`star ${conn.favorite ? 'on' : ''}`}
				title={conn.favorite ? 'Unfavorite' : 'Favorite'}
				onClick={(e) => {
					e.stopPropagation()
					onToggleFav(conn.id)
				}}
			>
				{conn.favorite ? '★' : '☆'}
			</span>
			<span
				className="star"
				title="Export profile"
				onClick={(e) => {
					e.stopPropagation()
					void window.conduit.connections.exportProfile(conn.id)
				}}
			>
				<span className="material-symbols-outlined">arrow_downward</span>
			</span>
			<span
				className="star"
				title="Edit"
				onClick={(e) => {
					e.stopPropagation()
					onEdit(conn)
				}}
			>
				<span className="material-symbols-outlined">edit</span>
			</span>
			<span
				className="star"
				title="Delete"
				onClick={async (e) => {
					e.stopPropagation()
					const ok = await confirmDialog({
						title: `Delete connection "${conn.name}"?`,
						warning: 'This removes the saved connection and its favorites.',
						confirmText: 'Delete',
						danger: true
					})
					if (ok) onDelete(conn.id)
				}}
			>
				<span className="material-symbols-outlined">delete</span>
			</span>
		</div>
	)
}

function statusLabel(status: ConnStatusType): string {
	switch (status) {
		case 'connected': return 'Connected (in a pane)'
		case 'loading': return 'Connecting…'
		case 'error': return 'Connection error'
		case 'background': return 'Connected in background'
		default: return ''
	}
}

function describe(conn: Connection): string {
	if (conn.type === 's3') {
		const cfg = conn.config as { bucket?: string; region?: string }
		return `S3 · ${cfg.bucket ?? ''}${cfg.region ? ' · ' + cfg.region : ''}`
	}
	if (conn.type === 'wasabi') {
		const cfg = conn.config as { bucket?: string; region?: string }
		return `Wasabi · ${cfg.bucket ?? ''}${cfg.region ? ' · ' + cfg.region : ''}`
	}
	if (conn.type === 'local') {
		const cfg = conn.config as { rootPath?: string }
		return cfg.rootPath ?? 'Home folder'
	}
	if (conn.type === 'sftp') {
		const cfg = conn.config as { host?: string; username?: string }
		return `SFTP · ${cfg.username ?? ''}@${cfg.host ?? ''}`
	}
	if (conn.type === 'smb') {
		const cfg = conn.config as { host?: string; share?: string }
		return `SMB · \\\\${cfg.host ?? ''}\\${cfg.share ?? ''}`
	}
	if (conn.type === 'ftp') {
		const cfg = conn.config as { host?: string; username?: string }
		return `FTP · ${cfg.username ?? ''}@${cfg.host ?? ''}`
	}
	if (conn.type === 'webdav') {
		const cfg = conn.config as { url?: string }
		return `WebDAV · ${cfg.url ?? ''}`
	}
	if (conn.type === 'gdrive') return 'Google Drive'
	if (conn.type === 'onedrive') return 'OneDrive'
	if (conn.type === 'dropbox') return 'Dropbox'
	return ''
}


function isLocalBacked(connectionId: string, connections: Connection[]): boolean {
	if (connectionId === BUILTIN_LOCAL_ID) return true
	const conn = connections.find((c) => c.id === connectionId)
	return (
		conn?.type === 'local' ||
		conn?.type === 'smb' ||
		conn?.type === 's3' ||
		conn?.type === 'wasabi'
	)
}

// ── Coffee Maker easter egg ───────────────────────────────────────────────────

function CoffeeMakerModal({ onClose }: { onClose: () => void }): JSX.Element {
	const [phase, setPhase] = useState<'brewing' | 'ready'>('brewing')
	const [dots, setDots] = useState('')

	useEffect(() => {
		const dotInterval = setInterval(() => setDots((d) => d.length >= 3 ? '' : d + '.'), 400)
		const brewTimer = setTimeout(() => { setPhase('ready'); clearInterval(dotInterval) }, 3000)
		return () => { clearInterval(dotInterval); clearTimeout(brewTimer) }
	}, [])

	return (
		<div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal coffee-modal" onMouseDown={(e) => e.stopPropagation()}>
				{phase === 'brewing' ? (
					<div className="coffee-brewing">
						<div className="coffee-cup-wrap">
							<div className="coffee-steam">
								<span>〰</span><span>〰</span><span>〰</span>
							</div>
							<div className="coffee-cup">☕</div>
						</div>
						<div className="coffee-status">Connecting to Coffee Maker{dots}</div>
						<div className="coffee-substatus">Authenticating beans · Checking grind level · Heating water</div>
					</div>
				) : (
					<div className="coffee-ready">
						<div className="coffee-cup-big">☕</div>
						<div className="coffee-headline">Connection Successful!</div>
						<div className="coffee-message">
							Your coffee is ready.<br />
							<strong>Now get back to work.</strong>
						</div>
						<div className="coffee-specs">
							<span className="coffee-spec">Protocol: <code>HTTP/Brew</code></span>
							<span className="coffee-spec">Latency: <code>3,000ms (grinding)</code></span>
							<span className="coffee-spec">Throughput: <code>1 cup/session</code></span>
							<span className="coffee-spec">Encryption: <code>Steamed (TLS 1.3)</code></span>
						</div>
						<button className="btn primary" onClick={onClose} style={{ marginTop: 20 }}>
							Drink Coffee ☕
						</button>
					</div>
				)}
			</div>
		</div>
	)
}
