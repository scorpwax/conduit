import { useEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/** A small positioned right-click menu with a click-away backdrop. */
export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: y, left: x })

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = y
    let left = x
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    setPos({ top, left })
  }, [x, y, items])

  return (
    <>
      <div
        className="ctx-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div ref={menuRef} className="ctx-menu" style={{ top: pos.top, left: pos.left }}>
        {items.map((item, i) => (
          <div
            key={i}
            className={`ctx-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
            onClick={() => {
              if (item.disabled) return
              item.onClick()
              onClose()
            }}
          >
            {item.label}
          </div>
        ))}
      </div>
    </>
  )
}
