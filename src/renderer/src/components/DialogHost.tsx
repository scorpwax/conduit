import { useEffect, useRef, useState } from 'react'
import { useDialogStore, type ActiveDialog } from '../lib/dialog'

export function DialogHost(): JSX.Element | null {
  const active = useDialogStore((s) => s.active)
  const setActive = useDialogStore((s) => s._set)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (active?.kind === 'prompt') {
      setValue(active.opts.defaultValue ?? '')
      // Focus + select so the user can type over the default (e.g. rename).
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    }
  }, [active])

  if (!active) return null

  function resolve(result: boolean | string | null): void {
    if (!active) return
    ;(active.resolve as (r: typeof result) => void)(result)
    setActive(null)
  }

  if (active.kind === 'confirm') {
    const { opts } = active
    return (
      <div className="modal-overlay" onMouseDown={() => resolve(false)}>
        <div className="dialog-card" onMouseDown={(e) => e.stopPropagation()}>
          {opts.danger && <div className="dialog-icon">⚠️</div>}
          <h2 className="dialog-title">{opts.title}</h2>
          {opts.fileName && <div className="dialog-file">{opts.fileName}</div>}
          {opts.warning && <div className="dialog-warning">{opts.warning}</div>}
          <div className="dialog-actions">
            <button className="btn ghost" onClick={() => resolve(false)}>
              Cancel
            </button>
            <button
              className={opts.danger ? 'btn danger-solid' : 'btn primary'}
              onClick={() => resolve(true)}
              autoFocus
            >
              {opts.confirmText ?? 'OK'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const { opts } = active
  const submit = (): void => {
    if (value.trim()) resolve(value.trim())
  }
  return (
    <div className="modal-overlay" onMouseDown={() => resolve(null)}>
      <div className="dialog-card" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">{opts.title}</h2>
        <input
          ref={inputRef}
          className="dialog-input"
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') resolve(null)
          }}
        />
        <div className="dialog-actions">
          <button className="btn ghost" onClick={() => resolve(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!value.trim()}>
            {opts.confirmText ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
