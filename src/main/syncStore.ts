import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { SyncTask, SyncRunStats } from '@shared/types'

const filePath = (): string => join(app.getPath('userData'), 'conduit-sync-tasks.json')

let cache: SyncTask[] | null = null

async function load(): Promise<SyncTask[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(filePath(), 'utf-8')
    cache = JSON.parse(raw) as SyncTask[]
  } catch {
    cache = []
  }
  return cache
}

async function persist(tasks: SyncTask[]): Promise<void> {
  cache = tasks
  await fs.writeFile(filePath(), JSON.stringify(tasks, null, 2), 'utf-8')
}

export const syncStore = {
  async getAll(): Promise<SyncTask[]> {
    return load()
  },

  async save(task: SyncTask): Promise<SyncTask[]> {
    const tasks = await load()
    const idx = tasks.findIndex((t) => t.id === task.id)
    if (idx >= 0) tasks[idx] = task
    else tasks.push(task)
    await persist(tasks)
    return tasks
  },

  async remove(id: string): Promise<SyncTask[]> {
    const tasks = (await load()).filter((t) => t.id !== id)
    await persist(tasks)
    return tasks
  },

  async updateTaskResult(
    id: string,
    result: SyncTask['lastRunResult'],
    stats: SyncRunStats
  ): Promise<void> {
    const tasks = await load()
    const task = tasks.find((t) => t.id === id)
    if (task) {
      task.lastRun = new Date().toISOString()
      task.lastRunResult = result
      task.lastRunStats = stats
      await persist(tasks)
    }
  }
}
