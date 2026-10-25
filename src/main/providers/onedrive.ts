import { Readable } from 'stream'
import { posix } from 'path'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, OAuthConfig } from '@shared/types'
import type { Provider } from './types'
import { refreshTokens, type OAuthProviderConfig, type OAuthTokens } from '../oauth'
import { withRetry, sleep, streamToBuffer, chunkWithLast } from './cloudHttp'

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

  /** Authenticated fetch with retry on 429/5xx and one re-auth on 401. */
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

  private async api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.req(url, init)
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

  async createReadStream(path: string, offset = 0): Promise<{ stream: Readable; size: number }> {
    const { size } = await this.stat(path)
    // Graph 302s to a pre-authenticated download URL; fetch drops the bearer
    // header on the cross-origin hop, which is what we want.
    const res = await this.req(`${this.addr(path)}/content`, {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
      redirect: 'follow'
    })
    if (!res.ok || !res.body) throw new Error(`OneDrive download ${res.status}: ${await res.text().catch(() => '')}`)
    if (offset > 0 && res.status !== 206) throw new Error('OneDrive did not honor the resume range')
    return { stream: Readable.fromWeb(res.body as never), size }
  }

  async writeFile(path: string, body: Readable, size: number, onProgress?: (n: number) => void): Promise<void> {
    // Small (and zero-byte) files: single PUT. An empty file can't use an upload session.
    if (size >= 0 && size <= SIMPLE_UPLOAD_MAX) {
      const buf = await streamToBuffer(body)
      onProgress?.(buf.length)
      const res = await this.req(`${this.addr(path)}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf
      })
      if (!res.ok) throw new Error(`OneDrive upload ${res.status}: ${await res.text()}`)
      return
    }
    // Large file: upload session with chunks.
    const sessionRes = await this.req(`${this.addr(path)}/createUploadSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
    })
    if (!sessionRes.ok) throw new Error(`OneDrive session ${sessionRes.status}: ${await sessionRes.text()}`)
    const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string }

    // The upload URL is pre-authorized (no bearer token). On a transient error,
    // ask the session which byte it expects next and resume from there.
    const putChunk = async (chunk: Buffer, start: number, total: number): Promise<void> => {
      let data = chunk
      let from = start
      for (let attempt = 1; ; attempt++) {
        let status = 0
        let errText = ''
        try {
          const res = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Range': `bytes ${from}-${from + data.length - 1}/${total}` },
            body: data
          })
          status = res.status
          if (res.ok) return // 200/201 final, 202 chunk accepted
          errText = await res.text()
        } catch (err) {
          errText = (err as Error).message
        }
        const transient = status === 0 || status === 429 || status >= 500
        if (!transient || attempt >= 6) throw new Error(`OneDrive chunk ${status}: ${errText}`)
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000))
        try {
          const q = await fetch(uploadUrl)
          if (q.ok) {
            const info = (await q.json()) as { nextExpectedRanges?: string[] }
            const next = Number(info.nextExpectedRanges?.[0]?.split('-')[0])
            if (Number.isFinite(next)) {
              if (next >= start + chunk.length) return
              if (next > from) {
                data = chunk.subarray(next - start)
                from = next
              }
            }
          }
        } catch {
          /* status query failed — loop and retry the send */
        }
      }
    }

    let offset = 0
    for await (const { chunk } of chunkWithLast(body, CHUNK)) {
      await putChunk(chunk, offset, size)
      offset += chunk.length
      onProgress?.(offset)
    }
    if (offset !== size) {
      await fetch(uploadUrl, { method: 'DELETE' }).catch(() => undefined) // cancel the session
      throw new Error(`OneDrive upload ended at ${offset} of ${size} bytes`)
    }
  }

  async mkdir(path: string): Promise<void> {
    const n = this.norm(path)
    if (!n) return
    let parent = ''
    for (const seg of n.split('/')) {
      // 'fail' (never 'replace' — that would wipe an existing folder's contents);
      // 409 nameAlreadyExists just means the folder is already there.
      const res = await this.req(`${this.addr(parent)}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
      })
      if (!res.ok && res.status !== 409) throw new Error(`OneDrive mkdir ${res.status}: ${await res.text()}`)
      parent = parent ? `${parent}/${seg}` : seg
    }
  }

  async createFile(path: string): Promise<void> {
    const dir = posix.dirname(this.norm(path))
    if (dir && dir !== '.') await this.mkdir(dir)
    const res = await this.req(`${this.addr(path)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: ''
    })
    if (!res.ok) throw new Error(`OneDrive create ${res.status}: ${await res.text()}`)
  }

  async delete(path: string, _kind: 'file' | 'directory'): Promise<void> {
    const res = await this.req(this.addr(path), { method: 'DELETE' })
    if (!res.ok && res.status !== 204) throw new Error(`OneDrive delete ${res.status}: ${await res.text()}`)
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
