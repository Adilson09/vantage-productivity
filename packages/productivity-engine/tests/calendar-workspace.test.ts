import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCalendar } from '../src/calendar'
import {
  CalendarOriginConflictError,
  CalendarRevisionConflictError,
  CalendarWorkspace,
  CalendarWorkspaceLimitError,
} from '../src/calendar-workspace'
import type { CalendarEventInput } from '../src/calendar-types'

const directories: string[] = [],
  workspaces: CalendarWorkspace[] = []
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'vantage-calendar-workspace-'))
  directories.push(path)
  return path
}
const workspace = (path = ':memory:', create = false): CalendarWorkspace => {
  const db = new CalendarWorkspace(path, { create })
  workspaces.push(db)
  return db
}
const meeting = (patch: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  uid: 'planning',
  summary: 'Planning',
  start: '2026-10-29T09:00:00Z',
  end: '2026-10-29T10:00:00Z',
  recurrence: 'FREQ=DAILY;COUNT=3',
  organizer: { address: 'organizer@example.test' },
  attendees: [
    { address: 'alice@example.test', participation: 'NEEDS-ACTION' },
    { address: 'bob@example.test', participation: 'NEEDS-ACTION' },
  ],
  ...patch,
})
const range = { start: '2026-10-28T00:00:00Z', end: '2026-11-03T00:00:00Z' }
const envelope = (method: string, ...body: string[]): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Local test//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    'UID:planning',
    ...body,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of workspaces.splice(0)) db.close()
  for (const path of directories.splice(0)) {
    if (
      !resolve(path).startsWith(
        resolve(tmpdir()) +
          '/'.replace('/', process.platform === 'win32' ? '\\' : '/') +
          'vantage-calendar-workspace-',
      )
    )
      throw new Error('Unsafe calendar test cleanup path')
    rmSync(path, { recursive: true, force: true })
  }
})

describe('local persistent calendar workspace', () => {
  it('creates an empty calendar, persists a real event, closes and reopens with stable identity', () => {
    const path = join(directory(), 'calendar.sqlite')
    const first = workspace(path, true),
      calendar = first.createCalendar({ name: 'My calendar' })
    expect(calendar.eventCount).toBe(0)
    const changed = first.mutateCalendar(
      calendar.id,
      { type: 'create', event: meeting({ recurrence: null }) },
      { expectedRevision: 1 },
    )
    const instance = first.occurrences(calendar.id, range).occurrences[0]!
    first.close()
    const reopened = workspace(path)
    expect(reopened.readCalendar(calendar.id).revision).toBe(changed.calendar.revision)
    expect(reopened.occurrences(calendar.id, range).occurrences[0]!.instanceId).toBe(
      instance.instanceId,
    )
    expect(instance.recurrenceId).toBeNull()
    expect(instance).toMatchObject({
      calendarId: calendar.id,
      calendarRevision: 2,
      organizer: { address: 'mailto:organizer@example.test' },
    })
    expect(reopened.listCalendars()[0]).not.toHaveProperty('source')
  })
  it('rejects overwrite creation, foreign databases and stale writes from a second connection', () => {
    const path = join(directory(), 'calendar.sqlite')
    const first = workspace(path, true),
      calendar = first.createCalendar({ name: 'A' })
    expect(() => new CalendarWorkspace(path, { create: true })).toThrow()
    const second = workspace(path)
    first.mutateCalendar(
      calendar.id,
      { type: 'create', event: meeting() },
      { expectedRevision: calendar.revision },
    )
    expect(() => second.renameCalendar(calendar.id, 'Stale', { expectedRevision: 1 })).toThrow(
      CalendarRevisionConflictError,
    )
    expect(second.readCalendar(calendar.id).name).toBe('A')
    const foreign = join(directory(), 'foreign.sqlite'),
      db = new DatabaseSync(foreign)
    db.exec('CREATE TABLE example(value TEXT)')
    db.close()
    expect(() => new CalendarWorkspace(foreign)).toThrow('not a supported')
  })
  it('retains unknown components, properties, parameters and BOM while editing known text', () => {
    const db = workspace()
    const original =
      '\uFEFF' +
      createCalendar([meeting()])
        .replace(
          'END:VCALENDAR',
          'BEGIN:VTODO\r\nUID:task\r\nX-TASK:keep\r\nEND:VTODO\r\nX-CALENDAR;X-PARAM=retain:opaque\r\nEND:VCALENDAR',
        )
        .replace(
          'SUMMARY:Planning',
          'SUMMARY;X-UNKNOWN=yes:Planning\r\nX-CUSTOM:opaque\r\nATTACH:https://example.invalid/never-fetched',
        )
    const calendar = db.importCalendar(original, { name: 'Imported' })
    expect(db.exportCalendar(calendar.id)).toBe(original)
    const changed = db.mutateCalendar(
      calendar.id,
      { type: 'update', uid: 'planning', patch: { summary: 'Edited' } },
      { expectedRevision: 1 },
    ).calendar
    expect(changed.source.startsWith('\uFEFF')).toBe(true)
    for (const preserved of [
      'X-UNKNOWN=yes',
      'X-CUSTOM:opaque',
      'X-CALENDAR;X-PARAM=retain:opaque',
      'BEGIN:VTODO',
      'ATTACH:https://example.invalid/never-fetched',
    ])
      expect(changed.source).toContain(preserved)
  })
  it('moves one instance without moving its stable original identifier or the other dates', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Recurring', source: createCalendar([meeting()]) })
    const before = db.occurrences(calendar.id, range).occurrences
    const selected = before[1]!
    const changed = db.mutateCalendar(
      calendar.id,
      {
        type: 'update',
        uid: selected.uid,
        recurrenceId: selected.recurrenceId!,
        patch: { start: '2026-10-30T14:00:00Z', end: '2026-10-30T15:00:00Z', summary: 'Moved' },
      },
      { expectedRevision: 1 },
    )
    const after = db.occurrences(calendar.id, range).occurrences
    expect(after.map((o) => o.start)).toEqual([
      '2026-10-29T09:00:00.000Z',
      '2026-10-30T14:00:00.000Z',
      '2026-10-31T09:00:00.000Z',
    ])
    expect(after[1]!.instanceId).toBe(selected.instanceId)
    expect(
      db.eventDetails(calendar.id, { uid: 'planning', recurrenceId: selected.recurrenceId! })
        .summary,
    ).toBe('Moved')
    expect(() =>
      db.mutateCalendar(
        calendar.id,
        {
          type: 'update',
          uid: 'planning',
          scope: 'series',
          patch: { recurrence: 'FREQ=WEEKLY;COUNT=3' },
        },
        { expectedRevision: changed.calendar.revision },
      ),
    ).toThrow('explicit series split')
    expect(db.readCalendar(calendar.id).revision).toBe(changed.calendar.revision)
  })
  it('edits full local-time fields using an imported custom definition and preserves its origin rules', () => {
    const db = workspace()
    const source = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Custom zone//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Custom/Office',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0545',
      'TZOFFSETTO:+0545',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:custom',
      'DTSTART;TZID=Custom/Office:20261029T090000',
      'DTEND;TZID=Custom/Office:20261029T100000',
      'X-KEEP:opaque',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const calendar = db.importCalendar(source, { name: 'Custom' })
    db.mutateCalendar(
      calendar.id,
      {
        type: 'update',
        uid: 'custom',
        patch: {
          summary: 'Changed',
          start: '2026-10-29T11:00:00',
          end: '2026-10-29T12:00:00',
          timeZone: 'Custom/Office',
        },
      },
      { expectedRevision: 1 },
    )
    expect(db.eventDetails(calendar.id, { uid: 'custom' })).toMatchObject({
      start: '2026-10-29T05:15:00.000Z',
      timeZone: 'Custom/Office',
      localStart: '2026-10-29T11:00:00',
    })
    expect(db.exportCalendar(calendar.id)).toContain('X-KEEP:opaque')
    expect(db.exportCalendar(calendar.id)).toContain('TZID:Custom/Office')
  })
  it('changes a timed event to all-day without carrying its old zone into DATE values', () => {
    const db = workspace(),
      calendar = db.createCalendar({
        name: 'All day',
        source: createCalendar([
          meeting({
            recurrence: null,
            start: '2026-10-29T09:00:00',
            end: '2026-10-29T10:00:00',
            timeZone: 'America/Toronto',
          }),
        ]),
      })
    db.mutateCalendar(
      calendar.id,
      { type: 'update', uid: 'planning', patch: { start: '2026-10-29', end: '2026-10-31' } },
      { expectedRevision: 1 },
    )
    expect(db.eventDetails(calendar.id, { uid: 'planning' })).toMatchObject({
      allDay: true,
      start: '2026-10-29',
      end: '2026-10-31',
      timeZone: 'date',
    })
    expect(db.exportCalendar(calendar.id)).toContain('DTSTART;VALUE=DATE:20261029')
  })
  it('does not silently turn an existing wall-time recurrence into a later-fold UTC recurrence', () => {
    const db = workspace(),
      calendar = db.createCalendar({
        name: 'Fold',
        source: createCalendar([
          meeting({
            start: '2026-10-31T01:30:00',
            end: '2026-10-31T02:30:00',
            timeZone: 'America/Toronto',
          }),
        ]),
      })
    const before = db.exportCalendar(calendar.id)
    expect(() =>
      db.mutateCalendar(
        calendar.id,
        {
          type: 'update',
          uid: 'planning',
          patch: {
            start: '2026-11-01T01:30:00',
            end: '2026-11-01T02:30:00',
            timeZone: 'America/Toronto',
            disambiguation: 'later',
          },
        },
        { expectedRevision: 1 },
      ),
    ).toThrow('explicit UTC series')
    expect(db.exportCalendar(calendar.id)).toBe(before)
    expect(db.readCalendar(calendar.id).revision).toBe(1)
  })
  it('cancels one instance and supports an explicit future-range cancellation', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Recurring', source: createCalendar([meeting()]) })
    db.mutateCalendar(
      calendar.id,
      { type: 'delete', uid: 'planning', recurrenceId: '2026-10-30T09:00:00Z', scope: 'instance' },
      { expectedRevision: 1 },
    )
    expect(db.occurrences(calendar.id, range).occurrences.map((o) => o.start)).toEqual([
      '2026-10-29T09:00:00.000Z',
      '2026-10-31T09:00:00.000Z',
    ])
    const second = db.createCalendar({ name: 'Future', source: createCalendar([meeting()]) })
    db.mutateCalendar(
      second.id,
      {
        type: 'delete',
        uid: 'planning',
        recurrenceId: '2026-10-30T09:00:00Z',
        scope: 'this-and-future',
      },
      { expectedRevision: 1 },
    )
    expect(db.occurrences(second.id, range).occurrences).toHaveLength(1)
    expect(db.exportCalendar(second.id)).toContain('RANGE=THISANDFUTURE')
  })
  it('applies an explicit future wall-time shift while retaining earlier instances', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Future', source: createCalendar([meeting()]) })
    db.mutateCalendar(
      calendar.id,
      {
        type: 'update',
        uid: 'planning',
        recurrenceId: '2026-10-30T09:00:00Z',
        scope: 'this-and-future',
        patch: { start: '2026-10-30T11:00:00Z', end: '2026-10-30T12:00:00Z', summary: 'Later' },
      },
      { expectedRevision: 1 },
    )
    expect(db.occurrences(calendar.id, range).occurrences.map((o) => o.start)).toEqual([
      '2026-10-29T09:00:00.000Z',
      '2026-10-30T11:00:00.000Z',
      '2026-10-31T11:00:00.000Z',
    ])
  })
  it('rolls back a rejected invitation or quota error without changing the calendar revision', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Local' })
    expect(() =>
      db.mutateCalendar(
        calendar.id,
        { type: 'create', event: meeting({ organizer: null }) },
        { expectedRevision: 1, queueMethod: 'REQUEST' },
      ),
    ).toThrow('organizer')
    expect(db.readCalendar(calendar.id)).toMatchObject({ revision: 1, eventCount: 0 })
    const raw = (db as unknown as { db: DatabaseSync }).db
    const insert = raw.prepare(
      "INSERT INTO outbox(id,calendar_id,calendar_revision,uid,method,source,state,created_at) VALUES(?,?,1,'fixture','PUBLISH','fixture','pending',?)",
    )
    raw.exec('BEGIN')
    for (let i = 0; i < 256; i++) insert.run(randomUUID(), calendar.id, new Date().toISOString())
    raw.exec('COMMIT')
    expect(() =>
      db.mutateCalendar(
        calendar.id,
        { type: 'create', event: meeting() },
        { expectedRevision: 1, queueMethod: 'REQUEST' },
      ),
    ).toThrow(CalendarWorkspaceLimitError)
    expect(db.readCalendar(calendar.id)).toMatchObject({ revision: 1, eventCount: 0 })
  })
  it('enforces aggregate outbox bytes with an independent persisted SQL fixture', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Local' })
    const raw = (db as unknown as { db: DatabaseSync }).db
    raw
      .prepare(
        "INSERT INTO outbox(id,calendar_id,calendar_revision,uid,method,source,state,created_at) VALUES(?,?,1,'fixture','PUBLISH',CAST(zeroblob(67108864) AS TEXT),'pending',?)",
      )
      .run(randomUUID(), calendar.id, new Date().toISOString())
    expect(() =>
      db.mutateCalendar(
        calendar.id,
        { type: 'create', event: meeting() },
        { expectedRevision: 1, queueMethod: 'REQUEST' },
      ),
    ).toThrow('64 MiB')
    expect(db.readCalendar(calendar.id).eventCount).toBe(0)
  })
  it('enforces calendar/event/occurrence/output limits visibly without partial edits', () => {
    const db = new CalendarWorkspace(':memory:', { maxCalendars: 1, maxStoredEvents: 2 })
    workspaces.push(db)
    const calendar = db.createCalendar({ name: 'One', source: createCalendar([meeting()]) })
    expect(() => db.createCalendar({ name: 'Two' })).toThrow('At most 1')
    expect(() => db.occurrences(calendar.id, { ...range, maxOccurrences: 1 })).toThrow(
      'Occurrence limit',
    )
    const huge = workspace(),
      large = huge.createCalendar({
        name: 'Large',
        source: createCalendar([
          meeting({ description: 'Text '.repeat(4000), recurrence: 'FREQ=DAILY;COUNT=500' }),
        ]),
      })
    expect(() =>
      huge.occurrences(large.id, { start: '2026-01-01T00:00:00Z', end: '2029-01-01T00:00:00Z' }),
    ).toThrow('4 MiB')
    expect(huge.readCalendar(large.id).revision).toBe(1)
  })
  it('exports byte-identical no-op source, preserves imported origin on SaveAs and refuses changed/deleted origins', async () => {
    const folder = directory(),
      origin = join(folder, 'original.ics'),
      copy = join(folder, 'copy.ics')
    const source = '\uFEFF' + createCalendar([meeting()])
    writeFileSync(origin, source)
    const db = workspace(),
      calendar = db.importCalendar(source, {
        name: 'Imported',
        originPath: origin,
        originSha256: createHash('sha256').update(source).digest('hex'),
      })
    const saved = await db.exportToFile(calendar.id, copy, { expectedRevision: 1 })
    expect(readFileSync(copy, 'utf8')).toBe(source)
    expect(saved.originPath).toBe(resolve(origin))
    writeFileSync(origin, 'outside change')
    await expect(
      db.exportToFile(calendar.id, origin, { expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(CalendarOriginConflictError)
    expect(readFileSync(origin, 'utf8')).toBe('outside change')
    expect(db.readCalendar(calendar.id).revision).toBe(1)
  })
})

describe('local-only iTIP and visible outbox', () => {
  it('prepares REQUEST/REPLY/CANCEL messages with correct sequence rules and body-free summaries', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Invitations' })
    const created = db.mutateCalendar(
      calendar.id,
      { type: 'create', event: meeting() },
      { expectedRevision: 1, queueMethod: 'REQUEST' },
    )
    expect(db.exportOutboxMessage(created.outboxIds[0]!)).toContain('METHOD:REQUEST')
    const replied = db.mutateCalendar(
      calendar.id,
      {
        type: 'respond',
        uid: 'planning',
        attendee: 'alice@example.test',
        participation: 'ACCEPTED',
      },
      { expectedRevision: 2, queueMethod: 'REPLY' },
    )
    const reply = db.exportOutboxMessage(replied.outboxIds[0]!)
    expect(reply).toContain('METHOD:REPLY')
    expect(reply).toContain('SEQUENCE:0')
    expect(reply).toContain('PARTSTAT=ACCEPTED')
    expect(reply).not.toContain('bob@example.test')
    expect(db.eventDetails(calendar.id, { uid: 'planning' }).sequence).toBe(0)
    const cancelled = db.mutateCalendar(
      calendar.id,
      { type: 'delete', uid: 'planning', scope: 'series' },
      { expectedRevision: 3, queueMethod: 'CANCEL' },
    )
    expect(db.exportOutboxMessage(cancelled.outboxIds[0]!)).toContain('SEQUENCE:1')
    expect(db.occurrences(calendar.id, range).occurrences).toHaveLength(0)
    expect(db.listOutbox()).toHaveLength(3)
    expect(db.listOutbox()[0]).not.toHaveProperty('source')
  })
  it('ignores stale organizer messages and preserves unknown stored properties on a newer request', () => {
    const db = workspace(),
      original = createCalendar([meeting()]).replace(
        'SUMMARY:Planning',
        'SUMMARY:Planning\r\nX-LOCAL:keep',
      )
    const calendar = db.createCalendar({ name: 'Scheduling', source: original })
    const request = envelope(
      'REQUEST',
      'DTSTAMP:20261101T000000Z',
      'SEQUENCE:5',
      'ORGANIZER:mailto:organizer@example.test',
      'ATTENDEE:mailto:alice@example.test',
      'DTSTART:20261029T110000Z',
      'DTEND:20261029T120000Z',
      'SUMMARY:New request',
    )
    expect(db.applySchedulingMessage(calendar.id, request, { expectedRevision: 1 })).toMatchObject({
      applied: 1,
      ignored: 0,
    })
    expect(db.exportCalendar(calendar.id)).toContain('X-LOCAL:keep')
    const stale = request
      .replace('SEQUENCE:5', 'SEQUENCE:4')
      .replace('New request', 'Stale request')
    expect(db.applySchedulingMessage(calendar.id, stale, { expectedRevision: 2 })).toMatchObject({
      applied: 0,
      ignored: 1,
    })
    expect(db.readCalendar(calendar.id).revision).toBe(2)
    expect(db.eventDetails(calendar.id, { uid: 'planning' }).summary).toBe('New request')
  })
  it('applies attendee response state without changing schedule/sequence and rejects uninvited or wrong-organizer messages', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Replies', source: createCalendar([meeting()]) })
    const reply = envelope(
      'REPLY',
      'DTSTAMP:20261101T000000Z',
      'SEQUENCE:0',
      'ORGANIZER:mailto:organizer@example.test',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@example.test',
      'DTSTART:20300101T000000Z',
    )
    db.applySchedulingMessage(calendar.id, reply, { expectedRevision: 1 })
    const details = db.eventDetails(calendar.id, { uid: 'planning' })
    expect(details.start).toBe('2026-10-29T09:00:00.000Z')
    expect(details.sequence).toBe(0)
    expect(details.attendees[0]!.participation).toBe('ACCEPTED')
    expect(() =>
      db.applySchedulingMessage(
        calendar.id,
        reply.replace('alice@example.test', 'uninvited@example.test'),
        { expectedRevision: 2 },
      ),
    ).toThrow('uninvited')
    expect(() =>
      db.applySchedulingMessage(
        calendar.id,
        reply.replace('organizer@example.test', 'other@example.test'),
        { expectedRevision: 2 },
      ),
    ).toThrow('organizer differs')
    expect(db.readCalendar(calendar.id).revision).toBe(2)
  })
  it('applies minimum CANCEL with no DTSTART and rejects a late older REQUEST', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Cancellation', source: createCalendar([meeting()]) })
    const cancel = envelope(
      'CANCEL',
      'DTSTAMP:20261101T000000Z',
      'SEQUENCE:1',
      'ORGANIZER:mailto:organizer@example.test',
    )
    db.applySchedulingMessage(calendar.id, cancel, { expectedRevision: 1 })
    expect(db.occurrences(calendar.id, range).occurrences).toHaveLength(0)
    const late = envelope(
      'REQUEST',
      'DTSTAMP:20261102T000000Z',
      'SEQUENCE:0',
      'ORGANIZER:mailto:organizer@example.test',
      'ATTENDEE:mailto:alice@example.test',
      'DTSTART:20261029T090000Z',
      'SUMMARY:Too late',
    )
    expect(db.applySchedulingMessage(calendar.id, late, { expectedRevision: 2 })).toMatchObject({
      applied: 0,
      ignored: 1,
    })
  })
  it('applies CANCEL to this and future original recurrence identifiers', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Range cancel', source: createCalendar([meeting()]) })
    const cancel = envelope(
      'CANCEL',
      'DTSTAMP:20261101T000000Z',
      'SEQUENCE:1',
      'ORGANIZER:mailto:organizer@example.test',
      'RECURRENCE-ID;RANGE=THISANDFUTURE:20261030T090000Z',
    )
    db.applySchedulingMessage(calendar.id, cancel, { expectedRevision: 1 })
    expect(db.occurrences(calendar.id, range).occurrences.map((o) => o.start)).toEqual([
      '2026-10-29T09:00:00.000Z',
    ])
  })
  it('fences local test delivery attempts and records retry without using network transports', async () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Outbox' })
    const queued = db.mutateCalendar(
      calendar.id,
      { type: 'create', event: meeting() },
      { expectedRevision: 1, queueMethod: 'REQUEST' },
    )
    const id = queued.outboxIds[0]!,
      first = db.beginOutboxAttempt(id)
    db.acknowledgeOutbox(id, {
      attemptId: first.attemptId!,
      success: false,
      error: 'Synthetic local failure',
    })
    const second = db.beginOutboxAttempt(id)
    expect(() => db.acknowledgeOutbox(id, { attemptId: first.attemptId!, success: true })).toThrow(
      'stale',
    )
    db.acknowledgeOutbox(id, { attemptId: second.attemptId!, success: false })
    const delivered: string[] = []
    expect(
      await db.runLocalTestTransport({
        kind: 'local-test',
        async deliver(item) {
          delivered.push(item.source)
        },
      }),
    ).toEqual({ delivered: 1, failed: 0 })
    expect(delivered[0]).toContain('METHOD:REQUEST')
    expect(db.listOutbox()[0]).toMatchObject({ state: 'delivered', attempts: 3 })
    expect(() => db.exportOutboxMessage(id)).toThrow('no longer has a payload')
  })
  it('discards queued bytes locally and refuses unsupported iTIP methods without touching events', () => {
    const db = workspace(),
      calendar = db.createCalendar({ name: 'Local' })
    const changed = db.mutateCalendar(
      calendar.id,
      { type: 'create', event: meeting() },
      { expectedRevision: 1, queueMethod: 'REQUEST' },
    )
    expect(db.discardOutbox(changed.outboxIds[0]!).state).toBe('discarded')
    const before = db.exportCalendar(calendar.id)
    expect(() =>
      db.applySchedulingMessage(calendar.id, envelope('COUNTER', 'DTSTAMP:20261101T000000Z'), {
        expectedRevision: 2,
      }),
    ).toThrow('other methods')
    expect(db.exportCalendar(calendar.id)).toBe(before)
  })
  it('recovers an expired local test attempt after close/reopen and fences the old acknowledgement', async () => {
    const path = join(directory(), 'outbox.sqlite'),
      first = workspace(path, true),
      calendar = first.createCalendar({ name: 'Reconnect' })
    const queued = first.mutateCalendar(
      calendar.id,
      { type: 'create', event: meeting() },
      { expectedRevision: 1, queueMethod: 'REQUEST' },
    )
    const attempt = first.beginOutboxAttempt(queued.outboxIds[0]!),
      clock = Date.now()
    first.close()
    vi.spyOn(Date, 'now').mockReturnValue(clock + 31000)
    const reopened = workspace(path),
      files: string[] = []
    expect(
      await reopened.runLocalTestTransport({
        kind: 'local-test',
        async deliver(item) {
          files.push(item.id)
        },
      }),
    ).toEqual({ delivered: 1, failed: 0 })
    expect(files).toEqual([attempt.id])
    expect(reopened.listOutbox()[0]).toMatchObject({ attempts: 2, state: 'delivered' })
    expect(() =>
      reopened.acknowledgeOutbox(attempt.id, { attemptId: attempt.attemptId!, success: true }),
    ).toThrow('stale')
  })
})
