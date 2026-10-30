import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  atomicWriteFile,
  readAtomicFileVersion,
  withAtomicSaveQueue,
} from '../../electron-utils/src/atomic-write'
import {
  boundedCalendarSource,
  calendarText,
  createCalendar,
  expandCalendar,
  exportCalendar,
  inspectCalendar,
  parseCalendarSource,
} from './calendar'
import {
  applyCalendarSchedulingMessage,
  createSchedulingMessage,
  describeCalendarEvent,
  mutateCalendarSource,
} from './calendar-mutations'
import { resolveCalendarWallTime } from './calendar-timezones'
import type {
  CalendarEventDetails,
  CalendarLocalTestTransport,
  CalendarMutation,
  CalendarMutationOptions,
  CalendarMutationResult,
  CalendarMutationScope,
  CalendarOccurrenceOptions,
  CalendarOutboxAcknowledgement,
  CalendarOutboxItem,
  CalendarOutboxState,
  CalendarOutboxSummary,
  CalendarRecord,
  CalendarRecordSummary,
  CalendarSchedulingResult,
  CalendarWorkspaceApi,
  CalendarWorkspaceOccurrence,
  CalendarWorkspaceOptions,
} from './calendar-types'

const APPLICATION_ID = 0x5643414c
const MAX_SOURCE = 4 * 1024 * 1024
const MAX_CALENDARS = 100
const MAX_EVENTS = 20000
const MAX_OUTBOX_ACTIVE = 256
const MAX_OUTBOX_BYTES = 64 * 1024 * 1024
const OUTPUT_BUDGET = 4 * 1024 * 1024
const exportingWorkspaces = new Set<string>()
const hash = (source: string | Uint8Array): string =>
  createHash('sha256').update(source).digest('hex')
const utcNow = (): string => new Date().toISOString()

export class CalendarRevisionConflictError extends Error {
  readonly code = 'CALENDAR_REVISION_CONFLICT'
  constructor(
    readonly calendarId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
    readonly publishedRevision?: number,
  ) {
    super(
      publishedRevision === undefined
        ? 'This calendar changed. Reload it before applying your edit.'
        : `File revision ${publishedRevision} was exported, but the calendar now has newer local edits. Reload and export the current revision.`,
    )
    this.name = 'CalendarRevisionConflictError'
  }
}
export class CalendarOriginConflictError extends Error {
  readonly code = 'CALENDAR_ORIGIN_CONFLICT'
  constructor(readonly path: string) {
    super(
      'The destination changed since import/export. Keep the original and export to a separate file, or explicitly select its current version.',
    )
    this.name = 'CalendarOriginConflictError'
  }
}
export class CalendarWorkspaceLimitError extends Error {
  readonly code = 'CALENDAR_WORKSPACE_LIMIT'
  constructor(message: string) {
    super(message)
    this.name = 'CalendarWorkspaceLimitError'
  }
}
export class CalendarWorkspaceBusyError extends Error {
  readonly code = 'CALENDAR_WORKSPACE_BUSY'
  constructor() {
    super('A calendar export is publishing. Wait for it to finish before changing this workspace.')
    this.name = 'CalendarWorkspaceBusyError'
  }
}
export class CalendarExportMetadataError extends Error {
  readonly code = 'CALENDAR_EXPORTED_METADATA_PENDING'
  constructor(
    readonly path: string,
    readonly publishedRevision: number,
    cause: unknown,
  ) {
    super(
      'The ICS file was exported, but local origin tracking could not be committed. Keep the exported copy and refresh before exporting again.',
      { cause },
    )
    this.name = 'CalendarExportMetadataError'
  }
}

function nameOf(value: string): string {
  const name = calendarText(value, 'Calendar name', 256).trim()
  if (!name) throw new Error('A calendar name is required.')
  return name
}
function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('An expected positive calendar revision is required.')
  return value
}
function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value))
    throw new Error('Invalid calendar/work item identifier.')
  return value
}
function sha256(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('Expected a SHA-256 fingerprint.')
  return value.toLowerCase()
}
function recordSummary(row: Record<string, unknown>): CalendarRecordSummary {
  const warnings = JSON.parse(String(row.warnings ?? '[]')) as string[]
  return {
    id: String(row.id),
    name: String(row.name),
    revision: Number(row.revision),
    eventCount: Number(row.event_count),
    originPath: row.origin_path === null ? null : String(row.origin_path),
    originSha256: row.origin_sha256 === null ? null : String(row.origin_sha256),
    updatedAt: String(row.updated_at),
    warnings,
  }
}
function outboxSummary(row: Record<string, unknown>): CalendarOutboxSummary {
  return {
    id: String(row.id),
    calendarId: String(row.calendar_id),
    calendarRevision: Number(row.calendar_revision),
    uid: String(row.uid),
    recurrenceId: row.recurrence_id === null ? null : String(row.recurrence_id),
    method: String(row.method) as CalendarOutboxSummary['method'],
    state: String(row.state) as CalendarOutboxState,
    createdAt: String(row.created_at),
    attempts: Number(row.attempts),
    attemptId: row.attempt_id === null ? null : String(row.attempt_id),
    error: row.error === null ? null : String(row.error),
  }
}

/** A local-only SQLite calendar store. No provider transport, credentials, alarms or notifications. */
export class CalendarWorkspace implements CalendarWorkspaceApi {
  private readonly db: DatabaseSync
  private readonly maxCalendars: number
  private readonly maxEvents: number
  private readonly guardKey: string
  private closed = false
  constructor(
    readonly path: string,
    options: CalendarWorkspaceOptions = {},
  ) {
    this.maxCalendars = options.maxCalendars ?? MAX_CALENDARS
    this.maxEvents = options.maxStoredEvents ?? MAX_EVENTS
    this.guardKey =
      path === ':memory:'
        ? randomUUID()
        : process.platform === 'win32'
          ? resolve(path).toLowerCase()
          : resolve(path)
    if (
      !Number.isSafeInteger(this.maxCalendars) ||
      this.maxCalendars < 1 ||
      this.maxCalendars > MAX_CALENDARS ||
      !Number.isSafeInteger(this.maxEvents) ||
      this.maxEvents < 1 ||
      this.maxEvents > MAX_EVENTS
    )
      throw new Error('Calendar workspace limits exceed the supported bounds.')
    let created = path === ':memory:'
    if (options.create && !created) {
      closeSync(openSync(path, 'wx', 0o600))
      created = true
    }
    if (!created && !existsSync(path))
      throw new Error('The calendar workspace does not exist. Use create for a new local store.')
    let db: DatabaseSync | undefined
    try {
      this.db = db = new DatabaseSync(path, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
      })
      db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=2000;')
      if (created)
        db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
        CREATE TABLE calendars(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL,source TEXT NOT NULL,event_count INTEGER NOT NULL,warnings TEXT NOT NULL,origin_path TEXT,origin_sha256 TEXT,updated_at TEXT NOT NULL) STRICT;
        CREATE TABLE outbox(id TEXT PRIMARY KEY,calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,calendar_revision INTEGER NOT NULL,uid TEXT NOT NULL,recurrence_id TEXT,method TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,attempt_id TEXT,attempt_expires INTEGER,error TEXT) STRICT;
        CREATE INDEX outbox_calendar ON outbox(calendar_id,created_at); COMMIT;`)
      else if (
        db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 1
      )
        throw new Error('This is not a supported Vantage calendar workspace.')
      db.prepare('SELECT id FROM calendars LIMIT 1').all()
      db.prepare('SELECT id FROM outbox LIMIT 1').all()
    } catch (error) {
      db?.close()
      if (created && path !== ':memory:') {
        try {
          unlinkSync(path)
        } catch {
          /* keep initialization error */
        }
      }
      throw error
    }
  }
  close(): void {
    if (!this.closed) {
      if (exportingWorkspaces.has(this.guardKey)) throw new CalendarWorkspaceBusyError()
      this.db.close()
      this.closed = true
    }
  }
  private open(): void {
    if (this.closed) throw new Error('The calendar workspace is closed.')
  }
  private transaction<T>(operation: () => T): T {
    this.open()
    if (exportingWorkspaces.has(this.guardKey)) throw new CalendarWorkspaceBusyError()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* SQLite may already have rolled back. */
      }
      throw error
    }
  }
  private row(id: string): Record<string, unknown> {
    this.open()
    identifier(id)
    const row = this.db.prepare('SELECT * FROM calendars WHERE id=?').get(id)
    if (!row) throw new Error('The calendar does not exist.')
    return row
  }
  private checked(id: string, expected: number): Record<string, unknown> {
    const row = this.row(id)
    if (Number(row.revision) !== revision(expected))
      throw new CalendarRevisionConflictError(id, expected, Number(row.revision))
    return row
  }
  private sourceInfo(source: string): { count: number; warnings: string[] } {
    boundedCalendarSource(source)
    const inspected = inspectCalendar(source)
    return {
      count: parseCalendarSource(source).getAllSubcomponents('vevent').length,
      warnings: inspected.warnings,
    }
  }
  private eventBudget(count: number, excluding?: string): void {
    const stored = Number(
      this.db
        .prepare('SELECT COALESCE(SUM(event_count),0) AS total FROM calendars WHERE id<>?')
        .get(excluding ?? '')?.total,
    )
    if (stored + count > this.maxEvents)
      throw new CalendarWorkspaceLimitError(
        `The workspace supports at most ${this.maxEvents} stored VEVENT components.`,
      )
  }
  private replaceSource(id: string, expected: number, source: string): CalendarRecord {
    this.checked(id, expected)
    const { count, warnings } = this.sourceInfo(source)
    this.eventBudget(count, id)
    this.db
      .prepare(
        'UPDATE calendars SET source=?,event_count=?,warnings=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
      )
      .run(source, count, JSON.stringify(warnings), utcNow(), id, expected)
    return this.readCalendar(id)
  }
  listCalendars(): CalendarRecordSummary[] {
    this.open()
    return this.db
      .prepare(
        'SELECT id,name,revision,event_count,warnings,origin_path,origin_sha256,updated_at FROM calendars ORDER BY name,id LIMIT 100',
      )
      .all()
      .map(recordSummary)
  }
  createCalendar(input: { name: string; source?: string }): CalendarRecord {
    return this.importCalendar(input.source ?? createCalendar([]), { name: input.name })
  }
  importCalendar(
    source: string,
    input: { name: string; originPath?: string; originSha256?: string },
  ): CalendarRecord {
    const { count, warnings } = this.sourceInfo(source)
    const name = nameOf(input.name)
    const sourceHash = hash(source)
    if (input.originSha256 && sha256(input.originSha256) !== sourceHash)
      throw new Error('The supplied source fingerprint differs from the imported bytes.')
    const origin = input.originPath
      ? resolve(calendarText(input.originPath, 'Origin path', 32768))
      : null
    return this.transaction(() => {
      if (
        Number(this.db.prepare('SELECT COUNT(*) AS total FROM calendars').get()?.total) >=
        this.maxCalendars
      )
        throw new CalendarWorkspaceLimitError(
          `At most ${this.maxCalendars} local calendars are supported.`,
        )
      this.eventBudget(count)
      const id = randomUUID()
      this.db
        .prepare(
          'INSERT INTO calendars(id,name,revision,source,event_count,warnings,origin_path,origin_sha256,updated_at) VALUES(?,?,1,?,?,?,?,?,?)',
        )
        .run(
          id,
          name,
          source,
          count,
          JSON.stringify(warnings),
          origin,
          origin ? sourceHash : null,
          utcNow(),
        )
      return this.readCalendar(id)
    })
  }
  readCalendar(id: string): CalendarRecord {
    const row = this.row(id)
    return { ...recordSummary(row), source: String(row.source) }
  }
  eventDetails(
    id: string,
    selector: { uid: string; recurrenceId?: string; scope?: CalendarMutationScope },
  ): CalendarEventDetails {
    return describeCalendarEvent(String(this.row(id).source), selector)
  }
  renameCalendar(id: string, name: string, options: { expectedRevision: number }): CalendarRecord {
    return this.transaction(() => {
      this.checked(id, options.expectedRevision)
      this.db
        .prepare('UPDATE calendars SET name=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(nameOf(name), utcNow(), id)
      return this.readCalendar(id)
    })
  }
  removeCalendar(id: string, options: { expectedRevision: number }): void {
    this.transaction(() => {
      this.checked(id, options.expectedRevision)
      this.db.prepare('DELETE FROM calendars WHERE id=?').run(id)
    })
  }
  occurrences(
    id: string,
    options: CalendarOccurrenceOptions,
  ): { occurrences: CalendarWorkspaceOccurrence[]; warnings: string[] } {
    const row = this.row(id)
    const result = expandCalendar(String(row.source), options)
    return {
      occurrences: result.occurrences.map((item) => {
        const recurrenceId = item.recurring ? item.recurrenceId : null
        return {
          ...item,
          recurrenceId,
          calendarId: id,
          calendarRevision: Number(row.revision),
          instanceId: `${id}/${encodeURIComponent(item.uid)}/${encodeURIComponent(recurrenceId ?? '@single')}`,
        }
      }),
      warnings: result.warnings,
    }
  }
  allOccurrences(options: CalendarOccurrenceOptions): {
    occurrences: CalendarWorkspaceOccurrence[]
    warnings: string[]
  } {
    this.open()
    expandCalendar(createCalendar([]), options)
    const maximum = options.maxOccurrences ?? 2000
    const deadline = Date.now() + (options.deadlineMs ?? 2000)
    const occurrences: CalendarWorkspaceOccurrence[] = [],
      warnings = new Set<string>()
    let bytes = 0
    for (const row of this.db.prepare('SELECT id FROM calendars ORDER BY id LIMIT 100').all()) {
      const remaining = deadline - Date.now()
      if (remaining < 10)
        throw new CalendarWorkspaceLimitError(
          'Global calendar expansion deadline reached; select fewer calendars or a narrower range.',
        )
      const result = this.occurrences(String(row.id), {
        ...options,
        deadlineMs: Math.min(remaining, 5000),
        maxOccurrences: Math.max(1, maximum - occurrences.length),
      })
      for (const occurrence of result.occurrences) {
        if (occurrences.length >= maximum)
          throw new CalendarWorkspaceLimitError(
            'The global occurrence limit was reached; narrow the range.',
          )
        bytes += Buffer.byteLength(JSON.stringify(occurrence))
        if (bytes > OUTPUT_BUDGET)
          throw new CalendarWorkspaceLimitError(
            'Global calendar occurrence output exceeds 4 MiB; narrow the range.',
          )
        occurrences.push(occurrence)
      }
      result.warnings.forEach((warning) => warnings.add(warning))
    }
    const order = (item: CalendarWorkspaceOccurrence): number =>
      item.floating || item.allDay
        ? Date.parse(
            resolveCalendarWallTime(
              `${item.localStart}${item.allDay ? 'T00:00:00' : ''}`,
              options.viewTimeZone ?? 'UTC',
              'compatible',
            ).instant,
          )
        : Date.parse(item.start)
    const orderEpoch = new Map(occurrences.map((item) => [item.instanceId, order(item)]))
    occurrences.sort(
      (a, b) =>
        orderEpoch.get(a.instanceId)! - orderEpoch.get(b.instanceId)! ||
        a.instanceId.localeCompare(b.instanceId),
    )
    return { occurrences, warnings: [...warnings] }
  }
  mutateCalendar(
    id: string,
    mutation: CalendarMutation,
    options: CalendarMutationOptions,
  ): CalendarMutationResult {
    return this.transaction(() => {
      const current = this.checked(id, options.expectedRevision)
      const result = mutateCalendarSource(String(current.source), mutation)
      const method = options.queueMethod
      if (
        method &&
        method !== result.method &&
        !(method === 'PUBLISH' && result.method === 'REQUEST')
      )
        throw new Error('The queued scheduling method does not match this local edit.')
      const payload = method
        ? createSchedulingMessage(result.messageSource, {
            uid: result.uid,
            recurrenceId: result.recurrenceId,
            method,
            ...(result.respondent ? { respondent: result.respondent } : {}),
          })
        : null
      const calendar = this.replaceSource(id, options.expectedRevision, result.source)
      const outboxIds =
        payload && method
          ? [this.enqueue(id, calendar.revision, result.uid, result.recurrenceId, method, payload)]
          : []
      return {
        calendar,
        changedUid: result.uid,
        changedRecurrenceId: result.recurrenceId,
        outboxIds,
        warnings: result.warnings,
      }
    })
  }
  applySchedulingMessage(
    id: string,
    source: string,
    options: { expectedRevision: number },
  ): CalendarSchedulingResult {
    return this.transaction(() => {
      const current = this.checked(id, options.expectedRevision)
      const result = applyCalendarSchedulingMessage(String(current.source), source)
      const calendar = result.applied
        ? this.replaceSource(id, options.expectedRevision, result.source)
        : this.readCalendar(id)
      return {
        calendar,
        applied: result.applied,
        ignored: result.ignored,
        warnings: result.warnings,
      }
    })
  }
  exportCalendar(id: string): string {
    return exportCalendar(String(this.row(id).source))
  }
  async exportToFile(
    id: string,
    path: string,
    options: { expectedRevision: number; expectedOriginSha256?: string },
  ): Promise<CalendarRecord> {
    const destination = resolve(calendarText(path, 'Export path', 32768))
    if (
      this.path !== ':memory:' &&
      (process.platform === 'win32'
        ? destination.toLowerCase() === resolve(this.path).toLowerCase()
        : destination === resolve(this.path))
    )
      throw new Error('A calendar workspace database cannot be overwritten by an ICS export.')
    const explicitHash = options.expectedOriginSha256
      ? sha256(options.expectedOriginSha256)
      : undefined
    let published: CalendarRecord | undefined
    await withAtomicSaveQueue(destination, async () => {
      this.open()
      if (exportingWorkspaces.has(this.guardKey)) throw new CalendarWorkspaceBusyError()
      // The writer transaction spans asynchronous file publication. Other OS
      // processes cannot advance the calendar revision during the await; an
      // in-process guard makes concurrent local mutations fail immediately.
      this.db.exec('BEGIN IMMEDIATE')
      exportingWorkspaces.add(this.guardKey)
      let filePublished = false
      try {
        const current = this.checked(id, options.expectedRevision)
        const source = String(current.source)
        const expectedHash =
          explicitHash ??
          (current.origin_path && resolve(String(current.origin_path)) === destination
            ? String(current.origin_sha256)
            : undefined)
        let actualHash: string | undefined
        try {
          const metadata = await stat(destination)
          if (metadata.size > MAX_SOURCE) throw new CalendarOriginConflictError(destination)
          actualHash = hash(await readFile(destination))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (
          (actualHash !== undefined && (!expectedHash || actualHash !== expectedHash)) ||
          (actualHash === undefined && expectedHash !== undefined)
        )
          throw new CalendarOriginConflictError(destination)
        const version = await readAtomicFileVersion(destination)
        if (actualHash === undefined ? version !== null : version?.sha256 !== actualHash)
          throw new CalendarOriginConflictError(destination)
        this.checked(id, options.expectedRevision)
        await atomicWriteFile(destination, Buffer.from(source, 'utf8'), {
          expectedVersion: version,
        })
        filePublished = true
        // Save a separate copy without forgetting the imported original. A new
        // local calendar adopts its first export; in-place exports refresh its hash.
        if (current.origin_path === null || resolve(String(current.origin_path)) === destination)
          this.db
            .prepare('UPDATE calendars SET origin_path=?,origin_sha256=? WHERE id=?')
            .run(destination, hash(source), id)
        published = this.readCalendar(id)
        this.db.exec('COMMIT')
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* Preserve publication status and original failure. */
        }
        if (filePublished)
          throw new CalendarExportMetadataError(destination, options.expectedRevision, error)
        throw error
      } finally {
        exportingWorkspaces.delete(this.guardKey)
      }
    })
    return published!
  }
  private enqueue(
    calendarId: string,
    calendarRevision: number,
    uid: string,
    recurrenceId: string | null,
    method: CalendarOutboxItem['method'],
    source: string,
  ): string {
    const active = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS total FROM outbox WHERE state IN ('pending','failed','inflight')",
        )
        .get()?.total,
    )
    const bytes = Number(
      this.db
        .prepare('SELECT COALESCE(SUM(length(CAST(source AS BLOB))),0) AS total FROM outbox')
        .get()?.total,
    )
    if (active >= MAX_OUTBOX_ACTIVE || bytes + Buffer.byteLength(source) > MAX_OUTBOX_BYTES)
      throw new CalendarWorkspaceLimitError(
        'The local outbox exceeds 256 active messages or 64 MiB; export/discard existing items before preparing more.',
      )
    this.db.exec(
      "DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE state IN ('discarded','delivered') ORDER BY created_at DESC LIMIT -1 OFFSET 255)",
    )
    const id = randomUUID()
    this.db
      .prepare(
        "INSERT INTO outbox(id,calendar_id,calendar_revision,uid,recurrence_id,method,source,state,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)",
      )
      .run(id, calendarId, calendarRevision, uid, recurrenceId, method, source, utcNow())
    return id
  }
  listOutbox(
    options: { state?: CalendarOutboxState; calendarId?: string } = {},
  ): CalendarOutboxSummary[] {
    this.open()
    const values: string[] = [],
      clauses: string[] = []
    if (options.calendarId) {
      clauses.push('calendar_id=?')
      values.push(identifier(options.calendarId))
    }
    if (options.state) {
      if (!['pending', 'inflight', 'failed', 'delivered', 'discarded'].includes(options.state))
        throw new Error('Unknown outbox state.')
      clauses.push('state=?')
      values.push(options.state)
    }
    return this.db
      .prepare(
        `SELECT id,calendar_id,calendar_revision,uid,recurrence_id,method,state,created_at,attempts,attempt_id,error FROM outbox${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at,id LIMIT 512`,
      )
      .all(...values)
      .map(outboxSummary)
  }
  readOutbox(id: string): CalendarOutboxItem {
    this.open()
    identifier(id)
    const row = this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id)
    if (!row) throw new Error('The outbox item does not exist.')
    return { ...outboxSummary(row), source: String(row.source) }
  }
  exportOutboxMessage(id: string): string {
    const item = this.readOutbox(id)
    if (!item.source)
      throw new Error('This completed/discarded local message no longer has a payload.')
    return item.source
  }
  beginOutboxAttempt(id: string): CalendarOutboxItem {
    return this.transaction(() => {
      const item = this.readOutbox(id)
      const expires = Number(
        this.db.prepare('SELECT attempt_expires FROM outbox WHERE id=?').get(id)?.attempt_expires ??
          0,
      )
      if (
        !item.source ||
        ['delivered', 'discarded'].includes(item.state) ||
        (item.state === 'inflight' && expires > Date.now())
      )
        throw new Error('This local outbox message is not available for a new test attempt.')
      this.db
        .prepare(
          "UPDATE outbox SET state='inflight',attempts=attempts+1,attempt_id=?,attempt_expires=?,error=NULL WHERE id=?",
        )
        .run(randomUUID(), Date.now() + 30000, id)
      return this.readOutbox(id)
    })
  }
  acknowledgeOutbox(id: string, result: CalendarOutboxAcknowledgement): CalendarOutboxItem {
    return this.transaction(() => {
      const item = this.readOutbox(id)
      if (item.state !== 'inflight' || item.attemptId !== result.attemptId)
        throw new Error('The local test attempt is stale; its result was not applied.')
      if (typeof result.success !== 'boolean')
        throw new Error('A local test acknowledgement requires a boolean result.')
      const error = result.success
        ? null
        : calendarText(
            result.error ?? 'Local test transport failed.',
            'Local transport error',
            1024,
          )
      this.db
        .prepare('UPDATE outbox SET state=?,source=?,attempt_expires=NULL,error=? WHERE id=?')
        .run(result.success ? 'delivered' : 'failed', result.success ? '' : item.source, error, id)
      return this.readOutbox(id)
    })
  }
  discardOutbox(id: string): CalendarOutboxSummary {
    return this.transaction(() => {
      const item = this.readOutbox(id)
      const expires = Number(
        this.db.prepare('SELECT attempt_expires FROM outbox WHERE id=?').get(id)?.attempt_expires ??
          0,
      )
      if (item.state === 'inflight' && expires > Date.now())
        throw new Error('An in-flight local test attempt must finish before discard.')
      this.db
        .prepare(
          "UPDATE outbox SET state='discarded',source='',attempt_id=NULL,attempt_expires=NULL,error=NULL WHERE id=?",
        )
        .run(id)
      const { source: _source, ...summary } = this.readOutbox(id)
      return summary
    })
  }
  async runLocalTestTransport(
    transport: CalendarLocalTestTransport,
    options: { limit?: number } = {},
  ): Promise<{ delivered: number; failed: number }> {
    if (transport.kind !== 'local-test' || typeof transport.deliver !== 'function')
      throw new Error(
        'Only an explicitly supplied local-test transport is supported; no provider sends are implemented.',
      )
    const limit = options.limit ?? 10
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new Error('Local test delivery supports 1–50 items.')
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE outbox SET state='failed',attempt_id=NULL,attempt_expires=NULL,error='Interrupted local test attempt; retry is available.' WHERE state='inflight' AND COALESCE(attempt_expires,0)<=?",
        )
        .run(Date.now())
    })
    let delivered = 0,
      failed = 0
    const deadline = Date.now() + 30000
    for (const entry of this.listOutbox()
      .filter((item) => item.state === 'pending' || item.state === 'failed')
      .slice(0, limit)) {
      if (Date.now() >= deadline)
        throw new CalendarWorkspaceLimitError(
          'The local test transport reached its 30-second overall deadline; completed items remain recorded.',
        )
      const item = this.beginOutboxAttempt(entry.id)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          transport.deliver(item),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Local test transport deadline reached.')),
              5000,
            )
          }),
        ])
        this.acknowledgeOutbox(item.id, { attemptId: item.attemptId!, success: true })
        delivered++
      } catch (error) {
        this.acknowledgeOutbox(item.id, {
          attemptId: item.attemptId!,
          success: false,
          error: String(error instanceof Error ? error.message : error).slice(0, 512),
        })
        failed++
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    return { delivered, failed }
  }
}
