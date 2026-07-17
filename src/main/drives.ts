import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { DriveInfo } from '@shared/types'

/**
 * Enumerate mounted drives / common roots so the UI can offer quick jumps.
 * macOS: home + everything under /Volumes. Windows (later): drive letters.
 */
export async function listDrives(): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = [
    { name: 'Home', path: homedir(), kind: 'home' }
  ]

  if (platform() === 'darwin') {
    drives.push({ name: 'Macintosh HD', path: '/', kind: 'internal' })
    try {
      const vols = await fs.readdir('/Volumes')
      for (const v of vols) {
        // Skip hidden system entries (e.g. .timemachine).
        if (v.startsWith('.')) continue
        const p = join('/Volumes', v)
        try {
          // Skip symlinks — the boot volume appears in /Volumes as a firmlink to
          // "/", which would duplicate "Macintosh HD".
          const l = await fs.lstat(p)
          if (l.isSymbolicLink()) continue
          if (l.isDirectory()) {
            drives.push({ name: v, path: p, kind: 'external' })
          }
        } catch {
          // skip unreadable volume
        }
      }
    } catch {
      // /Volumes not present
    }
  } else if (platform() === 'win32') {
    // Probe drive letters A: through Z:.
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c)
      const root = `${letter}:\\`
      try {
        await fs.access(root)
        drives.push({ name: `${letter}:`, path: root, kind: c === 67 ? 'internal' : 'external' })
      } catch {
        // no such drive
      }
    }
  } else {
    drives.push({ name: 'Root', path: '/', kind: 'internal' })
  }

  return drives
}
