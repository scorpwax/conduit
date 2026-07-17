export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

export function formatSpeed(bytesPerSec?: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return ''
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const EXT_ICONS: Record<string, string> = {
  pdf: '📕',
  doc: '📄',
  docx: '📄',
  txt: '📄',
  md: '📄',
  xls: '📊',
  xlsx: '📊',
  csv: '📊',
  ppt: '📽️',
  pptx: '📽️',
  zip: '🗜️',
  gz: '🗜️',
  tar: '🗜️',
  rar: '🗜️',
  jpg: '🖼️',
  jpeg: '🖼️',
  png: '🖼️',
  gif: '🖼️',
  svg: '🖼️',
  webp: '🖼️',
  heic: '🖼️',
  mp4: '🎬',
  mov: '🎬',
  mkv: '🎬',
  avi: '🎬',
  mp3: '🎵',
  wav: '🎵',
  flac: '🎵',
  js: '📜',
  ts: '📜',
  jsx: '📜',
  tsx: '📜',
  json: '📜',
  html: '📜',
  css: '📜',
  py: '📜',
  app: '📦',
  dmg: '📦'
}

/** Short human type label for the Type column. */
export function fileType(name: string, kind: 'file' | 'directory'): string {
  if (kind === 'directory') return 'Folder'
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : ''
  return ext || 'File'
}

export function fileIcon(name: string, kind: 'file' | 'directory'): string {
  if (kind === 'directory') return '📁'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_ICONS[ext] ?? '📄'
}
