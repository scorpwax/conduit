import { posix } from 'path'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'
import { createClient, type WebDAVClient } from 'webdav'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, WebdavConfig } from '@shared/types'
import type { Provider } from './types'

/**
 * WebDAV provider — works with Nextcloud, ownCloud, Box, Fastmail, and any
 * standard WebDAV server. Paths are server paths relative to the base URL.
 */
export class WebdavProvider implements Provider {
  private cfg: WebdavConfig
  private clientInstance: WebDAVClient | null = null

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as WebdavConfig
  }

  private client(): WebDAVClient {
    if (!this.clientInstance) {
      this.clientInstance = createClient(this.cfg.url, {
        username: this.cfg.username,
        password: this.cfg.password || ''
      })
    }
    return this.clientInstance
  }

  private resolve(path: string): string {
    if (path && path.length > 0) return path.startsWith('/') ? path : '/' + path
    const root = this.cfg.rootPath?.trim() || '/'
    return root.startsWith('/') ? root : '/' + root
  }

  async list(path: string): Promise<ListResult> {
    const dir = this.resolve(path)
    const items = (await this.client().getDirectoryContents(dir)) as Array<{
      basename: string
      filename: string
      type: 'file' | 'directory'
      size: number
      lastmod: string
    }>
    const entries: FileEntry[] = items.map((it) => ({
      name: it.basename,
      path: it.filename,
      kind: it.type === 'directory' ? 'directory' : 'file',
      size: it.size ?? 0,
      modified: it.lastmod ? new Date(it.lastmod).toISOString() : null,
      hidden: it.basename.startsWith('.')
    }))
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { path: dir, entries }
  }

  async stat(path: string): Promise<FileEntry> {
    const s = (await this.client().stat(path)) as {
      basename: string
      type: 'file' | 'directory'
      size: number
      lastmod: string
    }
    return {
      name: s.basename,
      path,
      kind: s.type === 'directory' ? 'directory' : 'file',
      size: s.size ?? 0,
      modified: s.lastmod ? new Date(s.lastmod).toISOString() : null
    }
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    const { size } = await this.stat(path)
    const stream = this.client().createReadStream(path) as unknown as Readable
    return { stream, size }
  }

  async writeFile(path: string, body: Readable, _size: number, onProgress?: (n: number) => void): Promise<void> {
    await this.mkdir(posix.dirname(path))
    let written = 0
    if (onProgress) {
      body.on('data', (c: Buffer) => {
        written += c.length
        onProgress(written)
      })
    }
    const ws = this.client().createWriteStream(path) as unknown as NodeJS.WritableStream
    await pipeline(body, ws)
  }

  async mkdir(path: string): Promise<void> {
    const dir = this.resolve(path)
    if (dir === '/' || !dir) return
    try {
      await this.client().createDirectory(dir, { recursive: true })
    } catch {
      // already exists / server without recursive support — best effort
    }
  }

  async createFile(path: string): Promise<void> {
    await this.mkdir(posix.dirname(path))
    await this.client().putFileContents(path, '')
  }

  async delete(path: string, _kind: 'file' | 'directory'): Promise<void> {
    await this.client().deleteFile(path)
  }

  async rename(path: string, newName: string): Promise<void> {
    await this.client().moveFile(path, posix.join(posix.dirname(path), newName))
  }

  async exists(path: string): Promise<boolean> {
    return this.client().exists(path)
  }

  join(...segments: string[]): string {
    return posix.join(...segments.filter((s) => s !== ''))
  }

  parent(path: string): string | null {
    const root = this.resolve('')
    const resolved = this.resolve(path)
    if (resolved === root || resolved === '/') return null
    const up = posix.dirname(resolved)
    return up.length < root.length ? root : up
  }

  async test(): Promise<ConnectionTestResult> {
    try {
      await this.client().getDirectoryContents(this.resolve(''))
      return { ok: true, message: `Connected to ${this.cfg.url}` }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}
