import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AppSettings } from '@shared/types'

/** Persisted user settings, stored as JSON in the app's userData directory. */

const DEFAULTS: AppSettings = {
  logRetentionDays: 180,
  transferConcurrency: 5,
  adaptiveConnectionSpeed: false,
  lowBandwidthWarning: true,
  lowBandwidthThresholdBps: 1_000_000
}

let cache: AppSettings | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'conduit-settings.json')
}

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(filePath(), 'utf-8')
    cache = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings()
  cache = { ...current, ...patch }
  await fs.writeFile(filePath(), JSON.stringify(cache, null, 2), 'utf-8')
  return cache
}
