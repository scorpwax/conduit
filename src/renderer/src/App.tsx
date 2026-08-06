import { Fragment, useEffect, useRef, useState } from 'react'
import type { Connection, UpdateInfo } from '@shared/types'
import { useStore } from './store'
import { Pane } from './components/Pane'
import { TransferPanel } from './components/TransferPanel'
import { ConnectionModal } from './components/ConnectionModal'
import { ConflictModal } from './components/ConflictModal'
import { LogsPanel } from './components/LogsPanel'
import { DialogHost } from './components/DialogHost'
import { Logo } from './components/Logo'
import { SyncPanel } from './components/SyncPanel'
import { SettingsModal } from './components/SettingsModal'

export default function App(): JSX.Element {
	const init = useStore((s) => s.init)
	const panes = useStore((s) => s.panes)
	const addPane = useStore((s) => s.addPane)
	const showHidden = useStore((s) => s.showHidden)
	const toggleShowHidden = useStore((s) => s.toggleShowHidden)
	const fontScale = useStore((s) => s.fontScale)
	const adjustFontScale = useStore((s) => s.adjustFontScale)
	const theme = useStore((s) => s.theme)
	const toggleTheme = useStore((s) => s.toggleTheme)
	const transfers = useStore((s) => s.transfers)

	const [modal, setModal] = useState<{
		existing: Connection | null
		importDefaults?: Connection
		paneId: string | null
	} | null>(null)
	const [logsOpen, setLogsOpen] = useState(false)
	const [syncOpen, setSyncOpen] = useState(false)
	const [settingsOpen, setSettingsOpen] = useState(false)
	const [version, setVersion] = useState('')
	const [transferPanelOpen, setTransferPanelOpen] = useState(false)
	const [downloadDir, setDownloadDir] = useState<string>('')
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)

	useEffect(() => {
		void window.conduit.app.getVersion().then(setVersion)
		void window.conduit.settings.get().then((s) => setDownloadDir(s.downloadDir ?? ''))
		const off = window.conduit.app.onUpdateAvailable(setUpdateInfo)
		return off
	}, [])

	async function pickDownloadDir(): Promise<void> {
		const dir = await window.conduit.dialog.pickFolder()
		if (!dir) return
		setDownloadDir(dir)
		await window.conduit.settings.set({ downloadDir: dir })
	}

	// Restore saved UI state on first load.
	useEffect(() => {
		void (async () => {
			const state = await window.conduit.app.getUiState()
			if (state) {
				if (state.transferPanelOpen) setTransferPanelOpen(true)
				if (state.panes && state.panes.length > 1) {
					// Re-add extra panes (store starts with 2 by default, so this handles 3+)
					const store = useStore.getState()
					while (store.panes.length < state.panes.length) {
						store.addPane()
					}
				}
			}
			void init()
		})()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Save UI state whenever pane count or transfer panel open/closed changes.
	// Reactive save is reliable; beforeunload is not (async IPC can't complete before renderer dies).
	useEffect(() => {
		void window.conduit.app.saveUiState({
			transferPanelOpen,
			panes: panes.map((p) => ({ connectionId: p.connectionId, path: p.path }))
		})
	}, [panes.length, transferPanelOpen]) // eslint-disable-line react-hooks/exhaustive-deps

	// Fire a macOS notification when a transfer batch finishes.
	const prevAllFinishedRef = useRef(false)
	useEffect(() => {
		const active = transfers.filter((t) => t.status === 'transferring' || t.status === 'queued')
		const allFinished = transfers.length > 0 && active.length === 0
		if (allFinished && !prevAllFinishedRef.current) {
			const done = transfers.filter((t) => t.status === 'done').length
			const failed = transfers.filter((t) => t.status === 'error').length
			const body = [
				done > 0 && `${done} completed`,
				failed > 0 && `${failed} failed`
			].filter(Boolean).join(', ')
			void window.conduit.app.notify({ title: 'Conduit — Transfers Complete', body: body || 'Done' })
		}
		prevAllFinishedRef.current = allFinished

		// Auto-clear / auto-quit when all transfers finish.
		if (allFinished) {
			void window.conduit.settings.get().then((s) => {
				if (s.clearTransfersAfterComplete) void window.conduit.transfer.clearFinished()
				if (s.quitAfterTransfer) window.close()
			})
		}
	}, [transfers])

	// Apply the file-list font scale globally.
	useEffect(() => {
		document.documentElement.style.setProperty('--fl-scale', String(fontScale))
	}, [fontScale])

	// Apply theme on mount and whenever it changes.
	useEffect(() => {
		document.documentElement.setAttribute('data-theme', theme)
	}, [theme])

	// ⌘+ / ⌘- adjust font size (⌘0 resets).
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (!(e.metaKey || e.ctrlKey)) return
			if (e.key === '=' || e.key === '+') {
				e.preventDefault()
				adjustFontScale(0.1)
			} else if (e.key === '-') {
				e.preventDefault()
				adjustFontScale(-0.1)
			} else if (e.key === '0') {
				e.preventDefault()
				adjustFontScale(1 - useStore.getState().fontScale)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [adjustFontScale])

	// Pane widths are keyed by pane id so reordering keeps each pane's width.
	const [grows, setGrows] = useState<Record<string, number>>({})
	const containerRef = useRef<HTMLDivElement>(null)
	const dragInfo = useRef<{ leftId: string; rightId: string; startX: number; startGrows: Record<string, number> } | null>(
		null
	)

	// Ensure every pane has a width entry (new panes default to 1).
	useEffect(() => {
		setGrows((prev) => {
			const next = { ...prev }
			let changed = false
			for (const p of panes) {
				if (next[p.id] === undefined) {
					next[p.id] = 1
					changed = true
				}
			}
			return changed ? next : prev
		})
	}, [panes])


	function onDividerDown(leftId: string, rightId: string, e: React.MouseEvent): void {
		dragInfo.current = { leftId, rightId, startX: e.clientX, startGrows: { ...grows } }
		document.body.style.cursor = 'col-resize'
	}

	useEffect(() => {
		function onMove(e: MouseEvent): void {
			const info = dragInfo.current
			const container = containerRef.current
			if (!info || !container) return
			const width = container.getBoundingClientRect().width
			const dx = e.clientX - info.startX
			const leftStart = info.startGrows[info.leftId] ?? 1
			const rightStart = info.startGrows[info.rightId] ?? 1
			const delta = (dx / width) * (leftStart + rightStart)
			setGrows((prev) => ({
				...prev,
				[info.leftId]: Math.max(0.25, leftStart + delta),
				[info.rightId]: Math.max(0.25, rightStart - delta)
			}))
		}
		function onUp(): void {
			dragInfo.current = null
			document.body.style.cursor = ''
		}
		window.addEventListener('mousemove', onMove)
		window.addEventListener('mouseup', onUp)
		return () => {
			window.removeEventListener('mousemove', onMove)
			window.removeEventListener('mouseup', onUp)
		}
	}, [])

	return (
		<div className="app">
			<div className="titlebar">
				{window.conduit.platform === 'darwin' && <div className="titlebar-mac-pad" />}
				<div className="brand">
					<Logo size={26} />
					<div className="brand-text">
						<span className="brand-name">Conduit</span>
						{version && <span className="brand-version">v{version}</span>}
					</div>
				</div>
				<div className="spacer" />
				{downloadDir && (
					<button
						className="btn ghost toolbtn download-folder"
						title={`Download folder: ${downloadDir}`}
						onClick={() => setSettingsOpen(true)}
					>
						<span className="material-symbols-outlined">folder</span>
						{downloadDir.split('/').pop() || downloadDir.split('\\').pop() || 'Downloads'}
					</button>
				)}
				<div className="font-controls" title="Font size (⌘+ / ⌘-)">
					<button className="iconbtn" onClick={() => adjustFontScale(-0.1)} title="Smaller text">
						A−
					</button>
					<button className="iconbtn" onClick={() => adjustFontScale(0.1)} title="Larger text">
						A+
					</button>
				</div>
				<button className="btn ghost toolbtn" title="Sync Tasks" onClick={() => setSyncOpen(true)}>
					<span className="material-symbols-outlined">sync</span> Sync
				</button>
				<button className="btn ghost toolbtn" title="Activity log" onClick={() => setLogsOpen(true)}>
					<span className="material-symbols-outlined">article</span> Logs
				</button>
				<button className="btn ghost toolbtn" title="Settings" onClick={() => setSettingsOpen(true)}>
					<span className="material-symbols-outlined">settings</span> Settings
				</button>
				<button
					className="btn ghost toolbtn add-pane"
					title={panes.length >= 5 ? 'Maximum of 5 panes' : 'Add another pane'}
					onClick={addPane}
					disabled={panes.length >= 5}
				>
					<span className="material-symbols-outlined">add</span> Add Pane
				</button>
			</div>

			{updateInfo && (
				<div className="update-banner">
					<span className="material-symbols-outlined update-banner-icon">system_update_alt</span>
					<span className="update-banner-text">
						Conduit v{updateInfo.version} is available
					</span>
					<button
						className="btn update-banner-download"
						onClick={() => void window.conduit.app.openExternal(updateInfo.downloadUrl)}
					>
						Download
					</button>
					<button
						className="iconbtn update-banner-dismiss"
						title="Dismiss"
						onClick={() => setUpdateInfo(null)}
					>
						✕
					</button>
				</div>
			)}

			<div className="workspace">
				<div className="panes" ref={containerRef}>
					{panes.map((pane, i) => (
						<Fragment key={pane.id}>
							<div className="pane-wrap" style={{ flex: `${grows[pane.id] ?? 1} 1 0` }}>
								<Pane
									pane={pane}
									index={i}
									isOnly={panes.length === 1}
									onNewConnection={(paneId) => setModal({ existing: null, paneId })}
									onEditConnection={(conn) => setModal({ existing: conn, paneId: null })}
									onImportConnection={(conn) => setModal({ existing: null, importDefaults: conn, paneId: pane.id })}
								/>
							</div>
							{i < panes.length - 1 && (
								<div
									className="pane-divider"
									onMouseDown={(e) => onDividerDown(pane.id, panes[i + 1].id, e)}
								/>
							)}
						</Fragment>
					))}
				</div>
			</div>

			<TransferPanel open={transferPanelOpen} onOpenChange={setTransferPanelOpen} />

			<ConflictModal />

			{logsOpen && <LogsPanel onClose={() => setLogsOpen(false)} />}
			{syncOpen && <SyncPanel onClose={() => setSyncOpen(false)} />}
			{settingsOpen && (
				<SettingsModal
					onClose={() => setSettingsOpen(false)}
					onDownloadDirChange={setDownloadDir}
					showHidden={showHidden}
					onToggleHidden={toggleShowHidden}
				/>
			)}

			<DialogHost />

			{modal && (
				<ConnectionModal
					existing={modal.existing}
					importDefaults={modal.importDefaults}
					onClose={() => setModal(null)}
					onSaved={(conn) => {
						const paneId = modal.paneId
						setModal(null)
						if (paneId) void useStore.getState().setPaneConnection(paneId, conn.id)
					}}
				/>
			)}
		</div>
	)
}
