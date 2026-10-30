import { useRef, useState } from 'react'
import { Dropdown } from '@vantage/ui'
import type { PivotField } from './PivotDialog'
import { useI18n } from './i18n/locale'
import { useModalDialog } from './modal-dialog'

/// Excel's Data → Subtotal, minimal: one "at each change in" column, one
/// aggregated column, SUBTOTAL rows inserted per group plus a grand total.

export interface SubtotalConfig {
  readonly groupCol: number
  readonly valueCol: number
  readonly agg: 'sum' | 'count' | 'average'
}

export function SubtotalDialog({
  fields,
  onCreate,
  onClose,
}: {
  readonly fields: readonly PivotField[]
  /// Returns an error message, or null on success.
  readonly onCreate: (config: SubtotalConfig) => string | null | Promise<string | null>
  readonly onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [groupCol, setGroupCol] = useState(fields[0]?.colIndex ?? 0)
  const [valueCol, setValueCol] = useState(fields[1]?.colIndex ?? fields[0]?.colIndex ?? 0)
  const [agg, setAgg] = useState<SubtotalConfig['agg']>('sum')
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
      const failure = await onCreate({ groupCol, valueCol, agg })
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
        className="format-cells-dialog"
        role="dialog"
        {...modal}
        aria-label={t('dlgSubtotalTitle')}
        aria-busy={pending}
        onClick={(event) => event.stopPropagation()}
      >
        <header>{t('dlgSubtotalTitle')}</header>
        {fields.length === 0 ? (
          <p className="dialog-note">{t('dlgSubtotalNoFields')}</p>
        ) : (
          <div className="dialog-grid">
            <label>
              {t('dlgSubtotalGroupBy')}
              <Dropdown
                disabled={pending}
                ariaLabel={t('dlgSubtotalGroupBy')}
                value={String(groupCol)}
                options={fields.map((field) => ({
                  value: String(field.colIndex),
                  label: field.label,
                }))}
                onPick={(v) => setGroupCol(Number(v))}
              />
            </label>
            <label>
              {t('dlgSubtotalFunction')}
              <Dropdown
                disabled={pending}
                ariaLabel={t('dlgSubtotalFunction')}
                value={agg}
                options={[
                  { value: 'sum', label: t('dlgPivotAggSum') },
                  { value: 'count', label: t('dlgPivotAggCount') },
                  { value: 'average', label: t('dlgPivotAggAverage') },
                ]}
                onPick={(v) => setAgg(v as SubtotalConfig['agg'])}
              />
            </label>
            <label>
              {t('dlgSubtotalAddTo')}
              <Dropdown
                disabled={pending}
                ariaLabel={t('dlgSubtotalAddTo')}
                value={String(valueCol)}
                options={fields.map((field) => ({
                  value: String(field.colIndex),
                  label: field.label,
                }))}
                onPick={(v) => setValueCol(Number(v))}
              />
            </label>
            <p className="dialog-note">{t('dlgSubtotalNote')}</p>
          </div>
        )}
        {error && (
          <p className="dialog-note" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="secondary" disabled={pending} onClick={close}>
            {t('dlgCancel')}
          </button>
          {fields.length > 0 && (
            <button
              className="primary-action"
              disabled={pending}
              onClick={() => void create()}
            >
              {t('dlgOk')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
