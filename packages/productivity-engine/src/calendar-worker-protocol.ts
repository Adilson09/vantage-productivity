import { isAbsolute } from 'node:path'
import type { expandCalendar } from './calendar'
import type {
  CalendarEventDetails,
  CalendarMutationResult,
  CalendarOutboxSummary,
  CalendarRecordSummary,
  CalendarSchedulingResult,
  CalendarWorkspaceApi,
  CalendarWorkspaceOptions,
} from './calendar-types'

export const CALENDAR_MAX_INPUT = 8 * 1024 * 1024
export const CALENDAR_MAX_OUTPUT = 8 * 1024 * 1024
export const CALENDAR_MAX_READY = 256
export const CALENDAR_READY_ENV = 'VANTAGE_CALENDAR_READY_NONCE'
export const CALENDAR_DEFAULT_STARTUP_MS = 10_000
export const CALENDAR_GENERATION_DIRECTORY = 'workspace-v1'
export const CALENDAR_WORKSPACE_FILENAME = 'workspace.sqlite3'
export interface CalendarInitializationResult {
  path: string
  layout: 'legacy' | 'generation'
}
export interface CalendarWorkerReady {
  version: 1
  nonce: string
  ready: true
}
export const CALENDAR_METHODS = [
  'initializeWorkspace',
  'metadata',
  'listCalendars',
  'createCalendar',
  'importCalendar',
  'readCalendar',
  'eventDetails',
  'renameCalendar',
  'removeCalendar',
  'occurrences',
  'allOccurrences',
  'mutateCalendar',
  'applySchedulingMessage',
  'exportCalendar',
  'listOutbox',
  'readOutbox',
  'exportOutboxMessage',
  'beginOutboxAttempt',
  'acknowledgeOutbox',
  'discardOutbox',
  'expandSource',
] as const
export type CalendarWorkerMethod = (typeof CALENDAR_METHODS)[number]
export type CalendarWorkspaceMethod = Exclude<
  CalendarWorkerMethod,
  'metadata' | 'expandSource' | 'initializeWorkspace'
>
export type CalendarRemoteMutation = Omit<CalendarMutationResult, 'calendar'> & {
  calendar: CalendarRecordSummary
}
export type CalendarRemoteScheduling = Omit<CalendarSchedulingResult, 'calendar'> & {
  calendar: CalendarRecordSummary
}
export interface CalendarRemoteMetadata {
  calendars: CalendarRecordSummary[]
  outbox: CalendarOutboxSummary[]
}
export type CalendarSourcePreview = ReturnType<typeof expandCalendar>
export type CalendarRemoteResult<M extends CalendarWorkerMethod> = M extends 'initializeWorkspace'
  ? CalendarInitializationResult
  : M extends 'metadata'
    ? CalendarRemoteMetadata
    : M extends 'expandSource'
      ? CalendarSourcePreview
      : M extends 'createCalendar' | 'importCalendar' | 'readCalendar' | 'renameCalendar'
        ? CalendarRecordSummary
        : M extends 'mutateCalendar'
          ? CalendarRemoteMutation
          : M extends 'applySchedulingMessage'
            ? CalendarRemoteScheduling
            : M extends 'readOutbox' | 'beginOutboxAttempt' | 'acknowledgeOutbox'
              ? CalendarOutboxSummary
              : M extends CalendarWorkspaceMethod
                ? Awaited<ReturnType<CalendarWorkspaceApi[M]>>
                : never

export interface CalendarWorkerRequest {
  version: 1
  nonce: string
  method: CalendarWorkerMethod
  args: unknown[]
  path?: string
  workspaceOptions?: Omit<CalendarWorkspaceOptions, 'create'>
  deadlineMs: number
  maxHeapMb: number
  maxOutputBytes: number
}
export interface CalendarWorkerFailure {
  code: string
  message: string
  mutationMayHaveCommitted: boolean
}
export type CalendarWorkerResponse =
  | { version: 1; nonce: string; method: CalendarWorkerMethod; ok: true; result: unknown }
  | {
      version: 1
      nonce: string
      method: CalendarWorkerMethod
      ok: false
      error: CalendarWorkerFailure
    }
export const CALENDAR_WRITES = new Set<CalendarWorkerMethod>([
  'initializeWorkspace',
  'createCalendar',
  'importCalendar',
  'renameCalendar',
  'removeCalendar',
  'mutateCalendar',
  'applySchedulingMessage',
  'beginOutboxAttempt',
  'acknowledgeOutbox',
  'discardOutbox',
])
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export function validCalendarReady(value: unknown, nonce: string): value is CalendarWorkerReady {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    value.version === 1 &&
    value.ready === true &&
    value.nonce === nonce &&
    /^[a-f0-9]{32}$/.test(nonce)
  )
}
const number = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0
const string = (value: unknown, maximum = 4 * 1024 * 1024): value is string =>
  typeof value === 'string' && Buffer.byteLength(value) <= maximum
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 20000 && value.every((v) => string(v))
const nullableString = (v: unknown): boolean => v === null || string(v)
export function isCalendarMethod(value: unknown): value is CalendarWorkerMethod {
  return typeof value === 'string' && (CALENDAR_METHODS as readonly string[]).includes(value)
}
export function sanitizeCalendarFailure(value: unknown): string {
  return (
    (typeof value === 'string' ? value : 'Calendar operation failed.')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .slice(0, 512)
      .trim() || 'Calendar operation failed.'
  )
}
export function calendarFailure(
  request: Pick<CalendarWorkerRequest, 'method'>,
  code: string,
  message: string,
): CalendarWorkerFailure {
  const mutationMayHaveCommitted = CALENDAR_WRITES.has(request.method)
  return { code, mutationMayHaveCommitted, message: sanitizeCalendarFailure(message) }
}

/** Reject functions, accessors, exotic prototypes and cycles before JSON can execute toJSON hooks. */
export function assertCalendarJson(value: unknown): void {
  const seen = new Set<object>()
  let count = 0
  const visit = (v: unknown, depth: number): void => {
    if (++count > 250000 || depth > 32)
      throw new Error('Calendar request exceeds its structural budget.')
    if (
      v === null ||
      typeof v === 'boolean' ||
      typeof v === 'string' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return
    if (!v || typeof v !== 'object' || seen.has(v))
      throw new Error('Calendar requests accept only JSON data, without functions or cycles.')
    const prototype = Object.getPrototypeOf(v)
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
      throw new Error('Calendar requests accept only plain JSON objects.')
    seen.add(v)
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1)
    } else
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key !== 'string') throw new Error('Calendar request symbols are not supported.')
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!
        if (descriptor.get || descriptor.set)
          throw new Error('Calendar request accessors are not supported.')
        if (descriptor.value !== undefined) visit(descriptor.value, depth + 1)
      }
    seen.delete(v)
  }
  visit(value, 0)
}

/** Strict UTF-8, bounded nesting/tokens, unique object keys, one complete JSON document. */
export function decodeCalendarJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const stack: { keys?: Set<string>; expectsKey?: boolean }[] = []
  let tokens = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      const start = i++
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      if (i >= text.length) throw new Error('Incomplete calendar JSON.')
      const current = stack.at(-1)
      if (current?.keys && current.expectsKey) {
        const key = JSON.parse(text.slice(start, i + 1)) as string
        if (key.length > 256 || current.keys.has(key))
          throw new Error('Duplicate calendar JSON key.')
        current.keys.add(key)
        current.expectsKey = false
      }
      tokens++
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? { keys: new Set(), expectsKey: true } : {})
      if (stack.length > 32) throw new Error('Calendar JSON nesting exceeded.')
      tokens++
    } else if (char === '}' || char === ']') stack.pop()
    else if (char === ',') {
      if (stack.at(-1)?.keys) stack.at(-1)!.expectsKey = true
      tokens++
    }
    if (tokens > 250000) throw new Error('Calendar JSON token budget exceeded.')
  }
  return JSON.parse(text) as unknown
}

const ARITY: Record<CalendarWorkerMethod, readonly [number, number]> = {
  initializeWorkspace: [0, 0],
  metadata: [0, 0],
  listCalendars: [0, 0],
  createCalendar: [1, 1],
  importCalendar: [2, 2],
  readCalendar: [1, 1],
  eventDetails: [2, 2],
  renameCalendar: [3, 3],
  removeCalendar: [2, 2],
  occurrences: [2, 2],
  allOccurrences: [1, 1],
  mutateCalendar: [3, 3],
  applySchedulingMessage: [3, 3],
  exportCalendar: [1, 1],
  listOutbox: [0, 1],
  readOutbox: [1, 1],
  exportOutboxMessage: [1, 1],
  beginOutboxAttempt: [1, 1],
  acknowledgeOutbox: [2, 2],
  discardOutbox: [1, 1],
  expandSource: [2, 2],
}
export function assertCalendarRequest(value: unknown): asserts value is CalendarWorkerRequest {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.nonce) ||
    !isCalendarMethod(value.method) ||
    Object.keys(value).some(
      (key) =>
        ![
          'version',
          'nonce',
          'method',
          'args',
          'path',
          'workspaceOptions',
          'deadlineMs',
          'maxHeapMb',
          'maxOutputBytes',
        ].includes(key),
    ) ||
    !Array.isArray(value.args) ||
    value.args.length < ARITY[value.method][0] ||
    value.args.length > ARITY[value.method][1] ||
    !number(value.deadlineMs) ||
    value.deadlineMs < 100 ||
    value.deadlineMs > 30000 ||
    !number(value.maxHeapMb) ||
    value.maxHeapMb < 32 ||
    value.maxHeapMb > 256 ||
    !number(value.maxOutputBytes) ||
    value.maxOutputBytes < 1024 ||
    value.maxOutputBytes > CALENDAR_MAX_OUTPUT
  )
    throw new Error('Invalid calendar worker request.')
  if (value.method === 'expandSource') {
    if (value.path !== undefined || value.workspaceOptions !== undefined)
      throw new Error('Calendar source preview must not open a workspace.')
  } else if (!string(value.path, 32768) || !isAbsolute(value.path) || value.path.includes('\0'))
    throw new Error('A trusted absolute calendar workspace path is required.')
  if (value.workspaceOptions !== undefined) {
    if (value.method === 'initializeWorkspace')
      throw new Error('Calendar initialization accepts no source or workspace settings.')
    const options = value.workspaceOptions
    if (
      !object(options) ||
      Object.keys(options).some((key) => !['maxCalendars', 'maxStoredEvents'].includes(key)) ||
      (options.maxCalendars !== undefined &&
        (!number(options.maxCalendars) ||
          options.maxCalendars < 1 ||
          options.maxCalendars > 100)) ||
      (options.maxStoredEvents !== undefined &&
        (!number(options.maxStoredEvents) ||
          options.maxStoredEvents < 1 ||
          options.maxStoredEvents > 20000))
    )
      throw new Error('Invalid calendar workspace options.')
  }
  assertCalendarJson(value.args)
}

function record(v: unknown): v is CalendarRecordSummary {
  return (
    object(v) &&
    string(v.id, 128) &&
    string(v.name, 1024) &&
    number(v.revision) &&
    v.revision > 0 &&
    number(v.eventCount) &&
    nullableString(v.originPath) &&
    nullableString(v.originSha256) &&
    string(v.updatedAt, 128) &&
    strings(v.warnings) &&
    !Object.hasOwn(v, 'source')
  )
}
function participant(v: unknown): boolean {
  return (
    object(v) &&
    string(v.address, 4096) &&
    ['name', 'participation', 'role'].every(
      (key) => v[key] === undefined || string(v[key], 4096),
    ) &&
    (v.rsvp === undefined || typeof v.rsvp === 'boolean')
  )
}
function details(v: unknown): v is CalendarEventDetails {
  return (
    object(v) &&
    [
      'uid',
      'summary',
      'start',
      'end',
      'localStart',
      'localEnd',
      'timeZone',
      'description',
      'location',
      'status',
    ].every((key) => string(v[key])) &&
    nullableString(v.recurrenceId) &&
    nullableString(v.recurrence) &&
    ['allDay', 'floating', 'recurring'].every((key) => typeof v[key] === 'boolean') &&
    number(v.sequence) &&
    (v.organizer === null || participant(v.organizer)) &&
    Array.isArray(v.attendees) &&
    v.attendees.length <= 20000 &&
    v.attendees.every(participant)
  )
}
function outbox(v: unknown): v is CalendarOutboxSummary {
  return (
    object(v) &&
    ['id', 'calendarId', 'uid', 'createdAt'].every((key) => string(v[key], 4096)) &&
    number(v.calendarRevision) &&
    v.calendarRevision > 0 &&
    nullableString(v.recurrenceId) &&
    ['PUBLISH', 'REQUEST', 'REPLY', 'CANCEL'].includes(String(v.method)) &&
    ['pending', 'inflight', 'delivered', 'failed', 'discarded'].includes(String(v.state)) &&
    number(v.attempts) &&
    nullableString(v.attemptId) &&
    nullableString(v.error) &&
    !Object.hasOwn(v, 'source')
  )
}
export function validCalendarResult(method: CalendarWorkerMethod, value: unknown): boolean {
  switch (method) {
    case 'initializeWorkspace':
      return (
        object(value) &&
        Object.keys(value).length === 2 &&
        string(value.path, 32768) &&
        isAbsolute(value.path) &&
        !value.path.includes('\0') &&
        (value.layout === 'legacy' || value.layout === 'generation')
      )
    case 'metadata':
      return (
        object(value) &&
        Array.isArray(value.calendars) &&
        value.calendars.length <= 100 &&
        value.calendars.every(record) &&
        Array.isArray(value.outbox) &&
        value.outbox.length <= 512 &&
        value.outbox.every(outbox)
      )
    case 'listCalendars':
      return Array.isArray(value) && value.length <= 100 && value.every(record)
    case 'createCalendar':
    case 'importCalendar':
    case 'readCalendar':
    case 'renameCalendar':
      return record(value)
    case 'eventDetails':
      return details(value)
    case 'removeCalendar':
      return value === null
    case 'occurrences':
    case 'allOccurrences':
    case 'expandSource':
      return (
        object(value) &&
        strings(value.warnings) &&
        Array.isArray(value.occurrences) &&
        value.occurrences.length <= 20000 &&
        value.occurrences.every(
          (v: unknown) =>
            details(v) &&
            (method === 'expandSource' ||
              (object(v) &&
                string(v.calendarId, 128) &&
                number(v.calendarRevision) &&
                v.calendarRevision > 0 &&
                string(v.instanceId))),
        )
      )
    case 'mutateCalendar':
      return (
        object(value) &&
        record(value.calendar) &&
        string(value.changedUid) &&
        nullableString(value.changedRecurrenceId) &&
        strings(value.outboxIds) &&
        strings(value.warnings)
      )
    case 'applySchedulingMessage':
      return (
        object(value) &&
        record(value.calendar) &&
        number(value.applied) &&
        number(value.ignored) &&
        strings(value.warnings)
      )
    case 'exportCalendar':
    case 'exportOutboxMessage':
      return string(value)
    case 'listOutbox':
      return Array.isArray(value) && value.length <= 512 && value.every(outbox)
    case 'readOutbox':
    case 'beginOutboxAttempt':
    case 'acknowledgeOutbox':
    case 'discardOutbox':
      return outbox(value)
  }
}
export function validCalendarResponse(
  value: unknown,
  request: CalendarWorkerRequest,
): value is CalendarWorkerResponse {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.nonce !== request.nonce ||
    value.method !== request.method ||
    typeof value.ok !== 'boolean'
  )
    return false
  if (value.ok)
    return (
      Object.keys(value).every((key) =>
        ['version', 'nonce', 'method', 'ok', 'result'].includes(key),
      ) &&
      Object.hasOwn(value, 'result') &&
      validCalendarResult(request.method, value.result)
    )
  return (
    Object.keys(value).every((key) =>
      ['version', 'nonce', 'method', 'ok', 'error'].includes(key),
    ) &&
    object(value.error) &&
    string(value.error.code, 128) &&
    /^[A-Z_]+$/.test(value.error.code) &&
    string(value.error.message, 2048) &&
    typeof value.error.mutationMayHaveCommitted === 'boolean'
  )
}
