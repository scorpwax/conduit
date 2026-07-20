import { Readable, Transform } from 'stream'
import http from 'http'
import https from 'https'
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, S3Config, TreeNode, FolderTreeResult } from '@shared/types'
import type { Provider } from './types'

/** Real AWS region ids — used to flag likely S3-compatible configs missing an endpoint. */
const AWS_REGIONS = new Set([
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'af-south-1', 'ap-east-1', 'ap-south-1', 'ap-south-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ca-central-1', 'ca-west-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'il-central-1', 'me-south-1', 'me-central-1', 'sa-east-1'
])

/**
 * S3 provider. Paths are object keys within the bucket, using '/' separators.
 * "Directories" are synthesized from common prefixes; a zero-byte key ending
 * in '/' acts as an explicit folder marker (created by mkdir).
 */
export class S3Provider implements Provider {
  private client: S3Client
  private cfg: S3Config

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as S3Config
    // Keep-alive agent: reuses TLS connections across requests to the same host,
    // cutting the ~1-3s cold-start delay on every new transfer.
    // maxSockets 25: multipart uploads run queueSize=2 parts per file; with the
    // default concurrency of 5 files that's up to 10 simultaneous part requests
    // plus headroom for list/stat/mkdir calls.
    const agent = new https.Agent({ keepAlive: true, maxSockets: 25 })
    this.client = new S3Client({
      region: this.cfg.region,
      endpoint: this.cfg.endpoint || undefined,
      forcePathStyle: this.cfg.forcePathStyle ?? !!this.cfg.endpoint,
      credentials: {
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey
      },
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 10_000,
        socketTimeout: 0,
        httpsAgent: agent,
        httpAgent: agent as unknown as http.Agent
      })
    })
  }

  /** Normalize a folder prefix to end with a single slash (or be empty). */
  private asPrefix(path: string): string {
    const p = (path || this.cfg.prefix || '').replace(/^\/+/, '')
    if (p === '') return ''
    return p.endsWith('/') ? p : p + '/'
  }

  async list(path: string): Promise<ListResult> {
    const Prefix = this.asPrefix(path)
    const entries: FileEntry[] = []
    let ContinuationToken: string | undefined

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix,
          Delimiter: '/',
          ContinuationToken
        })
      )

      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue
        const name = cp.Prefix.slice(Prefix.length).replace(/\/$/, '')
        if (!name) continue
        entries.push({
          name,
          path: cp.Prefix.replace(/\/$/, ''),
          kind: 'directory',
          size: 0,
          modified: null
        })
      }

      for (const obj of res.Contents ?? []) {
        if (!obj.Key || obj.Key === Prefix) continue // skip the folder marker itself
        const name = obj.Key.slice(Prefix.length)
        if (!name || name.endsWith('/')) continue // nested marker
        entries.push({
          name,
          path: obj.Key,
          kind: 'file',
          size: obj.Size ?? 0,
          modified: obj.LastModified ? obj.LastModified.toISOString() : null
        })
      }

      ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (ContinuationToken)

    // Folders first, then files, each alphabetical.
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return { path: Prefix.replace(/\/$/, ''), entries }
  }

  async stat(path: string): Promise<FileEntry> {
    const key = path.replace(/^\/+/, '').replace(/\/$/, '')
    const name = key.split('/').pop() || key

    // 1. Try as an exact file object.
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key })
      )
      return {
        name,
        path: key,
        kind: 'file',
        size: res.ContentLength ?? 0,
        modified: res.LastModified ? res.LastModified.toISOString() : null
      }
    } catch { /* not a file — fall through */ }

    // 2. Try as an explicit folder marker (key + '/').
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key + '/' })
      )
      return { name, path: key, kind: 'directory', size: 0, modified: null }
    } catch { /* no marker — check if it's a virtual prefix */ }

    // 3. Any objects under this prefix → it's a virtual directory.
    const prefix = key + '/'
    const res = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, MaxKeys: 1 })
    )
    if ((res.KeyCount ?? 0) > 0) {
      return { name, path: key, kind: 'directory', size: 0, modified: null }
    }

    throw Object.assign(new Error(`Not found: ${key}`), { code: 'ENOENT' })
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    const key = path.replace(/^\/+/, '')
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key })
    )
    const stream = res.Body as Readable
    return { stream, size: res.ContentLength ?? 0 }
  }

  async writeFile(
    path: string,
    body: Readable,
    size: number,
    onProgress?: (bytesWritten: number) => void
  ): Promise<void> {
    const key = path.replace(/^\/+/, '')

    // Large files (>50 MB): multipart upload via @aws-sdk/lib-storage.
    // Each 16 MB part is acknowledged by the server independently — httpUploadProgress
    // fires after each ACK, so bytesDone advances as bytes are confirmed on the server
    // (not just buffered locally). This gives genuine, continuously-updating progress
    // with no extended "waiting for server" phase at the end.
    //
    // The S3CompatHandler on this.client strips the `Expires` header before
    // deserialization, fixing the Wasabi ISO 8601 header issue that previously caused
    // CreateMultipartUpload to fail.
    const MULTIPART_THRESHOLD = 50 * 1024 * 1024
    if (size > MULTIPART_THRESHOLD) {
      const upload = new Upload({
        client: this.client,
        params: { Bucket: this.cfg.bucket, Key: key, Body: body, ContentLength: size },
        partSize: 16 * 1024 * 1024,
        queueSize: 2,
        leavePartsOnError: false
      })
      if (onProgress) {
        upload.on('httpUploadProgress', (progress) => {
          if (progress.loaded != null) {
            try { onProgress(progress.loaded) } catch { /* renderer may have closed */ }
          }
        })
      }
      await upload.done()
      if (onProgress) try { onProgress(size) } catch {}
      return
    }

    // Small files (≤50 MB): single PutObjectCommand with a Transform for progress.
    // The Transform wraps the body so the SDK reads in paused mode (not flowing),
    // and counts bytes as they pass through to report progress.
    let uploadBody: Readable = body
    if (onProgress) {
      let written = 0
      const counter = new Transform({
        readableHighWaterMark: 256 * 1024,
        writableHighWaterMark: 256 * 1024,
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length
          try { onProgress(written) } catch { /* renderer may have closed */ }
          cb(null, chunk)
        }
      })
      body.on('error', (err) => counter.destroy(err))
      body.pipe(counter)
      uploadBody = counter
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: uploadBody,
        ContentLength: size > 0 ? size : undefined
      })
    )
  }

  async mkdir(path: string): Promise<void> {
    const key = this.asPrefix(path)
    if (!key) return
    await this.client.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: '' })
    )
  }

  async createFile(path: string): Promise<void> {
    const key = path.replace(/^\/+/, '')
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: '' }))
  }

  async delete(path: string, kind: 'file' | 'directory'): Promise<void> {
    const key = path.replace(/^\/+/, '')
    if (kind === 'file') {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      return
    }
    // Directory: delete every object under the prefix, in batches of 1000.
    const prefix = key.endsWith('/') ? key : key + '/'
    let ContinuationToken: string | undefined
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken })
      )
      const objects = (res.Contents ?? []).map((o) => ({ Key: o.Key! }))
      if (objects.length) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: objects } })
        )
      }
      ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (ContinuationToken)
  }

  /** Build a CopySource that keeps path separators but escapes each segment. */
  private copySource(key: string): string {
    return `${this.cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  async rename(path: string, newName: string): Promise<void> {
    const key = path.replace(/^\/+/, '')
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : ''

    // If an exact object exists it's a file; otherwise treat as a folder prefix.
    const isFile = await this.headExists(key)
    if (isFile) {
      const newKey = parent + newName
      await this.copyObject(key, newKey)
      await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      return
    }

    const oldPrefix = key.endsWith('/') ? key : key + '/'
    const newPrefix = parent + newName + '/'
    let ContinuationToken: string | undefined
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: oldPrefix, ContinuationToken })
      )
      for (const o of res.Contents ?? []) {
        const rel = o.Key!.slice(oldPrefix.length)
        await this.copyObject(o.Key!, newPrefix + rel, o.Size)
        await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: o.Key! }))
      }
      ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (ContinuationToken)
  }

  /**
   * Copy a single S3 object. Uses CopyObject for files ≤ 5 GB and multipart
   * copy for larger files (S3 rejects CopyObject above that limit).
   */
  private async copyObject(srcKey: string, dstKey: string, knownSize?: number): Promise<void> {
    const COPY_LIMIT = 5 * 1024 * 1024 * 1024 // 5 GB
    const PART_SIZE = 128 * 1024 * 1024        // 128 MB parts

    // Resolve size if not supplied by the caller.
    let size = knownSize
    if (size === undefined) {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: srcKey }))
      size = head.ContentLength ?? 0
    }

    if (size <= COPY_LIMIT) {
      await this.client.send(
        new CopyObjectCommand({ Bucket: this.cfg.bucket, CopySource: this.copySource(srcKey), Key: dstKey })
      )
      return
    }

    // Multipart copy for files > 5 GB.
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.cfg.bucket, Key: dstKey })
    )
    if (!UploadId) throw new Error('Failed to create multipart upload')

    const parts: { PartNumber: number; ETag: string }[] = []
    try {
      let offset = 0
      let partNumber = 1
      while (offset < size) {
        const end = Math.min(offset + PART_SIZE - 1, size - 1)
        const res = await this.client.send(
          new UploadPartCopyCommand({
            Bucket: this.cfg.bucket,
            Key: dstKey,
            UploadId,
            PartNumber: partNumber,
            CopySource: this.copySource(srcKey),
            CopySourceRange: `bytes=${offset}-${end}`
          })
        )
        parts.push({ PartNumber: partNumber, ETag: res.CopyPartResult?.ETag ?? '' })
        offset += PART_SIZE
        partNumber++
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.cfg.bucket,
          Key: dstKey,
          UploadId,
          MultipartUpload: { Parts: parts }
        })
      )
    } catch (err) {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.cfg.bucket, Key: dstKey, UploadId })
      ).catch(() => undefined)
      throw err
    }
  }

  async checksum(path: string): Promise<string | null> {
    const key = path.replace(/^\/+/, '')
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      return res.ETag ? res.ETag.replace(/"/g, '') : null
    } catch {
      return null
    }
  }

  async folderSize(path: string): Promise<{ size: number; latestModified: string | null } | null> {
    const prefix = path.replace(/^\/+/, '').replace(/\/$/, '') + '/'
    let totalSize = 0
    let latestMs = 0
    let ContinuationToken: string | undefined
    try {
      do {
        const res = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken })
        )
        for (const obj of res.Contents ?? []) {
          totalSize += obj.Size ?? 0
          const ms = obj.LastModified?.getTime() ?? 0
          if (ms > latestMs) latestMs = ms
        }
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (ContinuationToken)
    } catch {
      return null
    }
    return { size: totalSize, latestModified: latestMs > 0 ? new Date(latestMs).toISOString() : null }
  }

  async folderTree(path: string): Promise<FolderTreeResult> {
    const prefix = path.replace(/^\/+/, '').replace(/\/$/, '') + '/'
    const MAX = 25000
    const flat: Array<{ relKey: string; size: number; modified: string | null }> = []
    let ContinuationToken: string | undefined
    let truncated = false

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken })
      )
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue
        const relKey = obj.Key.slice(prefix.length)
        if (!relKey || relKey.endsWith('/')) continue // skip folder markers
        flat.push({ relKey, size: obj.Size ?? 0, modified: obj.LastModified?.toISOString() ?? null })
        if (flat.length >= MAX) { truncated = true; break }
      }
      ContinuationToken = res.IsTruncated && !truncated ? res.NextContinuationToken : undefined
    } while (ContinuationToken)

    // Reconstruct tree from flat key list
    const nodeMap = new Map<string, TreeNode>()
    const root: TreeNode[] = []
    let totalFiles = 0, totalFolders = 0, totalSize = 0

    for (const { relKey, size, modified } of flat) {
      const parts = relKey.split('/')
      let currentList = root
      let currentPath = ''

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isFile = i === parts.length - 1
        currentPath = currentPath ? `${currentPath}/${part}` : part

        if (isFile) {
          currentList.push({ name: part, kind: 'file', size, modified, children: [] })
          totalFiles++
          totalSize += size
        } else {
          let dir = nodeMap.get(currentPath)
          if (!dir) {
            dir = { name: part, kind: 'directory', size: 0, modified: null, children: [] }
            nodeMap.set(currentPath, dir)
            currentList.push(dir)
            totalFolders++
          }
          currentList = dir.children
        }
      }
    }

    function sortLevel(nodes: TreeNode[]): void {
      nodes.sort((a, b) => a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : a.name.localeCompare(b.name))
      for (const n of nodes) if (n.children.length) sortLevel(n.children)
    }
    sortLevel(root)

    return { tree: root, totalFiles, totalFolders, totalSize, truncated }
  }

  private async headExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      return true
    } catch {
      return false
    }
  }

  async exists(path: string): Promise<boolean> {
    const key = path.replace(/^\/+/, '')
    if (await this.headExists(key)) return true
    // Maybe it's a folder prefix with objects under it.
    const prefix = key.endsWith('/') ? key : key + '/'
    const res = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, MaxKeys: 1 })
    )
    return (res.KeyCount ?? 0) > 0
  }

  join(...segments: string[]): string {
    return segments
      .filter((s) => s !== '')
      .join('/')
      .replace(/\/{2,}/g, '/')
  }

  parent(path: string): string | null {
    const trimmed = path.replace(/\/$/, '')
    const root = (this.cfg.prefix || '').replace(/\/$/, '')
    if (trimmed === root || trimmed === '') return null
    const idx = trimmed.lastIndexOf('/')
    if (idx < 0) return ''
    const up = trimmed.slice(0, idx)
    return up.length < root.length ? root : up
  }

  async test(): Promise<ConnectionTestResult> {
    // Catch the most common misconfiguration before making a confusing DNS call:
    // a non-AWS region with no endpoint (e.g. Wasabi's us-central-1) would resolve
    // to a nonexistent AWS host.
    if (!this.cfg.endpoint && !AWS_REGIONS.has(this.cfg.region)) {
      return {
        ok: false,
        message: `“${this.cfg.region}” isn’t an AWS region. If this is Wasabi, Cloudflare R2, MinIO, etc., set the Endpoint (click the “Wasabi” button for Wasabi).`
      }
    }
    if (/wasabisys\.com|amazonaws\.com|\.r2\.|digitaloceanspaces/.test(this.cfg.bucket)) {
      return {
        ok: false,
        message: `The Bucket field looks like a server address. It should be just your bucket name — put “${this.cfg.bucket}” in the Endpoint field instead.`
      }
    }
    try {
      await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, MaxKeys: 1 })
      )
      return { ok: true, message: `Connected to ${this.cfg.bucket}` }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}
