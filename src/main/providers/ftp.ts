import { posix } from 'path'
import { PassThrough, type Readable } from 'stream'
import { Client } from 'basic-ftp'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, FtpConfig } from '@shared/types'
import type { Provider } from './types'

/**
 * FTP / FTPS provider.
 *
 * FTP uses a single control connection that can't multiplex concurrent
 * transfers, so each operation opens its own short-lived client. That's a bit
 * slower per call but robust under the transfer engine's parallelism.
 */
export class FtpProvider implements Provider {
  private cfg: FtpConfig

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as FtpConfig
  }

  private async open(): Promise<Client> {
    const client = new Client(30000)
    await client.access({
      host: this.cfg.host,
      port: this.cfg.port || 21,
      user: this.cfg.username,
      password: this.cfg.password || '',
      secure: this.cfg.secure ?? false
    })
    return client
  }

  private resolve(path: string): string {
    if (path && path.length > 0) return path
    return this.cfg.rootPath && this.cfg.rootPath.trim() ? this.cfg.rootPath : '/'
  }

  async list(path: string): Promise<ListResult> {
    const dir = this.resolve(path)
    const client = await this.open()
    try {
      const list = await client.list(dir)
      const entries: FileEntry[] = list
        .filter((f) => f.name !== '.' && f.name !== '..')
        .map((f) => ({
          name: f.name,
          path: posix.join(dir, f.name),
          kind: f.isDirectory ? 'directory' : 'file',
          size: f.size ?? 0,
          modified: f.modifiedAt ? f.modifiedAt.toISOString() : null,
          hidden: f.name.startsWith('.')
        }))
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return { path: dir, entries }
    } finally {
      client.close()
    }
  }

  async stat(path: string): Promise<FileEntry> {
    const client = await this.open()
    try {
      const size = await client.size(path).catch(() => 0)
      // FTP has no portable single-file stat; infer kind by trying to cd into it.
      let kind: 'file' | 'directory' = 'file'
      try {
        await client.cd(path)
        kind = 'directory'
      } catch {
        kind = 'file'
      }
      return { name: posix.basename(path), path, kind, size, modified: null }
    } finally {
      client.close()
    }
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    const client = await this.open()
    const size = await client.size(path).catch(() => 0)
    const stream = new PassThrough()
    // Download runs in the background, piping into the PassThrough; close the
    // client when done or on error.
    client
      .downloadTo(stream, path)
      .then(() => client.close())
      .catch((err) => {
        stream.destroy(err as Error)
        client.close()
      })
    return { stream, size }
  }

  async writeFile(path: string, body: Readable, _size: number, onProgress?: (n: number) => void): Promise<void> {
    const client = await this.open()
    try {
      await this.ensureDir(client, posix.dirname(path))
      if (onProgress) {
        let written = 0
        body.on('data', (c: Buffer) => {
          written += c.length
          onProgress(written)
        })
      }
      await client.uploadFrom(body, path)
    } finally {
      client.close()
    }
  }

  private async ensureDir(client: Client, dir: string): Promise<void> {
    if (!dir || dir === '/' || dir === '.') return
    // ensureDir changes into the dir, creating segments as needed.
    await client.ensureDir(dir)
    await client.cd('/')
  }

  async mkdir(path: string): Promise<void> {
    const client = await this.open()
    try {
      await client.ensureDir(this.resolve(path))
    } finally {
      client.close()
    }
  }

  async createFile(path: string): Promise<void> {
    const client = await this.open()
    try {
      await this.ensureDir(client, posix.dirname(path))
      await client.uploadFrom(emptyStream(), path)
    } finally {
      client.close()
    }
  }

  async delete(path: string, kind: 'file' | 'directory'): Promise<void> {
    const client = await this.open()
    try {
      if (kind === 'directory') await client.removeDir(path)
      else await client.remove(path)
    } finally {
      client.close()
    }
  }

  async rename(path: string, newName: string): Promise<void> {
    const client = await this.open()
    try {
      await client.rename(path, posix.join(posix.dirname(path), newName))
    } finally {
      client.close()
    }
  }

  async exists(path: string): Promise<boolean> {
    const client = await this.open()
    try {
      const size = await client.size(path).catch(() => -1)
      if (size >= 0) return true
      try {
        await client.cd(path)
        return true
      } catch {
        return false
      }
    } finally {
      client.close()
    }
  }

  join(...segments: string[]): string {
    return posix.join(...segments.filter((s) => s !== ''))
  }

  parent(path: string): string | null {
    const root = this.resolve('')
    const resolved = this.resolve(path)
    if (resolved === root || resolved === '/') return null
    const up = posix.dirname(resolved)
    return up
  }

  async test(): Promise<ConnectionTestResult> {
    try {
      const client = await this.open()
      try {
        await client.list(this.resolve(''))
        return { ok: true, message: `Connected to ${this.cfg.host}` }
      } finally {
        client.close()
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}

function emptyStream(): Readable {
  const s = new PassThrough()
  s.end()
  return s
}
