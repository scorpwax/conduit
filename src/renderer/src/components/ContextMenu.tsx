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
      <div className="ctx-menu" style={{ top: y, left: x }}>
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
