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
  const [activeTab, setActiveTab] = useState<'settings' | 'help'>('settings')
  const [speedInfoOpen, setSpeedInfoOpen] = useState(false)
  const [versions, setVersions] = useState<{ app: string; electron: string; chrome: string; node: string } | null>(null)

  useEffect(() => {
    void window.conduit.settings.get().then((s) => {
      setSettings(s)
      setPreset(detectPreset(s.transferConcurrency ?? 5))
    })
    void window.conduit.sync.getLaunchAtStartup().then(setLaunchAtStartup)
    void window.conduit.app.getVersions().then(setVersions)
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
    <>
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="material-symbols-outlined">{activeTab === 'help' ? 'help' : 'settings'}</span>
          <h2>{activeTab === 'help' ? 'Help & Documentation' : 'Settings'}</h2>
          <button className="iconbtn modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="br-tabs settings-tabs">
          <button className={`br-tab${activeTab === 'settings' ? ' active' : ''}`} onClick={() => setActiveTab('settings')}>
            Settings
          </button>
          <button className={`br-tab${activeTab === 'help' ? ' active' : ''}`} onClick={() => setActiveTab('help')}>
            Help & Docs
          </button>
        </div>

        {activeTab === 'help' && (
          <div className="settings-body help-docs">
            <DocsContent />
          </div>
        )}

        {activeTab === 'settings' && <div className="settings-body">

          {/* ── Transfers ─────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Transfers</h3>

            <div className="settings-row">
              <div className="settings-label">
                <span>
                  Connection Speed
                  <button
                    className="iconbtn settings-info-btn"
                    title="What does this do?"
                    onClick={() => setSpeedInfoOpen((v) => !v)}
                  >
                    <span className="material-symbols-outlined">info</span>
                  </button>
                </span>
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

          {/* ── About ─────────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">About</h3>
            <div className="settings-about">
              <div>Conduit {versions ? `v${versions.app}` : '…'}</div>
              <div className="settings-hint">
                {versions
                  ? `Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`
                  : 'Loading version info…'}
              </div>
            </div>
          </section>

        </div>}

        <div className="modal-footer">
          {activeTab === 'settings' ? (
            <>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            </>
          ) : (
            <button className="btn ghost" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>

    {speedInfoOpen && (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setSpeedInfoOpen(false)}>
        <div className="modal settings-info-modal" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span className="material-symbols-outlined">info</span>
            <h2>Connection Speed</h2>
            <button className="iconbtn modal-close" onClick={() => setSpeedInfoOpen(false)}>✕</button>
          </div>
          <div className="settings-body">
            <ConnectionSpeedInfo />
          </div>
          <div className="modal-footer">
            <button className="btn ghost" onClick={() => setSpeedInfoOpen(false)}>Close</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

function ConnectionSpeedInfo(): JSX.Element {
  return (
    <div className="docs-content">
      <section className="docs-section">
        <h3>What each preset does</h3>
        <p>This isn't a bandwidth throttle — Conduit never slows down an individual file on purpose. It controls <strong>how many files transfer at the same time</strong> out of the queue. A single large file is unaffected by this setting.</p>
        <table className="docs-table">
          <thead><tr><th>Preset</th><th>Concurrency</th><th>Label</th></tr></thead>
          <tbody>
            <tr><td>Slow</td><td>2</td><td>Cellular / VPN</td></tr>
            <tr><td>Balanced</td><td>5</td><td>Home broadband</td></tr>
            <tr><td>Fast</td><td>10</td><td>Office / fiber</td></tr>
            <tr><td>Custom</td><td>1–20</td><td>Set manually below</td></tr>
          </tbody>
        </table>
      </section>

      <section className="docs-section">
        <h3>The trade-off, and why it's different per connection type</h3>
        <p>The right number depends heavily on what's on the other end:</p>
        <table className="docs-table">
          <thead><tr><th>Connection</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>S3 / Wasabi</td><td>Every file over 50MB already splits into 6 parallel part-uploads on its own. So concurrency multiplies: at "Balanced" (5 files) with several large files, that's up to 30 simultaneous HTTPS connections; at "Fast" (10), up to 60 — against a connection pool capped at 75 sockets. Wasabi/S3 is built to take that load well, so cranking this up genuinely helps when you have fiber/office bandwidth to feed it. Past the socket cap you're just adding contention, not speed.</td></tr>
            <tr><td>SFTP</td><td>All transfers multiplex over one SSH connection. Raising concurrency won't trip a server's "too many connections" limit, but every stream shares the same encrypted channel and CPU-bound cipher overhead. On a slow/high-latency link (VPN, hotel Wi-Fi), more simultaneous streams mostly just contend with each other rather than adding real throughput.</td></tr>
            <tr><td>FTP</td><td>The opposite of SFTP: FTP can't multiplex, so every concurrent transfer opens its own fresh login connection. Many FTP servers cap connections per user/IP (often 5–20) — push concurrency too high against one of those and you'll start seeing timeouts/refused connections instead of more speed.</td></tr>
            <tr><td>Local / External / SMB / NAS</td><td>No network, bounded by disk I/O. SSDs handle parallel reads/writes fine or even benefit. Spinning HDDs (some vault drives, NAS shares) can get slower with more parallel streams because the head has to seek between files — "Slow" is often genuinely faster there, not just for weak connections.</td></tr>
          </tbody>
        </table>
      </section>

      <section className="docs-section">
        <h3>Recommendations</h3>
        <table className="docs-table">
          <thead><tr><th>Scenario</th><th>Recommended</th></tr></thead>
          <tbody>
            <tr><td>Office fiber → Wasabi (bulk BRAW/R3D/WAV uploads)</td><td>Fast (10), or push Custom to 15 — Wasabi handles it well.</td></tr>
            <tr><td>Home broadband / hotel Wi-Fi / VPN → Wasabi</td><td>Balanced (5); drop to Slow if you see stalls.</td></tr>
            <tr><td>SFTP delivery to a client server</td><td>Keep it low, 2–5 — it's one connection regardless, so more parallelism mostly adds contention on a constrained pipe.</td></tr>
            <tr><td>FTP destination</td><td>Start at Slow (2) and step up carefully; connection-refused errors mid-transfer mean you've hit the server's cap — back off.</td></tr>
            <tr><td>External HDD / NAS</td><td>2–5. An SSD dock can comfortably run Fast.</td></tr>
            <tr><td>A few huge single files</td><td>This setting is irrelevant — S3's internal 6-way part parallelism already handles it, other providers are single-stream regardless.</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  )
}

function DocsContent(): JSX.Element {
  return (
    <div className="docs-content">

      <section className="docs-section">
        <h3>Getting Started</h3>
        <p>Conduit is a dual-pane file manager for transferring files between local drives, cloud storage (S3, Wasabi, Google Drive, OneDrive, Dropbox), and remote servers (SFTP, FTP, SMB, WebDAV). Drag files from one pane to the other to start a transfer.</p>
      </section>

      <section className="docs-section">
        <h3>Connections</h3>
        <p>Click the connection bar at the top of any pane to open the connection picker. Hit <strong>+ New Connection</strong> to set up a new one. Connection credentials are stored encrypted in your system keychain.</p>
        <table className="docs-table">
          <thead><tr><th>Type</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>Local / External</td><td>Your Mac or connected drives. No setup required.</td></tr>
            <tr><td>Amazon S3</td><td>Enter bucket, region, access key, and secret key. Supports custom endpoints for S3-compatible services.</td></tr>
            <tr><td>Wasabi</td><td>Select your region from the dropdown — the endpoint is filled in automatically.</td></tr>
            <tr><td>SFTP</td><td>Supports password or private key authentication. Key passphrase optional.</td></tr>
            <tr><td>SMB</td><td>Windows file shares and NAS devices. Leave domain blank for workgroup.</td></tr>
            <tr><td>FTP / FTPS</td><td>Standard FTP with optional TLS (FTPS). SFTP is recommended when available.</td></tr>
            <tr><td>WebDAV</td><td>Nextcloud, ownCloud, Box, and any WebDAV server.</td></tr>
            <tr><td>Google Drive</td><td>Authorize via OAuth — no passwords stored.</td></tr>
            <tr><td>OneDrive</td><td>Authorize via OAuth — no passwords stored.</td></tr>
            <tr><td>Dropbox</td><td>Authorize via OAuth — no passwords stored.</td></tr>
          </tbody>
        </table>
      </section>

      <section className="docs-section">
        <h3>Transferring Files</h3>
        <ul>
          <li><strong>Drag & drop</strong> — drag files or folders from one pane and drop them onto the other.</li>
          <li><strong>Right-click → Download</strong> — copies the selected files to your default download folder.</li>
          <li><strong>Large files</strong> — files over 50 MB use multipart upload automatically on S3/Wasabi.</li>
          <li><strong>Conflicts</strong> — if a file already exists at the destination, Conduit will ask before overwriting.</li>
          <li>Progress, speed, and estimated time are shown in the Transfers panel at the bottom.</li>
        </ul>
      </section>

      <section className="docs-section">
        <h3>File Operations</h3>
        <ul>
          <li><strong>Rename</strong> — right-click → Rename, or select and press <kbd>F2</kbd>. If the name already exists you'll be asked to overwrite, merge (folders), rename again, or cancel.</li>
          <li><strong>Duplicate</strong> — right-click → Duplicate. Creates a copy in the same folder with "(copy)" appended.</li>
          <li><strong>Batch Rename</strong> — select multiple files, right-click → Batch Rename… to apply a pattern across all of them.</li>
          <li><strong>Copy / Paste</strong> — copies file references; Paste transfers into the current folder.</li>
          <li><strong>Delete</strong> — right-click → Delete. Files are permanently removed (no Trash).</li>
          <li><strong>Quick Look</strong> — press <kbd>Space</kbd> or right-click → Quick Look to preview a file (macOS only).</li>
        </ul>
      </section>

      <section className="docs-section">
        <h3>Sync Tasks</h3>
        <p>Click <strong>Sync</strong> in the toolbar to open the Sync Tasks panel.</p>
        <table className="docs-table">
          <thead><tr><th>Mode</th><th>Behavior</th></tr></thead>
          <tbody>
            <tr><td>Mirror</td><td>Left → Right only. Deletes extras on the right to match left exactly.</td></tr>
            <tr><td>Copy</td><td>Left → Right only. Never deletes anything on the right.</td></tr>
            <tr><td>Two-Way Sync</td><td>Syncs both directions. Newer version wins on conflict.</td></tr>
            <tr><td>Two-Way Merge</td><td>Syncs both directions. Never deletes anything.</td></tr>
          </tbody>
        </table>
        <ul>
          <li><strong>Preview before execute</strong> — Conduit always shows you exactly what will change before anything is moved.</li>
          <li><strong>Run in Background</strong> — click "Run in Background" in the preview to dismiss the modal and track progress in the Transfers panel.</li>
          <li><strong>Queue</strong> — use "+ Queue" on multiple tasks, then "Run Queue" to execute them in sequence.</li>
          <li><strong>Scheduled sync</strong> — configure a task to run on launch, on an interval, daily, weekly, or monthly.</li>
          <li><strong>Include root folder</strong> — when enabled, files are placed inside a subfolder named after the source directory rather than directly at the destination root.</li>
        </ul>
      </section>

      <section className="docs-section">
        <h3>Keyboard Shortcuts</h3>
        <table className="docs-table">
          <thead><tr><th>Shortcut</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td><kbd>Space</kbd></td><td>Quick Look preview (macOS)</td></tr>
            <tr><td><kbd>F2</kbd></td><td>Rename selected file</td></tr>
            <tr><td><kbd>⌘A</kbd> / <kbd>Ctrl A</kbd></td><td>Select all</td></tr>
            <tr><td><kbd>⌘C</kbd> / <kbd>Ctrl C</kbd></td><td>Copy selected files</td></tr>
            <tr><td><kbd>⌘V</kbd> / <kbd>Ctrl V</kbd></td><td>Paste into current folder</td></tr>
            <tr><td><kbd>⌘+</kbd> / <kbd>⌘-</kbd></td><td>Increase / decrease file list font size</td></tr>
            <tr><td><kbd>⌘0</kbd></td><td>Reset font size</td></tr>
          </tbody>
        </table>
      </section>

      <section className="docs-section">
        <h3>Activity Log</h3>
        <p>Click <strong>Logs</strong> in the toolbar to view the full activity log. Logs are color-coded by category (Transfer, Sync, Connection, File System, App). Use the filter chips and search bar to narrow results. Transfer speed and duration are shown for each completed file transfer. Logs are stored in <code>~/Library/Application Support/conduit/logs/conduit.log</code>.</p>
      </section>

      <section className="docs-section">
        <h3>Multi-Pane Layout</h3>
        <p>Click <strong>+ Add Pane</strong> to open up to 5 panes side by side. Drag the dividers between panes to resize them. Each pane is independent — you can browse different connections or folders simultaneously.</p>
      </section>

    </div>
  )
}
