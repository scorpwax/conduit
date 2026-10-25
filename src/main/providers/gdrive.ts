import { Readable } from 'stream'
import { posix } from 'path'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, OAuthConfig } from '@shared/types'
import type { Provider } from './types'
import { refreshTokens, type OAuthProviderConfig, type OAuthTokens } from '../oauth'
import { withRetry, sleep, chunkWithLast } from './cloudHttp'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const CHUNK = 32 * 1024 * 1024 // resumable chunks must be multiples of 256 KiB
const SHARED = 'supportsAllDrives=true'

export const GOOGLE_OAUTH = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/drive'],
  // offline + consent so Google returns a refresh token.
  extraAuthParams: { access_type: 'offline', prompt: 'consent' }
}

/**
 * Google Drive provider.
 *
 * Drive identifies files by opaque IDs, not paths, and permits duplicate names
 * in a folder. Conduit is path-based, so this provider maintains a path→ID
 * cache and resolves each path to a file/folder ID on demand.
 */
export class GoogleDriveProvider implements Provider {
  private cfg: OAuthConfig
  private tokens: OAuthTokens | null = null
  private idCache = new Map<string, string>()

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as OAuthConfig
  }

  private oauthCfg(): OAuthProviderConfig {
    return {
      ...GOOGLE_OAUTH,
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret
    }
  }

  private async token(): Promise<string> {
    if (this.tokens && this.tokens.expiresAt > Date.now() + 60_000) return this.tokens.accessToken
    if (!this.cfg.refreshToken) throw new Error('Not authorized — connect this Google account first.')
    this.tokens = await refreshTokens(this.oauthCfg(), this.cfg.refreshToken)
    return this.tokens.accessToken
  }

  /** Authenticated fetch with retry on 429/5xx/rate-limit and one re-auth on 401. */
  private req(url: string, init?: RequestInit): Promise<Response> {
    return withRetry(
      async () =>
        fetch(url, {
          ...init,
          headers: { Authorization: `Bearer ${await this.token()}`, ...(init?.headers ?? {}) }
        }),
      { onUnauthorized: () => (this.tokens = null) }
    )
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.req(path.startsWith('http') ? path : `${API}${path}`, init)
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }

  /** Forget a path and everything cached beneath it. */
  private dropCache(path: string): void {
    const n = this.norm(path)
    for (const k of [...this.idCache.keys()]) if (k === n || k.startsWith(n + '/')) this.idCache.delete(k)
  }

  private norm(path: string): string {
    return (path || '').replace(/^\/+|\/+$/g, '')
  }

  private escape(name: string): string {
    return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  }

  /** Find a direct child folder/file id by name. */
  private async findChild(parentId: string, name: string): Promise<string | null> {
    const q = `'${parentId}' in parents and name='${this.escape(name)}' and trashed=false`
    const res = await this.api<{ files: { id: string }[] }>(
      `/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&spaces=drive&${SHARED}&includeItemsFromAllDrives=true`
    )
    return res.files[0]?.id ?? null
  }

  /** Resolve a path to a Drive id, caching each segment. */
  private async resolveId(path: string): Promise<string> {
    const norm = this.norm(path)
    if (!norm) return 'root'
    if (this.idCache.has(norm)) return this.idCache.get(norm)!
    const segments = norm.split('/')
    let parentId = 'root'
    let acc = ''
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg
      const cached = this.idCache.get(acc)
      if (cached) {
        parentId = cached
        continue
      }
      const id = await this.findChild(parentId, seg)
      if (!id) throw new Error(`Path not found: ${path}`)
      this.idCache.set(acc, id)
      parentId = id
    }
    return parentId
  }

  /** Ensure a folder path exists, creating missing segments; returns its id. */
  private async ensureFolderPath(path: string): Promise<string> {
    const norm = this.norm(path)
    if (!norm) return 'root'
    const segments = norm.split('/')
    let parentId = 'root'
    let acc = ''
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg
      const cached = this.idCache.get(acc)
      if (cached) {
        parentId = cached
        continue
      }
      let id = await this.findChild(parentId, seg)
      if (!id) {
        const created = await this.api<{ id: string }>(`/files?fields=id&${SHARED}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: seg, mimeType: FOLDER_MIME, parents: [parentId] })
        })
        id = created.id
      }
      this.idCache.set(acc, id)
      parentId = id
    }
    return parentId
  }

  async list(path: string): Promise<ListResult> {
    const parentId = await this.resolveId(path)
    const base = this.norm(path)
    const entries: FileEntry[] = []
    let pageToken: string | undefined
    do {
      const q = `'${parentId}' in parents and trashed=false`
      const url =
        `/files?q=${encodeURIComponent(q)}` +
        `&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)` +
        `&pageSize=1000&spaces=drive&orderBy=folder,name&${SHARED}&includeItemsFromAllDrives=true` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
      const res = await this.api<{
        nextPageToken?: string
        files: { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }[]
      }>(url)
      for (const f of res.files) {
        const childPath = base ? `${base}/${f.name}` : f.name
        this.idCache.set(childPath, f.id)
        entries.push({
          name: f.name,
          path: childPath,
          kind: f.mimeType === FOLDER_MIME ? 'directory' : 'file',
          size: f.size ? Number(f.size) : 0,
          modified: f.modifiedTime ?? null
        })
      }
      pageToken = res.nextPageToken
    } while (pageToken)

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { path: base, entries }
  }

  async stat(path: string): Promise<FileEntry> {
    const id = await this.resolveId(path)
    const f = await this.api<{ name: string; mimeType: string; size?: string; modifiedTime?: string }>(
      `/files/${id}?fields=name,mimeType,size,modifiedTime&${SHARED}`
    )
    return {
      name: f.name,
      path: this.norm(path),
      kind: f.mimeType === FOLDER_MIME ? 'directory' : 'file',
      size: f.size ? Number(f.size) : 0,
      modified: f.modifiedTime ?? null
    }
  }

  async createReadStream(path: string, offset = 0): Promise<{ stream: Readable; size: number }> {
    const id = await this.resolveId(path)
    const meta = await this.api<{ size?: string; mimeType: string }>(`/files/${id}?fields=size,mimeType&${SHARED}`)
    if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
      throw new Error(
        'Google Docs/Sheets/Slides files have no downloadable bytes — export them from Drive, or open them in the browser.'
      )
    }
    const res = await this.req(`${API}/files/${id}?alt=media&${SHARED}`, {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {}
    })
    if (!res.ok || !res.body) throw new Error(`Drive download ${res.status}: ${await res.text().catch(() => '')}`)
    if (offset > 0 && res.status !== 206) throw new Error('Drive did not honor the resume range')
    return { stream: Readable.fromWeb(res.body as never), size: meta.size ? Number(meta.size) : 0 }
  }

  async writeFile(path: string, body: Readable, _size: number, onProgress?: (n: number) => void): Promise<void> {
    const parentPath = posix.dirname(this.norm(path))
    const name = posix.basename(this.norm(path))
    const parentId = await this.ensureFolderPath(parentPath === '.' ? '' : parentPath)
    const existingId = await this.findChild(parentId, name)

    // Initiate a resumable upload session.
    const initUrl = existingId
      ? `${UPLOAD}/files/${existingId}?uploadType=resumable&${SHARED}`
      : `${UPLOAD}/files?uploadType=resumable&${SHARED}`
    const initRes = await this.req(initUrl, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(existingId ? {} : { name, parents: [parentId] })
    })
    if (!initRes.ok) throw new Error(`Drive upload init ${initRes.status}: ${await initRes.text()}`)
    const sessionUri = initRes.headers.get('location')
    if (!sessionUri) throw new Error('Drive upload: no session URI')

    // The session URI is pre-authorized (no bearer token). Send one chunk,
    // retrying on transient errors by asking Drive how much it committed.
    const putChunk = async (chunk: Buffer, start: number, total: string): Promise<boolean> => {
      let data = chunk
      let from = start
      for (let attempt = 1; ; attempt++) {
        let status = 0
        let errText = ''
        try {
          const res = await fetch(sessionUri, {
            method: 'PUT',
            headers: { 'Content-Range': `bytes ${from}-${from + data.length - 1}/${total}` },
            body: data
          })
          status = res.status
          if (status === 200 || status === 201) return true // upload complete
          if (status === 308) return false // chunk accepted
          errText = await res.text()
        } catch (err) {
          errText = (err as Error).message
        }
        const transient = status === 0 || status === 429 || status >= 500
        if (!transient || attempt >= 6) throw new Error(`Drive upload ${status}: ${errText}`)
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000))
        // Ask Drive what it has so we resume from the right byte.
        try {
          const q = await fetch(sessionUri, { method: 'PUT', headers: { 'Content-Range': 'bytes */*' } })
          if (q.status === 200 || q.status === 201) return true
          if (q.status === 308) {
            const range = q.headers.get('range') // "bytes=0-N"
            const committed = range ? Number(range.split('-')[1]) + 1 : 0
            if (committed >= start + chunk.length) return false
            if (committed > from) {
              data = chunk.subarray(committed - start)
              from = committed
            }
          }
        } catch {
          /* status query failed — loop and retry the send */
        }
      }
    }

    let offset = 0
    let done = false
    for await (const { chunk, isLast } of chunkWithLast(body, CHUNK)) {
      done = await putChunk(chunk, offset, isLast ? String(offset + chunk.length) : '*')
      offset += chunk.length
      onProgress?.(offset)
    }
    if (offset === 0) {
      // Empty file: finalize the session with a zero-length body.
      const res = await fetch(sessionUri, { method: 'PUT', headers: { 'Content-Range': 'bytes */0' } })
      if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`)
      done = true
    }
    if (!done) throw new Error('Drive upload ended before the file was finalized')
    this.dropCache(path)
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureFolderPath(path)
  }

  async createFile(path: string): Promise<void> {
    const parentPath = posix.dirname(this.norm(path))
    const name = posix.basename(this.norm(path))
    const parentId = await this.ensureFolderPath(parentPath === '.' ? '' : parentPath)
    await this.api(`/files?fields=id&${SHARED}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId] })
    })
  }

  async delete(path: string, _kind: 'file' | 'directory'): Promise<void> {
    const id = await this.resolveId(path)
    const res = await this.req(`${API}/files/${id}?${SHARED}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 204) throw new Error(`Drive delete ${res.status}: ${await res.text()}`)
    this.dropCache(path)
  }

  async rename(path: string, newName: string): Promise<void> {
    const id = await this.resolveId(path)
    await this.api(`/files/${id}?fields=id&${SHARED}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    })
    this.dropCache(path)
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolveId(path)
      return true
    } catch {
      return false
    }
  }

  join(...segments: string[]): string {
    return segments.filter((s) => s !== '').join('/').replace(/\/{2,}/g, '/')
  }

  parent(path: string): string | null {
    const norm = this.norm(path)
    if (!norm) return null
    const idx = norm.lastIndexOf('/')
    return idx < 0 ? '' : norm.slice(0, idx)
  }

  async test(): Promise<ConnectionTestResult> {
    try {
      await this.api(`/files?q=${encodeURIComponent("'root' in parents and trashed=false")}&pageSize=1&fields=files(id)`)
      return { ok: true, message: 'Connected to Google Drive' }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}
