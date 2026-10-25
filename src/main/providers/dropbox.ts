import { Readable } from 'stream'
import { posix } from 'path'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, OAuthConfig } from '@shared/types'
import type { Provider } from './types'
import { refreshTokens, type OAuthProviderConfig, type OAuthTokens } from '../oauth'
import { withRetry, streamToBuffer, chunkWithLast } from './cloudHttp'

const RPC = 'https://api.dropboxapi.com/2'
const CONTENT = 'https://content.dropboxapi.com/2'
const SINGLE_UPLOAD_MAX = 32 * 1024 * 1024 // buffered in memory; larger files use an upload session (API limit is 150MB)
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

  /** Authenticated fetch with retry on 429/5xx and one re-auth on 401 (tokens last ~4h). */
  private req(url: string, init: RequestInit): Promise<Response> {
    return withRetry(
      async () =>
        fetch(url, {
          ...init,
          headers: { Authorization: `Bearer ${await this.token()}`, ...(init.headers ?? {}) }
        }),
      { onUnauthorized: () => (this.tokens = null) }
    )
  }

  private async rpc<T>(endpoint: string, arg: unknown): Promise<T> {
    const res = await this.req(`${RPC}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  async createReadStream(path: string, offset = 0): Promise<{ stream: Readable; size: number }> {
    const res = await this.req(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': headerSafe({ path: this.dbx(path) }),
        ...(offset > 0 ? { Range: `bytes=${offset}-` } : {})
      }
    })
    if (!res.ok || !res.body) throw new Error(`Dropbox download ${res.status}: ${await res.text().catch(() => '')}`)
    if (offset > 0 && res.status !== 206) throw new Error('Dropbox did not honor the resume range')
    const result = res.headers.get('dropbox-api-result')
    const size = result ? (JSON.parse(result).size as number) ?? 0 : 0
    return { stream: Readable.fromWeb(res.body as never), size }
  }

  async writeFile(path: string, body: Readable, size: number, onProgress?: (n: number) => void): Promise<void> {
    const dbxPath = this.dbx(path)

    const post = (endpoint: string, arg: unknown, data: Buffer): Promise<Response> =>
      this.req(`${CONTENT}/files/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerSafe(arg) },
        body: data
      })

    if (size >= 0 && size <= SINGLE_UPLOAD_MAX) {
      const buf = await streamToBuffer(body)
      onProgress?.(buf.length)
      const res = await post('upload', { path: dbxPath, mode: 'overwrite', mute: true }, buf)
      if (!res.ok) throw new Error(`Dropbox upload ${res.status}: ${await res.text()}`)
      return
    }

    // Large file: upload session (start → append* → finish). chunkWithLast tells
    // us which chunk is the last (it carries the commit).
    let sessionId = ''
    let offset = 0

    /**
     * A retried append can hit "incorrect_offset" if the first attempt actually
     * landed before the connection dropped. If Dropbox's expected offset is the
     * end of this chunk, the chunk is already there — treat it as success.
     */
    const ensureOk = async (res: Response, label: string, chunkLen: number): Promise<Response> => {
      if (res.ok) return res
      const text = await res.text()
      if (res.status === 409) {
        try {
          const correct = JSON.parse(text)?.error?.correct_offset
          if (correct === offset + chunkLen) return res
        } catch {
          /* not JSON */
        }
      }
      throw new Error(`Dropbox ${label} ${res.status}: ${text}`)
    }

    for await (const { chunk, isLast } of chunkWithLast(body, CHUNK)) {
      if (!sessionId) {
        const res = await post('upload_session/start', { close: false }, chunk)
        if (!res.ok) throw new Error(`Dropbox session start ${res.status}: ${await res.text()}`)
        sessionId = ((await res.json()) as { session_id: string }).session_id
      } else if (!isLast) {
        const res = await post('upload_session/append_v2', { cursor: { session_id: sessionId, offset }, close: false }, chunk)
        await ensureOk(res, 'append_v2', chunk.length)
      }
      if (isLast) {
        // The first chunk is also the last for files just over SINGLE_UPLOAD_MAX that
        // arrive as one chunk; in that case it was sent by `start` above with no data left.
        const sentByStart = offset === 0
        const commit = {
          cursor: { session_id: sessionId, offset: sentByStart ? chunk.length : offset },
          commit: { path: dbxPath, mode: 'overwrite', mute: true }
        }
        const res = await post('upload_session/finish', commit, sentByStart ? Buffer.alloc(0) : chunk)
        await ensureOk(res, 'finish', sentByStart ? 0 : chunk.length)
      }
      offset += chunk.length
      onProgress?.(offset)
    }
    if (!sessionId) {
      // Empty stream with a large declared size — nothing to commit.
      throw new Error('Dropbox upload: source stream was empty')
    }
  }

  async mkdir(path: string): Promise<void> {
    const p = this.dbx(path)
    if (!p) return
    try {
      await this.rpc('files/create_folder_v2', { path: p }) // creates missing parents too
    } catch (err) {
      // Already exists is fine; surface anything else (permissions, bad name, quota).
      if (!/path\/conflict/.test((err as Error).message)) throw err
    }
  }

  async createFile(path: string): Promise<void> {
    const res = await this.req(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': headerSafe({ path: this.dbx(path), mode: 'add', autorename: true })
      },
      body: Buffer.alloc(0)
    })
    if (!res.ok) throw new Error(`Dropbox create ${res.status}: ${await res.text()}`)
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
