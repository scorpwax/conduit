import { Fragment, useEffect, useRef, useState } from 'react'
import type { Connection } from '@shared/types'
import { useStore } from './store'
import { Pane } from './components/Pane'
import { TransferPanel } from './components/TransferPanel'
import { ConnectionModal } from './components/ConnectionModal'
import { ConflictModal } from './components/ConflictModal'
import { LogsPanel } from './components/LogsPanel'
import { DialogHost } from './components/DialogHost'
import { Logo } from './components/Logo'

export default function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const panes = useStore((s) => s.panes)
  const addPane = useStore((s) => s.addPane)
const showHidden = useStore((s) => s.showHidden)
  const toggleShowHidden = useStore((s) => s.toggleShowHidden)
  const fontScale = useStore((s) => s.fontScale)
  const adjustFontScale = useStore((s) => s.adjustFontScale)

  const [modal, setModal] = useState<{
    existing: Connection | null
    importDefaults?: Connection
    paneId: string | null
  } | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.conduit.app.getVersion().then(setVersion)
  }, [])

  // Apply the file-list font scale globally.
  useEffect(() => {
    document.documentElement.style.setProperty('--fl-scale', String(fontScale))
  }, [fontScale])

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

  useEffect(() => {
    void init()
  }, [init])

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
        <button
          className={`btn ghost toolbtn ${showHidden ? 'active' : ''}`}
          title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
          onClick={toggleShowHidden}
        >
          {showHidden ? '👁 Hidden files: On' : '👁 Hidden files: Off'}
        </button>
        <div className="font-controls" title="Font size (⌘+ / ⌘-)">
          <button className="iconbtn" onClick={() => adjustFontScale(-0.1)} title="Smaller text">
            A−
          </button>
          <button className="iconbtn" onClick={() => adjustFontScale(0.1)} title="Larger text">
            A+
          </button>
        </div>
        <button className="btn ghost toolbtn" title="Activity log" onClick={() => setLogsOpen(true)}>
          🗒 Logs
        </button>
        <button
          className="btn ghost toolbtn"
          title={panes.length >= 5 ? 'Maximum of 5 panes' : 'Add another pane'}
          onClick={addPane}
          disabled={panes.length >= 5}
        >
          ＋ Add Pane
        </button>
      </div>

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

      <TransferPanel />

      <ConflictModal />

      {logsOpen && <LogsPanel onClose={() => setLogsOpen(false)} />}

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
