/**
 * Filesystem bookkeeping files/folders that macOS and Windows leave behind on
 * shared or removable volumes (camera cards, external drives) — never part of
 * the actual content someone transferred, so folder size, item count, and
 * folder verification all exclude them. They're still reported as a count
 * rather than silently vanishing, so the user knows why a number changed.
 */
export const JUNK_ENTRY_NAMES = [
  '.DS_Store',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  '.TemporaryItems',
  '.VolumeIcon.icns',
  '.apdisk',
  'Thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
  'System Volume Information',
  '$RECYCLE.BIN'
]

const JUNK_NAME_SET = new Set(JUNK_ENTRY_NAMES)

/** True for a known OS-bookkeeping name, or a macOS AppleDouble resource-fork
 *  sidecar (`._filename`) — created when Finder writes metadata to a
 *  non-HFS/APFS volume (exFAT/FAT32 camera cards, NTFS drives, etc.). */
export function isJunkEntryName(name: string): boolean {
  return JUNK_NAME_SET.has(name) || name.startsWith('._')
}

/**
 * Builds the `find`-argument fragment that prunes every junk name (files AND
 * directories — `-prune` stops descent so contents of a junk directory like
 * `.Trashes` never get counted either) before the caller's own `-type f ...`
 * clause. Meant to be spread into an execFile('find', [...]) argument array —
 * no shell involved, so these parens/names are safe as literal arguments.
 */
export function findPruneArgs(): string[] {
  const nameArgs: string[] = []
  for (const name of JUNK_ENTRY_NAMES) {
    if (nameArgs.length > 0) nameArgs.push('-o')
    nameArgs.push('-name', name)
  }
  nameArgs.push('-o', '-name', '._*')
  return ['(', ...nameArgs, ')', '-prune', '-o']
}
