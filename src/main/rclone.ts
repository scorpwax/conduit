/**
 * Mounts S3 / Wasabi buckets as local filesystems via rclone + macFUSE.
 *
 * Requirements (both installed via Homebrew):
 *   brew install --cask macfuse
 *   brew install rclone
 *
 * The mount daemon runs as a child process; its PID is stored so we can
 * unmount cleanly when the connection is closed or the app quits.
 */
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { Connection, S3Config } from '@shared/types'

const execFileP = promisify(execFile)

/** PID → mount point, so we can unmount on quit / disconnect. */
const activeMounts = new Map<number, string>()

export async function checkRclone(): Promise<boolean> {
  try {
    await execFileP('rclone', ['version'])
    return true
  } catch {
    return false
  }
}

/** Build a minimal rclone config block for an S3/Wasabi connection. */
function buildRcloneConfig(conn: Connection): { remoteName: string; configContent: string } {
  const cfg = conn.config as S3Config
  const remoteName = conn.id.replace(/[^a-z0-9]/gi, '_')

  let configContent = `[${remoteName}]\ntype = s3\n`
  configContent += `provider = AWS\n`
  configContent += `access_key_id = ${cfg.accessKeyId}\n`
  configContent += `secret_access_key = ${cfg.secretAccessKey}\n`
  if (cfg.endpoint) configContent += `endpoint = ${cfg.endpoint}\n`
  if (cfg.region) configContent += `region = ${cfg.region}\n`
  if (cfg.forcePathStyle) configContent += `force_path_style = true\n`

  return { remoteName, configContent }
}

/**
 * Mount an S3/Wasabi connection using rclone and return the local mount path.
 * Requires rclone + macFUSE on macOS. Not supported on Windows.
 */
export async function mountS3(conn: Connection): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error('Mounting S3 as a local drive is not supported on Windows.')
  }
  const available = await checkRclone()
  if (!available) {
    throw new Error(
      'rclone is not installed. Install it with:\n  brew install rclone\n\nYou also need macFUSE:\n  brew install --cask macfuse'
    )
  }

  const cfg = conn.config as S3Config
  const safe = conn.name.replace(/[^\w.-]/g, '_')
  const mountPoint = join(homedir(), 'ConduitMounts', safe)
  await fs.mkdir(mountPoint, { recursive: true })

  // Write a temp rclone config.
  const { remoteName, configContent } = buildRcloneConfig(conn)
  const configPath = join(tmpdir(), `conduit-rclone-${conn.id}.conf`)
  await fs.writeFile(configPath, configContent, { mode: 0o600 })

  const remote = cfg.prefix ? `${remoteName}:${cfg.bucket}/${cfg.prefix}` : `${remoteName}:${cfg.bucket}`

  const child = spawn(
    'rclone',
    [
      'mount',
      remote,
      mountPoint,
      '--config', configPath,
      '--daemon',
      '--vfs-cache-mode', 'writes',
      '--dir-cache-time', '60s',
      '--allow-non-empty'
    ],
    { detached: true, stdio: 'ignore' }
  )

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`rclone mount exited with code ${code}`))
      else resolve()
    })
    // rclone --daemon forks immediately; the spawned process exits once the
    // daemon is running, so we just wait for close.
    setTimeout(resolve, 3000)
  })

  if (child.pid) activeMounts.set(child.pid, mountPoint)
  return mountPoint
}

export async function unmountS3(mountPoint: string): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      await execFileP('umount', [mountPoint])
    } catch {
      try {
        await execFileP('diskutil', ['unmount', 'force', mountPoint])
      } catch {
        // best-effort
      }
    }
  }
  for (const [pid, mp] of activeMounts) {
    if (mp === mountPoint) activeMounts.delete(pid)
  }
}

export async function unmountAll(): Promise<void> {
  for (const mountPoint of activeMounts.values()) {
    await unmountS3(mountPoint).catch(() => {})
  }
}
