import { useEffect, useId, useRef, useState } from 'react'
import {
  readRetainedRecoveryList,
  type RetainedRecoveryApi,
  type RetainedRecoveryCopy,
  type RetainedRecoveryItem,
} from '../../shared/retained-recovery'

const selection = (item: RetainedRecoveryItem) => ({ id: item.id, updatedAt: item.updatedAt })
const labels = {
  'needs-review': 'Needs review',
  'closed-copy': 'Closed copy',
  'canceled-close': 'Close canceled',
  working: 'Finishing…',
  removing: 'Removing…',
}
const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )

export function RetainedRecoveryPanel({
  api,
  onOpenPath,
}: {
  api: RetainedRecoveryApi | undefined
  onOpenPath?: (path: string) => Promise<void>
}) {
  const headingId = useId()
  const operation = useRef(false)
  const readVersion = useRef(0)
  const [items, setItems] = useState<RetainedRecoveryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [copy, setCopy] = useState<RetainedRecoveryCopy | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(25)
  const available =
    typeof api?.retainedRecoveryList === 'function' &&
    typeof api.recoverRetainedCopy === 'function' &&
    typeof api.removeRetainedCopy === 'function' &&
    typeof api.retryRetainedRecovery === 'function' &&
    typeof api.keepRetainedOutput === 'function'
  const refresh = async () => {
    if (!available) return
    const version = ++readVersion.current
    setLoading(true)
    try {
      const result = readRetainedRecoveryList(await api!.retainedRecoveryList!())
      if (version !== readVersion.current) return
      setItems(result.items)
      setTruncated(result.truncated)
      setLoaded(true)
    } finally {
      if (version === readVersion.current) setLoading(false)
    }
  }
  const report = (reason: unknown) =>
    setError(
      reason instanceof Error
        ? reason.message
        : 'Recovery could not finish. Please refresh and try again.',
    )
  useEffect(() => {
    if (available) void refresh().catch(report)
    return () => {
      readVersion.current++
    }
  }, [available, api])
  const act = async (item: RetainedRecoveryItem, action: () => Promise<void>) => {
    if (operation.current || busy || loading) return
    operation.current = true
    setBusy(item.id)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (reason) {
      report(reason)
    } finally {
      try {
        await refresh()
      } catch (reason) {
        report(reason)
      }
      setBusy(null)
      operation.current = false
    }
  }
  const needle = query.trim().toLowerCase()
  const visible = items.filter(
    (item) =>
      !needle || `${item.fileName} ${item.originalPath ?? ''}`.toLowerCase().includes(needle),
  )
  if (!available) return null
  return (
    <section className="vantage-retained-recovery" aria-labelledby={headingId}>
      <h3 id={headingId}>Copies kept during closing</h3>
      <p>
        Review recovery copies and unfinished cleanup. Recovering saves a separate file. Removing a
        copy removes only the selected recovery item.
      </p>
      <div className="vantage-panel-toolbar">
        <span role="status" aria-live="polite">
          {loading
            ? 'Reading retained copies…'
            : loaded
              ? `${items.length} item${items.length === 1 ? '' : 's'}`
              : 'Retained copies'}
        </span>
        <button
          className="vantage-secondary-button"
          disabled={loading || busy !== null}
          onClick={() => {
            if (operation.current) return
            operation.current = true
            setError('')
            void refresh()
              .catch(report)
              .finally(() => {
                operation.current = false
              })
          }}
        >
          Refresh retained copies
        </button>
      </div>
      {error && (
        <p className="vantage-tool-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="vantage-panel-message" role="status">
          {message}
        </p>
      )}
      {copy && (
        <div className="vantage-restore-result" role="status">
          <strong>Recovered copy created</strong>
          <p dir="auto">{copy.path}</p>
          {onOpenPath && (
            <button
              className="vantage-secondary-button"
              disabled={busy !== null}
              onClick={() => void onOpenPath(copy.path).catch(report)}
            >
              Open recovered copy
            </button>
          )}
        </div>
      )}
      {loaded && !items.length && <p className="vantage-panel-message">No copies need review.</p>}
      {items.length > 0 && (
        <label className="vantage-recovery-search">
          <span>Find a retained copy</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(25)
            }}
            placeholder="Search by filename or folder…"
          />
        </label>
      )}
      <ul className="vantage-retained-recovery-list">
        {visible.slice(0, limit).map((item) => (
          <li key={item.id}>
            <strong dir="auto">{item.fileName}</strong>
            <span> · {labels[item.state]}</span>
            {item.originalPath && <p dir="auto">{item.originalPath}</p>}
            <p>{date(item.updatedAt)}</p>
            <p>{item.detail}</p>
            {item.pendingOutput && <p dir="auto">File to review: {item.pendingOutput.path}</p>}
            <div className="vantage-panel-toolbar">
              {item.canRestore && (
                <button
                  className="vantage-secondary-button"
                  disabled={loading || busy !== null}
                  onClick={() =>
                    void act(item, async () => {
                      setCopy(null)
                      const result = await api!.recoverRetainedCopy!(selection(item))
                      if (result === null) {
                        setMessage('Recovery canceled.')
                        return
                      }
                      if (
                        !result ||
                        typeof result.path !== 'string' ||
                        !result.path.trim() ||
                        result.path.length > 4096 ||
                        typeof result.module !== 'string' ||
                        result.module.length > 20
                      )
                        throw new Error(
                          'The recovered copy location could not be read. Please refresh.',
                        )
                      setCopy({ path: result.path, module: result.module })
                    })
                  }
                >
                  Save recovered copy
                </button>
              )}
              {item.canRemove && (
                <button
                  className="vantage-secondary-button"
                  disabled={loading || busy !== null}
                  onClick={() =>
                    void act(item, async () => {
                      await api!.removeRetainedCopy!(selection(item))
                      setMessage('Selected recovery copy removed.')
                    })
                  }
                >
                  Remove copy
                </button>
              )}
              {item.canRetry && (
                <button
                  className="vantage-secondary-button"
                  disabled={loading || busy !== null}
                  onClick={() =>
                    void act(item, async () => {
                      await api!.retryRetainedRecovery!(selection(item))
                      setMessage('Selected cleanup checked again.')
                    })
                  }
                >
                  Retry cleanup
                </button>
              )}
              {item.pendingOutput && (
                <button
                  className="vantage-secondary-button"
                  disabled={loading || busy !== null}
                  onClick={() =>
                    void act(item, async () => {
                      await api!.keepRetainedOutput!(selection(item), item.pendingOutput!.id)
                      setMessage('File kept. You can now review the remaining recovery copy.')
                    })
                  }
                >
                  Keep this file
                </button>
              )}
              {busy === item.id && <span role="status">Working…</span>}
            </div>
          </li>
        ))}
      </ul>
      {visible.length > limit && (
        <button
          className="vantage-secondary-button"
          onClick={() => setLimit((value) => value + 25)}
        >
          Show more retained copies
        </button>
      )}
      {truncated && (
        <p className="vantage-panel-message">
          The most recent retained items are shown. Remove completed items and refresh to review
          more.
        </p>
      )}
    </section>
  )
}
