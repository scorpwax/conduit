/**
 * Tracks an in-progress pane-reorder drag. Kept separate from the file-transfer
 * drag (lib/drag.ts) so a pane's drop handler can tell which kind of drag it is.
 */
let draggingIndex: number | null = null

export function setPaneDrag(index: number): void {
  draggingIndex = index
}

export function getPaneDrag(): number | null {
  return draggingIndex
}

export function clearPaneDrag(): void {
  draggingIndex = null
}
