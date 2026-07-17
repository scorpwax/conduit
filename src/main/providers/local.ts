import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { basename, dirname, join, sep } from 'path'
import { homedir } from 'os'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, LocalConfig } from '@shared/types'
import type { Provider } from './types'

export class LocalProvider implements Provider {
  constructor(public readonly connection: Connection) {}

  private root(): string {
    const cfg = this.connection.config as LocalConfig
    return cfg.rootPath || homedir()
  }

  /** Resolve a possibly-empty path to an absolute filesystem path. */
  private resolve(path: string): string {
    return path && path.length > 0 ? path : this.root()
  }

  async list(path: string): Promise<ListResult> {
    const dir = this.resolve(path)
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const entries: FileEntry[] = []

    for (const dirent of dirents) {
      const full = join(dir, dirent.name)
      try {
        // Follow symlinks for stat, but flag them.
        const stat = await fs.stat(full)
        entries.push({
          name: dirent.name,
          path: full,
          kind: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
          hidden: dirent.name.startsWith('.')
        })
      } catch {
        // Broken symlink or permission denied — show it but mark as file.
        entries.push({
          name: dirent.name,
          path: full,
          kind: dirent.isDirectory() ? 'directory' : 'file',
          size: 0,
          modified: null,
          hidden: dirent.name.startsWith('.')
        })
      }
    }
    return { path: dir, entries }
  }

  async stat(path: string): Promise<FileEntry> {
    const full = this.resolve(path)
    const stat = await fs.stat(full)
    return {
      name: basename(full),
      path: full,
      kind: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
      hidden: basename(full).startsWith('.')
    }
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    const stat = await fs.stat(path)
    return { stream: createReadStream(path), size: stat.size }
  }

  async writeFile(
    path: string,
    body: Readable,
    _size: number,
    onProgress?: (bytesWritten: number) => void
  ): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    let written = 0
    if (onProgress) {
      body.on('data', (chunk: Buffer) => {
        written += chunk.length
        onProgress(written)
      })
    }
    await pipeline(body, createWriteStream(path))
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true })
  }

  async createFile(path: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    // 'wx' fails if the file already exists, so we don't clobber.
    const handle = await fs.open(path, 'wx')
    await handle.close()
  }

  async delete(path: string, _kind: 'file' | 'directory'): Promise<void> {
    await fs.rm(path, { recursive: true, force: true })
  }

  async rename(path: string, newName: string): Promise<void> {
    await fs.rename(path, join(dirname(path), newName))
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  }

  join(...segments: string[]): string {
    return join(...segments)
  }

  parent(path: string): string | null {
    const resolved = this.resolve(path)
    const up = dirname(resolved)
    if (up === resolved) return null // reached filesystem root
    return up
  }

  async getLocalRoot(): Promise<string | null> {
    return this.root()
  }

  async test(): Promise<ConnectionTestResult> {
    try {
      await fs.access(this.root())
      return { ok: true, message: `Ready — ${this.root()}` }
    } catch (err) {
      return { ok: false, message: `Cannot access ${this.root()}: ${(err as Error).message}` }
    }
  }

  static separator = sep
}
