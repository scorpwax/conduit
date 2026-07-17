import { posix } from 'path'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { lookup } from 'dns'
import { execFile } from 'child_process'
import type { Readable } from 'stream'
import { Client, type SFTPWrapper } from 'ssh2'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, SftpConfig } from '@shared/types'
import type { Provider } from './types'

const dnsLookup = promisify(lookup)
const execFileP = promisify(execFile)

/**
 * Resolve a hostname to a routable IPv4 address.
 *
 * On macOS, dscacheutil queries the system DNS cache including Bonjour/mDNS,
 * so .local hostnames work. We explicitly take the `ip_address` field (IPv4)
 * and ignore `ipv6_address` — link-local IPv6 addresses (fe80::) require a
 * scope ID that ssh2 doesn't support and will fail with EHOSTUNREACH.
 */
async function resolveHost(host: string): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('dscacheutil', ['-q', 'host', '-a', 'name', host])
      // Only take the IPv4 address line — skip ipv6_address entirely.
      const match = stdout.match(/^ip_address:\s+(\S+)/m)
      if (match) return match[1]
    } catch {
      // dscacheutil unavailable — fall through
    }
  }
  // Force IPv4 so we never hand a link-local IPv6 address to ssh2.
  try {
    const { address } = await dnsLookup(host, { family: 4 })
    return address
  } catch {
    // Last resort: any address the OS gives us.
    try {
      const { address } = await dnsLookup(host)
      // Refuse link-local IPv6 — they are unreachable without a scope ID.
      if (address.startsWith('fe80:')) return host
      return address
    } catch {
      return host
    }
  }
}

/**
 * SFTP/SSH provider — also the transport for computer-to-computer transfers.
 * Point it at any machine running an SSH server (macOS "Remote Login",
 * Linux sshd, Windows OpenSSH) and browse/transfer its filesystem.
 *
 * A single SSH connection is opened lazily and reused for the lifetime of the
 * provider (providers are cached per connection id upstream).
 */
export class SftpProvider implements Provider {
  private cfg: SftpConfig
  private client: Client | null = null
  private sftpPromise: Promise<SFTPWrapper> | null = null
  private rootAbs = '/'

  constructor(public readonly connection: Connection) {
    this.cfg = connection.config as SftpConfig
  }

  /** Establish (or reuse) the SSH connection and return the SFTP session. */
  private connect(): Promise<SFTPWrapper> {
    if (this.sftpPromise) return this.sftpPromise
    this.sftpPromise = resolveHost(this.cfg.host).then(
      (resolvedHost) =>
        new Promise<SFTPWrapper>((resolve, reject) => {
          const client = new Client()
          this.client = client
          client
            .on('ready', () => {
              client.sftp((err, sftp) => {
                if (err) return reject(err)
                // Resolve the starting directory (login home when no root given).
                const start = this.cfg.rootPath && this.cfg.rootPath.trim() ? this.cfg.rootPath : '.'
                sftp.realpath(start, (rpErr, abs) => {
                  this.rootAbs = rpErr ? this.cfg.rootPath || '/' : abs
                  resolve(sftp)
                })
              })
            })
            .on('error', (err) => {
              this.sftpPromise = null
              reject(err)
            })
            .on('close', () => {
              this.sftpPromise = null
              this.client = null
            })
            .connect({
              host: resolvedHost,
              port: this.cfg.port || 22,
              username: this.cfg.username,
              password: this.cfg.password || undefined,
              privateKey: this.cfg.privateKey || undefined,
              passphrase: this.cfg.passphrase || undefined,
              readyTimeout: 20000
            })
        })
    )
    return this.sftpPromise
  }

  private resolve(path: string): string {
    return path && path.length > 0 ? path : this.rootAbs
  }

  async list(path: string): Promise<ListResult> {
    const sftp = await this.connect()
    const dir = this.resolve(path)
    const list = await new Promise<import('ssh2').FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(dir, (err, entries) => (err ? reject(err) : resolve(entries)))
    })
    const entries: FileEntry[] = list.map((e) => {
      const isDir = e.attrs.isDirectory()
      return {
        name: e.filename,
        path: posix.join(dir, e.filename),
        kind: isDir ? 'directory' : 'file',
        size: e.attrs.size ?? 0,
        modified: e.attrs.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null,
        hidden: e.filename.startsWith('.')
      }
    })
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { path: dir, entries }
  }

  async stat(path: string): Promise<FileEntry> {
    const sftp = await this.connect()
    const full = this.resolve(path)
    const attrs = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      sftp.stat(full, (err, s) => (err ? reject(err) : resolve(s)))
    })
    return {
      name: posix.basename(full),
      path: full,
      kind: attrs.isDirectory() ? 'directory' : 'file',
      size: attrs.size ?? 0,
      modified: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null
    }
  }

  async createReadStream(path: string): Promise<{ stream: Readable; size: number }> {
    const sftp = await this.connect()
    const { size } = await this.stat(path)
    return { stream: sftp.createReadStream(path), size }
  }

  async writeFile(
    path: string,
    body: Readable,
    _size: number,
    onProgress?: (bytesWritten: number) => void
  ): Promise<void> {
    const sftp = await this.connect()
    await this.ensureDir(posix.dirname(path))
    let written = 0
    if (onProgress) {
      body.on('data', (chunk: Buffer) => {
        written += chunk.length
        onProgress(written)
      })
    }
    await pipeline(body, sftp.createWriteStream(path))
  }

  /** Recursively create a directory (SFTP mkdir is single-level). */
  private async ensureDir(dir: string): Promise<void> {
    const sftp = await this.connect()
    const segments = dir.split('/').filter(Boolean)
    let current = dir.startsWith('/') ? '' : '.'
    for (const seg of segments) {
      current = current === '' ? `/${seg}` : posix.join(current, seg)
      await new Promise<void>((resolve) => {
        sftp.mkdir(current, (err) => resolve()) // ignore "already exists"
      })
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureDir(this.resolve(path))
  }

  async createFile(path: string): Promise<void> {
    const sftp = await this.connect()
    await this.ensureDir(posix.dirname(path))
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, '', (err) => (err ? reject(err) : resolve()))
    })
  }

  async delete(path: string, kind: 'file' | 'directory'): Promise<void> {
    const sftp = await this.connect()
    if (kind === 'file') {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
      })
      return
    }
    // Directory: remove children depth-first, then the directory itself.
    const { entries } = await this.list(path)
    for (const entry of entries) {
      await this.delete(entry.path, entry.kind)
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const sftp = await this.connect()
    const newPath = posix.join(posix.dirname(path), newName)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(path, newPath, (err) => (err ? reject(err) : resolve()))
    })
  }

  async exists(path: string): Promise<boolean> {
    try {
      const sftp = await this.connect()
      await new Promise<void>((resolve, reject) => {
        sftp.stat(path, (err) => (err ? reject(err) : resolve()))
      })
      return true
    } catch {
      return false
    }
  }

  join(...segments: string[]): string {
    return posix.join(...segments.filter((s) => s !== ''))
  }

  parent(path: string): string | null {
    const resolved = this.resolve(path)
    if (resolved === this.rootAbs) return null
    const up = posix.dirname(resolved)
    if (up === resolved) return null
    // Don't navigate above the configured root.
    if (!up.startsWith(this.rootAbs) && this.rootAbs !== '/') return this.rootAbs
    return up
  }

  async test(): Promise<ConnectionTestResult> {
    try {
      const sftp = await this.connect()
      await new Promise<void>((resolve, reject) => {
        sftp.readdir(this.rootAbs, (err) => (err ? reject(err) : resolve()))
      })
      return { ok: true, message: `Connected to ${this.cfg.username}@${this.cfg.host}` }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }

  close(): void {
    this.client?.end()
    this.client = null
    this.sftpPromise = null
  }
}
