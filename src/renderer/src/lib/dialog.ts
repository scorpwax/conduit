import { create } from 'zustand'

/**
 * Promise-based in-app dialogs, replacing window.prompt/confirm (which Electron
 * disables). Call confirmDialog()/promptDialog() from anywhere; <DialogHost/>
 * renders the active one and resolves the promise.
 */

export interface ConfirmOptions {
  /** The main question. */
  title: string
  /** Optional subject shown on its own line (e.g. a filename). */
  fileName?: string
  /** Optional prominent warning line. */
  warning?: string
  confirmText?: string
  /** Red destructive styling for the confirm button + a warning icon. */
  danger?: boolean
}

export interface PromptOptions {
  title: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
}

export type ActiveDialog =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (value: string | null) => void }

interface DialogStore {
  active: ActiveDialog | null
  _set: (a: ActiveDialog | null) => void
}

export const useDialogStore = create<DialogStore>((set) => ({
  active: null,
  _set: (active) => set({ active })
}))

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useDialogStore.getState()._set({ kind: 'confirm', opts, resolve }))
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => useDialogStore.getState()._set({ kind: 'prompt', opts, resolve }))
}
