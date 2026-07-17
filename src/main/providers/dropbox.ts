import { Readable } from 'stream'
import { posix } from 'path'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, OAuthConfig } from '@shared/types'
import type { Provider } from './types'
import { refreshTokens, type OAuthProviderConfig, type OAuthTokens } from '../oauth'

const RPC = 'https://api.dropboxapi.com/2'
const CONTENT = 'https://content.dropboxapi.com/2'
const SINGLE_UPLOAD_MAX = 140 * 1024 * 1024 // Dropbox single-request limit is 150MB
const CHUNK = 16 * 1024 * 1024

export const DROPBOX_OAUTH = {
  authUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  scopes: ['files.content.write', 'files.content.read', 'files.metadata.read'],
  // offline so Dropbox issues a refresh token.
  extraAuthParams: { token_access_type: 'offline' }
}

/** JSON safe to place in an HTTP header (Dropbox-API-Arg): escape non-ASCII. */
function headerSafe(v: unknown): string {
  return JSON.stringify(v).replace(/[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

interface DbxEntry {
  '.tag': 'file' | 'folder' | 'deleted'
  name: string
  path_display?: string
  path_lower?: string
  size?: number
  server_modified?: string
}

/**
 * Dropbox provider (API v2). Path-based: root is "" and sub-paths are "/a/b".
 */
export class DropboxProvider implements Provider {
  private cfg: OAuthConfig
  private tokens: OAuthTokens | null = null

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as OAuthConfig
  }

  private oauthCfg(): OAuthProviderConfig {
    return { ...DROPBOX_OAUTH, clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }
  }

  private async token(): Promise<string> {
    if (this.tokens && this.tokens.expiresAt > Date.now() + 60_000) return this.tokens.accessToken
    if (!this.cfg.refreshToken) throw new Error('Not authorized — connect this Dropbox account first.')
    this.tokens = await refreshTokens(this.oauthCfg(), this.cfg.refreshToken)
    return this.tokens.accessToken
  }

  private norm(path: string): string {
    return (path || '').replace(/^\/+|\/+$/g, '')
  }

  /** Dropbox path form: "" for root, otherwise "/a/b". */
  private dbx(path: string): string {
    const n = this.norm(path)
    return n ? '/' + n : ''
  }

  private async rpc<T>(endpoint: string, arg: unknown): Promise<T> {
    const token = await this.token()
    const res = await fetch(`${RPC}/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(arg)
    })
    if (!res.ok) throw new Error(`Dropbox ${endpoint} ${res.status}: ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private toEntry(e: DbxEntry, base: string): FileEntry {
    return {
      name: e.name,
      path: base ? `${base}/${e.name}` : e.name,
      kind: e['.tag'] === 'folder' ? 'directory' : 'file',
      size: e.size ?? 0,
      modified: e.server_modified ?? null
    }
  }

  async list(path: string): Promise<ListResult> {
    const base = this.norm(path)
    const entries: FileEntry[] = []
    let res = await this.rpc<{ entries: DbxEntry[]; cursor: string; has_more: boolean }>('files/list_folder', {
      path: this.dbx(path),
      limit: 2000
    })
    for (;;) {
      for (const e of res.entries) if (e['.tag'] !== 'deleted') entries.push(this.toEntry(e, base))
      if (!res.has_more) break
      res = await this.rpc('files/list_folder/continue', { cursor: res.cursor })
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { path: base, entries }
  }

  async stat(path: string): Promise<FileEntry> {
    const e = await this.rpc<DbxEntry>('files/get_metadata', { path: this.dbx(path) })
    const parent = posix.dirname(this.norm(path))
    return this.toEntry(e, parent === '.' ? '' : parent)
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    const token = await this.token()
    const res = await fetch(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': headerSafe({ path: this.dbx(path) }) }
    })
    if (!res.ok || !res.body) throw new Error(`Dropbox download ${res.status}: ${await res.text()}`)
    const result = res.headers.get('dropbox-api-result')
    const size = result ? (JSON.parse(result).size as number) ?? 0 : 0
    return { stream: Readable.fromWeb(res.body as never), size }
  }

  async writeFile(path: string, body: Readable, size: number, onProgress?: (n: number) => void): Promise<void> {
    const token = await this.token()
    const dbxPath = this.dbx(path)

    if (size >= 0 && size <= SINGLE_UPLOAD_MAX) {
      const buf = await streamToBuffer(body)
      onProgress?.(buf.length)
      const res = await fetch(`${CONTENT}/files/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': headerSafe({ path: dbxPath, mode: 'overwrite', mute: true })
        },
        body: buf
      })
      if (!res.ok) throw new Error(`Dropbox upload ${res.status}: ${await res.text()}`)
      return
    }

    // Large file: upload session (start → append* → finish). We look ahead one
    // chunk so we know which chunk is the last (it carries the commit).
    let sessionId = ''
    let offset = 0

    const post = (endpoint: string, arg: unknown, chunk: Buffer): Promise<Response> =>
      fetch(`${CONTENT}/files/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': headerSafe(arg)
        },
        body: chunk
      })

    const commitArg = (): unknown => ({
      cursor: { session_id: sessionId, offset },
      commit: { path: dbxPath, mode: 'overwrite', mute: true }
    })

    const flush = async (chunk: Buffer, isLast: boolean): Promise<void> => {
      if (!sessionId) {
        const res = await post('upload_session/start', { close: isLast }, chunk)
        if (!res.ok) throw new Error(`Dropbox session start ${res.status}: ${await res.text()}`)
        sessionId = ((await res.json()) as { session_id: string }).session_id
        offset += chunk.length
        onProgress?.(offset)
        if (isLast) {
          const fin = await post('upload_session/finish', commitArg(), Buffer.alloc(0))
          if (!fin.ok) throw new Error(`Dropbox session finish ${fin.status}: ${await fin.text()}`)
        }
        return
      }
      const endpoint = isLast ? 'upload_session/finish' : 'upload_session/append_v2'
      const arg = isLast ? commitArg() : { cursor: { session_id: sessionId, offset }, close: false }
      const res = await post(endpoint, arg, chunk)
      if (!res.ok) throw new Error(`Dropbox session ${endpoint} ${res.status}: ${await res.text()}`)
      offset += chunk.length
      onProgress?.(offset)
    }

    let pending: Buffer | null = null
    for await (const chunk of chunker(body, CHUNK)) {
      if (pending) await flush(pending, false)
      pending = chunk
    }
    await flush(pending ?? Buffer.alloc(0), true)
  }

  async mkdir(path: string): Promise<void> {
    const p = this.dbx(path)
    if (!p) return
    try {
      await this.rpc('files/create_folder_v2', { path: p })
    } catch {
      // already exists — fine
    }
  }

  async createFile(path: string): Promise<void> {
    const token = await this.token()
    const res = await fetch(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': headerSafe({ path: this.dbx(path), mode: 'add', autorename: true })
      },
      body: Buffer.alloc(0)
    })
    if (!res.ok) throw new Error(`Dropbox create ${res.status}`)
  }

  async delete(path: string, _kind: 'file' | 'directory'): Promise<void> {
    await this.rpc('files/delete_v2', { path: this.dbx(path) })
  }

  async rename(path: string, newName: string): Promise<void> {
    const to = posix.join(posix.dirname(this.norm(path)), newName)
    await this.rpc('files/move_v2', { from_path: this.dbx(path), to_path: this.dbx(to) })
  }

  async exists(path: string): Promise<boolean> {
    if (!this.norm(path)) return true // root
    try {
      await this.rpc('files/get_metadata', { path: this.dbx(path) })
      return true
    } catch {
      return false
    }
  }

  join(...segments: string[]): string {
    return segments.filter((s) => s !== '').join('/').replace(/\/{2,}/g, '/')
  }

  parent(path: string): string | null {
    const n = this.norm(path)
    if (!n) return null
    const idx = n.lastIndexOf('/')
    return idx < 0 ? '' : n.slice(0, idx)
  }

  async test(): Promise<ConnectionTestResult> {
    try {
      await this.rpc('files/list_folder', { path: '', limit: 1 })
      return { ok: true, message: 'Connected to Dropbox' }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

async function* chunker(stream: Readable, size: number): AsyncGenerator<Buffer> {
  let buf = Buffer.alloc(0)
  for await (const c of stream) {
    buf = Buffer.concat([buf, c as Buffer])
    while (buf.length >= size) {
      yield buf.subarray(0, size)
      buf = buf.subarray(size)
    }
  }
  if (buf.length > 0) yield buf
}
