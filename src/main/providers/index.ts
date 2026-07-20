import type { Connection } from '@shared/types'
import { BUILTIN_LOCAL, BUILTIN_LOCAL_ID } from '@shared/builtin'
import type { Provider } from './types'
import { LocalProvider } from './local'
import { S3Provider } from './s3'
import { SftpProvider } from './sftp'
import { SmbProvider } from './smb'
import { FtpProvider } from './ftp'
import { WebdavProvider } from './webdav'
import { GoogleDriveProvider } from './gdrive'
import { OneDriveProvider } from './onedrive'
import { DropboxProvider } from './dropbox'
import { connectionStore } from '../store'

export type { Provider } from './types'

/**
 * Build a Provider for a resolved connection (secrets included). S3 clients are
 * cached per connection id so we don't recreate them on every listing.
 */
const cache = new Map<string, { provider: Provider; signature: string }>()

function signature(conn: Connection): string {
  return JSON.stringify({ type: conn.type, config: conn.config })
}

export function createProvider(conn: Connection): Provider {
  switch (conn.type) {
    case 'local':
      return new LocalProvider(conn)
    case 's3':
    case 'wasabi':
      // Wasabi is S3-compatible; its config is a full S3Config (endpoint baked in).
      return new S3Provider(conn)
    case 'sftp':
      return new SftpProvider(conn)
    case 'smb':
      return new SmbProvider(conn)
    case 'ftp':
      return new FtpProvider(conn)
    case 'webdav':
      return new WebdavProvider(conn)
    case 'gdrive':
      return new GoogleDriveProvider(conn)
    case 'onedrive':
      return new OneDriveProvider(conn)
    case 'dropbox':
      return new DropboxProvider(conn)
    default:
      throw new Error(`Unsupported connection type: ${conn.type}`)
  }
}

/** Providers holding a live network connection expose an optional close(). */
function closeProvider(provider: Provider): void {
  const closable = provider as Provider & { close?: () => void }
  if (typeof closable.close === 'function') closable.close()
}

/** Resolve a saved connection by id and return a (cached) Provider. */
export async function getProvider(connectionId: string): Promise<Provider> {
  const conn =
    connectionId === BUILTIN_LOCAL_ID
      ? BUILTIN_LOCAL
      : await connectionStore.getResolved(connectionId)
  if (!conn) throw new Error(`Unknown connection: ${connectionId}`)

  const sig = signature(conn)
  const hit = cache.get(connectionId)
  if (hit && hit.signature === sig) return hit.provider
  // Config changed — tear down the stale (possibly connected) provider.
  if (hit) closeProvider(hit.provider)

  const provider = createProvider(conn)
  cache.set(connectionId, { provider, signature: sig })
  return provider
}

export function invalidateProvider(connectionId: string): void {
  const hit = cache.get(connectionId)
  if (hit) closeProvider(hit.provider)
  cache.delete(connectionId)
}

/** Return the ids of all currently cached (live) non-local connections. */
export function getActiveConnectionIds(): string[] {
  return [...cache.keys()].filter((id) => id !== BUILTIN_LOCAL_ID)
}

/** Tear down every live provider (unmount SMB, end SSH/FTP sessions). */
export function closeAllProviders(): void {
  for (const { provider } of cache.values()) closeProvider(provider)
  cache.clear()
}
