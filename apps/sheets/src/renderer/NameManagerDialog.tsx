import { useRef, useState } from 'react'
import { Dropdown } from '@vantage/ui'
import { useI18n } from './i18n/locale'
import { useModalDialog } from './modal-dialog'

/// The Name Manager dialog, minimal: list, add, edit (name / refers-to), and
/// delete. Scope is chosen at creation and cannot be changed afterwards.

export interface DefinedNameRow {
  readonly name: string
  readonly ref: string
  /// null = workbook scope.
  readonly scopeSheetId: string | null
  readonly scopeLabel: string
}

export type DefinedNameAction =
  | { kind: 'add'; name: string; ref: string; sheetId: string | null }
  | {
      kind: 'update'
      originalName: string
      scopeSheetId: string | null
      name: string
      ref: string
    }
  | { kind: 'remove'; name: string; scopeSheetId: string | null }

export function NameManagerDialog({
  names,
  sheets,
  onAction,
  onClose,
}: {
  readonly names: readonly DefinedNameRow[]
  readonly sheets: readonly { id: string; name: string }[]
  /// Returns an error message, or null on success.
  readonly onAction: (action: DefinedNameAction) => string | null | Promise<string | null>
  readonly onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [selected, setSelected] = useState<DefinedNameRow | null>(null)
  const [name, setName] = useState('')
  const [ref, setRef] = useState('')
  const [scope, setScope] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const close = (): void => {
    if (!pendingRef.current) onClose()
  }

  const pick = (row: DefinedNameRow): void => {
    if (pendingRef.current) return
    setSelected(row)
    setName(row.name)
    setRef(row.ref)
    setError(null)
  }
  const run = async (action: DefinedNameAction): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      const failure = await onAction(action)
      setError(failure)
      if (failure === null) {
        setSelected(null)
        setName('')
        setRef('')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const modal = useModalDialog(close)
  return (
    <div className="dialog-backdrop" onClick={close}>
      <div
        className="format-cells-dialog name-manager-dialog"
        role="dialog"
        {...modal}
        aria-label={t('dlgNmTitle')}
        aria-busy={pending}
        onClick={(event) => event.stopPropagation()}
      >
        <header>{t('dlgNmTitle')}</header>
        <section className="dialog-body">
          <table className="name-manager-table">
            <thead>
              <tr>
                <th>{t('dlgNmName')}</th>
                <th>{t('dlgNmRefersTo')}</th>
                <th>{t('dlgNmScope')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {names.length === 0 && (
                <tr>
                  <td colSpan={4} className="name-manager-empty">
                    {t('dlgNmNoNames')}
                  </td>
                </tr>
              )}
              {names.map((row) => (
                <tr
                  key={`${row.scopeSheetId ?? ''}!${row.name}`}
                  className={
                    selected?.name === row.name && selected.scopeSheetId === row.scopeSheetId
                      ? 'selected'
                      : ''
                  }
                  onClick={() => pick(row)}
                >
                  <td>{row.name}</td>
                  <td>{row.ref}</td>
                  <td>{row.scopeLabel}</td>
                  <td>
                    <button
                      data-tip={t('dlgNmDeleteName')}
                      aria-label={t('dlgNmDeleteName')}
                      disabled={pending}
                      onClick={(event) => {
                        event.stopPropagation()
                        void run({ kind: 'remove', name: row.name, scopeSheetId: row.scopeSheetId })
                      }}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dialog-grid">
            <label>
              {t('dlgNmName')}
              <input
                disabled={pending}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="MyRange"
              />
            </label>
            <label>
              {t('dlgNmRefersTo')}
              <input
                disabled={pending}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="=Sheet1!$A$1:$B$9"
              />
            </label>
            {selected === null && (
              <label>
                {t('dlgNmScope')}
                <Dropdown
                  disabled={pending}
                  ariaLabel={t('dlgNmScope')}
                  value={scope}
                  options={[
                    { value: '', label: t('dlgNmWorkbook') },
                    ...sheets.map((sheet) => ({ value: sheet.id, label: sheet.name })),
                  ]}
                  onPick={setScope}
                />
              </label>
            )}
          </div>
          {error && (
            <p className="dialog-note dialog-error" role="alert">
              {error}
            </p>
          )}
        </section>
        <footer className="dialog-actions">
          <button className="secondary" disabled={pending} onClick={close}>
            {t('dlgClose')}
          </button>
          {selected !== null && (
            <button
              className="secondary"
              disabled={pending}
              onClick={() => {
                setSelected(null)
                setName('')
                setRef('')
                setError(null)
              }}
            >
              {t('dlgNmNew')}
            </button>
          )}
          <button
            className="primary-action"
            disabled={pending || name.trim() === '' || ref.trim() === ''}
            onClick={() =>
              run(
                selected === null
                  ? { kind: 'add', name: name.trim(), ref: ref.trim(), sheetId: scope || null }
                  : {
                      kind: 'update',
                      originalName: selected.name,
                      scopeSheetId: selected.scopeSheetId,
                      name: name.trim(),
                      ref: ref.trim(),
                    },
              )
            }
          >
            {selected === null ? t('dlgNmAdd') : t('dlgNmUpdate')}
          </button>
        </footer>
      </div>
    </div>
  )
}
