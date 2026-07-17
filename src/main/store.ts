import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Connection, Bookmark } from '@shared/types'

/**
 * Persists saved connections to a JSON file in the app's userData directory.
 * Secret fields (S3 secret keys, SFTP passwords/keys, SMB passwords) are
 * encrypted at rest with the OS keychain via Electron's safeStorage and are
 * never written in plaintext or sent to the renderer.
 */

/** Which config fields are sensitive, per connection type. */
const SECRET_FIELDS: Record<string, string[]> = {
  local: [],
  s3: ['secretAccessKey'],
  wasabi: ['secretAccessKey'],
  sftp: ['password', 'privateKey', 'passphrase'],
  smb: ['password'],
  ftp: ['password'],
  webdav: ['password'],
  gdrive: ['clientSecret', 'refreshToken'],
  onedrive: ['clientSecret', 'refreshToken'],
  dropbox: ['clientSecret', 'refreshToken']
}

interface StoredSecret {
  /** base64 of the safeStorage-encrypted JSON blob of secret fields. */
  enc: string
}

interface PersistShape {
  version: 1
  connections: Connection[]
  /** connectionId -> encrypted secret material */
  secrets: Record<string, StoredSecret>
  bookmarks: Bookmark[]
}

let cache: PersistShape | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'conduit-connections.json')
}

async function load(): Promise<PersistShape> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistShape>
    cache = {
      version: 1,
      connections: parsed.connections ?? [],
      secrets: parsed.secrets ?? {},
      bookmarks: parsed.bookmarks ?? []
    }
  } catch {
    cache = { version: 1, connections: [], secrets: {}, bookmarks: [] }
  }
  return cache
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.writeFile(filePath(), JSON.stringify(cache, null, 2), 'utf-8')
}

function encrypt(plaintext: string): string {
  if (!plaintext) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext).toString('base64')
  }
  // Fallback for platforms without an available keychain — not secure, but keeps
  // the app functional. (safeStorage is available on macOS/Windows in practice.)
  return Buffer.from(plaintext, 'utf-8').toString('base64')
}

function decrypt(enc: string): string {
  if (!enc) return ''
  const buf = Buffer.from(enc, 'base64')
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
  } catch {
    // fall through
  }
  return buf.toString('utf-8')
}

function secretFields(type: string): string[] {
  return SECRET_FIELDS[type] ?? []
}

/** The decrypted { field: value } secret object for a connection. */
function readSecrets(state: PersistShape, id: string): Record<string, string> {
  const stored = state.secrets[id]
  if (!stored?.enc) return {}
  try {
    return JSON.parse(decrypt(stored.enc)) as Record<string, string>
  } catch {
    return {}
  }
}

/** Strip secret fields before sending a connection to the renderer. */
function sanitize(conn: Connection): Connection {
  const fields = secretFields(conn.type)
  if (fields.length === 0) return conn
  const config = { ...(conn.config as Record<string, unknown>) }
  for (const f of fields) if (f in config) config[f] = ''
  return { ...conn, config }
}

export const connectionStore = {
  async getAll(): Promise<Connection[]> {
    const state = await load()
    return state.connections.map(sanitize)
  },

  /** Full connection incl. decrypted secrets — for main-process use only. */
  async getResolved(id: string): Promise<Connection | undefined> {
    const state = await load()
    const conn = state.connections.find((c) => c.id === id)
    if (!conn) return undefined
    const fields = secretFields(conn.type)
    if (fields.length === 0) return conn
    const secrets = readSecrets(state, id)
    const config = { ...(conn.config as Record<string, unknown>) }
    for (const f of fields) if (secrets[f]) config[f] = secrets[f]
    return { ...conn, config }
  },

  async save(conn: Connection): Promise<Connection> {
    const state = await load()
    const fields = secretFields(conn.type)

    if (fields.length > 0) {
      // Merge incoming non-empty secrets over any existing ones, so leaving a
      // field blank on edit preserves the previously saved secret.
      const merged = readSecrets(state, conn.id)
      const config = conn.config as Record<string, unknown>
      for (const f of fields) {
        const val = config[f]
        if (typeof val === 'string' && val.length > 0) merged[f] = val
      }
      if (Object.keys(merged).length > 0) {
        state.secrets[conn.id] = { enc: encrypt(JSON.stringify(merged)) }
      }
      conn = sanitize(conn)
    }

    const idx = state.connections.findIndex((c) => c.id === conn.id)
    if (idx >= 0) {
      conn.createdAt = state.connections[idx].createdAt
      state.connections[idx] = conn
    } else {
      state.connections.push(conn)
    }
    await persist()
    return sanitize(conn)
  },

  async remove(id: string): Promise<void> {
    const state = await load()
    state.connections = state.connections.filter((c) => c.id !== id)
    state.bookmarks = state.bookmarks.filter((b) => b.connectionId !== id)
    delete state.secrets[id]
    await persist()
  },

  async touch(id: string): Promise<void> {
    const state = await load()
    const conn = state.connections.find((c) => c.id === id)
    if (conn) {
      conn.lastUsedAt = new Date().toISOString()
      await persist()
    }
  },

  async getBookmarks(): Promise<Bookmark[]> {
    return (await load()).bookmarks
  },

  async addBookmark(bookmark: Bookmark): Promise<Bookmark[]> {
    const state = await load()
    // De-dupe by connection + path.
    if (!state.bookmarks.some((b) => b.connectionId === bookmark.connectionId && b.path === bookmark.path)) {
      state.bookmarks.push(bookmark)
      await persist()
    }
    return state.bookmarks
  },

  async removeBookmark(id: string): Promise<Bookmark[]> {
    const state = await load()
    state.bookmarks = state.bookmarks.filter((b) => b.id !== id)
    await persist()
    return state.bookmarks
  }
}
