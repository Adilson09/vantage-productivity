import { useRef, useState } from 'react'

import { useI18n } from './i18n/locale'
import { useModalDialog } from './modal-dialog'

/// Create PivotTable: source range (from the selection) and destination cell.
/// The layout itself is edited in the PivotTable Fields pane that opens once
/// the pivot exists, like Excel.

export type {
  OoXmlPivotConfig,
  PivotField,
  PivotGroupingOption,
  PivotLabelFilterOption,
  PivotValueFilterOption,
  PivotValueSpec,
} from './pivot-field-model'

export interface PivotCreateRequest {
  readonly sourceRange: string
  readonly targetCell: string
}

export function PivotDialog({
  hasFields,
  sourceRange,
  onCreate,
  onClose,
}: {
  readonly hasFields: boolean
  readonly sourceRange: string
  /// Returns an error message, or null on success.
  readonly onCreate: (request: PivotCreateRequest) => string | null | Promise<string | null>
  readonly onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [targetCell, setTargetCell] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const close = (): void => {
    if (!pendingRef.current) onClose()
  }
  const create = async (): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      const failure = await onCreate({ sourceRange, targetCell: targetCell.trim() || 'A1' })
      setError(failure)
      if (failure === null) onClose()
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
        className="format-cells-dialog pivot-dialog"
        role="dialog"
        {...modal}
        aria-label={t('dlgPivotCreateTitle')}
        aria-busy={pending}
        style={{ minWidth: 380 }}
        onClick={(event) => event.stopPropagation()}
      >
        <header>{t('dlgPivotCreateTitle')}</header>
        {!hasFields ? (
          <p className="dialog-note">{t('dlgPivotNoFields')}</p>
        ) : (
          <div className="dialog-grid">
            <label>
              {t('dlgPivotSourceRange')}
              <input type="text" className="cell-input" value={sourceRange} readOnly />
            </label>
            <label>
              {t('dlgPivotTargetCell')}
              <input
                type="text"
                className="cell-input"
                placeholder={t('dlgPivotTargetPlaceholder')}
                value={targetCell}
                disabled={pending}
                onChange={(event) => setTargetCell(event.target.value.toUpperCase())}
                style={{ width: 80 }}
              />
            </label>
            <p className="dialog-note dialog-span">{t('dlgPivotCreateHint')}</p>
          </div>
        )}
        {error && (
          <p className="dialog-note dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="secondary" disabled={pending} onClick={close}>
            {t('dlgCancel')}
          </button>
          {hasFields && (
            <button
              className="primary-action"
              disabled={pending}
              onClick={() => void create()}
            >
              {t('dlgCreate')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
