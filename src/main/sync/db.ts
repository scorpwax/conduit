import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

export interface SyncDbEntry {
  size: number
  mtime: number
}

export type SyncDb = Record<string, SyncDbEntry>

function dbPath(taskId: string): string {
  return join(app.getPath('userData'), 'sync-db', `${taskId}.json`)
}

export async function readSyncDb(taskId: string): Promise<SyncDb> {
  try {
    const raw = await fs.readFile(dbPath(taskId), 'utf-8')
    return JSON.parse(raw) as SyncDb
  } catch {
    return {}
  }
}

export async function writeSyncDb(taskId: string, db: SyncDb): Promise<void> {
  const dir = join(app.getPath('userData'), 'sync-db')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(dbPath(taskId), JSON.stringify(db, null, 2), 'utf-8')
}

export async function clearSyncDb(taskId: string): Promise<void> {
  try {
    await fs.unlink(dbPath(taskId))
  } catch {
    // ok if file doesn't exist
  }
}
