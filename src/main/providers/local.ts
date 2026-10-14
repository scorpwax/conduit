import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { basename, dirname, join, sep } from 'path'
import { homedir } from 'os'
import { pipeline } from 'stream/promises'
import { createHash } from 'crypto'
import type { Readable } from 'stream'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, LocalConfig } from '@shared/types'
import type { Provider, WalkOptions } from './types'

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
          created: stat.birthtime.toISOString(),
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

  /**
   * Parallel recursive readdir. Uses dirent types only — no per-file stat —
   * so a whole-disk walk is bounded by directory reads. Symlinked folders are
   * not followed (avoids loops and double-counting, e.g. /Volumes/<boot disk>).
   */
  async walk(path: string, onEntries: (entries: FileEntry[]) => void, opts: WalkOptions): Promise<void> {
    const queue: string[] = [this.resolve(path)]
    let queued = 1
    let done = 0
    let active = 0
    const CONCURRENCY = 24

    await new Promise<void>((resolve) => {
      const pump = (): void => {
        if (opts.signal.aborted) {
          if (active === 0) resolve()
          return
        }
        while (active < CONCURRENCY && queue.length > 0) {
          const dir = queue.pop()!
          active++
          void fs
            .readdir(dir, { withFileTypes: true })
            .then((dirents) => {
              const batch: FileEntry[] = []
              for (const d of dirents) {
                const isDir = d.isDirectory()
                const hidden = d.name.startsWith('.')
                batch.push({
                  name: d.name,
                  path: join(dir, d.name),
                  kind: isDir ? 'directory' : 'file',
                  size: -1,
                  modified: null,
                  hidden
                })
                if (isDir && !(hidden && opts.skipHiddenDirs)) {
                  queue.push(join(dir, d.name))
                  queued++
                }
              }
              if (batch.length) onEntries(batch)
            })
            .catch(() => {
              // Permission denied / vanished mid-walk — skip this folder.
            })
            .finally(() => {
              active--
              done++
              opts.onFolders?.(done, queued)
              if (active === 0 && queue.length === 0) resolve()
              else pump()
            })
        }
        if (active === 0 && queue.length === 0) resolve()
      }
      pump()
    })
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
      created: stat.birthtime.toISOString(),
      hidden: basename(full).startsWith('.')
    }
  }

  async createReadStream(path: string, offset = 0): Promise<{ stream: Readable; size: number }> {
    const stat = await fs.stat(path)
    const opts = offset > 0
      ? { start: offset, highWaterMark: 1 * 1024 * 1024 }
      : { highWaterMark: 1 * 1024 * 1024 }
    return { stream: createReadStream(path, opts), size: stat.size }
  }

  async writeFile(
    path: string,
    body: Readable,
    _size: number,
    onProgress?: (bytesWritten: number) => void,
    appendFromOffset = 0
  ): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })

    // Fast path: if the body is a LocalReadStream (comes from another LocalProvider),
    // use fs.copyFile which delegates to the OS (clonefile on APFS, sendfile elsewhere).
    const srcPath: string | undefined = (body as NodeJS.ReadableStream & { path?: string }).path as string | undefined
    if (srcPath && appendFromOffset === 0) {
      await fs.copyFile(srcPath, path)
      if (onProgress) onProgress(_size)
      return
    }

    // Track cumulative bytes including any already-written offset so progress
    // reflects total file progress, not just the bytes written in this session.
    let written = appendFromOffset
    if (onProgress) {
      body.on('data', (chunk: Buffer) => {
        written += chunk.length
        onProgress(written)
      })
    }
    const flags = appendFromOffset > 0 ? 'a' : 'w'
    await pipeline(body, createWriteStream(path, { flags, highWaterMark: 1 * 1024 * 1024 }))
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

  /**
   * Plain whole-file MD5 by default — matches the ETag S3/Wasabi return for
   * single-part uploads. When `multipart` is given (the actual part size the
   * upload used), computes the same S3-style multipart hash instead, so large
   * files that went through multipart upload can still be verified against
   * their local source. See the `Provider.checksum` doc for why this needs
   * the real part size rather than just the ETag's encoded part count.
   */
  async checksum(path: string, multipart?: { partSizeBytes: number }): Promise<string | null> {
    const full = this.resolve(path)
    try {
      if (multipart && multipart.partSizeBytes > 0) {
        const { size } = await fs.stat(full)
        const handle = await fs.open(full, 'r')
        try {
          const partDigests: Buffer[] = []
          let offset = 0
          while (offset < size) {
            const length = Math.min(multipart.partSizeBytes, size - offset)
            const buf = Buffer.alloc(length)
            await handle.read(buf, 0, length, offset)
            partDigests.push(createHash('md5').update(buf).digest())
            offset += length
          }
          const combined = createHash('md5').update(Buffer.concat(partDigests)).digest('hex')
          return `${combined}-${partDigests.length}`
        } finally {
          await handle.close()
        }
      }

      return await new Promise<string>((resolve, reject) => {
        const hash = createHash('md5')
        const stream = createReadStream(full, { highWaterMark: 4 * 1024 * 1024 })
        stream.on('data', (chunk) => hash.update(chunk as Buffer))
        stream.on('end', () => resolve(hash.digest('hex')))
        stream.on('error', reject)
      })
    } catch {
      return null
    }
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
