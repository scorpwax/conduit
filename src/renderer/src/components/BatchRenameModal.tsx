import React, { useMemo, useState } from 'react'
import type { FileEntry } from '@shared/types'

type Tab = 'replace' | 'add' | 'remove' | 'sequence' | 'date'
type Separator = '' | ' ' | '-' | '_'

interface Props {
  entries: FileEntry[]
  allEntries: FileEntry[]
  connectionId: string
  onClose: () => void
  onRename: (path: string, newName: string) => Promise<void>
  onComplete: () => void
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

function fmtDate(dateStr: string, fmt: string): string {
  const [y, m, d] = dateStr.split('-')
  return fmt.replace('YYYY', y).replace('MM', m).replace('DD', d)
}

function todayIso(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function BatchRenameModal({ entries, allEntries, connectionId, onClose, onRename, onComplete }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('replace')
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [runProgress, setRunProgress] = useState(0)
  const [runTotal, setRunTotal] = useState(0)
  const [errors, setErrors] = useState<string[]>([])

  // Replace
  const [findText, setFindText] = useState('')
  const [replaceWith, setReplaceWith] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)

  // Add Text
  const [addText, setAddText] = useState('')
  const [addPos, setAddPos] = useState<'before' | 'after'>('before')
  const [addSep, setAddSep] = useState<Separator>('')

  // Remove
  const [removeMode, setRemoveMode] = useState<'chars' | 'first' | 'last'>('chars')
  const [removeChars, setRemoveChars] = useState('')
  const [removeN, setRemoveN] = useState(1)

  // Sequence
  const [seqName, setSeqName] = useState('')
  const [seqNamePos, setSeqNamePos] = useState<'before' | 'after'>('before')
  const [seqDigits, setSeqDigits] = useState(2)
  const [seqStart, setSeqStart] = useState(1)
  const [seqLoc, setSeqLoc] = useState<'replace' | 'prepend' | 'append'>('append')
  const [seqArrange, setSeqArrange] = useState<'custom' | 'alpha' | 'date'>('custom')
  const [seqDir, setSeqDir] = useState<'asc' | 'desc'>('asc')

  // Date
  const [dateVal, setDateVal] = useState(todayIso())
  const [dateFmt, setDateFmt] = useState('YYYY-MM-DD')
  const [dateLoc, setDateLoc] = useState<'prepend' | 'append' | 'replace'>('prepend')
  const [dateSep, setDateSep] = useState<Separator>(' ')

  const orderedEntries = useMemo(() => {
    if (tab !== 'sequence') return entries
    const list = [...entries]
    if (seqArrange === 'alpha') list.sort((a, b) => seqDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name))
    else if (seqArrange === 'date') list.sort((a, b) => seqDir === 'asc' ? (a.modified ?? '').localeCompare(b.modified ?? '') : (b.modified ?? '').localeCompare(a.modified ?? ''))
    return list
  }, [entries, tab, seqArrange, seqDir])

  function computeNewName(entry: FileEntry, index: number): string {
    const [base, ext] = splitExt(entry.name)
    let nb = base

    if (tab === 'replace') {
      if (!findText) return entry.name
      const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      nb = base.replace(new RegExp(escaped, caseSensitive ? 'g' : 'gi'), replaceWith)
    } else if (tab === 'add') {
      if (!addText) return entry.name
      const s = addSep
      nb = addPos === 'before' ? addText + s + base : base + s + addText
    } else if (tab === 'remove') {
      if (removeMode === 'chars') {
        if (!removeChars) return entry.name
        for (const ch of removeChars) nb = nb.split(ch).join('')
      } else if (removeMode === 'first') {
        nb = base.slice(removeN)
      } else {
        nb = base.slice(0, Math.max(0, base.length - removeN))
      }
    } else if (tab === 'sequence') {
      const num = String(seqStart + index).padStart(seqDigits, '0')
      const token = seqName
        ? (seqNamePos === 'before' ? seqName + num : num + seqName)
        : num
      if (seqLoc === 'replace') nb = token
      else if (seqLoc === 'prepend') nb = base ? token + ' ' + base : token
      else nb = base ? base + ' ' + token : token
    } else if (tab === 'date') {
      if (!dateVal) return entry.name
      const formatted = fmtDate(dateVal, dateFmt)
      const s = dateSep
      if (dateLoc === 'replace') nb = formatted
      else if (dateLoc === 'prepend') nb = formatted + s + base
      else nb = base + s + formatted
    }

    if (!nb.trim()) return entry.name
    return nb + ext
  }

  const preview = useMemo(() => {
    const existingNames = new Set(
      allEntries.filter((e) => !entries.some((s) => s.path === e.path)).map((e) => e.name)
    )
    const list = tab === 'sequence' ? orderedEntries : entries
    const batchNewNames = new Set<string>()
    return list.map((entry, i) => {
      const newName = computeNewName(entry, i)
      const unchanged = newName === entry.name
      const conflict = !unchanged && (existingNames.has(newName) || batchNewNames.has(newName))
      if (!unchanged) batchNewNames.add(newName)
      return { entry, newName, unchanged, conflict }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, entries, orderedEntries, allEntries, findText, replaceWith, caseSensitive, addText, addPos, addSep, removeMode, removeChars, removeN, seqName, seqNamePos, seqDigits, seqStart, seqLoc, seqArrange, seqDir, dateVal, dateFmt, dateLoc, dateSep])

  const toRename = preview.filter((r) => !r.unchanged && !r.conflict)
  const conflictCount = preview.filter((r) => r.conflict).length
  const hasChanges = preview.some((r) => !r.unchanged)

  async function doRename(): Promise<void> {
    setRunStatus('running')
    setRunProgress(0)
    setRunTotal(toRename.length)
    const errs: string[] = []
    for (let i = 0; i < toRename.length; i++) {
      const row = toRename[i]
      try {
        await onRename(row.entry.path, row.newName)
      } catch (e: unknown) {
        errs.push(`${row.entry.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
      setRunProgress(i + 1)
    }
    setErrors(errs)
    setRunStatus('done')
    onComplete()
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'replace', label: 'Replace' },
    { id: 'add', label: 'Add Text' },
    { id: 'remove', label: 'Remove' },
    { id: 'sequence', label: 'Sequence' },
    { id: 'date', label: 'Date' },
  ]

  const SEP_OPTIONS: [Separator, string][] = [['', 'None'], [' ', 'Space'], ['-', 'Dash'], ['_', 'Underscore']]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal br-modal" onClick={(e) => e.stopPropagation()}>
        <div className="br-header">
          <div>
            <h2>Batch Rename</h2>
            <p className="modal-sub">{entries.length} item{entries.length !== 1 ? 's' : ''} selected</p>
          </div>
          <button className="icon-btn" onClick={onClose} style={{ marginLeft: 'auto' }}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="br-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`br-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="br-content">
          {tab === 'replace' && (
            <div className="br-fields">
              <div className="br-field-row">
                <label>Find</label>
                <input value={findText} onChange={(e) => setFindText(e.target.value)} placeholder="Text to find" autoFocus />
              </div>
              <div className="br-field-row">
                <label>Replace with</label>
                <input value={replaceWith} onChange={(e) => setReplaceWith(e.target.value)} placeholder="Replacement (leave blank to remove)" />
              </div>
              <label className="br-checkbox">
                <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
                Case sensitive
              </label>
            </div>
          )}

          {tab === 'add' && (
            <div className="br-fields">
              <div className="br-field-row">
                <label>Text to add</label>
                <input value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="Text to add" autoFocus />
              </div>
              <div className="br-field-row">
                <label>Position</label>
                <div className="br-radios">
                  {(['before', 'after'] as const).map((p) => (
                    <label key={p} className="br-radio">
                      <input type="radio" checked={addPos === p} onChange={() => setAddPos(p)} />
                      {p === 'before' ? 'Before filename' : 'After filename'}
                    </label>
                  ))}
                </div>
              </div>
              <div className="br-field-row">
                <label>Separator</label>
                <div className="br-radios">
                  {SEP_OPTIONS.map(([val, lbl]) => (
                    <label key={lbl} className="br-radio">
                      <input type="radio" checked={addSep === val} onChange={() => setAddSep(val)} />
                      {lbl}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'remove' && (
            <div className="br-fields">
              <div className="br-field-row">
                <label>Mode</label>
                <div className="br-radios">
                  {([['chars', 'Characters'], ['first', 'First N chars'], ['last', 'Last N chars']] as [typeof removeMode, string][]).map(([val, lbl]) => (
                    <label key={val} className="br-radio">
                      <input type="radio" checked={removeMode === val} onChange={() => setRemoveMode(val)} />
                      {lbl}
                    </label>
                  ))}
                </div>
              </div>
              {removeMode === 'chars' && (
                <div className="br-field-row">
                  <label>Characters</label>
                  <input value={removeChars} onChange={(e) => setRemoveChars(e.target.value)} placeholder="Each character listed will be removed" autoFocus />
                </div>
              )}
              {(removeMode === 'first' || removeMode === 'last') && (
                <div className="br-field-row">
                  <label>Count</label>
                  <input type="number" min={1} value={removeN} onChange={(e) => setRemoveN(Math.max(1, parseInt(e.target.value) || 1))} style={{ width: 80 }} autoFocus />
                </div>
              )}
            </div>
          )}

          {tab === 'sequence' && (
            <div className="br-fields">
              <div className="br-two-col">
                <div>
                  <div className="br-field-row">
                    <label>Sequence Name</label>
                    <input value={seqName} onChange={(e) => setSeqName(e.target.value)} placeholder="Optional name" autoFocus />
                  </div>
                  <div className="br-field-row" style={{ marginTop: 8 }}>
                    <label>Name position</label>
                    <div className={`br-radios${!seqName ? ' faded' : ''}`}>
                      {([['before', 'Before digits'], ['after', 'After digits']] as [typeof seqNamePos, string][]).map(([val, lbl]) => (
                        <label key={val} className="br-radio">
                          <input type="radio" checked={seqNamePos === val} onChange={() => setSeqNamePos(val)} disabled={!seqName} />
                          {lbl}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="br-field-row">
                  <label>Location</label>
                  <div className="br-radios vertical">
                    {([['replace', 'Replace'], ['prepend', 'Prepend'], ['append', 'Append']] as [typeof seqLoc, string][]).map(([val, lbl]) => (
                      <label key={val} className="br-radio">
                        <input type="radio" checked={seqLoc === val} onChange={() => setSeqLoc(val)} />
                        {lbl}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="br-field-row">
                <label>Digits</label>
                <div className="br-inline">
                  <span className="br-inline-label"># of digits</span>
                  <input type="number" min={1} max={6} value={seqDigits} onChange={(e) => setSeqDigits(Math.max(1, Math.min(6, parseInt(e.target.value) || 2)))} style={{ width: 64 }} />
                  <span className="br-inline-label">Starting at</span>
                  <input type="number" min={0} value={seqStart} onChange={(e) => setSeqStart(Math.max(0, parseInt(e.target.value) || 0))} style={{ width: 72 }} />
                </div>
              </div>
              <div className="br-field-row">
                <label>Arrangement</label>
                <div className="br-arrangement">
                  <div className="br-radios">
                    {([['custom', 'Custom'], ['alpha', 'Alphabetical'], ['date', 'File Date']] as [typeof seqArrange, string][]).map(([val, lbl]) => (
                      <label key={val} className="br-radio">
                        <input type="radio" checked={seqArrange === val} onChange={() => setSeqArrange(val)} />
                        {lbl}
                      </label>
                    ))}
                  </div>
                  <div className={`br-radios${seqArrange === 'custom' ? ' faded' : ''}`}>
                    {([['asc', 'Ascending'], ['desc', 'Descending']] as [typeof seqDir, string][]).map(([val, lbl]) => (
                      <label key={val} className="br-radio">
                        <input type="radio" checked={seqDir === val} onChange={() => setSeqDir(val)} disabled={seqArrange === 'custom'} />
                        {lbl}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'date' && (
            <div className="br-fields">
              <div className="br-two-col">
                <div className="br-field-row">
                  <label>Date</label>
                  <div className="br-inline">
                    <input type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)} />
                    <button className="br-today-btn" onClick={() => setDateVal(todayIso())}>Today</button>
                  </div>
                </div>
                <div className="br-field-row">
                  <label>Format</label>
                  <select value={dateFmt} onChange={(e) => setDateFmt(e.target.value)}>
                    {['YYYY-MM-DD', 'YYYYMMDD', 'MM-DD-YYYY', 'MMDDYYYY', 'DD-MM-YYYY', 'DDMMYYYY'].map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="br-field-row">
                <label>Location</label>
                <div className="br-radios">
                  {([['prepend', 'Prepend'], ['append', 'Append'], ['replace', 'Replace filename']] as [typeof dateLoc, string][]).map(([val, lbl]) => (
                    <label key={val} className="br-radio">
                      <input type="radio" checked={dateLoc === val} onChange={() => setDateLoc(val)} />
                      {lbl}
                    </label>
                  ))}
                </div>
              </div>
              {dateLoc !== 'replace' && (
                <div className="br-field-row">
                  <label>Separator</label>
                  <div className="br-radios">
                    {SEP_OPTIONS.map(([val, lbl]) => (
                      <label key={lbl} className="br-radio">
                        <input type="radio" checked={dateSep === val} onChange={() => setDateSep(val)} />
                        {lbl}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Live preview */}
        <div className="br-preview">
          <div className="br-preview-header">
            <span>Before</span>
            <span>After</span>
          </div>
          <div className="br-preview-rows">
            {preview.map((row) => (
              <div
                key={row.entry.path}
                className={`br-preview-row${row.conflict ? ' conflict' : ''}${row.unchanged ? ' unchanged' : ''}`}
              >
                <span className="br-prev-name">{row.entry.name}</span>
                <span className="br-prev-arrow">→</span>
                <span className="br-prev-name new">{row.newName}</span>
                {row.conflict && <span className="br-conflict-badge">conflict</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="br-footer">
          <div className="br-footer-left">
            {conflictCount > 0 && (
              <span className="br-warn-msg">
                <span className="material-symbols-outlined" style={{ fontSize: 15, verticalAlign: 'middle' }}>warning</span>
                {' '}{conflictCount} conflict{conflictCount !== 1 ? 's' : ''} will be skipped
              </span>
            )}
            {runStatus === 'done' && errors.length === 0 && (
              <span className="br-ok-msg">Rename complete</span>
            )}
            {errors.length > 0 && (
              <span className="br-err-msg">{errors.length} error{errors.length !== 1 ? 's' : ''}</span>
            )}
          </div>
          <div className="br-footer-right">
            <button className="btn-outline" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!hasChanges || toRename.length === 0 || runStatus === 'running'}
              onClick={() => void doRename()}
            >
              {runStatus === 'running'
                ? `Renaming… ${runProgress} / ${runTotal}`
                : `Rename ${toRename.length > 0 ? toRename.length : ''} Item${toRename.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
