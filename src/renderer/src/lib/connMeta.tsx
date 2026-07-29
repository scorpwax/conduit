/**
 * Single source of truth for connection type colors and icons.
 * Used by Pane.tsx, ConnectionModal.tsx, and anywhere else a
 * connection type needs a color or visual identity.
 */

import type { ConnectionType } from '@shared/types'

// ─── Color palette ───────────────────────────────────────────────────────────

export const CONN_COLORS: Record<ConnectionType, string> = {
  local:    '#6b7280', 
  s3:       '#f59e0b', 
  wasabi:   '#22c55e', 
  sftp:     '#5cf6f4', 
  smb:      '#ec4899', 
  ftp:      '#ef4444', 
  webdav:   '#e3ef00', 
  gdrive:   '#02A745', 
  onedrive: '#0078d4', 
  dropbox:  '#0061ff', 
  frameio:  '#5A52FF', 
}

export function connColor(type: ConnectionType): string {
  return CONN_COLORS[type] ?? '#6b7280'
}

// ─── Icons ───────────────────────────────────────────────────────────────────

const S: React.CSSProperties = { width: '100%', height: '100%', display: 'block' }

/** Local / external drive — hard-disk cylinder */
function IconLocal(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={S}>
      <ellipse cx="12" cy="7" rx="8" ry="3" />
      <path d="M4 7v10c0 1.66 3.58 3 8 3s8-1.34 8-3V7" />
      <circle cx="16.5" cy="17" r="1.2" fill="white" stroke="none" />
    </svg>
  )
}

/** Amazon S3 — simplified AWS S3 bucket */
function IconS3(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" style={S}>
      {/* bucket body */}
      <path d="M6 5h12l-1.5 14H7.5L6 5z" fill="white" opacity="0.9" />
      {/* rim */}
      <rect x="4" y="3.5" width="16" height="2.5" rx="1" fill="white" />
      {/* handle */}
      <path d="M9 3.5V2.5a3 3 0 016 0v1" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
      {/* S3 label line */}
      <rect x="8" y="11" width="8" height="1.2" rx="0.6" fill="rgba(0,0,0,0.35)" />
    </svg>
  )
}

/** Wasabi — stylised leaf / W mark */
function IconWasabi(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" style={S}>
      {/* Bold W paths */}
      <path
        d="M3 5 L6.5 19 L12 10 L17.5 19 L21 5"
        fill="none"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** SFTP / Computer — terminal prompt */
function IconSftp(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" style={S}>
      {/* Monitor outline */}
      <rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="white" strokeWidth="1.7" />
      <path d="M8 21h8M12 17v4" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
      {/* > _ prompt */}
      <path d="M6 8l3 2.5L6 13" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="13" x2="17" y2="13" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** SMB — network folder */
function IconSmb(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" style={S}>
      {/* Folder shape */}
      <path d="M2 7c0-1.1.9-2 2-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V7z" fill="white" opacity="0.85" />
      {/* Network share arrows */}
      <path d="M8 13.5l4-3 4 3" fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="10.5" x2="12" y2="16" stroke="rgba(0,0,0,0.4)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** FTP — two-arrow transfer */
function IconFtp(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" style={S}>
      {/* Server rectangles */}
      <rect x="3" y="3" width="18" height="5" rx="1.5" fill="white" opacity="0.9" />
      <rect x="3" y="10" width="18" height="5" rx="1.5" fill="white" opacity="0.65" />
      {/* Arrow down */}
      <path d="M9 17.5v3m0 0l-2-2m2 2l2-2" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      {/* Arrow up */}
      <path d="M15 20.5v-3m0 0l-2 2m2-2l2 2" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** WebDAV — cloud with a path slash */
function IconWebdav(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" style={S}>
      {/* Cloud shape */}
      <path d="M6 19a4 4 0 01-.5-8A5 5 0 0116 9.5 4 4 0 0118 17H6z" fill="white" opacity="0.9" />
      {/* DAV slash-path mark */}
      <path d="M9.5 21l5-10" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0" />
      {/* Globe lines on the cloud */}
      <path d="M9 14h6M10 11.5c-.5 1-1 2.5-1 3.5M14 11.5c.5 1 1 2.5 1 3.5" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

/** Google Drive — official triangle logo (multicolor) */
function IconGdrive(): JSX.Element {
  return (
    <svg viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg" style={{ ...S, padding: '1px' }}>
      <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
      <path d="M43.65 25L29.9 1.2C28.55 2 27.4 3.1 26.6 4.5L1.2 48.5A9.06 9.06 0 000 53h27.5z" fill="#00ac47" />
      <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.65z" fill="#ea4335" />
      <path d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.1.45-4.5 1.2z" fill="#00832d" />
      <path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.1-.45 4.5-1.2z" fill="#2684fc" />
      <path d="M73.4 26.5l-12.7-22A9.72 9.72 0 0057.4 1.2L43.65 25 59.8 53h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
    </svg>
  )
}

/** OneDrive — Microsoft cloud logo */
function IconOnedrive(): JSX.Element {
  return (
    <svg viewBox="0 0 48 32" xmlns="http://www.w3.org/2000/svg" style={{ ...S, padding: '1px' }}>
      <path
        d="M28.8 10.4A11.2 11.2 0 0048 20.8c0 .37-.02.73-.05 1.08H28.27L18 18.03l10.8-7.63z"
        fill="#0078d4"
      />
      <path
        d="M18.93 12.1l-.13-.15A9.6 9.6 0 000 20.8c0 .37.02.73.05 1.08h28.22L18.93 12.1z"
        fill="#0078d4"
        opacity="0.8"
      />
      <rect x="0" y="20" width="48" height="9" rx="4.5" fill="#0078d4" />
    </svg>
  )
}

/** Frame.io — signal broadcast waves (official logo) */
function IconFrameIo(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ ...S, padding: '1px' }}>
      {/* 4 arcs, largest to smallest, left to right */}
      <path d="M2 3.5 C2 3.5 0 8 0 12 C0 16 2 20.5 2 20.5" stroke="white" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M6.5 6 C6.5 6 5 9 5 12 C5 15 6.5 18 6.5 18" stroke="white" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M11 8 C11 8 9.8 10 9.8 12 C9.8 14 11 16 11 16" stroke="white" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M15 9.5 C15 9.5 14.2 10.8 14.2 12 C14.2 13.2 15 14.5 15 14.5" stroke="white" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      {/* dot */}
      <circle cx="19" cy="12" r="1.5" fill="white" />
    </svg>
  )
}

/** Dropbox — official five-diamond logo */
function IconDropbox(): JSX.Element {
  return (
    <svg viewBox="0 0 50 44" xmlns="http://www.w3.org/2000/svg" style={{ ...S, padding: '2px' }}>
      <path
        d="M0 8.3L12.5 0 25 8.3 12.5 16.7z
           M25 8.3L37.5 0 50 8.3 37.5 16.7z
           M0 25L12.5 16.7 25 25 12.5 33.3z
           M25 25L37.5 16.7 50 25 37.5 33.3z
           M12.5 36L25 27.7 37.5 36 25 44z"
        fill="#0061ff"
      />
    </svg>
  )
}

// ─── Exported component ───────────────────────────────────────────────────────

const ICONS: Record<ConnectionType, () => JSX.Element> = {
  local:    IconLocal,
  s3:       IconS3,
  wasabi:   IconWasabi,
  sftp:     IconSftp,
  smb:      IconSmb,
  ftp:      IconFtp,
  webdav:   IconWebdav,
  gdrive:   IconGdrive,
  onedrive: IconOnedrive,
  dropbox:  IconDropbox,
  frameio:  IconFrameIo,
}

// Brand types render their logo on white; others get white icon on colored bg.
const BRAND_TYPES = new Set<ConnectionType>(['gdrive', 'onedrive', 'dropbox'])

interface ConnIconProps {
  type: ConnectionType
  size?: number
  className?: string
}

export function ConnIcon({ type, size = 22, className }: ConnIconProps): JSX.Element {
  const Icon = ICONS[type] ?? IconLocal
  const isBrand = BRAND_TYPES.has(type)
  return (
    <div
      className={`conn-icon ${type}${className ? ' ' + className : ''}`}
      style={{
        width: size,
        height: size,
        background: isBrand ? 'white' : connColor(type),
        overflow: 'hidden',
      }}
    >
      <Icon />
    </div>
  )
}
