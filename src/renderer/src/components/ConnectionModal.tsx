import { useState } from 'react'
import type {
  Connection,
  ConnectionType,
  LocalConfig,
  S3Config,
  SftpConfig,
  SmbConfig,
  FtpConfig,
  WebdavConfig,
  OAuthConfig,
  ConnectionTestResult
} from '@shared/types'
import { useStore } from '../store'
import { ConnIcon, connColor } from '../lib/connMeta'

interface Props {
  /** Existing connection to edit, or null to create a new one. */
  existing: Connection | null
  /** Pre-populate the form from an imported profile (treated as new, not edit). */
  importDefaults?: Connection
  onClose: () => void
  onSaved: (conn: Connection) => void
}

const TYPES: { type: ConnectionType; name: string; sub: string; enabled: boolean }[] = [
  { type: 'local', name: 'Local / External', sub: 'Drives & folders', enabled: true },
  { type: 's3', name: 'Amazon S3', sub: 'AWS & compatible', enabled: true },
  { type: 'wasabi', name: 'Wasabi', sub: 'S3-compatible cloud', enabled: true },
  { type: 'sftp', name: 'Computer (SFTP)', sub: 'Another Mac/PC via SSH', enabled: true },
  { type: 'smb', name: 'SMB Share', sub: 'NAS & Windows shares', enabled: true },
  { type: 'ftp', name: 'FTP / FTPS', sub: 'File Transfer Protocol', enabled: true },
  { type: 'webdav', name: 'WebDAV', sub: 'Nextcloud, ownCloud, Box…', enabled: true },
  { type: 'gdrive', name: 'Google Drive', sub: 'via your OAuth app', enabled: true },
  { type: 'onedrive', name: 'OneDrive', sub: 'Microsoft 365', enabled: true },
  { type: 'dropbox', name: 'Dropbox', sub: 'via your OAuth app', enabled: true },
  { type: 'frameio', name: 'Frame.io', sub: 'Adobe Frame.io V4', enabled: true }
]

// Suggested regions across AWS and common S3-compatible providers (Wasabi, etc.).
// The region field is a free-text combobox, so any region string is accepted —
// these are just the quick-pick suggestions.
const SUGGESTED_REGIONS = [
  // AWS
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-central-1',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
  'ca-central-1', 'sa-east-1',
  // Wasabi (also us-east-1/2, us-west-1 above)
  'us-central-1', 'eu-central-2', 'eu-south-1',
  'ap-northeast-2'
]

/** Providers that need a custom endpoint; used to auto-suggest one. */
function endpointForRegion(region: string): string {
  // Wasabi's endpoint pattern is s3.<region>.wasabisys.com
  return region ? `https://s3.${region}.wasabisys.com` : ''
}

const WASABI_REGIONS = [
  'us-east-1', 'us-east-2', 'us-central-1', 'us-west-1', 'us-west-2',
  'ca-central-1',
  'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-south-1',
  'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2'
]

export function ConnectionModal({ existing, importDefaults, onClose, onSaved }: Props): JSX.Element {
  const saveConnection = useStore((s) => s.saveConnection)

  // For imports, use importDefaults to pre-populate but treat as new (no existing id).
  const defaults = existing ?? importDefaults ?? null

  const [type, setType] = useState<ConnectionType>(defaults?.type ?? 'local')
  const [name, setName] = useState(importDefaults ? `${importDefaults.name} (copy)` : (existing?.name ?? ''))
  const [favorite, setFavorite] = useState(defaults?.favorite ?? false)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)

  // Local
  const localCfg = (defaults?.config ?? {}) as LocalConfig
  const [rootPath, setRootPath] = useState(localCfg.rootPath ?? '')

  // S3
  const s3Cfg = (defaults?.config ?? {}) as S3Config
  const [region, setRegion] = useState(s3Cfg.region ?? 'us-east-1')
  const [bucket, setBucket] = useState(s3Cfg.bucket ?? '')
  const [accessKeyId, setAccessKeyId] = useState(s3Cfg.accessKeyId ?? '')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [endpoint, setEndpoint] = useState(s3Cfg.endpoint ?? '')
  const [prefix, setPrefix] = useState(s3Cfg.prefix ?? '')
  const [forcePathStyle, setForcePathStyle] = useState(s3Cfg.forcePathStyle ?? false)

  // Wasabi (stored as an S3 config with endpoint baked in)
  const waCfg = (defaults?.config ?? {}) as S3Config
  const [waRegion, setWaRegion] = useState(waCfg.region ?? 'us-east-1')
  const [waBucket, setWaBucket] = useState(waCfg.bucket ?? '')
  const [waKey, setWaKey] = useState(waCfg.accessKeyId ?? '')
  const [waSecret, setWaSecret] = useState('')
  const [waPrefix, setWaPrefix] = useState(waCfg.prefix ?? '')

  // SFTP
  const sftpCfg = (defaults?.config ?? {}) as SftpConfig
  const [sftpHost, setSftpHost] = useState(sftpCfg.host ?? '')
  const [sftpPort, setSftpPort] = useState(String(sftpCfg.port ?? 22))
  const [sftpUser, setSftpUser] = useState(sftpCfg.username ?? '')
  const [sftpAuth, setSftpAuth] = useState<'password' | 'key'>(sftpCfg.privateKey ? 'key' : 'password')
  const [sftpPassword, setSftpPassword] = useState('')
  const [sftpKey, setSftpKey] = useState('')
  const [sftpPassphrase, setSftpPassphrase] = useState('')
  const [sftpRoot, setSftpRoot] = useState(sftpCfg.rootPath ?? '')

  // SMB
  const smbCfg = (defaults?.config ?? {}) as SmbConfig
  const [smbHost, setSmbHost] = useState(smbCfg.host ?? '')
  const [smbShare, setSmbShare] = useState(smbCfg.share ?? '')
  const [smbDomain, setSmbDomain] = useState(smbCfg.domain ?? '')
  const [smbUser, setSmbUser] = useState(smbCfg.username ?? '')
  const [smbPassword, setSmbPassword] = useState('')
  const [smbGuest, setSmbGuest] = useState(smbCfg.guest ?? false)
  const [smbRoot, setSmbRoot] = useState(smbCfg.rootPath ?? '')

  // FTP
  const ftpCfg = (defaults?.config ?? {}) as FtpConfig
  const [ftpHost, setFtpHost] = useState(ftpCfg.host ?? '')
  const [ftpPort, setFtpPort] = useState(String(ftpCfg.port ?? 21))
  const [ftpUser, setFtpUser] = useState(ftpCfg.username ?? '')
  const [ftpPassword, setFtpPassword] = useState('')
  const [ftpSecure, setFtpSecure] = useState(ftpCfg.secure ?? true)
  const [ftpRoot, setFtpRoot] = useState(ftpCfg.rootPath ?? '')

  // WebDAV
  const wdCfg = (defaults?.config ?? {}) as WebdavConfig
  const [wdUrl, setWdUrl] = useState(wdCfg.url ?? '')
  const [wdUser, setWdUser] = useState(wdCfg.username ?? '')
  const [wdPassword, setWdPassword] = useState('')
  const [wdRoot, setWdRoot] = useState(wdCfg.rootPath ?? '')

  // OAuth cloud providers (Google Drive, OneDrive, Dropbox, Frame.io) — shared state.
  const oauthCfg = (defaults?.config ?? {}) as OAuthConfig
  const [oauthClientId, setOauthClientId] = useState(oauthCfg.clientId ?? '')
  const [oauthClientSecret, setOauthClientSecret] = useState('')
  const [oauthRefreshToken, setOauthRefreshToken] = useState('')
  // Editing an existing (not imported) cloud connection implies it was already authorized.
  const [oauthAuthorized, setOauthAuthorized] = useState(
    !!existing && ['gdrive', 'onedrive', 'dropbox', 'frameio'].includes(existing?.type ?? '')
  )

  const isOAuth = type === 'gdrive' || type === 'onedrive' || type === 'dropbox' || type === 'frameio'
  // Frame.io uses a baked-in client ID — no user-supplied credentials required.
  const isFrameIo = type === 'frameio'
  // Only Google's desktop client requires a client secret; MS/Dropbox/Frame.io use PKCE public clients.
  const oauthNeedsSecret = type === 'gdrive'

  function buildConnection(): Connection {
    const base: Connection = {
      id: existing?.id ?? crypto.randomUUID(),
      name: name.trim() || defaultName(),
      type,
      favorite,
      config: {},
      createdAt: existing?.createdAt ?? new Date().toISOString()
    }
    if (type === 'local') {
      base.config = { rootPath: rootPath.trim() || undefined } satisfies LocalConfig
    } else if (type === 's3') {
      base.config = {
        region,
        bucket: bucket.trim(),
        accessKeyId: accessKeyId.trim(),
        // Empty means "keep existing secret" on edit.
        secretAccessKey,
        endpoint: endpoint.trim() || undefined,
        prefix: prefix.trim() || undefined,
        forcePathStyle
      } satisfies S3Config
    } else if (type === 'wasabi') {
      base.config = {
        region: waRegion,
        bucket: waBucket.trim(),
        accessKeyId: waKey.trim(),
        secretAccessKey: waSecret,
        endpoint: endpointForRegion(waRegion),
        forcePathStyle: true,
        prefix: waPrefix.trim() || undefined
      } satisfies S3Config
    } else if (type === 'sftp') {
      base.config = {
        host: sftpHost.trim(),
        port: Number(sftpPort) || 22,
        username: sftpUser.trim(),
        password: sftpAuth === 'password' ? sftpPassword : '',
        privateKey: sftpAuth === 'key' ? sftpKey : '',
        passphrase: sftpAuth === 'key' ? sftpPassphrase : '',
        rootPath: sftpRoot.trim() || undefined
      } satisfies SftpConfig
    } else if (type === 'smb') {
      base.config = {
        host: smbHost.trim(),
        share: smbShare.trim(),
        domain: smbDomain.trim() || undefined,
        username: smbGuest ? '' : smbUser.trim(),
        password: smbGuest ? '' : smbPassword,
        guest: smbGuest,
        rootPath: smbRoot.trim() || undefined
      } satisfies SmbConfig
    } else if (type === 'ftp') {
      base.config = {
        host: ftpHost.trim(),
        port: Number(ftpPort) || 21,
        username: ftpUser.trim(),
        password: ftpPassword,
        secure: ftpSecure,
        rootPath: ftpRoot.trim() || undefined
      } satisfies FtpConfig
    } else if (type === 'webdav') {
      base.config = {
        url: wdUrl.trim(),
        username: wdUser.trim(),
        password: wdPassword,
        rootPath: wdRoot.trim() || undefined
      } satisfies WebdavConfig
    } else if (isFrameIo) {
      base.config = {
        // Frame.io uses a baked-in client ID; only the refresh token is stored.
        refreshToken: oauthRefreshToken
      }
    } else if (isOAuth) {
      base.config = {
        clientId: oauthClientId.trim(),
        // Blank secret/token on edit means "keep the saved one" (merge in store).
        clientSecret: oauthClientSecret,
        refreshToken: oauthRefreshToken
      } satisfies OAuthConfig
    }
    return base
  }

  function defaultName(): string {
    if (type === 'local') return rootPath ? rootPath.split('/').pop() || 'Local' : 'Local'
    if (type === 's3') return bucket || 'S3 Bucket'
    if (type === 'wasabi') return waBucket || 'Wasabi'
    if (type === 'sftp') return sftpHost ? `${sftpUser || 'sftp'}@${sftpHost}` : 'Computer'
    if (type === 'smb') return smbShare ? `${smbShare} on ${smbHost}` : 'SMB Share'
    if (type === 'ftp') return ftpHost ? `${ftpUser || 'ftp'}@${ftpHost}` : 'FTP Server'
    if (type === 'webdav') {
      try {
        return wdUrl ? new URL(wdUrl).hostname : 'WebDAV'
      } catch {
        return 'WebDAV'
      }
    }
    if (type === 'gdrive') return 'Google Drive'
    if (type === 'onedrive') return 'OneDrive'
    if (type === 'dropbox') return 'Dropbox'
    if (type === 'frameio') return 'Frame.io'
    return 'Connection'
  }

  async function pickFolder(): Promise<void> {
    const picked = await window.conduit.dialog.pickFolder()
    if (picked) {
      setRootPath(picked)
      if (!name) setName(picked.split('/').pop() || '')
    }
  }

  async function handleTest(): Promise<void> {
    setBusy(true)
    setTestResult(null)
    try {
      const result = await window.conduit.connections.test(buildConnection())
      setTestResult(result)
    } finally {
      setBusy(false)
    }
  }

  async function handleAuthorize(): Promise<void> {
    setBusy(true)
    setTestResult(null)
    try {
      const r = await window.conduit.connections.authorize({
        type,
        clientId: oauthClientId.trim(),
        clientSecret: oauthClientSecret || undefined
      })
      if (r.ok && r.refreshToken) {
        setOauthRefreshToken(r.refreshToken)
        setOauthAuthorized(true)
        setTestResult({ ok: true, message: 'Account connected ✓' })
      } else {
        setTestResult({ ok: false, message: r.message || 'Authorization failed' })
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleSave(): Promise<void> {
    setBusy(true)
    try {
      const saved = await saveConnection(buildConnection())
      onSaved(saved)
    } finally {
      setBusy(false)
    }
  }

  const canSave =
    type === 'local'
      ? true
      : type === 's3'
        ? !!(bucket.trim() && accessKeyId.trim() && (secretAccessKey || existing))
        : type === 'wasabi'
          ? !!(waBucket.trim() && waKey.trim() && (waSecret || existing))
          : type === 'sftp'
          ? !!(
              sftpHost.trim() &&
              sftpUser.trim() &&
              (sftpAuth === 'password' ? sftpPassword || existing : sftpKey || existing)
            )
          : type === 'smb'
            ? !!(smbHost.trim() && smbShare.trim() && (smbGuest || smbUser.trim()))
            : type === 'ftp'
              ? !!(ftpHost.trim() && ftpUser.trim())
              : type === 'webdav'
                ? !!(wdUrl.trim() && wdUser.trim())
                : isFrameIo
                  ? !!(oauthRefreshToken || existing)
                  : isOAuth
                  ? !!(oauthClientId.trim() && (oauthRefreshToken || existing))
                  : false

  // Imports with no secrets yet should still be saveable (e.g. SMB / local / FTP with partial config).
  const canSaveImport = !!importDefaults

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{existing ? 'Edit Connection' : importDefaults ? 'Import Connection' : 'New Connection'}</h2>
        <p className="modal-sub">
          {importDefaults
            ? 'Review and fill in any required credentials, then save.'
            : 'Connect to a location you want to browse and transfer files with.'}
        </p>

        <div className="type-grid">
          {TYPES.map((t) => (
            <div
              key={t.type}
              className={`type-card ${type === t.type ? 'active' : ''} ${t.enabled ? '' : 'disabled'}`}
              style={{ borderTop: `3px solid ${connColor(t.type)}` }}
              onClick={() => t.enabled && setType(t.type)}
            >
              <ConnIcon type={t.type} size={28} />
              <div>
                <div className="tc-name">{t.name}</div>
                <div className="tc-sub">{t.sub}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="field">
          <label>Name</label>
          <input
            value={name}
            placeholder={defaultName()}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {type === 'local' && (
          <div className="field">
            <label>Starting folder</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={rootPath}
                placeholder="Defaults to your Home folder"
                onChange={(e) => setRootPath(e.target.value)}
              />
              <button className="btn" onClick={pickFolder}>
                Browse…
              </button>
            </div>
            <div className="hint">Pick any folder on an internal or external drive.</div>
          </div>
        )}

        {type === 's3' && (
          <>
            <div className="field-row">
              <div className="field">
                <label>Bucket</label>
                <input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-bucket" />
              </div>
              <div className="field">
                <label>Region</label>
                <input
                  list="s3-regions"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="us-east-1"
                  autoComplete="off"
                />
                <datalist id="s3-regions">
                  {SUGGESTED_REGIONS.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="field">
              <label>Access Key ID</label>
              <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} autoComplete="off" />
            </div>
            <div className="field">
              <label>Secret Access Key</label>
              <input
                type="password"
                value={secretAccessKey}
                placeholder={existing ? '•••••• (unchanged)' : ''}
                onChange={(e) => setSecretAccessKey(e.target.value)}
                autoComplete="off"
              />
              <div className="hint">Stored encrypted in your system keychain.</div>
            </div>
            <div className="field">
              <label>Endpoint (optional)</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="For S3-compatible services (Wasabi, R2, MinIO…)"
                />
                <button
                  type="button"
                  className="btn"
                  title="Fill Wasabi endpoint for the region above"
                  onClick={() => {
                    setEndpoint(endpointForRegion(region))
                    setForcePathStyle(true)
                  }}
                >
                  Wasabi
                </button>
              </div>
              <div className="hint">
                Leave blank for AWS. For Wasabi, click <b>Wasabi</b> to fill{' '}
                <code>{endpointForRegion(region || 'us-central-1')}</code> and enable path-style.
              </div>
            </div>
            <div className="field">
              <label>Prefix (optional)</label>
              <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="folder/subfolder" />
            </div>
            <div className="checkbox-row">
              <input
                id="fps"
                type="checkbox"
                checked={forcePathStyle}
                onChange={(e) => setForcePathStyle(e.target.checked)}
              />
              <label htmlFor="fps" style={{ margin: 0 }}>
                Force path-style addressing (needed for most non-AWS endpoints)
              </label>
            </div>
          </>
        )}

        {type === 'wasabi' && (
          <>
            <div className="field-row">
              <div className="field">
                <label>Bucket</label>
                <input value={waBucket} onChange={(e) => setWaBucket(e.target.value)} placeholder="my-bucket" />
              </div>
              <div className="field">
                <label>Region</label>
                <input
                  list="wasabi-regions"
                  value={waRegion}
                  onChange={(e) => setWaRegion(e.target.value)}
                  placeholder="us-east-1"
                  autoComplete="off"
                />
                <datalist id="wasabi-regions">
                  {WASABI_REGIONS.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="field">
              <label>Access Key</label>
              <input value={waKey} onChange={(e) => setWaKey(e.target.value)} autoComplete="off" />
            </div>
            <div className="field">
              <label>Secret Key</label>
              <input
                type="password"
                value={waSecret}
                placeholder={existing ? '•••••• (unchanged)' : ''}
                onChange={(e) => setWaSecret(e.target.value)}
                autoComplete="off"
              />
              <div className="hint">Stored encrypted in your system keychain.</div>
            </div>
            <div className="field">
              <label>Prefix (optional)</label>
              <input value={waPrefix} onChange={(e) => setWaPrefix(e.target.value)} placeholder="folder/subfolder" />
            </div>
            <div className="field">
              <div className="hint">
                Connects to <code>{endpointForRegion(waRegion || 'us-east-1')}</code> (path-style, set
                automatically).
              </div>
            </div>
          </>
        )}

        {type === 'sftp' && (
          <>
            <div className="field-row">
              <div className="field">
                <label>Host</label>
                <input
                  value={sftpHost}
                  onChange={(e) => setSftpHost(e.target.value)}
                  placeholder="192.168.1.50 or mac.local"
                />
              </div>
              <div className="field">
                <label>Port</label>
                <input value={sftpPort} onChange={(e) => setSftpPort(e.target.value)} placeholder="22" />
              </div>
            </div>
            <div className="field">
              <label>Username</label>
              <input value={sftpUser} onChange={(e) => setSftpUser(e.target.value)} autoComplete="off" />
            </div>
            <div className="field">
              <label>Authentication</label>
              <select value={sftpAuth} onChange={(e) => setSftpAuth(e.target.value as 'password' | 'key')}>
                <option value="password">Password</option>
                <option value="key">Private Key</option>
              </select>
            </div>
            {sftpAuth === 'password' ? (
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  value={sftpPassword}
                  placeholder={existing ? '•••••• (unchanged)' : ''}
                  onChange={(e) => setSftpPassword(e.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : (
              <>
                <div className="field">
                  <label>Private Key (PEM)</label>
                  <textarea
                    value={sftpKey}
                    placeholder={existing ? '•••••• (unchanged)' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                    onChange={(e) => setSftpKey(e.target.value)}
                    rows={4}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      background: 'var(--bg)',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--text)',
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      resize: 'vertical'
                    }}
                  />
                </div>
                <div className="field">
                  <label>Key Passphrase (optional)</label>
                  <input
                    type="password"
                    value={sftpPassphrase}
                    onChange={(e) => setSftpPassphrase(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </>
            )}
            <div className="field">
              <label>Starting folder (optional)</label>
              <input
                value={sftpRoot}
                onChange={(e) => setSftpRoot(e.target.value)}
                placeholder="Defaults to the login home directory"
              />
              <div className="hint">
                Tip: on macOS enable <b>System Settings → General → Sharing → Remote Login</b> on the other
                computer, then connect with its username and password.
              </div>
            </div>
          </>
        )}

        {type === 'smb' && (
          <>
            <div className="field-row">
              <div className="field">
                <label>Server host</label>
                <input
                  value={smbHost}
                  onChange={(e) => setSmbHost(e.target.value)}
                  placeholder="192.168.1.10 or nas.local"
                />
              </div>
              <div className="field">
                <label>Share name</label>
                <input value={smbShare} onChange={(e) => setSmbShare(e.target.value)} placeholder="Public" />
              </div>
            </div>
            <div className="checkbox-row">
              <input
                id="smb-guest"
                type="checkbox"
                checked={smbGuest}
                onChange={(e) => setSmbGuest(e.target.checked)}
              />
              <label htmlFor="smb-guest" style={{ margin: 0 }}>
                Connect as Guest (no username or password)
              </label>
            </div>
            {!smbGuest && (
              <>
                <div className="field-row">
                  <div className="field">
                    <label>Username</label>
                    <input value={smbUser} onChange={(e) => setSmbUser(e.target.value)} autoComplete="off" />
                  </div>
                  <div className="field">
                    <label>Domain (optional)</label>
                    <input
                      value={smbDomain}
                      onChange={(e) => setSmbDomain(e.target.value)}
                      placeholder="WORKGROUP"
                    />
                  </div>
                </div>
                <div className="field">
                  <label>Password</label>
                  <input
                    type="password"
                    value={smbPassword}
                    placeholder={existing ? '•••••• (unchanged)' : ''}
                    onChange={(e) => setSmbPassword(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </>
            )}
            <div className="field">
              <label>Starting folder (optional)</label>
              <input value={smbRoot} onChange={(e) => setSmbRoot(e.target.value)} placeholder="subfolder/path" />
              <div className="hint">
                Connect to <code>\\{smbHost || 'server'}\{smbShare || 'share'}</code>. Uses SMB2 (most NAS &amp;
                Windows shares).
              </div>
            </div>
          </>
        )}

        {type === 'ftp' && (
          <>
            <div className="field-row">
              <div className="field">
                <label>Host</label>
                <input value={ftpHost} onChange={(e) => setFtpHost(e.target.value)} placeholder="ftp.example.com" />
              </div>
              <div className="field">
                <label>Port</label>
                <input value={ftpPort} onChange={(e) => setFtpPort(e.target.value)} placeholder="21" />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Username</label>
                <input value={ftpUser} onChange={(e) => setFtpUser(e.target.value)} autoComplete="off" />
              </div>
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  value={ftpPassword}
                  placeholder={existing ? '•••••• (unchanged)' : ''}
                  onChange={(e) => setFtpPassword(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="checkbox-row">
              <input id="ftps" type="checkbox" checked={ftpSecure} onChange={(e) => setFtpSecure(e.target.checked)} />
              <label htmlFor="ftps" style={{ margin: 0 }}>
                Use FTPS (encrypted, recommended)
              </label>
            </div>
            {!ftpSecure && (
              <div className="hint" style={{ color: 'var(--warn)', marginTop: -6, marginBottom: 12 }}>
                ⚠️ Plain FTP is unencrypted. Leave FTPS on unless your server doesn’t support it.
              </div>
            )}
            <div className="field">
              <label>Starting folder (optional)</label>
              <input value={ftpRoot} onChange={(e) => setFtpRoot(e.target.value)} placeholder="/" />
            </div>
          </>
        )}

        {type === 'webdav' && (
          <>
            <div className="field">
              <label>Server URL</label>
              <input
                value={wdUrl}
                onChange={(e) => setWdUrl(e.target.value)}
                placeholder="https://cloud.example.com/remote.php/dav/files/you"
              />
              <div className="hint">
                Use <code>https://</code> for an encrypted connection. For Nextcloud/ownCloud the path looks like{' '}
                <code>/remote.php/dav/files/USERNAME</code>.
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Username</label>
                <input value={wdUser} onChange={(e) => setWdUser(e.target.value)} autoComplete="off" />
              </div>
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  value={wdPassword}
                  placeholder={existing ? '•••••• (unchanged)' : ''}
                  onChange={(e) => setWdPassword(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="field">
              <label>Starting folder (optional)</label>
              <input value={wdRoot} onChange={(e) => setWdRoot(e.target.value)} placeholder="/" />
            </div>
          </>
        )}

        {isOAuth && (
          <>
            {!isFrameIo && (
              <div className="field">
                <label>Client ID</label>
                <input
                  value={oauthClientId}
                  onChange={(e) => setOauthClientId(e.target.value)}
                  placeholder={
                    type === 'gdrive'
                      ? 'xxxxx.apps.googleusercontent.com'
                      : type === 'onedrive'
                        ? 'Application (client) ID'
                        : 'Dropbox app key'
                  }
                  autoComplete="off"
                />
                <div className="hint">{oauthHint(type)}</div>
              </div>
            )}
            {oauthNeedsSecret && (
              <div className="field">
                <label>Client Secret</label>
                <input
                  type="password"
                  value={oauthClientSecret}
                  placeholder={existing ? '•••••• (unchanged)' : ''}
                  onChange={(e) => setOauthClientSecret(e.target.value)}
                  autoComplete="off"
                />
              </div>
            )}
            {isFrameIo && (
              <div className="hint" style={{ marginBottom: 8 }}>
                Signs in with your Adobe ID — no credentials to enter. Any Frame.io V4 account works.
              </div>
            )}
            <div className="field">
              <button
                className={`btn ${oauthAuthorized ? '' : 'primary'}`}
                disabled={busy || (!isFrameIo && !oauthClientId.trim()) || (oauthNeedsSecret && !oauthClientSecret && !existing)}
                onClick={handleAuthorize}
              >
                {busy
                  ? 'Waiting for browser…'
                  : oauthAuthorized
                    ? '✓ Connected — Re-authorize'
                    : 'Authorize in browser'}
              </button>
              <div className="hint">
                Opens your browser to sign in. Conduit stores only an encrypted refresh token — never your
                password.
              </div>
            </div>
          </>
        )}

        <div className="checkbox-row">
          <input id="fav" type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
          <label htmlFor="fav" style={{ margin: 0 }}>
            Save as Favorite
          </label>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.ok ? '✓ ' : '✕ '}
            {testResult.message}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={handleTest} disabled={busy || !(canSave || canSaveImport)}>
            {busy ? 'Testing…' : 'Test Connection'}
          </button>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={handleSave} disabled={busy || !(canSave || canSaveImport)}>
            {existing ? 'Save' : importDefaults ? 'Import Connection' : 'Add Connection'}
          </button>
        </div>
      </div>
    </div>
  )
}


function oauthHint(type: ConnectionType): string {
  if (type === 'gdrive') return "From an OAuth \"Desktop app\" client in Google Cloud (yours or your admin's)."
  if (type === 'onedrive') return 'From an app registered in Microsoft Entra (Azure AD) as a public/desktop client.'
  if (type === 'dropbox') return 'The App key from an app created at dropbox.com/developers (PKCE, no secret needed).'
  if (type === 'frameio') return ''
  return ''
}
