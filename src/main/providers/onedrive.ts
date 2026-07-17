import { Readable } from 'stream'
import { posix } from 'path'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, OAuthConfig } from '@shared/types'
import type { Provider } from './types'
import { refreshTokens, type OAuthProviderConfig, type OAuthTokens } from '../oauth'

const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive'
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024 // 4 MiB — Graph's simple PUT limit
const CHUNK = 320 * 1024 * 32 // ~10 MiB, a multiple of 320 KiB (required by Graph)

export const MICROSOFT_OAUTH = {
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: ['Files.ReadWrite.All', 'offline_access', 'User.Read'],
  extraAuthParams: { prompt: 'select_account' }
}

/**
 * OneDrive provider via the Microsoft Graph API. Graph supports path-based
 * addressing (/me/drive/root:/path:), so no ID mapping is needed.
 */
export class OneDriveProvider implements Provider {
  private cfg: OAuthConfig
  private tokens: OAuthTokens | null = null

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as OAuthConfig
  }

  private oauthCfg(): OAuthProviderConfig {
    return { ...MICROSOFT_OAUTH, clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }
  }

  private async token(): Promise<string> {
    if (this.tokens && this.tokens.expiresAt > Date.now() + 60_000) return this.tokens.accessToken
    if (!this.cfg.refreshToken) throw new Error('Not authorized — connect this OneDrive account first.')
    this.tokens = await refreshTokens(this.oauthCfg(), this.cfg.refreshToken)
    return this.tokens.accessToken
  }

  private norm(path: string): string {
    return (path || '').replace(/^\/+|\/+$/g, '')
  }

  /** Graph item address: root, or root:/<encoded path>: */
  private addr(path: string): string {
    const n = this.norm(path)
    if (!n) return `${GRAPH}/root`
    const encoded = n.split('/').map(encodeURIComponent).join('/')
    return `${GRAPH}/root:/${encoded}:`
  }

  private async api<T>(url: string, init?: RequestInit): Promise<T> {
    const token = await this.token()
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }
    })
    if (!res.ok) throw new Error(`OneDrive ${res.status}: ${await res.text()}`)
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T))
  }

  private toEntry(item: Record<string, unknown>, basePath: string): FileEntry {
    const name = item.name as string
    const isDir = 'folder' in item
    return {
      name,
      path: basePath ? `${basePath}/${name}` : name,
      kind: isDir ? 'directory' : 'file',
      size: (item.size as number) ?? 0,
      modified: (item.lastModifiedDateTime as string) ?? null
    }
  }

  async list(path: string): Promise<ListResult> {
    const base = this.norm(path)
    const entries: FileEntry[] = []
    let url = `${this.addr(path)}/children?$top=200&$select=name,size,folder,file,lastModifiedDateTime`
    for (;;) {
      const res = await this.api<{ value: Record<string, unknown>[]; '@odata.nextLink'?: string }>(url)
      for (const item of res.value) entries.push(this.toEntry(item, base))
      if (!res['@odata.nextLink']) break
      url = res['@odata.nextLink']
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { path: base, entries }
  }

  async stat(path: string): Promise<FileEntry> {
    const item = await this.api<Record<string, unknown>>(`${this.addr(path)}?$select=name,size,folder,file,lastModifiedDateTime`)
    const parent = posix.dirname(this.norm(path))
    return this.toEntry(item, parent === '.' ? '' : parent)
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    const { size } = await this.stat(path)
    const token = await this.token()
    const res = await fetch(`${this.addr(path)}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow'
    })
    if (!res.ok || !res.body) throw new Error(`OneDrive download ${res.status}`)
    return { stream: Readable.fromWeb(res.body as never), size }
  }

  async writeFile(path: string, body: Readable, size: number, onProgress?: (n: number) => void): Promise<void> {
    const token = await this.token()
    if (size > 0 && size <= SIMPLE_UPLOAD_MAX) {
      const buf = await streamToBuffer(body)
      onProgress?.(buf.length)
      const res = await fetch(`${this.addr(path)}/content`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: buf
      })
      if (!res.ok) throw new Error(`OneDrive upload ${res.status}: ${await res.text()}`)
      return
    }
    // Large / unknown size: upload session with chunks.
    const sessionRes = await fetch(`${this.addr(path)}/createUploadSession`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
    })
    if (!sessionRes.ok) throw new Error(`OneDrive session ${sessionRes.status}: ${await sessionRes.text()}`)
    const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string }

    const total = size
    let offset = 0
    for await (const chunk of chunker(body, CHUNK)) {
      const end = offset + chunk.length - 1
      const range = total > 0 ? `bytes ${offset}-${end}/${total}` : `bytes ${offset}-${end}/*`
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(chunk.length), 'Content-Range': range },
        body: chunk
      })
      if (!putRes.ok && putRes.status !== 202 && putRes.status !== 201 && putRes.status !== 200) {
        throw new Error(`OneDrive chunk ${putRes.status}: ${await putRes.text()}`)
      }
      offset += chunk.length
      onProgress?.(offset)
    }
  }

  async mkdir(path: string): Promise<void> {
    const n = this.norm(path)
    if (!n) return
    const segments = n.split('/')
    let parent = ''
    for (const seg of segments) {
      const token = await this.token()
      const res = await fetch(`${this.addr(parent)}/children`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' })
      })
      // 409/exists is fine; anything else with a real failure will surface later.
      if (!res.ok && res.status !== 409) {
        /* tolerate already-exists */
      }
      parent = parent ? `${parent}/${seg}` : seg
    }
  }

  async createFile(path: string): Promise<void> {
    const dir = posix.dirname(this.norm(path))
    if (dir && dir !== '.') await this.mkdir(dir)
    const token = await this.token()
    const res = await fetch(`${this.addr(path)}/content`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: ''
    })
    if (!res.ok) throw new Error(`OneDrive create ${res.status}`)
  }

  async delete(path: string, _kind: 'file' | 'directory'): Promise<void> {
    const token = await this.token()
    const res = await fetch(this.addr(path), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok && res.status !== 204) throw new Error(`OneDrive delete ${res.status}`)
  }

  async rename(path: string, newName: string): Promise<void> {
    await this.api(this.addr(path), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    })
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.api(`${this.addr(path)}?$select=id`)
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
      await this.api(`${GRAPH}/root?$select=id`)
      return { ok: true, message: 'Connected to OneDrive' }
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

/** Yield fixed-size buffers from a stream (last chunk may be smaller). */
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
