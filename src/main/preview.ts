import { spawn } from 'child_process'
import { createWriteStream, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, basename, dirname } from 'path'
import { pipeline } from 'stream/promises'
import { getProvider } from './providers'
import { LocalProvider } from './providers/local'
import { SmbProvider } from './providers/smb'

/**
 * Preview a file with macOS Quick Look (`qlmanage -p`).
 *
 * Local and SMB paths are already real files on disk (SMB is browsed through a
 * mount point), so they preview in place. S3/SFTP files are streamed to a temp
 * file first. Quick Look is macOS-only; this is a no-op elsewhere.
 */
export async function previewFile(connectionId: string, path: string): Promise<void> {
  if (process.platform !== 'darwin') return

  const provider = await getProvider(connectionId)
  let realPath = path

  const isOnDisk = provider instanceof LocalProvider || provider instanceof SmbProvider
  if (!isOnDisk) {
    const { stream } = await provider.createReadStream(path)
    const tmp = join(tmpdir(), 'conduit-preview', basename(path) || 'preview')
    await fs.mkdir(dirname(tmp), { recursive: true })
    await pipeline(stream, createWriteStream(tmp))
    realPath = tmp
  }

  // Detached so the Quick Look panel outlives this handler; ignore its output.
  const child = spawn('qlmanage', ['-p', realPath], { detached: true, stdio: 'ignore' })
  child.unref()
}
