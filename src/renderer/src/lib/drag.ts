/**
 * Cross-pane drag payload. The HTML5 DnD API doesn't expose dataTransfer
 * contents during dragover, so we stash the active drag here for the drop
 * target to read. Set on dragstart, cleared on dragend.
 */
export interface DragPayload {
  fromPaneId: string
  paths: string[]
  names: string[]
}

let current: DragPayload | null = null

export function setDrag(payload: DragPayload): void {
  current = payload
}

export function getDrag(): DragPayload | null {
  return current
}

export function clearDrag(): void {
  current = null
}
