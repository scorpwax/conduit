import { Readable, Transform } from 'stream'
import { posix } from 'path'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, OAuthConfig } from '@shared/types'
import type { Provider } from './types'
import { refreshTokens, type OAuthProviderConfig, type OAuthTokens } from '../oauth'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

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

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.token()
    const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }
    })
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
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
      `/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&spaces=drive`
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
        const created = await this.api<{ id: string }>(`/files?fields=id`, {
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
        `&pageSize=1000&spaces=drive&orderBy=folder,name` +
        (pageToken ? `&pageToken=${pageToken}` : '')
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
      `/files/${id}?fields=name,mimeType,size,modifiedTime`
    )
    return {
      name: f.name,
      path: this.norm(path),
      kind: f.mimeType === FOLDER_MIME ? 'directory' : 'file',
      size: f.size ? Number(f.size) : 0,
      modified: f.modifiedTime ?? null
    }
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    const id = await this.resolveId(path)
    const meta = await this.api<{ size?: string }>(`/files/${id}?fields=size`)
    const token = await this.token()
    const res = await fetch(`${API}/files/${id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok || !res.body) throw new Error(`Drive download ${res.status}`)
    return { stream: Readable.fromWeb(res.body as never), size: meta.size ? Number(meta.size) : 0 }
  }

  async writeFile(path: string, body: Readable, size: number, onProgress?: (n: number) => void): Promise<void> {
    const parentPath = posix.dirname(this.norm(path))
    const name = posix.basename(this.norm(path))
    const parentId = await this.ensureFolderPath(parentPath === '.' ? '' : parentPath)
    const existingId = await this.findChild(parentId, name)
    const token = await this.token()

    // Initiate a resumable upload session.
    const initUrl = existingId
      ? `${UPLOAD}/files/${existingId}?uploadType=resumable`
      : `${UPLOAD}/files?uploadType=resumable`
    const initRes = await fetch(initUrl, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(existingId ? {} : { name, parents: [parentId] })
    })
    if (!initRes.ok) throw new Error(`Drive upload init ${initRes.status}: ${await initRes.text()}`)
    const sessionUri = initRes.headers.get('location')
    if (!sessionUri) throw new Error('Drive upload: no session URI')

    let sent = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        sent += chunk.length
        onProgress?.(sent)
        cb(null, chunk)
      }
    })
    body.pipe(counter)

    const putRes = await fetch(sessionUri, {
      method: 'PUT',
      headers: size > 0 ? { 'Content-Length': String(size) } : {},
      body: counter as unknown as ReadableStream,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })
    if (!putRes.ok) throw new Error(`Drive upload ${putRes.status}: ${await putRes.text()}`)
    this.idCache.delete(this.norm(path))
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureFolderPath(path)
  }

  async createFile(path: string): Promise<void> {
    const parentPath = posix.dirname(this.norm(path))
    const name = posix.basename(this.norm(path))
    const parentId = await this.ensureFolderPath(parentPath === '.' ? '' : parentPath)
    await this.api(`/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId] })
    })
  }

  async delete(path: string, _kind: 'file' | 'directory'): Promise<void> {
    const id = await this.resolveId(path)
    const token = await this.token()
    const res = await fetch(`${API}/files/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok && res.status !== 204) throw new Error(`Drive delete ${res.status}`)
    this.idCache.delete(this.norm(path))
  }

  async rename(path: string, newName: string): Promise<void> {
    const id = await this.resolveId(path)
    await this.api(`/files/${id}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    })
    this.idCache.delete(this.norm(path))
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
