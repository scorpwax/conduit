import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { Readable } from 'stream'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, SmbConfig } from '@shared/types'
import type { Provider } from './types'
import { LocalProvider } from './local'

const execFileP = promisify(execFile)

/**
 * SMB provider that delegates to the operating system's own SMB client rather
 * than reimplementing the protocol in JavaScript.
 *
 * - macOS: mounts the share with `mount_smbfs` (the same client Finder uses —
 *   it handles guest/anonymous, NTLMv2, and SPNEGO correctly) and browses the
 *   mount point as a local folder.
 * - Windows: UNC paths (\\host\share) are accessed directly via the filesystem.
 *
 * All file operations are then handled by a LocalProvider rooted at the mount
 * point / UNC path, so transfers, listing, and mkdir all reuse the local code.
 */
export class SmbProvider implements Provider {
  private cfg: SmbConfig
  private local: LocalProvider | null = null
  private mountPoint: string | null = null
  private createdMount = false

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as SmbConfig
  }

  /** Escape a string for use inside a RegExp. */
  private static escape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** Find an already-mounted smbfs share for this host/share (macOS). */
  private async findExistingMount(): Promise<string | null> {
    const { stdout } = await execFileP('mount', [])
    const re = new RegExp(
      `@${SmbProvider.escape(this.cfg.host)}/${SmbProvider.escape(this.cfg.share)}$`,
      'i'
    )
    for (const line of stdout.split('\n')) {
      if (!/smbfs/i.test(line)) continue
      const m = line.match(/^\/\/(\S+) on (.+?) \(smbfs/i)
      if (m && re.test(m[1])) return m[2]
    }
    return null
  }

  /** Build the mount_smbfs URL, url-encoding credential parts. */
  private mountSpec(): string {
    if (this.cfg.guest) return `//GUEST:@${this.cfg.host}/${this.cfg.share}`
    const enc = encodeURIComponent
    const domain = this.cfg.domain ? `${enc(this.cfg.domain)};` : ''
    const user = enc(this.cfg.username)
    const pass = enc(this.cfg.password || '')
    return `//${domain}${user}:${pass}@${this.cfg.host}/${this.cfg.share}`
  }

  /** Ensure the share is mounted and return a LocalProvider rooted at it. */
  private async ensure(): Promise<LocalProvider> {
    if (this.local) return this.local

    let root: string
    if (platform() === 'win32') {
      // Windows can read UNC paths directly — no mount needed.
      const base = `\\\\${this.cfg.host}\\${this.cfg.share}`
      root = this.cfg.rootPath ? join(base, this.cfg.rootPath) : base
    } else if (platform() === 'darwin') {
      const existing = await this.findExistingMount()
      if (existing) {
        this.mountPoint = existing
      } else {
        const safe = `${this.cfg.host}-${this.cfg.share}`.replace(/[^\w.-]/g, '_')
        const mp = join(homedir(), 'ConduitMounts', safe)
        await fs.mkdir(mp, { recursive: true })
        try {
          await execFileP('mount_smbfs', ['-N', this.mountSpec(), mp])
        } catch (err) {
          const msg = (err as { stderr?: string; message: string }).stderr || (err as Error).message
          throw new Error(`Couldn’t mount \\\\${this.cfg.host}\\${this.cfg.share}: ${msg.trim()}`)
        }
        this.mountPoint = mp
        this.createdMount = true
      }
      root = this.cfg.rootPath ? join(this.mountPoint, this.cfg.rootPath) : this.mountPoint
    } else {
      throw new Error('SMB is currently supported on macOS and Windows.')
    }

    this.local = new LocalProvider({ ...this.connection, type: 'local', config: { rootPath: root } })
    return this.local
  }

  async list(path: string): Promise<ListResult> {
    return (await this.ensure()).list(path)
  }

  async stat(path: string): Promise<FileEntry> {
    return (await this.ensure()).stat(path)
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    return (await this.ensure()).createReadStream(path)
  }

  async writeFile(
    path: string,
    body: Readable,
    size: number,
    onProgress?: (bytesWritten: number) => void
  ): Promise<void> {
    return (await this.ensure()).writeFile(path, body, size, onProgress)
  }

  async mkdir(path: string): Promise<void> {
    return (await this.ensure()).mkdir(path)
  }

  async createFile(path: string): Promise<void> {
    return (await this.ensure()).createFile(path)
  }

  async delete(path: string, kind: 'file' | 'directory'): Promise<void> {
    return (await this.ensure()).delete(path, kind)
  }

  async rename(path: string, newName: string): Promise<void> {
    return (await this.ensure()).rename(path, newName)
  }

  async exists(path: string): Promise<boolean> {
    return (await this.ensure()).exists(path)
  }

  join(...segments: string[]): string {
    return join(...segments.filter((s) => s !== ''))
  }

  parent(path: string): string | null {
    // Bound navigation at the mount root so users don't wander the local disk.
    if (!this.local) return null
    const up = this.local.parent(path)
    const root = this.mountPoint
    if (root && up && !up.startsWith(root)) return null
    return up
  }

  async getLocalRoot(): Promise<string | null> {
    await this.ensure()
    return this.mountPoint
  }

  async test(): Promise<ConnectionTestResult> {
    try {
      const local = await this.ensure()
      await local.list('')
      return { ok: true, message: `Connected to \\\\${this.cfg.host}\\${this.cfg.share}` }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }

  /** Unmount only if we created the mount (leave Finder's mounts alone). */
  close(): void {
    if (this.createdMount && this.mountPoint && platform() === 'darwin') {
      const mp = this.mountPoint
      execFile('umount', [mp], () => {
        /* best-effort */
      })
    }
    this.local = null
    this.mountPoint = null
    this.createdMount = false
  }
}
