import { Readable } from 'stream'
import { ReadStream, promises as fsp } from 'fs'
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

/** Pull the human-readable `errors[].detail` out of a Frame.io error body, if it has one. */
function apiErrorDetail(body: string): string {
  try {
    const errs = (JSON.parse(body) as { errors?: Array<{ title?: string; detail?: string }> }).errors
    const msg = errs?.map((e) => [e.title, e.detail].filter(Boolean).join(' — ')).filter(Boolean).join('; ')
    if (msg) return msg
  } catch {
    // not JSON — fall through to the raw body
  }
  return body
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
              ...(body != null ? { 'Content-Type': 'application/json' } : {}),
              'x-api-version': '4'
            },
            body: body != null ? JSON.stringify(body) : undefined
          })
        },
        { onUnauthorized: () => { this.tokens = null }, maxAttempts: 6, rateLimitOnly: method !== 'GET' }
      )
      if (!res.ok) throw new Error(`Frame.io ${res.status} ${method} ${path}: ${apiErrorDetail(await res.text())}`)
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

    // Resolve (creating any missing folders along the way) the destination folder.
    // Folder uploads reach here for files whose folder doesn't exist in Frame.io yet.
    if (parentPath === '') throw new Error('Choose a workspace and project to upload into — files cannot go at the Frame.io root.')
    await this.ensureFolder(parentPath)
    const parentNode = this.nodes.get(parentPath)
    if (!parentNode) throw new Error(`Destination folder not found: ${parentPath}`)
    if (parentNode.kind === 'workspace') throw new Error('Open a project (or a folder inside it) to upload into — files cannot go directly in a workspace.')
    if (parentNode.kind === 'stack') throw new Error('Cannot upload into a Frame.io version stack — upload to its parent folder instead.')
    const folderId = parentNode.kind === 'project'
      ? (parentNode.rootFolderId ?? parentNode.id)
      : parentNode.id

    if (!(size > 0)) {
      const err = new Error('Frame.io cannot store empty (0-byte) files') as Error & { code?: string }
      err.code = 'NOT_READY' // reported as a skip, not a failure
      throw err
    }

    await this.uploadBody(accountId, folderId, p, name, body, size, onProgress)
  }

  private async uploadBody(
    accountId: string,
    folderId: string,
    p: string,
    name: string,
    body: Readable,
    size: number,
    onProgress?: (bytesWritten: number) => void
  ): Promise<void> {
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

    // Step 2: Parallel chunk upload. Each chunk's byte range comes straight from the
    // presigned URL sizes Frame.io returned.
    //  - Local file source: each chunk is read from disk by byte offset, only while its
    //    PUT is running, and re-read on retry (no sequential read-through, no buffer held
    //    between attempts).
    //  - Any other source (e.g. Wasabi → Frame.io): the stream is cut into chunks in order.
    // Either way, chunk memory is reserved from a shared budget so parallel transfers
    // can't exhaust RAM.
    const PARALLEL = 5
    const diskPath = localSourcePath(body)
    const reader = diskPath ? null : new ChunkedReader(body)
    const chunkBytes = new Array(uploadUrls.length).fill(0)
    const inFlight: Promise<void>[] = []
    let failure: Error | null = null
    let offset = 0

    const putChunk = async (getData: () => Promise<Buffer>, url: string, i: number): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        try {
          const chunkData = await getData()
          const res = await fetch(url, {
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
          if (res.ok) { chunkBytes[i] = chunkData.length; return }
          const text = await res.text()
          if (attempt >= 4 || res.status < 500) throw Object.assign(new Error(`Frame.io upload chunk ${i} failed (${res.status}): ${text}`), { fatal: true })
        } catch (err) {
          if (attempt >= 4 || (err as { fatal?: boolean }).fatal || (diskPath && body.destroyed)) throw err
        }
        await sleep(1000 * 2 ** (attempt - 1))
      }
    }

    try {
      for (let i = 0; i < uploadUrls.length; i++) {
        if (failure) break
        const { url, size: chunkSize } = uploadUrls[i]
        let len = chunkSize
        let data: Buffer | null = null
        if (diskPath) {
          len = Math.min(chunkSize, size - offset)
          if (len <= 0) break
          if (body.destroyed) throw new Error('canceled')
        }
        const reserved = await uploadMemory.acquire(len)
        if (!diskPath) {
          try {
            data = await reader!.read(chunkSize)
          } catch (err) {
            uploadMemory.release(reserved)
            throw err
          }
          if (!data || data.length === 0) { uploadMemory.release(reserved); break }
        }

        const start = offset
        offset += len
        const getData = diskPath
          ? () => readSlice(diskPath, start, len)
          : () => Promise.resolve(data!)
        const upload = putChunk(getData, url, i)
          .then(() => { if (onProgress) onProgress(chunkBytes.reduce((a, b) => a + b, 0)) })
          .catch((err) => { failure = failure ?? err })
          .finally(() => { data = null; uploadMemory.release(reserved) })
        inFlight.push(upload)

        // Once we hit the concurrency limit, wait for the oldest in-flight upload
        // to complete before dispatching the next chunk.
        if (inFlight.length >= PARALLEL) await inFlight.shift()
      }
      await Promise.all(inFlight)
    } finally {
      await Promise.allSettled(inFlight)
      if (diskPath) body.destroy()
    }
    if (failure) throw failure
    const sent = chunkBytes.reduce((a, b) => a + b, 0)
    if (sent !== size) throw new Error(`Frame.io upload of "${name}" incomplete: sent ${sent} of ${size} bytes`)

    // Step 3: Confirm Frame.io has assembled the file.
    await this.confirmUpload(accountId, fileId, name)
  }

  /** Set once Frame.io rejects remote uploads outright (e.g. not enabled), so we stop trying. */
  private remoteUploadUnavailable = false

  /**
   * Remote upload: Frame.io downloads the file from `url` itself, so nothing passes
   * through this computer. Returns false (leaving nothing behind) whenever the caller
   * should fall back to a normal chunked upload.
   */
  async importFromUrl(
    path: string,
    url: string,
    size: number,
    onProgress: ((bytesWritten: number) => void) | undefined,
    isCanceled: () => boolean
  ): Promise<boolean> {
    if (this.remoteUploadUnavailable || !(size > 0)) return false
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (parentPath === '') return false
    await this.ensureFolder(parentPath)
    const parentNode = this.nodes.get(parentPath)
    if (!parentNode || parentNode.kind === 'workspace' || parentNode.kind === 'stack') return false
    const folderId = parentNode.kind === 'project' ? (parentNode.rootFolderId ?? parentNode.id) : parentNode.id

    let fileId: string
    try {
      const res = await this.req<FioResponse<FioAsset>>(
        'POST',
        `/v4/accounts/${accountId}/folders/${folderId}/files/remote_upload`,
        { data: { name, source_url: url } }
      )
      fileId = res.data.id
    } catch (err) {
      const msg = (err as Error).message
      if (/\b(403|404|405)\b/.test(msg)) this.remoteUploadUnavailable = true
      log.warn('transfer', `Frame.io remote upload not available for "${name}" (${msg.replace(/https?:\/\/\S+/g, '<url>')}) — falling back to normal upload`)
      return false
    }

    const discard = async (): Promise<void> => {
      try { await this.req('DELETE', `/v4/accounts/${accountId}/files/${fileId}`) } catch { /* best effort */ }
    }

    // Frame.io is now pulling the file. Poll until it reports success or failure.
    const startedAt = Date.now()
    const deadline = startedAt + Math.max(30 * 60_000, (size / (1024 * 1024)) * 1000 * 2) // ≥ 30 min, or 2 s per MB
    let errors = 0
    for (let wait = 1000; ; wait = Math.min(wait * 1.5, 8000)) {
      if (isCanceled()) { await discard(); throw new Error('canceled') }
      await sleep(wait)
      try {
        const res = await this.req<{ data?: { upload_complete?: boolean; upload_failed?: boolean } }>(
          'GET', `/v4/accounts/${accountId}/files/${fileId}/status`
        )
        errors = 0
        if (res.data?.upload_complete) {
          // Verify from Frame.io's side that it holds exactly the bytes we expect.
          let stored: number | undefined
          try {
            stored = (await this.req<FioResponse<FioAsset>>('GET', `/v4/accounts/${accountId}/files/${fileId}`)).data.file_size
          } catch { /* size is best-effort; completion was already confirmed */ }
          if (stored && stored !== size) {
            log.warn('transfer', `Frame.io stored ${stored} bytes for "${name}" but ${size} were expected — falling back to normal upload`)
            await discard()
            return false
          }
          this.nodes.set(p, { id: fileId, kind: 'file' })
          onProgress?.(size)
          return true
        }
        if (res.data?.upload_failed) {
          log.warn('transfer', `Frame.io could not fetch "${name}" directly — falling back to normal upload`)
          await discard()
          return false
        }
      } catch (err) {
        if (++errors >= 5) {
          log.warn('transfer', `Lost track of Frame.io remote upload of "${name}": ${(err as Error).message} — falling back to normal upload`)
          await discard()
          return false
        }
      }
      if (Date.now() > deadline) {
        log.warn('transfer', `Frame.io remote upload of "${name}" timed out — falling back to normal upload`)
        await discard()
        return false
      }
    }
  }

  /**
   * Poll the file's upload status until Frame.io reports it complete. A reported
   * failure is an error; an unreachable status endpoint or a slow assembly only
   * logs a warning (the bytes were all accepted), so it can't fail a good upload.
   */
  private async confirmUpload(accountId: string, fileId: string, name: string): Promise<void> {
    const deadline = Date.now() + 90_000
    for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
      try {
        const res = await this.req<{ data?: { upload_complete?: boolean; upload_failed?: boolean } }>(
          'GET',
          `/v4/accounts/${accountId}/files/${fileId}/status`
        )
        if (res.data?.upload_failed) throw Object.assign(new Error(`Frame.io reported the upload of "${name}" failed — try again`), { fatal: true })
        if (res.data?.upload_complete) return
      } catch (err) {
        if ((err as { fatal?: boolean }).fatal) throw err
        log.warn('transfer', `Could not confirm Frame.io upload status for "${name}": ${(err as Error).message}`)
        return
      }
      if (Date.now() + wait > deadline) {
        log.warn('transfer', `Frame.io had not finished assembling "${name}" after 90s; continuing`)
        return
      }
      await sleep(wait)
    }
  }

  /**
   * Create a container at `path`. What that means depends on where it is:
   *   - account root  → a new workspace
   *   - in a workspace → a new project
   *   - in a project / folder → a new folder
   */
  /** Folder paths currently being resolved/created, so parallel transfers share one creation. */
  private folderOps = new Map<string, Promise<void>>()

  /**
   * Make sure the folder/project at `path` exists, creating missing folders and
   * projects. Safe under parallel transfers (one creation per path). Workspaces are
   * never created implicitly — a missing one is almost certainly a typo.
   */
  private ensureFolder(path: string): Promise<void> {
    const p = this.norm(path)
    if (!p || this.nodes.has(p)) return Promise.resolve()
    const running = this.folderOps.get(p)
    if (running) return running
    const op = (async () => {
      const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
      if (parentPath) await this.ensureFolder(parentPath)
      // Refresh the parent's listing: the item may exist but not be cached yet.
      await this.list(parentPath)
      if (this.nodes.has(p)) return
      if (!parentPath) throw new Error(`Workspace not found: ${p}`)
      await this.createContainer(p)
    })().finally(() => this.folderOps.delete(p))
    this.folderOps.set(p, op)
    return op
  }

  /**
   * Create a container at `path` (no-op if it already exists, since Frame.io would
   * otherwise happily make a duplicate). What that means depends on where it is:
   *   - account root  → a new workspace
   *   - in a workspace → a new project
   *   - in a project / folder → a new folder
   */
  async mkdir(path: string): Promise<void> {
    const p = this.norm(path)
    if (!p) throw new Error('Folder name is required')
    if (this.nodes.has(p)) return
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (parentPath) await this.ensureFolder(parentPath)
    await this.list(parentPath)
    if (this.nodes.has(p)) return
    const running = this.folderOps.get(p)
    if (running) return running
    const op = this.createContainer(p).finally(() => this.folderOps.delete(p))
    this.folderOps.set(p, op)
    return op
  }

  private async createContainer(p: string): Promise<void> {
    const accountId = await this.getAccountId()
    const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''

    if (parentPath === '') {
      const res = await this.req<FioResponse<FioWorkspace>>(
        'POST', `/v4/accounts/${accountId}/workspaces`, { data: { name } }
      )
      this.nodes.set(name, { id: res.data.id, kind: 'workspace' })
      return
    }

    const parentNode = this.nodes.get(parentPath)
    if (!parentNode) throw new Error(`Parent not found: ${parentPath}`)
    if (parentNode.kind === 'stack') throw new Error('Cannot create a folder inside a Frame.io version stack.')
    if (parentNode.kind === 'file') throw new Error(`"${parentPath}" is a file, not a folder.`)

    if (parentNode.kind === 'workspace') {
      const res = await this.req<FioResponse<FioProject>>(
        'POST', `/v4/accounts/${accountId}/workspaces/${parentNode.id}/projects`, { data: { name } }
      )
      this.nodes.set(p, { id: res.data.id, kind: 'project', rootFolderId: res.data.root_folder_id })
      return
    }

    const folderId = parentNode.kind === 'project'
      ? (parentNode.rootFolderId ?? parentNode.id)
      : parentNode.id
    const res = await this.req<FioResponse<FioAsset>>(
      'POST', `/v4/accounts/${accountId}/folders/${folderId}/folders`, { data: { name } }
    )
    this.nodes.set(p, { id: res.data.id, kind: 'folder' })
  }

  async createFile(path: string): Promise<void> {
    throw new Error('Frame.io files are created by uploading — drag a file in or transfer one from another connection.')
  }

  async delete(path: string, _kind: 'file' | 'directory'): Promise<void> {
    const p = this.norm(path)
    const accountId = await this.getAccountId()
    let node = this.nodes.get(p)
    if (!node) {
      // Not cached (e.g. Conduit restarted) — list the parent so we can resolve its ID.
      const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
      await this.list(parentPath)
      node = this.nodes.get(p)
    }
    if (!node) throw Object.assign(new Error(`Not found in Frame.io: ${p}`), { code: 'ENOENT' })

    switch (node.kind) {
      case 'workspace':
        await this.req<void>('DELETE', `/v4/accounts/${accountId}/workspaces/${node.id}`)
        break
      case 'stack':
        throw new Error('Deleting a Frame.io version stack from Conduit is not supported — delete it in Frame.io.')
      case 'project':
        await this.req<void>('DELETE', `/v4/accounts/${accountId}/projects/${node.id}`)
        break
      case 'folder':
        await this.req<void>('DELETE', `/v4/accounts/${accountId}/folders/${node.id}`)
        break
      default:
        await this.req<void>('DELETE', `/v4/accounts/${accountId}/files/${node.id}`)
    }
    // Drop this path and anything cached beneath it.
    for (const key of [...this.nodes.keys()]) {
      if (key === p || key.startsWith(`${p}/`)) this.nodes.delete(key)
    }
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
  private parts: Buffer[] = []
  private len = 0
  private iter: AsyncIterator<Buffer | Uint8Array>
  private done = false

  constructor(stream: Readable) {
    this.iter = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | Uint8Array>
  }

  async read(n: number): Promise<Buffer | null> {
    // Collect pieces and concatenate once; re-concatenating per 64 KB read is quadratic.
    while (!this.done && this.len < n) {
      const { value, done } = await this.iter.next()
      if (done) { this.done = true; break }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      this.parts.push(chunk)
      this.len += chunk.length
    }
    if (this.len === 0) return null
    const all = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.len)
    const take = Math.min(n, all.length)
    // Copy so the returned chunk doesn't pin the larger buffer once uploaded.
    const out = Buffer.from(all.subarray(0, take))
    const rest = all.subarray(take)
    this.parts = rest.length ? [rest] : []
    this.len = rest.length
    return out
  }
}

/** The local file path behind a stream, when it is an unconsumed read from byte 0 of a local file. */
function localSourcePath(body: Readable): string | null {
  if (!(body instanceof ReadStream) || typeof body.path !== 'string') return null
  if ((body as unknown as { start?: number }).start) return null
  return body.path
}

async function readSlice(path: string, start: number, len: number): Promise<Buffer> {
  const fh = await fsp.open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(len)
    let got = 0
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, start + got)
      if (bytesRead === 0) throw new Error(`File changed while uploading: expected ${len} bytes at offset ${start}, got ${got}`)
      got += bytesRead
    }
    return buf
  } finally {
    await fh.close()
  }
}

/** Total memory Frame.io upload chunks may hold at once, across all parallel transfers. */
const UPLOAD_MEMORY_BUDGET = 384 * 1024 * 1024

/** Byte budget shared by every in-flight Frame.io chunk, across all transfers. */
class ByteBudget {
  private waiters: Array<{ n: number; run: () => void }> = []
  constructor(private free: number, private readonly total: number) {}
  async acquire(n: number): Promise<number> {
    n = Math.min(Math.max(n, 1), this.total)
    if (this.free >= n && !this.waiters.length) { this.free -= n; return n }
    await new Promise<void>((run) => this.waiters.push({ n, run }))
    return n
  }
  release(n: number): void {
    this.free += n
    while (this.waiters.length && this.free >= this.waiters[0].n) {
      const w = this.waiters.shift()!
      this.free -= w.n
      w.run()
    }
  }
}

const uploadMemory = new ByteBudget(UPLOAD_MEMORY_BUDGET, UPLOAD_MEMORY_BUDGET)
