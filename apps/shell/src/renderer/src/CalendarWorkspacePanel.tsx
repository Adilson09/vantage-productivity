import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  CalendarEventInput,
  CalendarEventPatch,
  CalendarMutationOptions,
  CalendarParticipation,
  CalendarParticipant,
} from '../../../../../packages/productivity-engine/src/calendar-types'
import type {
  CalendarAgendaItem,
  CalendarDesktopApi,
  CalendarEventSelection,
  CalendarMutationScope,
  CalendarWorkspaceState,
} from '../../shared/calendar-api'

interface EventForm {
  summary: string
  start: string
  end: string
  allDay: boolean
  timeZone: string
  disambiguation: 'reject' | 'earlier' | 'later' | 'compatible'
  location: string
  description: string
  recurrence: string
  organizer: string
  attendees: string
  status: string
}
interface Editor {
  calendarId: string
  selection: CalendarEventSelection | null
  occurrence: CalendarAgendaItem | null
  scope: CalendarMutationScope
  form: EventForm
  baseline: EventForm
  queue: boolean
}
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const pad = (value: number) => String(value).padStart(2, '0')
const dateText = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const localText = (date: Date) =>
  `${dateText(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`
function shiftDate(value: string, days: number): string {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}
function initialForm(): EventForm {
  const start = new Date(Date.now() + 3600000)
  start.setMinutes(0, 0, 0)
  return {
    summary: '',
    start: localText(start),
    end: localText(new Date(start.getTime() + 3600000)),
    allDay: false,
    timeZone: localZone(),
    disambiguation: 'reject',
    location: '',
    description: '',
    recurrence: '',
    organizer: '',
    attendees: '',
    status: 'CONFIRMED',
  }
}
function fromSelection(selection: CalendarEventSelection): EventForm {
  const value = selection.event
  return {
    summary: value.summary,
    start: value.localStart.slice(0, value.allDay ? 10 : 19),
    end: value.allDay ? shiftDate(value.localEnd, -1) : value.localEnd.slice(0, 19),
    allDay: value.allDay,
    timeZone: value.timeZone,
    disambiguation: 'reject',
    location: value.location,
    description: value.description,
    recurrence: value.recurrence ?? '',
    organizer: value.organizer?.address ?? '',
    attendees: value.attendees.map((p) => p.address).join('\n'),
    status: value.status || 'CONFIRMED',
  }
}
function addressList(value: string, previous: CalendarParticipant[] = []): CalendarParticipant[] {
  return value
    .split(/[\n,;]/)
    .map((address) => address.trim())
    .filter(Boolean)
    .map(
      (address) =>
        previous.find((entry) => entry.address.toLowerCase() === address.toLowerCase()) ?? {
          address,
        },
    )
}
function eventInput(editor: Editor): CalendarEventInput {
  const value = editor.form,
    old = editor.selection?.event
  return {
    summary: value.summary,
    start: value.start,
    end: value.allDay ? shiftDate(value.end, 1) : value.end,
    ...(value.allDay ? {} : { timeZone: value.timeZone }),
    disambiguation: value.disambiguation,
    location: value.location,
    description: value.description,
    recurrence: value.recurrence.trim() || null,
    organizer: value.organizer.trim()
      ? old?.organizer?.address === value.organizer.trim()
        ? old.organizer
        : { address: value.organizer.trim() }
      : null,
    attendees: addressList(value.attendees, old?.attendees),
    status: value.status as CalendarEventInput['status'],
  }
}
function patchFor(editor: Editor): CalendarEventPatch {
  const current = eventInput(editor),
    original = eventInput({ ...editor, form: editor.baseline })
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(current) as (keyof CalendarEventInput)[]) {
    const next = current[key],
      prior = original[key]
    if (
      typeof next === 'object' || typeof prior === 'object'
        ? JSON.stringify(next) !== JSON.stringify(prior)
        : next !== prior
    )
      patch[key] = next
  }
  if (editor.form.allDay !== editor.baseline.allDay) {
    patch.start = current.start
    patch.end = current.end
    if (!editor.form.allDay) patch.timeZone = editor.form.timeZone
  }
  if (
    !editor.form.allDay &&
    (editor.form.timeZone !== editor.baseline.timeZone ||
      editor.form.disambiguation !== editor.baseline.disambiguation)
  ) {
    patch.start = current.start
    patch.end = current.end
    patch.timeZone = current.timeZone
    patch.disambiguation = current.disambiguation
  }
  return patch as CalendarEventPatch
}
function changed(form: EventForm, baseline: EventForm): boolean {
  return (Object.keys(form) as (keyof EventForm)[]).some((key) => form[key] !== baseline[key])
}
function userError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  )
}
function when(item: CalendarAgendaItem): string {
  if (item.allDay)
    return `${item.localStart.slice(0, 10)} through ${shiftDate(item.localEnd, -1)} · All day`
  if (item.floating)
    return `${item.localStart.replace('T', ' ')} – ${item.localEnd.replace('T', ' ')} · Floating time`
  const format = (value: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    )
  return `${format(item.start)} – ${format(item.end)}`
}
const methodLabel = {
  PUBLISH: 'Calendar publication',
  REQUEST: 'Invitation or update',
  REPLY: 'Response',
  CANCEL: 'Cancellation',
}

function RepeatControl({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const simple =
    /^(?:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY))(?:;INTERVAL=(\d+))?(?:;COUNT=(\d+))?$/i.exec(value)
  const [custom, setCustom] = useState(false)
  const mode = custom || (value && !simple) ? 'custom' : simple?.[1].toUpperCase() || ''
  const interval = Number(simple?.[2] || 1)
  const count = simple?.[3] || ''
  const update = (frequency: string, every = interval, occurrences = count) =>
    onChange(
      frequency
        ? `FREQ=${frequency}${every > 1 ? `;INTERVAL=${every}` : ''}${occurrences ? `;COUNT=${occurrences}` : ''}`
        : '',
    )
  return (
    <div>
      <label>
        Repeats
        <select
          value={mode}
          onChange={(event) => {
            const next = event.target.value
            setCustom(next === 'custom')
            if (next !== 'custom') update(next, 1, '')
          }}
        >
          <option value="">Does not repeat</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
          <option value="YEARLY">Yearly</option>
          <option value="custom">Custom rule</option>
        </select>
      </label>
      {mode === 'custom' ? (
        <label>
          Custom calendar repeat rule
          <input
            value={value}
            maxLength={4096}
            placeholder="For example, FREQ=WEEKLY;BYDAY=MO,WE"
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      ) : mode ? (
        <div className="vantage-calendar-columns">
          <label>
            Repeat every
            <input
              type="number"
              min="1"
              max="999"
              required
              value={interval}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (Number.isInteger(next) && next >= 1 && next <= 999) update(mode, next)
              }}
            />
          </label>
          <label>
            Number of occurrences, optional
            <input
              type="number"
              min="1"
              max="100000"
              value={count}
              onChange={(event) => {
                const next = event.target.value
                if (!next || (/^\d+$/.test(next) && Number(next) >= 1 && Number(next) <= 100000))
                  update(mode, interval, next)
              }}
            />
          </label>
        </div>
      ) : null}
    </div>
  )
}

export function CalendarWorkspacePanel({
  api,
  active,
  onDirtyChange,
}: {
  api: CalendarDesktopApi
  active: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [workspace, setWorkspace] = useState<CalendarWorkspaceState>({ calendars: [], outbox: [] })
  const [filter, setFilter] = useState('')
  const [newName, setNewName] = useState('')
  const [rename, setRename] = useState('')
  const [start, setStart] = useState(dateText(new Date()))
  const [end, setEnd] = useState(shiftDate(dateText(new Date()), 30))
  const [occurrences, setOccurrences] = useState<CalendarAgendaItem[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [page, setPage] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [requestedScope, setRequestedScope] = useState<CalendarMutationScope>('instance')
  const [responding, setResponding] = useState('')
  const [participation, setParticipation] = useState<CalendarParticipation>('ACCEPTED')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const busyRef = useRef(false),
    request = useRef(0),
    mounted = useRef(true)
  const editorForm = useRef<HTMLFormElement>(null)
  const selected = workspace.calendars.find((entry) => entry.id === filter)
  const formDirty = !!editor && (changed(editor.form, editor.baseline) || editor.queue)
  const dirty = formDirty || !!newName.trim() || (!!selected && rename !== selected.name)
  useLayoutEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onDirtyChange?.(false)
    }
  }, [])
  const editorIdentity = editor
    ? `${editor.calendarId}:${editor.selection?.event.uid ?? 'new'}:${editor.occurrence?.instanceId ?? ''}:${editor.scope}`
    : ''
  useEffect(() => {
    if (!editorIdentity || !active) return
    const input = editorForm.current?.querySelector<HTMLInputElement>('input[data-calendar-name]')
    input?.focus({ preventScroll: true })
    input?.scrollIntoView({ block: 'nearest' })
  }, [editorIdentity, active])
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (reason) {
      if (mounted.current) setError(userError(reason))
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const loadAgenda = async (calendarId = filter) => {
    const current = ++request.current
    const from = new Date(`${start}T00:00:00`),
      through = new Date(`${shiftDate(end, 1)}T00:00:00`)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(through.getTime()))
      throw new Error('Choose valid agenda dates.')
    const result = await api.calendarAgenda({
      ...(calendarId ? { calendarId } : {}),
      start: from.toISOString(),
      end: through.toISOString(),
      viewTimeZone: localZone(),
    })
    if (mounted.current && current === request.current) {
      setOccurrences(result.occurrences)
      setWarnings(result.warnings)
      setPage(0)
    }
  }
  const refresh = async (calendarId = filter) => {
    const state = await api.calendarWorkspaceStatus()
    if (!mounted.current) return
    setWorkspace(state)
    const next =
      calendarId && state.calendars.some((entry) => entry.id === calendarId) ? calendarId : ''
    setFilter(next)
    setRename((current) =>
      next === filter && selected && current !== selected.name
        ? current
        : (state.calendars.find((entry) => entry.id === next)?.name ?? ''),
    )
    if (state.calendars.length) await loadAgenda(next)
    else {
      setOccurrences([])
      setWarnings([])
      setPage(0)
    }
  }
  useEffect(() => {
    if (active && typeof api.calendarWorkspaceStatus === 'function') void run(() => refresh())
  }, [active])
  const editOccurrence = async (
    occurrence: CalendarAgendaItem,
    scope: CalendarMutationScope = occurrence.recurring ? 'instance' : 'series',
  ) => {
    const selection = await api.calendarEventDetails(occurrence.calendarId, {
      uid: occurrence.uid,
      ...(occurrence.recurrenceId ? { recurrenceId: occurrence.recurrenceId } : {}),
      scope,
    })
    if (!mounted.current) return
    const form = fromSelection(selection)
    setEditor({
      calendarId: occurrence.calendarId,
      selection,
      occurrence,
      scope,
      form,
      baseline: form,
      queue: false,
    })
    setRequestedScope(scope)
    setResponding(selection.event.attendees[0]?.address ?? '')
  }
  const updateForm = (patch: Partial<EventForm>) =>
    setEditor((value) => (value ? { ...value, form: { ...value.form, ...patch } } : null))
  const save = async (copy = false) => {
    if (!editor) return
    const calendar = workspace.calendars.find((entry) => entry.id === editor.calendarId)
    if (!calendar) throw new Error('Choose a saved calendar.')
    const creating = copy || !editor.selection
    const input = creating ? eventInput(editor) : null
    if (input && copy && editor.selection && editor.scope !== 'series') input.recurrence = null
    const options: CalendarMutationOptions = {
      expectedRevision:
        editor.selection && !copy ? editor.selection.calendar.revision : calendar.revision,
      ...(editor.queue ? { queueMethod: 'REQUEST' as const } : {}),
    }
    const result = await api.calendarMutate(
      editor.calendarId,
      creating
        ? { type: 'create', event: input! }
        : {
            type: 'update',
            uid: editor.selection!.event.uid,
            ...(editor.scope !== 'series' && editor.occurrence?.recurrenceId
              ? { recurrenceId: editor.occurrence.recurrenceId }
              : {}),
            scope: editor.scope,
            patch: patchFor(editor),
          },
      options,
    )
    if (!result) return
    setEditor(null)
    await refresh(editor.calendarId)
    setMessage(
      `${creating ? 'Event saved.' : 'Event updated.'}${result.outboxIds.length ? ' A meeting message is prepared locally.' : ''}${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`,
    )
  }
  const visible = occurrences.slice(page * 50, (page + 1) * 50)
  const editorCalendar = editor
    ? workspace.calendars.find((entry) => entry.id === editor.calendarId)
    : undefined
  const stale =
    !!editor?.selection && editorCalendar?.revision !== editor.selection.calendar.revision
  if (typeof api.calendarWorkspaceStatus !== 'function')
    return <p>The saved calendar workspace requires an updated application build.</p>
  return (
    <section
      aria-label="Saved calendar workspace"
      aria-busy={busy}
      className="vantage-calendar-workspace"
    >
      <h3>Your calendars</h3>
      <p>
        Events are saved on this computer. Prepared meeting messages remain local until you export
        them.
      </p>
      {error && (
        <p className="vantage-tool-error" role="alert">
          {error}
        </p>
      )}
      <p className="vantage-panel-status" role="status" aria-live="polite">
        {busy ? 'Working…' : message}
      </p>
      <div className="vantage-calendar-columns">
        <form
          className="vantage-engine-field"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const value = await api.calendarCreate(newName)
              setNewName('')
              await refresh(value.id)
              setMessage('Calendar added to this workspace.')
            })
          }}
        >
          <label>
            New calendar name
            <input
              required
              maxLength={128}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="For example, Personal"
            />
          </label>
          <button className="vantage-primary-button" disabled={busy}>
            Add calendar
          </button>
        </form>
        <div className="vantage-engine-field">
          <h4>Calendar files</h4>
          <p>
            Import events, or apply an invitation, response or cancellation to a selected calendar.
          </p>
          <button
            type="button"
            className="vantage-secondary-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const value = await api.calendarImportFile()
                if (!value) {
                  setMessage('Calendar import cancelled.')
                  return
                }
                await refresh(value.id)
                setMessage('Calendar imported into this workspace.')
              })
            }
          >
            Import into workspace
          </button>
          <button
            type="button"
            className="vantage-secondary-button"
            disabled={busy || !selected}
            onClick={() =>
              void run(async () => {
                if (!selected) return
                const value = await api.calendarApplyMessage(selected.id, selected.revision)
                if (!value) {
                  setMessage('Calendar message cancelled.')
                  return
                }
                await refresh(selected.id)
                setMessage(
                  `${value.applied} updates applied locally; ${value.ignored} ignored. ${value.warnings.join(' ')}`,
                )
              })
            }
          >
            Apply calendar message
          </button>
        </div>
      </div>
      <fieldset className="vantage-engine-field" disabled={busy}>
        <legend>Agenda</legend>
        <div className="vantage-calendar-columns">
          <label>
            Calendar to show
            <select
              value={filter}
              onChange={(event) => {
                const value = event.target.value
                setFilter(value)
                setRename(workspace.calendars.find((entry) => entry.id === value)?.name ?? '')
                void run(() => loadAgenda(value))
              }}
            >
              <option value="">All saved calendars</option>
              {workspace.calendars.map((calendar) => (
                <option value={calendar.id} key={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            From date
            <input
              type="date"
              required
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            Through date
            <input
              type="date"
              required
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        </div>
        <p>
          Timed events are displayed in {localZone()}. All-day and floating times keep their
          calendar labels.
        </p>
        <div className="vantage-panel-toolbar">
          <button
            type="button"
            className="vantage-secondary-button"
            onClick={() => void run(() => refresh())}
          >
            Refresh agenda
          </button>
          <button
            type="button"
            className="vantage-primary-button"
            disabled={!workspace.calendars.length || formDirty}
            onClick={() => {
              const form = initialForm()
              setEditor({
                calendarId: filter || workspace.calendars[0].id,
                selection: null,
                occurrence: null,
                scope: 'series',
                form,
                baseline: form,
                queue: false,
              })
              setRequestedScope('series')
              setError('')
            }}
          >
            New event
          </button>
        </div>
        {selected && (
          <div className="vantage-engine-field">
            <label>
              Calendar name
              <input
                maxLength={128}
                value={rename}
                onChange={(event) => setRename(event.target.value)}
              />
            </label>
            <div className="vantage-panel-toolbar">
              <button
                type="button"
                className="vantage-secondary-button"
                disabled={!rename.trim() || rename === selected.name}
                onClick={() =>
                  void run(async () => {
                    await api.calendarRename(selected.id, rename, selected.revision)
                    await refresh(selected.id)
                    setMessage('Calendar renamed.')
                  })
                }
              >
                Rename calendar
              </button>
              <button
                type="button"
                className="vantage-secondary-button"
                onClick={() =>
                  void run(async () => {
                    const result = await api.calendarExport(selected.id, selected.revision)
                    await refresh(selected.id)
                    setMessage(
                      result ? 'Calendar exported to a new file.' : 'Calendar export cancelled.',
                    )
                  })
                }
              >
                Export calendar copy
              </button>
              <button
                type="button"
                className="vantage-secondary-button"
                disabled={!selected.originPath}
                onClick={() =>
                  void run(async () => {
                    const result = await api.calendarExport(selected.id, selected.revision, true)
                    await refresh(selected.id)
                    setMessage(result ? 'Linked calendar file updated.' : 'File update cancelled.')
                  })
                }
              >
                Update linked file
              </button>
              <button
                type="button"
                className="vantage-secondary-button"
                disabled={formDirty}
                onClick={() =>
                  void run(async () => {
                    if (await api.calendarRemove(selected.id, selected.revision)) {
                      setEditor(null)
                      await refresh('')
                      setMessage('Local calendar removed.')
                    }
                  })
                }
              >
                Remove local calendar
              </button>
            </div>
          </div>
        )}
      </fieldset>
      {warnings.map((warning, index) => (
        <p className="vantage-panel-message" key={index}>
          {warning}
        </p>
      ))}
      {!workspace.calendars.length ? (
        <p>Add or import your first calendar to begin.</p>
      ) : (
        <>
          <div className="vantage-engine-results">
            <table>
              <caption>{occurrences.length} events in this range</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">When</th>
                  <th scope="col">Calendar</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={`${item.calendarId}:${item.instanceId}`}>
                    <td>
                      <strong>
                        {item.summaryPreview || 'Untitled event'}
                        {item.summaryPreview.length === 256 && item.previewTruncated ? '…' : ''}
                      </strong>
                      {item.locationPreview && <p>{item.locationPreview}</p>}
                      {item.recurring && <span>Repeating event</span>}
                    </td>
                    <td>
                      {when(item)}
                      {!item.allDay && !item.floating && <p>Event zone: {item.timeZone}</p>}
                    </td>
                    <td>
                      {workspace.calendars.find((entry) => entry.id === item.calendarId)?.name}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="vantage-secondary-button"
                        disabled={busy || formDirty}
                        onClick={() => void run(() => editOccurrence(item))}
                      >
                        Edit event
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!occurrences.length && <p>No events in this range.</p>}
          {occurrences.length > 50 && (
            <nav className="vantage-panel-toolbar" aria-label="Agenda pages">
              <button
                type="button"
                className="vantage-secondary-button"
                disabled={busy || page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous events
              </button>
              <span>
                Page {page + 1} of {Math.ceil(occurrences.length / 50)}
              </span>
              <button
                type="button"
                className="vantage-secondary-button"
                disabled={busy || (page + 1) * 50 >= occurrences.length}
                onClick={() => setPage(page + 1)}
              >
                Next events
              </button>
            </nav>
          )}
        </>
      )}
      {editor && (
        <form
          ref={editorForm}
          className="vantage-engine-field"
          aria-label="Calendar event editor"
          onSubmit={(event) => {
            event.preventDefault()
            void run(() => save())
          }}
        >
          <h4>{editor.selection ? 'Edit saved event' : 'Create saved event'}</h4>
          {stale && (
            <p className="vantage-tool-error" role="alert">
              This calendar changed after the event was opened. Your edits are retained. Reload the
              event or save a new event to keep a separate copy.
            </p>
          )}
          <fieldset disabled={busy}>
            <label>
              Save in calendar
              <select
                value={editor.calendarId}
                disabled={!!editor.selection}
                onChange={(event) => setEditor({ ...editor, calendarId: event.target.value })}
              >
                {workspace.calendars.map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.name}
                  </option>
                ))}
              </select>
            </label>
            {editor.selection && editor.occurrence?.recurring && (
              <div>
                <label>
                  Occurrences to edit
                  <select
                    value={requestedScope}
                    onChange={(event) =>
                      setRequestedScope(event.target.value as CalendarMutationScope)
                    }
                  >
                    <option value="instance">Only this occurrence</option>
                    <option value="series">Entire series</option>
                    <option value="this-and-future">This and future occurrences</option>
                  </select>
                </label>
                {requestedScope !== editor.scope && (
                  <>
                    <p>Loading a different scope replaces the current unsaved edits.</p>
                    <button
                      type="button"
                      className="vantage-secondary-button"
                      onClick={() =>
                        void run(() => editOccurrence(editor.occurrence!, requestedScope))
                      }
                    >
                      Load selected edit scope
                    </button>
                  </>
                )}
              </div>
            )}
            <label>
              Event name
              <input
                data-calendar-name
                maxLength={4096}
                value={editor.form.summary}
                onChange={(event) => updateForm({ summary: event.target.value })}
              />
            </label>
            <label className="vantage-engine-check">
              <input
                type="checkbox"
                checked={editor.form.allDay}
                onChange={(event) =>
                  updateForm({
                    allDay: event.target.checked,
                    timeZone:
                      !event.target.checked && editor.form.timeZone === 'date'
                        ? localZone()
                        : editor.form.timeZone,
                    start: event.target.checked
                      ? editor.form.start.slice(0, 10)
                      : `${editor.form.start.slice(0, 10)}T09:00:00`,
                    end: event.target.checked
                      ? editor.form.end.slice(0, 10)
                      : `${editor.form.end.slice(0, 10)}T10:00:00`,
                  })
                }
              />
              All-day event
            </label>
            <div className="vantage-calendar-columns">
              <label>
                {editor.form.allDay ? 'First day' : 'Event starts'}
                <input
                  type={editor.form.allDay ? 'date' : 'datetime-local'}
                  step="1"
                  required
                  value={editor.form.start}
                  onChange={(event) => updateForm({ start: event.target.value })}
                />
              </label>
              <label>
                {editor.form.allDay ? 'Last day' : 'Event ends'}
                <input
                  type={editor.form.allDay ? 'date' : 'datetime-local'}
                  step="1"
                  required
                  value={editor.form.end}
                  onChange={(event) => updateForm({ end: event.target.value })}
                />
              </label>
            </div>
            {!editor.form.allDay && (
              <>
                <label>
                  Event time zone
                  <input
                    required
                    value={editor.form.timeZone}
                    maxLength={128}
                    disabled={editor.scope === 'this-and-future'}
                    placeholder="For example, America/Toronto or UTC"
                    onChange={(event) => updateForm({ timeZone: event.target.value })}
                  />
                </label>
                <label>
                  Repeated or skipped clock time
                  <select
                    value={editor.form.disambiguation}
                    onChange={(event) =>
                      updateForm({
                        disambiguation: event.target.value as EventForm['disambiguation'],
                      })
                    }
                  >
                    <option value="reject">Ask me to choose if this time is ambiguous</option>
                    <option value="earlier">Use the earlier occurrence</option>
                    <option value="later">Use the later occurrence</option>
                    <option value="compatible">Use the calendar import convention</option>
                  </select>
                </label>
              </>
            )}
            <label>
              Event location
              <input
                maxLength={4096}
                value={editor.form.location}
                onChange={(event) => updateForm({ location: event.target.value })}
              />
            </label>
            <label>
              Event description
              <textarea
                rows={3}
                maxLength={16384}
                value={editor.form.description}
                onChange={(event) => updateForm({ description: event.target.value })}
              />
            </label>
            {(!editor.selection || editor.scope === 'series') && (
              <RepeatControl
                key={editorIdentity}
                value={editor.form.recurrence}
                onChange={(recurrence) => updateForm({ recurrence })}
              />
            )}
            <div className="vantage-calendar-columns">
              <label>
                Organizer address
                <input
                  maxLength={2048}
                  value={editor.form.organizer}
                  onChange={(event) => updateForm({ organizer: event.target.value })}
                />
              </label>
              <label>
                Attendee addresses, one per line
                <textarea
                  rows={3}
                  maxLength={65536}
                  value={editor.form.attendees}
                  onChange={(event) => updateForm({ attendees: event.target.value })}
                />
              </label>
            </div>
            <label>
              Event status
              <select
                value={editor.form.status}
                onChange={(event) => updateForm({ status: event.target.value })}
              >
                {!['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(editor.form.status) && (
                  <option value={editor.form.status}>{editor.form.status || 'Unspecified'}</option>
                )}
                <option value="CONFIRMED">Confirmed</option>
                <option value="TENTATIVE">Tentative</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </label>
            <label className="vantage-engine-check">
              <input
                type="checkbox"
                checked={editor.queue}
                onChange={(event) => setEditor({ ...editor, queue: event.target.checked })}
              />
              Prepare a local invitation/update message for the attendees
            </label>
            <div className="vantage-panel-toolbar">
              <button
                className="vantage-primary-button"
                disabled={
                  stale ||
                  (!!editor.selection && requestedScope !== editor.scope) ||
                  (!!editor.selection && !formDirty)
                }
              >
                Save event
              </button>
              <button
                type="button"
                className="vantage-secondary-button"
                onClick={() => setEditor(null)}
              >
                Cancel event editing
              </button>
              {editor.selection && (
                <button
                  type="button"
                  className="vantage-secondary-button"
                  onClick={() => void run(() => save(true))}
                >
                  Save as a new event
                </button>
              )}
              {editor.selection && editor.occurrence && (
                <button
                  type="button"
                  className="vantage-secondary-button"
                  onClick={() => void run(() => editOccurrence(editor.occurrence!, editor.scope))}
                >
                  Reload event and discard unsaved edits
                </button>
              )}
              {editor.selection && (
                <button
                  type="button"
                  className="vantage-secondary-button"
                  disabled={stale || requestedScope !== editor.scope}
                  onClick={() =>
                    void run(async () => {
                      const result = await api.calendarMutate(
                        editor.calendarId,
                        {
                          type: 'delete',
                          uid: editor.selection!.event.uid,
                          ...(editor.scope !== 'series' && editor.occurrence?.recurrenceId
                            ? { recurrenceId: editor.occurrence.recurrenceId }
                            : {}),
                          scope: editor.scope,
                        },
                        {
                          expectedRevision: editor.selection!.calendar.revision,
                          ...(editor.queue ? { queueMethod: 'CANCEL' as const } : {}),
                        },
                      )
                      if (result) {
                        setEditor(null)
                        await refresh(editor.calendarId)
                        setMessage('Event removed locally.')
                      }
                    })
                  }
                >
                  Delete saved event
                </button>
              )}
            </div>
          </fieldset>
          {editor.selection?.event.attendees.length ? (
            <fieldset
              disabled={
                busy ||
                formDirty ||
                stale ||
                requestedScope !== editor.scope ||
                editor.scope === 'this-and-future'
              }
              className="vantage-engine-field"
            >
              <legend>Prepare a local meeting response</legend>
              <p>
                Responses apply to the loaded occurrence or entire series. Load one of those scopes
                and save any event edits before preparing a response.
              </p>
              <label>
                Responding attendee
                <select value={responding} onChange={(event) => setResponding(event.target.value)}>
                  {editor.selection.event.attendees.map((participant) => (
                    <option value={participant.address} key={participant.address}>
                      {participant.name ? `${participant.name} · ` : ''}
                      {participant.address}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Participation response
                <select
                  value={participation}
                  onChange={(event) =>
                    setParticipation(event.target.value as CalendarParticipation)
                  }
                >
                  <option value="ACCEPTED">Accept</option>
                  <option value="TENTATIVE">Tentative</option>
                  <option value="DECLINED">Decline</option>
                  <option value="NEEDS-ACTION">Needs action</option>
                </select>
              </label>
              <button
                type="button"
                className="vantage-secondary-button"
                onClick={() =>
                  void run(async () => {
                    const result = await api.calendarMutate(
                      editor.calendarId,
                      {
                        type: 'respond',
                        uid: editor.selection!.event.uid,
                        ...(editor.scope !== 'series' && editor.occurrence?.recurrenceId
                          ? { recurrenceId: editor.occurrence.recurrenceId }
                          : {}),
                        attendee: responding,
                        participation,
                      },
                      {
                        expectedRevision: editor.selection!.calendar.revision,
                        queueMethod: 'REPLY',
                      },
                    )
                    if (result) {
                      setEditor(null)
                      await refresh(editor.calendarId)
                      setMessage('Response saved locally and prepared for export.')
                    }
                  })
                }
              >
                Prepare response
              </button>
              <p>No account is connected to deliver this response automatically.</p>
            </fieldset>
          ) : null}
        </form>
      )}
      <section className="vantage-engine-field" aria-label="Prepared calendar messages">
        <h4>Prepared messages</h4>
        <p>
          Export a message to use it in another calendar application. Exporting does not mark it as
          delivered.
        </p>
        {!workspace.outbox.some((item) => item.state !== 'discarded') ? (
          <p>No prepared calendar messages.</p>
        ) : (
          <ul className="vantage-calendar-outbox">
            {workspace.outbox
              .filter((item) => item.state !== 'discarded')
              .map((item) => (
                <li key={item.id}>
                  <strong>{methodLabel[item.method]}</strong> ·{' '}
                  {item.state === 'delivered'
                    ? 'Local test completed'
                    : item.state === 'inflight'
                      ? 'Local test running'
                      : item.state}
                  <p>
                    {workspace.calendars.find((calendar) => calendar.id === item.calendarId)
                      ?.name ?? 'Removed calendar'}{' '}
                    · {new Date(item.createdAt).toLocaleString()}
                  </p>
                  {item.error && <p className="vantage-tool-error">{item.error}</p>}
                  <div className="vantage-panel-toolbar">
                    <button
                      type="button"
                      className="vantage-secondary-button"
                      disabled={busy || item.state === 'delivered'}
                      onClick={() =>
                        void run(async () => {
                          const path = await api.calendarExportMessage(item.id)
                          setMessage(
                            path
                              ? 'Prepared message exported. Delivery remains your choice.'
                              : 'Message export cancelled.',
                          )
                        })
                      }
                    >
                      Export message
                    </button>
                    <button
                      type="button"
                      className="vantage-secondary-button"
                      disabled={busy || item.state === 'inflight'}
                      onClick={() =>
                        void run(async () => {
                          await api.calendarDiscardMessage(item.id)
                          await refresh()
                          setMessage('Prepared message discarded.')
                        })
                      }
                    >
                      Discard message
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
    </section>
  )
}
