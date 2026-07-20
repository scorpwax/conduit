// Shared domain model used by both the main (Node) and renderer (React) processes.

export type ConnectionType =
  | 'local'
  | 's3'
  | 'wasabi'
  | 'sftp'
  | 'smb'
  | 'ftp'
  | 'webdav'
  | 'gdrive'
  | 'onedrive'
  | 'dropbox'

/** Type-specific configuration for each kind of connection. */
export interface LocalConfig {
  /** Optional starting path. Defaults to the user's home directory. */
  rootPath?: string
}

export interface S3Config {
  region: string
  bucket: string
  accessKeyId: string
  /** Stored encrypted at rest via Electron safeStorage; blank when loaded into the UI. */
  secretAccessKey: string
  /** Optional custom endpoint for S3-compatible services (MinIO, R2, Wasabi, etc.). */
  endpoint?: string
  /** Use path-style addressing (required by most S3-compatible endpoints). */
  forcePathStyle?: boolean
  /** Optional prefix to treat as the connection root. */
  prefix?: string
}

export interface SftpConfig {
  host: string
  port?: number
  username: string
  /** One of password or privateKey is required. Encrypted at rest. */
  password?: string
  /** PEM private key contents. Encrypted at rest. */
  privateKey?: string
  /** Passphrase for the private key, if any. Encrypted at rest. */
  passphrase?: string
  /** Optional starting path; defaults to the login home directory. */
  rootPath?: string
}

export interface SmbConfig {
  host: string
  /** Share name, e.g. "Public" (the part after \\host\). */
  share: string
  domain?: string
  username: string
  /** Encrypted at rest. */
  password?: string
  /** Connect anonymously as Guest (no credentials) — e.g. BlackMagic cameras. */
  guest?: boolean
  /** Optional starting path within the share. */
  rootPath?: string
}

export interface FtpConfig {
  host: string
  port?: number
  username: string
  /** Encrypted at rest. */
  password?: string
  /** Use FTPS (explicit TLS). */
  secure?: boolean
  rootPath?: string
}

export interface WebdavConfig {
  /** Base URL, e.g. https://cloud.example.com/remote.php/dav/files/me */
  url: string
  username: string
  /** Encrypted at rest. */
  password?: string
  rootPath?: string
}

/** OAuth-based cloud providers (Google Drive, later OneDrive/Dropbox). */
export interface OAuthConfig {
  /** OAuth client id from the registered app. */
  clientId: string
  /** Client secret (Google desktop apps require it; encrypted at rest). */
  clientSecret?: string
  /** Long-lived refresh token obtained after authorizing (encrypted at rest). */
  refreshToken?: string
  /** Optional starting folder path. */
  rootPath?: string
}

export type ConnectionConfig =
  | LocalConfig
  | S3Config
  | SftpConfig
  | SmbConfig
  | FtpConfig
  | WebdavConfig
  | OAuthConfig
  | Record<string, unknown>

/** A saved connection the user can reconnect to. */
export interface Connection {
  id: string
  name: string
  type: ConnectionType
  config: ConnectionConfig
  favorite: boolean
  color?: string
  createdAt: string
  lastUsedAt?: string
}

/** A saved shortcut to a specific folder within a connection ("favorite folder"). */
export interface Bookmark {
  id: string
  name: string
  connectionId: string
  connectionType: ConnectionType
  path: string
}

/** A single file or folder listing entry, normalized across all connection types. */
export interface FileEntry {
  /** Display name (basename). */
  name: string
  /** Full path within the connection (POSIX-style for remote, native for local). */
  path: string
  kind: 'file' | 'directory'
  size: number
  /** ISO timestamp, or null when unknown. */
  modified: string | null
  /** True for symlinks, hidden files, etc. — used for subtle UI treatment. */
  hidden?: boolean
}

export interface ListResult {
  path: string
  entries: FileEntry[]
}

export interface DriveInfo {
  name: string
  path: string
  kind: 'internal' | 'external' | 'network' | 'home'
  totalBytes?: number
  freeBytes?: number
}

/** A reference to a location within a specific connection. */
export interface Endpoint {
  connectionId: string
  path: string
}

export type TransferStatus =
  | 'queued'
  | 'transferring'
  | 'done'
  | 'error'
  | 'canceled'

export interface TransferItem {
  id: string
  name: string
  source: Endpoint
  dest: Endpoint
  kind: 'file' | 'directory' | 'operation'
  bytesTotal: number
  bytesDone: number
  status: TransferStatus
  error?: string
  /** bytes/sec, updated as it runs. */
  speed?: number
  startedAt?: number
  finishedAt?: number
}

/** Request payload to enqueue a transfer of one or more items. */
export interface TransferRequest {
  sourceConnectionId: string
  destConnectionId: string
  /** Paths within the source connection to copy. */
  sourcePaths: string[]
  /** Destination directory path within the dest connection. */
  destDir: string
  /**
   * How to handle name collisions at the destination:
   * - 'replace' (default): overwrite existing files
   * - 'keepBoth': rename incoming items to a unique name
   * (skip is handled by the caller omitting those paths)
   */
  conflictPolicy?: 'replace' | 'keepBoth'
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error'
export type LogCategory = 'app' | 'transfer' | 'connection' | 'fs'

export interface LogEntry {
  /** Epoch milliseconds. */
  ts: number
  level: LogLevel
  category: LogCategory
  message: string
}

/** User-configurable settings persisted on the local machine. */
export interface AppSettings {
  /** Days to keep log files; 0 = never delete. */
  logRetentionDays: number
  /** Max simultaneous file transfers. Default 5. */
  transferConcurrency: number
  /** Whether to skip the quit-with-active-connections confirmation. */
  skipQuitConfirm?: boolean
}

/** A node in a recursive folder tree. */
export interface TreeNode {
  name: string
  kind: 'file' | 'directory'
  size: number
  modified: string | null
  children: TreeNode[]
}

/** Result returned by the fsFolderTree IPC handler. */
export interface FolderTreeResult {
  tree: TreeNode[]
  totalFiles: number
  totalFolders: number
  totalSize: number
  /** True when the folder exceeded the 25 000-item limit and results are partial. */
  truncated: boolean
}

/** UI layout state saved on quit and restored on next launch. */
export interface UiState {
  /** Window bounds (x, y may be undefined on first launch). */
  windowBounds?: { x: number; y: number; width: number; height: number }
  /** Whether the transfer panel is expanded. */
  transferPanelOpen: boolean
  /** Pane layout: connection + path only (no live result data). */
  panes: Array<{ connectionId: string | null; path: string }>
}
