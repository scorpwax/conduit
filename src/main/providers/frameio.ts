import { Readable } from 'stream'
import { posix } from 'path'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, FrameIoConfig, FolderSizeResult } from '@shared/types'
import type { Provider } from './types'
import { log } from '../logger'
import { withRetry, sleep } from './cloudHttp'
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

type NodeKind = 'workspace' | 'project' | 'folder' | 'stack' | 'file'
interface CacheNode {
  id: string
  kind: NodeKind
  /** For projects: the root folder ID needed to list the project's top-level assets. */
  rootFolderId?: string
}

/**
 * Thrown when a file exists but Frame.io has no downloadable original for it yet
 * (still processing, watermark-enforced, no download permission). The transfer
 * engine recognizes `code === 'NOT_READY'` and logs a skip instead of a hard failure.
 */
export class FrameNotReadyError extends Error {
  readonly code = 'NOT_READY'
}

/** Max simultaneous Frame.io API calls per connection (bulk transfers fan out wide). */
const MAX_API_CONCURRENCY = 4

/** Common structure Frame.io wraps all responses in. */
interface FioResponse<T> { data: T; links?: { next?: string } }

interface FioAsset {
  id: string
  name: string
  type: 'file' | 'folder' | 'version_stack'
  file_size?: number
  updated_at?: string
  inserted_at?: string
  /** Processing state, e.g. 'created' | 'uploaded' | 'transcoded' | 'failed'. */
  status?: string
  /**
   * V4 only returns media links when requested with `?include=media_links.original`.
   * URLs are signed and expire after ~24h, so fetch a fresh one per transfer.
   * Fields are null while processing, when watermarking is enforced, or when the
   * caller lacks download permission.
   */
  media_links?: { original?: { download_url?: string | null; inline_url?: string | null } | null }
  /** Upload URLs returned when creating a file placeholder. */
  /** Version stacks: the current (top) version, when present. */
  head_version?: { file_size?: number } | null
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

  private refreshing: Promise<OAuthTokens> | null = null
  private apiActive = 0
  private apiWaiters: Array<() => void> = []

  private async token(): Promise<string> {
    if (this.tokens && this.tokens.expiresAt > Date.now() + 60_000) return this.tokens.accessToken
    if (!this.cfg.refreshToken) throw new Error('Not authorized — connect this Frame.io account first.')
    // Many parallel transfers can hit an expired token at once. Share one refresh —
    // Adobe may rotate refresh tokens, so concurrent refreshes risk invalidating each other.
    if (!this.refreshing) {
      this.refreshing = refreshTokens(FRAMEIO_OAUTH, this.cfg.refreshToken).finally(() => { this.refreshing = null })
    }
    this.tokens = await this.refreshing
    return this.tokens.accessToken
  }

  private async apiSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.apiActive >= MAX_API_CONCURRENCY) await new Promise<void>((r) => this.apiWaiters.push(r))
    this.apiActive++
    try {
      return await fn()
    } finally {
      this.apiActive--
      this.apiWaiters.shift()?.()
    }
  }

  /**
   * Call the Frame.io API. Calls are capped at MAX_API_CONCURRENCY in flight per
   * connection, and GETs retry on 429/5xx/network errors with backoff. Writes
   * (POST/PATCH/DELETE) are not retried, to avoid duplicate side effects; a 401
   * always triggers one token refresh + retry.
   */
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${API}${path}`
    return this.apiSlot(async () => {
      const res = await withRetry(
        async () => {
          const tok = await this.token()
          return fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${tok}`,
              'Content-Type': 'application/json',
              'x-api-version': '4'
            },
            body: body != null ? JSON.stringify(body) : undefined
          })
        },
        { onUnauthorized: () => { this.tokens = null }, maxAttempts: method === 'GET' ? 6 : 1 }
      )
      if (!res.ok) throw new Error(`Frame.io ${res.status} ${method} ${path}: ${await res.text()}`)
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    })
  }

  private async getAccountId(): Promise<string> {
    if (this.accountId) return this.accountId
    const res = await this.req<FioResponse<FioAccount[]>>('GET', '/v4/accounts')
    const accounts = res.data
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
      // Deduplicate workspace names: if two workspaces share a name, append (2), (3), etc.
      const nameCounts = new Map<string, number>()
      const entries: FileEntry[] = workspaces.map(ws => {
        const count = (nameCounts.get(ws.name) ?? 0) + 1
        nameCounts.set(ws.name, count)
        const displayName = count === 1 ? ws.name : `${ws.name} (${count})`
        this.nodes.set(displayName, { id: ws.id, kind: 'workspace' })
        return { name: displayName, path: displayName, kind: 'directory', size: 0, modified: ws.updated_at ?? null }
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
      // Deduplicate project names within this workspace
      const projNameCounts = new Map<string, number>()
      const entries: FileEntry[] = projects.map(proj => {
        const count = (projNameCounts.get(proj.name) ?? 0) + 1
        projNameCounts.set(proj.name, count)
        const displayName = count === 1 ? proj.name : `${proj.name} (${count})`
        const projPath = `${parts[0]}/${displayName}`
        this.nodes.set(projPath, { id: proj.id, kind: 'project', rootFolderId: proj.root_folder_id })
        return { name: displayName, path: projPath, kind: 'directory', size: 0, modified: proj.updated_at ?? null }
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

    // Version stack: list its versions (shown as a folder of files)
    if (node?.kind === 'stack') {
      return this.listFolder(p, accountId, node.id, 'version_stacks')
    }

    // Unknown path — try to resolve by listing parent then retry
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    await this.list(parentPath)
    const resolved = this.nodes.get(p)
    if (!resolved) throw new Error(`Path not found: ${p}`)
    return this.list(path)
  }

  /**
   * List a folder's (or version stack's) children. Version stacks are surfaced as
   * directories containing their versions, so they can be browsed and transferred
   * like any other folder instead of appearing as 0-byte files that can't download.
   */
  private async listFolder(
    parentPath: string, accountId: string, folderId: string, parentType: 'folders' | 'version_stacks' = 'folders'
  ): Promise<ListResult> {
    const assets = await this.reqAll<FioAsset>(`/v4/accounts/${accountId}/${parentType}/${folderId}/children`)
    // Frame.io allows several items with the same name in one folder. Disambiguate
    // ("clip (2).mov") — otherwise they share one path, the cache keeps only the last
    // one, and the transfer queue silently drops the duplicates as "already queued".
    const seen = new Map<string, number>()
    const entries: FileEntry[] = assets.map(asset => {
      const n = (seen.get(asset.name) ?? 0) + 1
      seen.set(asset.name, n)
      let name = asset.name
      if (n > 1) {
        const dot = asset.type === 'file' ? name.lastIndexOf('.') : -1
        name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
      }
      const assetPath = `${parentPath}/${name}`
      const kind: NodeKind = asset.type === 'folder' ? 'folder' : asset.type === 'version_stack' ? 'stack' : 'file'
      this.nodes.set(assetPath, { id: asset.id, kind })
      return {
        name,
        path: assetPath,
        kind: kind === 'file' ? 'file' : 'directory',
        size: kind === 'file' ? (asset.file_size ?? 0) : 0,
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

  /**
   * Fetch a fresh signed download URL and open a ranged GET against it.
   * Signed URLs expire (~24h) and are single-purpose, so this is called again on
   * every reconnect rather than caching the URL.
   */
  private async openDownload(
    accountId: string, fileId: string, p: string, offset: number
  ): Promise<{ res: Response; size: number }> {
    // V4 requires `include=media_links.original` to get a download URL at all.
    // Retry with backoff in case the file really is still processing.
    const fileUrl = `/v4/accounts/${accountId}/files/${fileId}?include=media_links.original`
    let meta = await this.req<FioResponse<FioAsset>>('GET', fileUrl)
    let downloadUrl = meta.data.media_links?.original?.download_url
    // Short wait only: in a bulk transfer, unready files must not hog a transfer slot.
    for (const delay of [2000, 5000]) {
      if (downloadUrl || meta.data.status === 'failed') break
      await sleep(delay)
      meta = await this.req<FioResponse<FioAsset>>('GET', fileUrl)
      downloadUrl = meta.data.media_links?.original?.download_url
    }
    if (!downloadUrl) {
      const state = meta.data.status ? ` (Frame.io status: ${meta.data.status})` : ''
      throw new FrameNotReadyError(
        `Frame.io returned no download URL for "${p}"${state}. ` +
        `This happens while a file is still processing, when the project has watermarking enforced, ` +
        `or when your account lacks download permission on this project.`
      )
    }

    const headers: Record<string, string> = {}
    if (offset > 0) headers.Range = `bytes=${offset}-`
    // The signed URL carries its own auth — never send the bearer token to it.
    const res = await withRetry(() => fetch(downloadUrl!, { headers }))
    if (!res.ok) throw new Error(`Frame.io download ${res.status}: ${res.statusText}`)
    if (!res.body) throw new Error('Frame.io download returned no body')
    if (offset > 0 && res.status !== 206) {
      // A 200 would re-send the whole file from byte 0 and corrupt a resumed download.
      await res.body.cancel().catch(() => undefined)
      throw new Error(`Frame.io did not honor the resume request (HTTP ${res.status}) for "${p}"`)
    }
    const remaining = Number(res.headers.get('content-length') ?? 0)
    const size = meta.data.file_size ?? (remaining > 0 ? offset + remaining : 0)
    return { res, size }
  }

  async createReadStream(path: string, offset = 0): Promise<{ stream: Readable; size: number }> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const node = this.nodes.get(p)
    if (!node || node.kind !== 'file') throw new Error(`Not a file: ${p}`)
    const fileId = node.id

    // Initial open is eager so permission / processing errors surface immediately.
    const first = await this.openDownload(accountId, fileId, p, offset)
    const total = first.size
    const name = p.slice(p.lastIndexOf('/') + 1)

    // Self-healing stream: if the connection drops or the data ends short of the
    // file's size, fetch a fresh signed URL and resume with a Range request from
    // the last byte delivered. The consumer (e.g. a Wasabi multipart upload) just
    // sees one continuous stream. Gives up after MAX_STALLS consecutive failures
    // that made no progress.
    const MAX_STALLS = 8
    const self = this
    async function* healing(): AsyncGenerator<Uint8Array> {
      let pos = offset
      let stalls = 0
      let current: Response | null = first.res
      while (true) {
        try {
          if (!current) current = (await self.openDownload(accountId, fileId, p, pos)).res
          for await (const chunk of current.body as unknown as AsyncIterable<Uint8Array>) {
            pos += chunk.length
            stalls = 0
            yield chunk
          }
          if (total > 0 && pos < total) throw new Error(`stream ended at ${pos} of ${total} bytes`)
          return
        } catch (err) {
          current = null
          if (++stalls > MAX_STALLS) throw err
          log.warn('transfer', `Frame.io download of "${name}" interrupted at ${pos} bytes (${(err as Error).message}) — reconnecting (${stalls}/${MAX_STALLS})`)
          await sleep(Math.min(1000 * 2 ** (stalls - 1), 30_000))
        }
      }
    }

    return { stream: Readable.from(healing()), size: total }
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
    if (parentNode.kind === 'stack') throw new Error('Cannot upload into a Frame.io version stack — upload to its parent folder instead.')
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

    // Step 2: Sliding-window parallel upload.
    // Read one chunk at a time and immediately dispatch its upload, keeping up
    // to PARALLEL PUTs in-flight simultaneously. This way uploads start as soon
    // as the first chunk is read — no need to buffer the entire file first.
    const PARALLEL = 8
    const reader = new ChunkedReader(body)
    const chunkBytes = new Array(uploadUrls.length).fill(0)
    const inFlight: Promise<void>[] = []
    let chunkIdx = 0

    for (const { url, size: chunkSize } of uploadUrls) {
      const data = await reader.read(chunkSize)
      if (!data || data.length === 0) break

      const idx = chunkIdx++
      const upload = (async (chunkData: Buffer, chunkUrl: string, chunkI: number) => {
        const res = await fetch(chunkUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': mediaType,
            'x-amz-acl': 'private',
            'Content-Length': String(chunkData.length)
          },
          body: chunkData,
          // @ts-ignore — Node 18 fetch needs duplex for streaming bodies
          duplex: 'half'
        })
        if (!res.ok) throw new Error(`Frame.io upload chunk ${chunkI} failed (${res.status}): ${await res.text()}`)
        chunkBytes[chunkI] = chunkData.length
        if (onProgress) onProgress(chunkBytes.reduce((a, b) => a + b, 0))
      })(data, url, idx)

      inFlight.push(upload)

      // Once we hit the concurrency limit, wait for the oldest in-flight upload
      // to complete before reading (and dispatching) the next chunk.
      if (inFlight.length >= PARALLEL) {
        await inFlight.shift()
      }
    }

    // Drain any remaining in-flight uploads.
    await Promise.all(inFlight)
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
    if (parentNode.kind === 'stack') throw new Error('Cannot create a folder inside a Frame.io version stack.')
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
    if (node.kind === 'stack') throw new Error('Deleting a Frame.io version stack from Conduit is not supported — delete it in Frame.io.')
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
    if (node.kind === 'stack') throw new Error('Renaming a Frame.io version stack from Conduit is not supported.')
    const endpoint = node.kind === 'file'
      ? `/v4/accounts/${accountId}/files/${node.id}`
      : `/v4/accounts/${accountId}/folders/${node.id}`
    await this.req('PATCH', endpoint, { data: { name: newName } })
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    this.nodes.delete(p)
    this.nodes.set(posix.join(parentPath, newName), node)
  }

  async folderSize(path: string): Promise<FolderSizeResult | null> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()

    let node = this.nodes.get(p)
    if (!node) {
      await this.list(p)
      node = this.nodes.get(p)
    }
    if (!node) return null

    // Collect the root folder IDs to kick off the BFS.
    // For a workspace: list all projects, collect each project's root folder.
    // For a project: resolve its root folder.
    // For a regular folder: use directly.
    const rootFolderIds: string[] = []

    if (node.kind === 'workspace') {
      const projects = await this.reqAll<FioProject>(
        `/v4/accounts/${accountId}/workspaces/${node.id}/projects`
      )
      await Promise.all(projects.map(async (proj) => {
        const rootId = proj.root_folder_id ?? (
          await this.req<FioResponse<FioProject>>('GET', `/v4/accounts/${accountId}/projects/${proj.id}`)
        ).data.root_folder_id
        if (rootId) rootFolderIds.push(rootId)
      }))
    } else if (node.kind === 'project') {
      if (!node.rootFolderId) {
        const proj = await this.req<FioResponse<FioProject>>(
          'GET', `/v4/accounts/${accountId}/projects/${node.id}`
        )
        node.rootFolderId = proj.data.root_folder_id
      }
      if (node.rootFolderId) rootFolderIds.push(node.rootFolderId)
    } else {
      rootFolderIds.push(node.id)
    }

    if (rootFolderIds.length === 0) return null

    // BFS across all root folders, accumulating file sizes.
    let totalSize = 0
    let latestMs = 0
    const queue: Array<{ id: string; stack?: boolean }> = rootFolderIds.map(id => ({ id }))

    while (queue.length > 0) {
      const batch = queue.splice(0, 5)
      await Promise.all(batch.map(async ({ id, stack }) => {
        const assets = await this.reqAll<FioAsset>(
          `/v4/accounts/${accountId}/${stack ? 'version_stacks' : 'folders'}/${id}/children`
        )
        for (const asset of assets) {
          if (asset.type === 'folder') {
            queue.push({ id: asset.id })
          } else if (asset.type === 'version_stack') {
            queue.push({ id: asset.id, stack: true })
          } else {
            totalSize += asset.file_size ?? 0
            const ms = asset.updated_at ? new Date(asset.updated_at).getTime() : 0
            if (ms > latestMs) latestMs = ms
          }
        }
      }))
    }

    return { size: totalSize, junkBytes: 0, latestModified: latestMs > 0 ? new Date(latestMs).toISOString() : null }
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
