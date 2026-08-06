import { useState, useEffect } from 'react'
import type { AppSettings } from '@shared/types'
import { useStore } from '../store'

interface Props {
  onClose: () => void
  onDownloadDirChange: (dir: string) => void
  showHidden: boolean
  onToggleHidden: () => void
}

const CONCURRENCY_OPTIONS = [
  { n: 1,  label: '1 — Slow connection' },
  { n: 2,  label: '2' },
  { n: 3,  label: '3' },
  { n: 4,  label: '4' },
  { n: 5,  label: '5 — Default' },
  { n: 8,  label: '8' },
  { n: 10, label: '10 — Fast connection' },
  { n: 15, label: '15' },
  { n: 20, label: '20 — Very fast / LAN' },
]

// Speed presets: [concurrency, chunkSizeMB description]
const SPEED_PRESETS = [
  { id: 'slow',    label: 'Slow',     subtitle: 'Cellular / VPN',       concurrency: 2  },
  { id: 'balanced',label: 'Balanced', subtitle: 'Home broadband',        concurrency: 5  },
  { id: 'fast',    label: 'Fast',     subtitle: 'Office / fiber',        concurrency: 10 },
  { id: 'custom',  label: 'Custom',   subtitle: 'Set manually below',    concurrency: null },
] as const

type SpeedPreset = typeof SPEED_PRESETS[number]['id']

function detectPreset(concurrency: number): SpeedPreset {
  if (concurrency === 2)  return 'slow'
  if (concurrency === 5)  return 'balanced'
  if (concurrency === 10) return 'fast'
  return 'custom'
}

export function SettingsModal({ onClose, onDownloadDirChange, showHidden, onToggleHidden }: Props): JSX.Element {
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [preset, setPreset] = useState<SpeedPreset>('balanced')
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.conduit.settings.get().then((s) => {
      setSettings(s)
      setPreset(detectPreset(s.transferConcurrency ?? 5))
    })
    void window.conduit.sync.getLaunchAtStartup().then(setLaunchAtStartup)
  }, [])

  async function pickDownloadDir(): Promise<void> {
    const dir = await window.conduit.dialog.pickFolder()
    if (!dir || !settings) return
    const next = { ...settings, downloadDir: dir }
    setSettings(next)
    onDownloadDirChange(dir)
  }

  function clearDownloadDir(): void {
    if (!settings) return
    const next = { ...settings, downloadDir: '' }
    setSettings(next)
    onDownloadDirChange('')
  }

  function applyPreset(p: SpeedPreset): void {
    setPreset(p)
    const found = SPEED_PRESETS.find((x) => x.id === p)
    if (found?.concurrency !== null && settings) {
      setSettings({ ...settings, transferConcurrency: found!.concurrency as number })
    }
  }

  async function save(): Promise<void> {
    if (!settings) return
    setSaving(true)
    await window.conduit.settings.set(settings)
    await window.conduit.sync.setLaunchAtStartup(launchAtStartup)
    setSaving(false)
    onClose()
  }

  async function toggleLaunchAtStartup(): Promise<void> {
    const next = !launchAtStartup
    setLaunchAtStartup(next)
  }

  if (!settings) return <></>

  const folderName = settings.downloadDir
    ? (settings.downloadDir.split('/').pop() || settings.downloadDir.split('\\').pop() || settings.downloadDir)
    : ''

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="material-symbols-outlined">settings</span>
          <h2>Settings</h2>
          <button className="iconbtn modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">

          {/* ── Transfers ─────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Transfers</h3>

            <div className="settings-row">
              <div className="settings-label">
                <span>Connection Speed</span>
                <span className="settings-hint">Sets how many files transfer simultaneously</span>
              </div>
              <div className="speed-preset-group">
                {SPEED_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`speed-preset-btn${preset === p.id ? ' active' : ''}`}
                    onClick={() => applyPreset(p.id)}
                  >
                    <span className="speed-preset-label">{p.label}</span>
                    <span className="speed-preset-sub">{p.subtitle}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-row settings-row-indent">
              <div className="settings-label">
                <span>Concurrent Transfers</span>
                <span className="settings-hint">Number of files transferred at the same time</span>
              </div>
              <select
                className="input settings-select"
                value={settings.transferConcurrency ?? 5}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  setSettings({ ...settings, transferConcurrency: n })
                  setPreset(detectPreset(n))
                }}
              >
                {CONCURRENCY_OPTIONS.map(({ n, label }) => (
                  <option key={n} value={n}>{label}</option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                <span>Clear transfer log when complete</span>
                <span className="settings-hint">Automatically clear finished transfers from the queue when all complete</span>
              </div>
              <label className="st-toggle">
                <input
                  type="checkbox"
                  checked={settings.clearTransfersAfterComplete ?? false}
                  onChange={(e) => setSettings({ ...settings, clearTransfersAfterComplete: e.target.checked })}
                />
                <span className="st-toggle-slider" />
              </label>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                <span>Quit after transfer completes</span>
                <span className="settings-hint">Automatically quit Conduit when all transfers finish</span>
              </div>
              <label className="st-toggle">
                <input
                  type="checkbox"
                  checked={settings.quitAfterTransfer ?? false}
                  onChange={(e) => setSettings({ ...settings, quitAfterTransfer: e.target.checked })}
                />
                <span className="st-toggle-slider" />
              </label>
            </div>
          </section>

          {/* ── General ───────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">General</h3>

            <div className="settings-row">
              <div className="settings-label">
                <span>Default Download Folder</span>
                <span className="settings-hint">Where files go when using "Download" from the context menu</span>
              </div>
              <div className="settings-dir-row">
                {folderName && (
                  <span className="settings-dir-name" title={settings.downloadDir}>
                    <span className="material-symbols-outlined">folder</span>
                    {folderName}
                  </span>
                )}
                <button className="btn ghost" onClick={() => void pickDownloadDir()}>
                  {folderName ? 'Change…' : 'Choose Folder…'}
                </button>
                {folderName && (
                  <button className="btn ghost" onClick={clearDownloadDir} title="Clear download folder">
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                <span>Launch Conduit at Startup</span>
                <span className="settings-hint">Open Conduit automatically when you log in</span>
              </div>
              <label className="st-toggle">
                <input
                  type="checkbox"
                  checked={launchAtStartup}
                  onChange={() => void toggleLaunchAtStartup()}
                />
                <span className="st-toggle-slider" />
              </label>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                <span>Show Hidden Files</span>
                <span className="settings-hint">Show dotfiles and system-hidden files in file listings</span>
              </div>
              <label className="st-toggle">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={onToggleHidden}
                />
                <span className="st-toggle-slider" />
              </label>
            </div>
          </section>

          {/* ── Appearance ────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Appearance</h3>

            <div className="settings-row">
              <div className="settings-label">
                <span>Theme</span>
              </div>
              <div className="theme-toggle-group">
                <button
                  className={`theme-btn${theme === 'dark' ? ' active' : ''}`}
                  onClick={() => { if (theme !== 'dark') toggleTheme() }}
                >
                  <span className="material-symbols-outlined">dark_mode</span> Dark
                </button>
                <button
                  className={`theme-btn${theme === 'light' ? ' active' : ''}`}
                  onClick={() => { if (theme !== 'light') toggleTheme() }}
                >
                  <span className="material-symbols-outlined">light_mode</span> Light
                </button>
              </div>
            </div>
          </section>

        </div>

        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  )
}
