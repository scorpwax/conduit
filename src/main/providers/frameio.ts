import { Readable } from 'stream'
import { posix } from 'path'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, FrameIoConfig } from '@shared/types'
import type { Provider } from './types'
import { refreshTokens, type OAuthProviderConfig, type OAuthTokens } from '../oauth'

const API = 'https://api.frame.io'
const IMS = 'https://ims-na1.adobelogin.com'

// Client ID from Scorpion's Adobe Developer Console project (scorpwax/conduit is private).
// Any Frame.io user can sign in with their own Adobe ID — this ID identifies the app, not the user.
const CLIENT_ID = '446d21ea546a4b50aa23260fc640f957'

// Adobe IMS OAuth for Frame.io V4.
// Adobe Native App OAuth uses a custom URI scheme as the redirect.
// The scheme is auto-generated from the client ID by Adobe Dev Console.
// Conduit registers this scheme via app.setAsDefaultProtocolClient() on startup.
const ADOBE_SCHEME = 'adobe+c81c5be5270ca150347419700136d254c630836d'
export const FRAMEIO_REDIRECT_URI = `${ADOBE_SCHEME}://adobeid/${CLIENT_ID}`
export const FRAMEIO_PROTOCOL_SCHEME = ADOBE_SCHEME

export const FRAMEIO_OAUTH: OAuthProviderConfig = {
  authUrl: `${IMS}/ims/authorize/v2`,
  tokenUrl: `${IMS}/ims/token/v3`,
  // Match the scopes configured in the Adobe Dev Console credential exactly.
  scopes: ['openid,offline_access,profile,email,additional_info.roles'],
  clientId: CLIENT_ID
}

type NodeKind = 'workspace' | 'project' | 'folder' | 'file'
interface CacheNode {
  id: string
  kind: NodeKind
  /** For projects: the root folder ID needed to list the project's top-level assets. */
  rootFolderId?: string
}

/** Common structure Frame.io wraps all responses in. */
interface FioResponse<T> { data: T; links?: { next?: string } }

interface FioAsset {
  id: string
  name: string
  type: 'file' | 'folder'
  file_size?: number
  updated_at?: string
  inserted_at?: string
  /** Presigned S3 download URL — present on fully-transcoded files. */
  original?: string
  /** Upload URLs returned when creating a file placeholder. */
  upload_urls?: Array<{ url: string; size: number }>
}

interface FioWorkspace { id: string; name: string; updated_at?: string }
interface FioProject { id: string; name: string; root_folder_id?: string; updated_at?: string }
interface FioMe { id: string; email?: string; name?: string }
interface FioAccount { id: string; display_name?: string; roles?: string[] }

const MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', mxf: 'application/mxf',
  braw: 'video/x-braw', r3d: 'video/x-red-r3d', ari: 'video/x-arri',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv',
  m4v: 'video/x-m4v', webm: 'video/webm', mts: 'video/mp2t', ts: 'video/mp2t',
  wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac', aiff: 'audio/aiff',
  flac: 'audio/flac', m4a: 'audio/mp4',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic', webp: 'image/webp',
  dpx: 'image/x-dpx', exr: 'image/x-exr',
  pdf: 'application/pdf', zip: 'application/zip',
}

function mediaMime(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return MIME[ext] ?? 'application/octet-stream'
}

/**
 * Frame.io V4 provider via Adobe IMS OAuth.
 *
 * Hierarchy: Account → Workspaces → Projects → Folders/Files
 * Paths are human-readable names (e.g. "Production/Feature Film/Dailies/clip.braw").
 * A name→ID cache handles the opaque-ID API under the hood.
 */
export class FrameIoProvider implements Provider {
  private cfg: FrameIoConfig
  private tokens: OAuthTokens | null = null
  private accountId: string | null = null
  /** path (without leading slash) → node metadata */
  private nodes = new Map<string, CacheNode>()

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as FrameIoConfig
  }

  private async token(): Promise<string> {
    if (this.tokens && this.tokens.expiresAt > Date.now() + 60_000) return this.tokens.accessToken
    if (!this.cfg.refreshToken) throw new Error('Not authorized — connect this Frame.io account first.')
    this.tokens = await refreshTokens(FRAMEIO_OAUTH, this.cfg.refreshToken)
    return this.tokens.accessToken
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const tok = await this.token()
    const url = path.startsWith('http') ? path : `${API}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
        'x-api-version': '4'
      },
      body: body != null ? JSON.stringify(body) : undefined
    })
    if (!res.ok) throw new Error(`Frame.io ${res.status} ${method} ${path}: ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  private async getAccountId(): Promise<string> {
    if (this.accountId) return this.accountId
    const res = await this.req<FioResponse<FioAccount[]>>('GET', '/v4/accounts')
    const accounts = res.data
    console.log('[frameio] /v4/accounts raw:', JSON.stringify(res))
    if (!accounts || accounts.length === 0) throw new Error('No Frame.io accounts found for this user')
    this.accountId = accounts[0].id
    return this.accountId
  }

  /** Fetch all pages of a paginated list endpoint, following links.next cursors. */
  private async reqAll<T>(basePath: string): Promise<T[]> {
    const results: T[] = []
    let next: string | null = `${basePath}${basePath.includes('?') ? '&' : '?'}page_size=100`
    while (next) {
      const page: FioResponse<T[]> = await this.req<FioResponse<T[]>>('GET', next)
      if (Array.isArray(page.data)) results.push(...page.data)
      // links.next may be an absolute URL — strip the API base so req() can prepend it.
      const raw = page.links?.next ?? null
      const cursor = raw ? raw.replace(/^https?:\/\/api\.frame\.io/, '') : null
      next = cursor && cursor !== next ? cursor : null
    }
    return results
  }

  private norm(path: string): string {
    return (path || '').replace(/^\/+|\/+$/g, '')
  }

  async list(path: string): Promise<ListResult> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const parts = p ? p.split('/') : []

    // Root: list all workspaces (paginated — accounts can have hundreds)
    if (parts.length === 0) {
      const workspaces = await this.reqAll<FioWorkspace>(`/v4/accounts/${accountId}/workspaces`)
      console.log(`[frameio] accountId=${accountId} workspace count=${workspaces.length} first3=`, JSON.stringify(workspaces.slice(0, 3)))
      const entries: FileEntry[] = workspaces.map(ws => {
        this.nodes.set(ws.name, { id: ws.id, kind: 'workspace' })
        return { name: ws.name, path: ws.name, kind: 'directory', size: 0, modified: ws.updated_at ?? null }
      })
      return { path: '', entries }
    }

    const node = this.nodes.get(p)

    // Workspace level: list all projects (paginated)
    if (parts.length === 1 || node?.kind === 'workspace') {
      let wsId = node?.id
      if (!wsId) {
        const workspaces = await this.reqAll<FioWorkspace>(`/v4/accounts/${accountId}/workspaces`)
        const found = workspaces.find(w => w.name === parts[0])
        if (!found) throw new Error(`Workspace not found: ${parts[0]}`)
        wsId = found.id
        this.nodes.set(parts[0], { id: wsId, kind: 'workspace' })
      }
      const projects = await this.reqAll<FioProject>(`/v4/accounts/${accountId}/workspaces/${wsId}/projects`)
      const entries: FileEntry[] = projects.map(proj => {
        const projPath = `${parts[0]}/${proj.name}`
        this.nodes.set(projPath, { id: proj.id, kind: 'project', rootFolderId: proj.root_folder_id })
        return { name: proj.name, path: projPath, kind: 'directory', size: 0, modified: proj.updated_at ?? null }
      })
      return { path: p, entries }
    }

    // Project root: resolve root folder, then list
    if (node?.kind === 'project') {
      if (!node.rootFolderId) {
        const proj = await this.req<FioResponse<FioProject>>(
          'GET', `/v4/accounts/${accountId}/projects/${node.id}`
        )
        node.rootFolderId = proj.data.root_folder_id
        if (!node.rootFolderId) throw new Error(`No root folder found for project: ${p}`)
      }
      return this.listFolder(p, accountId, node.rootFolderId)
    }

    // Folder: list children
    if (node?.kind === 'folder') {
      return this.listFolder(p, accountId, node.id)
    }

    // Unknown path — try to resolve by listing parent then retry
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    await this.list(parentPath)
    const resolved = this.nodes.get(p)
    if (!resolved) throw new Error(`Path not found: ${p}`)
    return this.list(path)
  }

  private async listFolder(parentPath: string, accountId: string, folderId: string): Promise<ListResult> {
    const assets = await this.reqAll<FioAsset>(`/v4/accounts/${accountId}/folders/${folderId}/children`)
    const entries: FileEntry[] = assets.map(asset => {
      const assetPath = `${parentPath}/${asset.name}`
      this.nodes.set(assetPath, { id: asset.id, kind: asset.type === 'folder' ? 'folder' : 'file' })
      return {
        name: asset.name,
        path: assetPath,
        kind: asset.type === 'folder' ? 'directory' : 'file',
        size: asset.file_size ?? 0,
        modified: asset.updated_at ?? asset.inserted_at ?? null
      }
    })
    return { path: parentPath, entries }
  }

  async stat(path: string): Promise<FileEntry> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
    let node = this.nodes.get(p)
    if (!node) {
      const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
      await this.list(parentPath)
      node = this.nodes.get(p)
      if (!node) throw Object.assign(new Error(`Not found: ${p}`), { code: 'ENOENT' })
    }
    if (node.kind === 'file') {
      const res = await this.req<FioResponse<FioAsset>>('GET', `/v4/accounts/${accountId}/files/${node.id}`)
      return { name, path: p, kind: 'file', size: res.data.file_size ?? 0, modified: res.data.updated_at ?? null }
    }
    return { name, path: p, kind: 'directory', size: 0, modified: null }
  }

  async createReadStream(path: string, offset = 0): Promise<{ stream: Readable; size: number }> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const node = this.nodes.get(p)
    if (!node || node.kind !== 'file') throw new Error(`Not a file: ${p}`)

    const res = await this.req<FioResponse<FioAsset>>('GET', `/v4/accounts/${accountId}/files/${node.id}`)
    const downloadUrl = res.data.original
    if (!downloadUrl) throw new Error(`"${p}" has no download URL — it may still be processing in Frame.io`)

    const headers: Record<string, string> = {}
    if (offset > 0) headers.Range = `bytes=${offset}-`

    const fetchRes = await fetch(downloadUrl, { headers })
    if (!fetchRes.ok) throw new Error(`Frame.io download ${fetchRes.status}: ${fetchRes.statusText}`)
    if (!fetchRes.body) throw new Error('Frame.io download returned no body')

    const totalSize = offset > 0
      ? (res.data.file_size ?? 0)
      : (res.data.file_size ?? Number(fetchRes.headers.get('content-length') ?? 0))

    return { stream: Readable.from(fetchRes.body as AsyncIterable<Uint8Array>), size: totalSize }
  }

  async writeFile(
    path: string,
    body: Readable,
    size: number,
    onProgress?: (bytesWritten: number) => void
  ): Promise<void> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''

    // Resolve the destination folder ID
    let parentNode = this.nodes.get(parentPath)
    if (!parentNode) {
      await this.list(parentPath)
      parentNode = this.nodes.get(parentPath)
      if (!parentNode) throw new Error(`Destination folder not found: ${parentPath}`)
    }
    const folderId = parentNode.kind === 'project'
      ? (parentNode.rootFolderId ?? parentNode.id)
      : parentNode.id

    const mediaType = mediaMime(name)

    // Step 1: Create the file placeholder and get presigned S3 upload URLs
    const createRes = await this.req<FioResponse<FioAsset>>(
      'POST',
      `/v4/accounts/${accountId}/folders/${folderId}/files`,
      { data: { name, file_size: size, media_type: mediaType } }
    )
    const fileId = createRes.data.id
    const uploadUrls = createRes.data.upload_urls ?? []
    if (!uploadUrls.length) throw new Error(`Frame.io returned no upload URLs for "${name}"`)

    // Cache the new file node
    this.nodes.set(p, { id: fileId, kind: 'file' })

    // Step 2: Stream each chunk to its presigned S3 URL
    const reader = new ChunkedReader(body)
    let bytesWritten = 0

    for (const { url, size: chunkSize } of uploadUrls) {
      const chunk = await reader.read(chunkSize)
      if (!chunk || chunk.length === 0) break

      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': mediaType,
          'x-amz-acl': 'private',
          'Content-Length': String(chunk.length)
        },
        body: chunk,
        // @ts-ignore — Node 18 fetch needs duplex for streaming bodies
        duplex: 'half'
      })
      if (!res.ok) throw new Error(`Frame.io upload chunk failed (${res.status}): ${await res.text()}`)

      bytesWritten += chunk.length
      if (onProgress) onProgress(bytesWritten)
    }
  }

  async mkdir(path: string): Promise<void> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''

    let parentNode = this.nodes.get(parentPath)
    if (!parentNode) {
      await this.list(parentPath)
      parentNode = this.nodes.get(parentPath)
      if (!parentNode) throw new Error(`Parent not found: ${parentPath}`)
    }
    const folderId = parentNode.kind === 'project'
      ? (parentNode.rootFolderId ?? parentNode.id)
      : parentNode.id

    const res = await this.req<FioResponse<FioAsset>>(
      'POST',
      `/v4/accounts/${accountId}/folders/${folderId}/folders`,
      { data: { name } }
    )
    this.nodes.set(p, { id: res.data.id, kind: 'folder' })
  }

  async createFile(path: string): Promise<void> {
    // Frame.io files are always created with writeFile (requires size); no-op for zero-byte placeholder
  }

  async delete(path: string, kind: 'file' | 'directory'): Promise<void> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const node = this.nodes.get(p)
    if (!node) return
    if (kind === 'file') {
      await this.req<void>('DELETE', `/v4/accounts/${accountId}/files/${node.id}`)
    } else {
      await this.req<void>('DELETE', `/v4/accounts/${accountId}/folders/${node.id}`)
    }
    this.nodes.delete(p)
  }

  async rename(path: string, newName: string): Promise<void> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const node = this.nodes.get(p)
    if (!node) throw new Error(`Cannot rename — path not cached: ${p}`)
    const endpoint = node.kind === 'file'
      ? `/v4/accounts/${accountId}/files/${node.id}`
      : `/v4/accounts/${accountId}/folders/${node.id}`
    await this.req('PATCH', endpoint, { data: { name: newName } })
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    this.nodes.delete(p)
    this.nodes.set(posix.join(parentPath, newName), node)
  }

  async exists(path: string): Promise<boolean> {
    const p = this.norm(path)
    if (this.nodes.has(p)) return true
    try {
      await this.stat(p)
      return true
    } catch {
      return false
    }
  }

  join(...segments: string[]): string {
    return posix.join(...segments).replace(/^\//, '')
  }

  parent(path: string): string | null {
    const p = this.norm(path)
    if (!p) return null
    const idx = p.lastIndexOf('/')
    return idx >= 0 ? p.slice(0, idx) : ''
  }

  async test(): Promise<ConnectionTestResult> {
    try {
      const accountId = await this.getAccountId()
      const res = await this.req<FioResponse<FioMe>>('GET', '/v4/me')
      const name = res.data.name || res.data.email || accountId
      return { ok: true, message: `Connected as ${name}` }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}

/**
 * Buffers a Readable stream N bytes at a time so chunks can be uploaded
 * to individual presigned URLs in order without loading the full file into memory.
 */
class ChunkedReader {
  private buf = Buffer.alloc(0)
  private iter: AsyncIterator<Buffer | Uint8Array>
  private done = false

  constructor(stream: Readable) {
    this.iter = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | Uint8Array>
  }

  async read(n: number): Promise<Buffer | null> {
    while (!this.done && this.buf.length < n) {
      const { value, done } = await this.iter.next()
      if (done) { this.done = true; break }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      this.buf = Buffer.concat([this.buf, chunk])
    }
    if (this.buf.length === 0) return null
    const out = this.buf.slice(0, n)
    this.buf = this.buf.slice(n)
    return out
  }
}
