import { useStore } from '../store'

/**
 * Shown when a transfer would overwrite existing items at the destination.
 * Matches the delete dialog's layout (centered card, warning icon, prominent
 * warning line) but in amber, since overwriting is recoverable-with-care rather
 * than immediately destructive. The chosen action applies to all conflicts.
 */
export function ConflictModal(): JSX.Element | null {
  const conflict = useStore((s) => s.conflict)
  const resolve = useStore((s) => s.resolveConflict)
  if (!conflict) return null

  const { names } = conflict
  const count = names.length
  const single = count === 1

  return (
    <div className="modal-overlay" onMouseDown={() => resolve('cancel')}>
      <div className="dialog-card wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-icon">⚠️</div>
        <h2 className="dialog-title">
          {single ? 'An item already exists at the destination' : `${count} items already exist at the destination`}
        </h2>

        {single ? (
          <div className="dialog-file">{names[0]}</div>
        ) : (
          <div className="conflict-list">
            {names.slice(0, 8).map((n) => (
              <div key={n} className="conflict-row">
                <span className="ficon">⚠️</span>
                <span className="label">{n}</span>
              </div>
            ))}
            {count > 8 && <div className="conflict-more">+ {count - 8} more…</div>}
          </div>
        )}

        <div className="dialog-warning amber">Replacing will overwrite the existing {single ? 'item' : 'items'}.</div>

        <div className="dialog-actions wrap">
          <button className="btn ghost" onClick={() => resolve('cancel')}>
            Cancel
          </button>
          <button className="btn" onClick={() => resolve('skip')} title="Don’t transfer the conflicting items">
            Skip
          </button>
          <button className="btn" onClick={() => resolve('keepBoth')} title="Keep both by renaming the incoming items">
            Keep Both
          </button>
          <button className="btn warn-solid" onClick={() => resolve('replace')}>
            Replace
          </button>
        </div>
      </div>
    </div>
  )
}
