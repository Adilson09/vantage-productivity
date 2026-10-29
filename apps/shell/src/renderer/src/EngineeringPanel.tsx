import { useEffect, useState } from 'react'
import type {
  CalendarPreview,
  ContactPreview,
  DatabasePreview,
  DatabaseQueryResult,
  DraftPreview,
  EngineeringStatus,
  RecoveryEntry,
  RecoveryStatus,
} from '../../shared/vantage-api'
import {
  REMOTE_FEATURES,
  type NetworkPolicy,
} from '../../../../../packages/electron-utils/src/network-policy'

const FEATURE_LABELS = {
  ai: 'Cloud AI',
  mail: 'Mail companion',
  calendar: 'Calendar services',
  collaboration: 'Shared editing',
  updates: 'Update checks',
  assets: 'Remote images, fonts and templates',
  telemetry: 'Usage analytics',
}
const showValue = (value: unknown) => (value === null ? '' : String(value))
export function EngineeringPanel() {
  const [tab, setTab] = useState<'privacy' | 'tools' | 'calendar' | 'database' | 'history'>(
    'privacy',
  )
  const [status, setStatus] = useState<EngineeringStatus | null>(null)
  const [policy, setPolicy] = useState<NetworkPolicy | null>(null)
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null)
  const [drafts, setDrafts] = useState<DraftPreview[]>([])
  const [password, setPassword] = useState('')
  const [backupEntries, setBackupEntries] = useState<RecoveryEntry[]>([])
  const [calendarEvent, setCalendarEvent] = useState({
    summary: '',
    start: '',
    end: '',
    location: '',
  })
  const [calendar, setCalendar] = useState<CalendarPreview | null>(null)
  const [contacts, setContacts] = useState<ContactPreview | null>(null)
  const [database, setDatabase] = useState<DatabasePreview | null>(null)
  const [result, setResult] = useState<DatabaseQueryResult | null>(null)
  const [pdfResult, setPdfResult] = useState<{
    engine: string
    status: string
    stdout: string
    stderr: string
    scope: string
  } | null>(null)
  const [table, setTable] = useState('')
  const [newTable, setNewTable] = useState('Records')
  const [columnNames, setColumnNames] = useState('Name, Notes')
  const [record, setRecord] = useState<Record<string, string>>({})
  const [sql, setSql] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const api = window.vantage
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The action could not be completed.')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let disposed = false
    if (!api?.engineeringStatus) return
    void api
      .engineeringStatus()
      .then((s) => {
        if (!disposed) {
          setStatus(s)
          setPolicy(s.networkPolicy)
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    void api
      .recoveryStatus()
      .then((s) => {
        if (!disposed) setRecovery(s)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    void api
      .draftList()
      .then((s) => {
        if (!disposed) setDrafts(s)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [])
  const openDatabase = (create: boolean) =>
    run(async () => {
      const db = await api!.openDatabase(create)
      if (!db) {
        setMessage('Database selection cancelled.')
        return
      }
      setDatabase(db)
      setTable(db.tables[0]?.name ?? '')
      setRecord({})
      setResult(null)
      setSql('')
      setMessage(create ? 'Database created.' : 'Database opened.')
    })
  const selectedTable = database?.tables.find((t) => t.name === table)
  if (!api?.engineeringStatus)
    return <p>These tools are available in the updated desktop application.</p>
  return (
    <div className="vantage-engineering" aria-busy={busy}>
      <nav className="vantage-engine-tabs" aria-label="Tools and privacy sections">
        {(
          [
            ['privacy', 'Privacy'],
            ['tools', 'Document engines'],
            ['calendar', 'Calendar and contacts'],
            ['database', 'Database'],
            ['history', 'Recovery settings'],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            type="button"
            className="vantage-secondary-button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </nav>
      {error && (
        <p className="vantage-tool-error" role="alert">
          {error}
        </p>
      )}
      <p className="vantage-panel-status" role="status" aria-live="polite">
        {busy ? 'Working…' : message}
      </p>
      {tab === 'privacy' && policy && (
        <section aria-label="Remote feature permissions">
          <h3>You choose which services can connect</h3>
          <label className="vantage-engine-check">
            <input
              type="checkbox"
              checked={policy.localOnly}
              onChange={(e) => setPolicy({ ...policy, localOnly: e.target.checked })}
            />{' '}
            Local mode: block remote requests from the document workspace
          </label>
          <p>
            Local document editing and services on this computer remain available. To use a remote
            service, turn off local mode, enable its feature, and approve its exact HTTPS address.
          </p>
          {REMOTE_FEATURES.map((feature) => (
            <fieldset key={feature} disabled={busy} className="vantage-engine-field">
              <label className="vantage-engine-check">
                <input
                  type="checkbox"
                  checked={policy.features[feature]}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      features: { ...policy.features, [feature]: e.target.checked },
                    })
                  }
                />
                {FEATURE_LABELS[feature]}
              </label>
              {feature !== 'mail' && (
                <label>
                  <span>Approved service addresses (one per line)</span>
                  <textarea
                    aria-label={`${FEATURE_LABELS[feature]} approved addresses`}
                    rows={2}
                    placeholder="https://service.example"
                    value={(policy.origins[feature] ?? []).join('\n')}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        origins: { ...policy.origins, [feature]: e.target.value.split('\n') },
                      })
                    }
                  />
                </label>
              )}
            </fieldset>
          ))}
          <button
            className="vantage-primary-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setPolicy(await api.updateNetworkPolicy(policy))
                setMessage(
                  'Privacy choices saved. Native companions already running retain their own connection settings.',
                )
              })
            }
          >
            Save privacy choices
          </button>
          <p className="vantage-panel-caption">
            These controls cover workspace and editor browser requests, main-process fetch, and the
            launch of Mail. Native helpers, existing mail windows and third-party command tools have
            separate network behavior. System-wide offline acceptance remains a separate test.
          </p>
          <p className="vantage-panel-caption">
            For local AI, choose a custom provider in AI settings with your local service address.
            Local model software and weights are installed separately.
          </p>
        </section>
      )}
      {tab === 'tools' && (
        <section aria-label="Document engine integrations">
          <h3>Use the best available local engine</h3>
          <p>
            Vantage keeps its editing engines and can use LibreOffice to create a separate PDF copy
            when its conversion is useful. The source document stays unchanged.
          </p>
          {status?.engines.map((engine) => (
            <div className="vantage-engine-field" key={engine.id}>
              <strong>
                {engine.name} · {engine.available ? engine.version || 'Available' : 'Not installed'}
              </strong>
              <p>{engine.available ? engine.path : engine.reason}</p>
              {engine.validation && <p>{engine.validation.detail}</p>}
              <span className="vantage-panel-caption">{engine.license}</span>
            </div>
          ))}
          <div className="vantage-panel-toolbar">
            <button
              className="vantage-primary-button"
              disabled={busy || !status?.engines.some((e) => e.id === 'libreoffice' && e.available)}
              onClick={() =>
                void run(async () => {
                  const output = await api.convertDocument()
                  setMessage(
                    output
                      ? `PDF copy created: ${output.destinationPath}. Source bytes were verified unchanged.`
                      : 'Conversion cancelled.',
                  )
                })
              }
            >
              Convert a copy to PDF
            </button>
            <button
              className="vantage-secondary-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const s = await api.engineeringStatus()
                  setStatus(s)
                  setMessage('Local tools refreshed.')
                })
              }
            >
              Refresh tools
            </button>
            {(['qpdf', 'verapdf'] as const).map((engine) => (
              <button
                className="vantage-secondary-button"
                key={engine}
                disabled={busy || !status?.engines.some((e) => e.id === engine && e.available)}
                onClick={() =>
                  void run(async () => {
                    const value = await api.checkSpecialistPdf(engine)
                    if (value) {
                      setPdfResult(value)
                      setMessage(`${value.engine}: ${value.status}.`)
                    } else setMessage('PDF selection cancelled.')
                  })
                }
              >
                {engine === 'qpdf' ? 'Check PDF structure' : 'Validate PDF profile'}
              </button>
            ))}
          </div>
          {pdfResult && (
            <div className="vantage-engine-field">
              <strong>
                {pdfResult.engine}: {pdfResult.status}
              </strong>
              <p>{pdfResult.scope}</p>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {[pdfResult.stdout, pdfResult.stderr].filter(Boolean).join('\n')}
              </pre>
            </div>
          )}
          {status && (
            <p className="vantage-panel-caption">
              Development preview {status.version} · {status.runtime.platform}. Workspace processes:{' '}
              {status.metrics.processes}; working memory:{' '}
              {(status.metrics.workingSetKiB / 1024).toFixed(0)} MiB. External native companions are
              measured separately.
            </p>
          )}
          <p className="vantage-panel-caption">
            Conversion and structural checks do not establish complete Office compatibility.
            Imported macros remain untrusted and are never enabled by this workflow.
          </p>
        </section>
      )}
      {tab === 'calendar' && (
        <section aria-label="Local calendar and contacts">
          <h3>Calendar and contacts on this computer</h3>
          <p>
            Open an iCalendar file to see events in the next 90 days, or a vCard file to browse
            contacts. Recurrence and embedded time zones are handled by ICAL.js. Provider
            synchronization is a separate integration.
          </p>
          <div className="vantage-panel-toolbar">
            <button
              className="vantage-primary-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const value = await api.importCalendar()
                  if (value) {
                    setCalendar(value)
                    setMessage(`${value.occurrences.length} calendar occurrences loaded.`)
                  } else setMessage('Calendar selection cancelled.')
                })
              }
            >
              Open calendar
            </button>
            <button
              className="vantage-secondary-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const value = await api.importContacts()
                  if (value) {
                    setContacts(value)
                    setMessage(`${value.contacts.length} contacts loaded.`)
                  } else setMessage('Contact selection cancelled.')
                })
              }
            >
              Open contacts
            </button>
          </div>
          <form
            className="vantage-engine-field"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                const path = await api.saveCalendarEvent({
                  ...calendarEvent,
                  start: new Date(calendarEvent.start).toISOString(),
                  end: new Date(calendarEvent.end).toISOString(),
                })
                setMessage(path ? `Calendar created: ${path}` : 'Calendar save cancelled.')
              })
            }}
          >
            <h4>Create a calendar event</h4>
            <label>
              Event title
              <input
                required
                value={calendarEvent.summary}
                onChange={(e) => setCalendarEvent({ ...calendarEvent, summary: e.target.value })}
              />
            </label>
            <label>
              Starts at (your local time)
              <input
                type="datetime-local"
                required
                value={calendarEvent.start}
                onChange={(e) => setCalendarEvent({ ...calendarEvent, start: e.target.value })}
              />
            </label>
            <label>
              Ends at (your local time)
              <input
                type="datetime-local"
                required
                value={calendarEvent.end}
                onChange={(e) => setCalendarEvent({ ...calendarEvent, end: e.target.value })}
              />
            </label>
            <label>
              Location
              <input
                value={calendarEvent.location}
                onChange={(e) => setCalendarEvent({ ...calendarEvent, location: e.target.value })}
              />
            </label>
            <button className="vantage-secondary-button" disabled={busy}>
              Save new calendar
            </button>
          </form>
          {calendar && (
            <>
              <h4>{calendar.fileName}</h4>
              {calendar.warnings.map((w, i) => (
                <p key={i} className="vantage-panel-message">
                  {w}
                </p>
              ))}
              <ul>
                {calendar.occurrences.map((event, i) => (
                  <li key={`${event.uid}-${i}`}>
                    <strong>{event.summary || 'Untitled event'}</strong>
                    <p>
                      {event.start} – {event.end} · {event.timeZone}
                      {event.allDay ? ' · All day' : ''}
                      {event.location ? ` · ${event.location}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {contacts && (
            <>
              <h4>{contacts.fileName}</h4>
              {contacts.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
              <ul>
                {contacts.contacts.map((c, i) => (
                  <li key={`${c.uid}-${i}`}>
                    <strong>{c.name}</strong>
                    <p>{[c.organization, ...c.emails, ...c.phones].filter(Boolean).join(' · ')}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {tab === 'database' && (
        <section aria-label="Local database">
          <h3>Tables, records and queries</h3>
          <p>
            Store structured records in a local Vantage database powered by SQLite. The file format
            is independent of Microsoft Access.
          </p>
          <div className="vantage-panel-toolbar">
            <button
              className="vantage-primary-button"
              disabled={busy}
              onClick={() => void openDatabase(true)}
            >
              Create database
            </button>
            <button
              className="vantage-secondary-button"
              disabled={busy}
              onClick={() => void openDatabase(false)}
            >
              Open database
            </button>
          </div>
          {database && (
            <>
              <p className="vantage-panel-caption">{database.path}</p>
              <form
                className="vantage-engine-field"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run(async () => {
                    const name = newTable.trim()
                    const db = await api.createDatabaseTable(
                      name,
                      columnNames.split(',').map((v) => ({ name: v.trim(), type: 'TEXT' })),
                    )
                    setDatabase(db)
                    setTable(name)
                    setRecord({})
                    setMessage('Table created.')
                  })
                }}
              >
                <h4>Create a table</h4>
                <label>
                  Table name
                  <input value={newTable} onChange={(e) => setNewTable(e.target.value)} required />
                </label>
                <label>
                  Column names, separated by commas
                  <input
                    value={columnNames}
                    onChange={(e) => setColumnNames(e.target.value)}
                    required
                  />
                </label>
                <button className="vantage-secondary-button" disabled={busy}>
                  Create table
                </button>
              </form>
              {database.tables.length > 0 && (
                <>
                  <label>
                    Table
                    <select
                      value={table}
                      onChange={(e) => {
                        setTable(e.target.value)
                        setRecord({})
                        setResult(null)
                      }}
                    >
                      {database.tables.map((t) => (
                        <option key={t.name}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                  <form
                    className="vantage-engine-field"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void run(async () => {
                        const values = Object.fromEntries(
                          (selectedTable?.columns ?? []).map((column) => {
                            const value = record[column.name] ?? ''
                            return [
                              column.name,
                              column.type === 'TEXT'
                                ? value
                                : value.trim() === ''
                                  ? null
                                  : Number(value),
                            ]
                          }),
                        )
                        setDatabase(await api.insertDatabaseRows(table, [values]))
                        setRecord({})
                        setMessage('Record added.')
                      })
                    }}
                  >
                    <h4>Add a record</h4>
                    {selectedTable?.columns.map((column) => (
                      <label key={column.name}>
                        {column.name}
                        <input
                          type={column.type === 'TEXT' ? 'text' : 'number'}
                          step={column.type === 'REAL' ? 'any' : undefined}
                          value={record[column.name] ?? ''}
                          onChange={(e) => setRecord({ ...record, [column.name]: e.target.value })}
                        />
                      </label>
                    ))}
                    <button className="vantage-secondary-button" disabled={busy}>
                      Add record
                    </button>
                  </form>
                  <button
                    className="vantage-secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setResult(await api.queryDatabase(`SELECT * FROM "${table}"`))
                        setMessage('Records loaded.')
                      })
                    }
                  >
                    View records
                  </button>
                </>
              )}
              <form
                className="vantage-engine-field"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run(async () => {
                    setResult(await api.queryDatabase(sql))
                    setMessage('Query complete.')
                  })
                }}
              >
                <label>
                  Read-only SQL query
                  <textarea
                    rows={4}
                    value={sql}
                    onChange={(e) => setSql(e.target.value)}
                    placeholder="SELECT * FROM Records"
                    required
                  />
                </label>
                <button className="vantage-secondary-button" disabled={busy}>
                  Run query
                </button>
              </form>
              {result && (
                <div className="vantage-engine-results">
                  <table>
                    <caption>
                      {result.rows.length} records
                      {result.truncated ? ' · additional records omitted' : ''}
                    </caption>
                    <thead>
                      <tr>
                        {result.columns.map((c) => (
                          <th key={c} scope="col">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i}>
                          {result.columns.map((c) => (
                            <td key={c}>{showValue(row[c])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}
      {tab === 'history' && recovery && (
        <section aria-label="Recovery storage settings">
          <h3>Choose how much history to keep</h3>
          <p>
            {recovery.entries} snapshots · {(recovery.payloadBytes / 1048576).toFixed(1)} MiB of
            document data · {(recovery.occupiedBytes / 1048576).toFixed(1)} MiB on disk.
          </p>
          <p>
            New JavaScript saves record a first-save baseline. Existing-file saves keep the previous
            version. The native spreadsheet save path has its own acceptance checks.
          </p>
          <form
            className="vantage-engine-field"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                setRecovery(
                  await api.updateRecoveryPolicy({
                    maxVaultBytes: recovery.policy.maxVaultBytes,
                    maxEntries: recovery.policy.maxEntries,
                    maxRevisionsPerFile: recovery.policy.maxRevisionsPerFile,
                    minFreeBytes: recovery.policy.minFreeBytes,
                  }),
                )
                setMessage('Recovery budget saved. Limits apply when snapshots are captured.')
              })
            }}
          >
            <label>
              History budget (MiB)
              <input
                type="number"
                min={1}
                max={2048}
                value={recovery.policy.maxVaultBytes / 1048576}
                onChange={(e) =>
                  setRecovery({
                    ...recovery,
                    policy: { ...recovery.policy, maxVaultBytes: Number(e.target.value) * 1048576 },
                  })
                }
              />
            </label>
            <label>
              Maximum snapshots
              <input
                type="number"
                min={1}
                max={384}
                value={recovery.policy.maxEntries}
                onChange={(e) =>
                  setRecovery({
                    ...recovery,
                    policy: { ...recovery.policy, maxEntries: Number(e.target.value) },
                  })
                }
              />
            </label>
            <label>
              Versions per file
              <input
                type="number"
                min={1}
                max={100}
                value={recovery.policy.maxRevisionsPerFile}
                onChange={(e) =>
                  setRecovery({
                    ...recovery,
                    policy: { ...recovery.policy, maxRevisionsPerFile: Number(e.target.value) },
                  })
                }
              />
            </label>
            <button className="vantage-primary-button" disabled={busy}>
              Save history budget
            </button>
          </form>
          <p>
            New-snapshot encryption:{' '}
            {recovery.encryptionEnabled
              ? 'Enabled with an operating-system protected key'
              : 'Disabled'}
            . Earlier unencrypted snapshots: {recovery.plaintextEntries}.
          </p>
          <button
            className="vantage-secondary-button"
            disabled={busy || recovery.encryptionEnabled}
            onClick={() =>
              void run(async () => {
                setRecovery(await api.setRecoveryEncryption())
                setMessage(
                  'New snapshots will use authenticated encryption. Keep an independent backup; this key belongs to the current operating-system profile.',
                )
              })
            }
          >
            Encrypt new snapshots
          </button>
          <p className="vantage-panel-caption">
            Encryption does not rewrite old history or protect against other software running as the
            same user. Recovery copies always use a separate destination.
          </p>
          <h4>Unsaved Markdown drafts</h4>
          <p>
            Markdown records dirty text every 15 seconds and when its window loses focus. Saving or
            explicitly discarding clears that document's draft. Other editor draft models have
            separate support.
          </p>
          <button
            className="vantage-secondary-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setDrafts(await api.draftList())
                setMessage('Draft list refreshed.')
              })
            }
          >
            Refresh drafts
          </button>
          {drafts.length === 0 ? (
            <p>No retained drafts.</p>
          ) : (
            <ul>
              {drafts.map((draft) => (
                <li key={draft.id}>
                  <strong>{draft.documentPath || 'Unnamed document'}</strong>
                  <p>
                    {draft.module} · {draft.updatedAt} · {draft.bytes} bytes
                    {draft.encrypted ? ' · Encrypted' : ''}
                  </p>
                  <button
                    className="vantage-secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const path = await api.restoreDraft(draft.id)
                        setMessage(path ? `Draft recovered: ${path}` : 'Draft recovery cancelled.')
                      })
                    }
                  >
                    Recover draft copy
                  </button>
                  <button
                    className="vantage-secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.discardDraft(draft.id)
                        setDrafts(await api.draftList())
                        setMessage('Draft deleted.')
                      })
                    }
                  >
                    Delete draft
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h4>Portable encrypted history</h4>
          <p>
            Export up to 128 MiB of saved-version document payload to a separate destination. This
            export contains saved snapshots; keep a separate backup of current files, drafts and
            application data.
          </p>
          <label>
            Backup password
            <input
              type="password"
              minLength={8}
              maxLength={1024}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="vantage-panel-toolbar">
            <button
              className="vantage-secondary-button"
              disabled={busy || password.length < 8}
              onClick={() =>
                void run(async () => {
                  const path = await api.exportRecoveryBackup(password)
                  if (path) {
                    setPassword('')
                    setMessage(`Encrypted history exported: ${path}`)
                  } else setMessage('History export cancelled.')
                })
              }
            >
              Export encrypted history
            </button>
            <button
              className="vantage-secondary-button"
              disabled={busy || password.length < 8}
              onClick={() =>
                void run(async () => {
                  const report = await api.inspectRecoveryBackup(password)
                  if (report) {
                    setBackupEntries(report.entries)
                    setMessage(`${report.entries.length} authenticated history entries loaded.`)
                  } else setMessage('History selection cancelled.')
                })
              }
            >
              Open encrypted history
            </button>
          </div>
          {backupEntries.length > 0 && (
            <ul>
              {backupEntries.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.fileName}</strong>
                  <p>
                    {entry.createdAt} · {entry.bytes} bytes
                  </p>
                  <button
                    className="vantage-secondary-button"
                    disabled={busy || password.length < 8}
                    onClick={() =>
                      void run(async () => {
                        const path = await api.restoreBackupCopy(password, entry.id)
                        setMessage(
                          path ? `Backup copy recovered: ${path}` : 'Backup recovery cancelled.',
                        )
                      })
                    }
                  >
                    Recover backup copy
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
