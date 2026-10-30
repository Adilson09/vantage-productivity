import type { CalendarAgendaQuery } from '../shared/calendar-api'
import type {
  CalendarMutation,
  CalendarMutationOptions,
  CalendarMutationScope,
} from '../../../../packages/productivity-engine/src/calendar-types'

const scopes = new Set(['instance', 'series', 'this-and-future'])
const participations = new Set(['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE'])
const methods = new Set(['PUBLISH', 'REQUEST', 'REPLY', 'CANCEL'])
const fields = new Set([
  'summary',
  'start',
  'end',
  'timeZone',
  'disambiguation',
  'description',
  'location',
  'recurrence',
  'organizer',
  'attendees',
  'status',
])
function object(value: unknown, allowed: Set<string>): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Provide a calendar action with named fields.')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !allowed.has(key)))
    throw new Error('The calendar action contains an unsupported field.')
  return result
}
function text(value: unknown, name: string, maximum: number, multiline = false): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (multiline ? /[\u0000\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)
  )
    throw new Error(
      `${name} must be valid text within ${maximum.toLocaleString('en-US')} characters.`,
    )
  return value
}
function budget(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024)
    throw new Error('A calendar edit must be smaller than 64 KiB.')
}
export function calendarId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    throw new Error('Choose a valid saved calendar or message.')
  return value
}
export function calendarRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Reload the calendar before saving this edit.')
  return value as number
}
export function calendarName(value: unknown): string {
  const name = text(value, 'Calendar name', 128).trim()
  if (!name) throw new Error('Give the calendar a name.')
  return name
}
export function calendarSelector(value: unknown): {
  uid: string
  recurrenceId?: string
  scope?: CalendarMutationScope
} {
  const input = object(value, new Set(['uid', 'recurrenceId', 'scope']))
  const uid = text(input.uid, 'Event identifier', 1024)
  if (!uid) throw new Error('Choose an event.')
  if (input.recurrenceId !== undefined) text(input.recurrenceId, 'Occurrence identifier', 128)
  if (input.scope !== undefined && (typeof input.scope !== 'string' || !scopes.has(input.scope)))
    throw new Error('Choose this occurrence, the series, or this and future occurrences.')
  return input as ReturnType<typeof calendarSelector>
}
function participant(value: unknown): void {
  const input = object(value, new Set(['address', 'name', 'participation', 'role', 'rsvp']))
  if (!text(input.address, 'Participant address', 2048).trim())
    throw new Error('Provide a participant address.')
  if (input.name !== undefined) text(input.name, 'Participant name', 256)
  if (input.role !== undefined) text(input.role, 'Participant role', 64)
  if (
    input.participation !== undefined &&
    (typeof input.participation !== 'string' || !participations.has(input.participation))
  )
    throw new Error('Choose a valid participation response.')
  if (input.rsvp !== undefined && typeof input.rsvp !== 'boolean')
    throw new Error('Choose whether a response is requested.')
}
function eventFields(value: unknown, create: boolean): void {
  const allowed = new Set(fields)
  if (create) allowed.add('uid')
  const input = object(value, allowed)
  if (create || input.summary !== undefined) text(input.summary, 'Event name', 4096)
  for (const field of ['start', 'end'] as const)
    if (create || input[field] !== undefined) {
      if (!text(input[field], 'Event date/time', 128))
        throw new Error('Provide the start and end date/time.')
    }
  if (input.uid !== undefined && !text(input.uid, 'Event identifier', 1024))
    throw new Error('Provide an event identifier.')
  if (input.timeZone !== undefined) text(input.timeZone, 'Time zone', 128)
  if (input.location !== undefined) text(input.location, 'Location', 4096)
  if (input.description !== undefined) text(input.description, 'Description', 16 * 1024, true)
  if (input.recurrence !== undefined && input.recurrence !== null)
    text(input.recurrence, 'Recurrence rule', 4096)
  if (
    input.disambiguation !== undefined &&
    (typeof input.disambiguation !== 'string' ||
      !['reject', 'earlier', 'later', 'compatible'].includes(input.disambiguation))
  )
    throw new Error('Choose how to resolve a repeated or skipped local time.')
  if (
    input.status !== undefined &&
    (typeof input.status !== 'string' ||
      !['TENTATIVE', 'CONFIRMED', 'CANCELLED'].includes(input.status))
  )
    throw new Error('Choose a valid event status.')
  if (input.organizer !== undefined && input.organizer !== null) participant(input.organizer)
  if (input.attendees !== undefined) {
    if (!Array.isArray(input.attendees) || input.attendees.length > 256)
      throw new Error('An event supports up to 256 participants.')
    input.attendees.forEach(participant)
  }
}
export function calendarMutation(value: unknown): CalendarMutation {
  if (!value || typeof value !== 'object') throw new Error('Choose a calendar edit.')
  const type = (value as { type?: unknown }).type
  const input = object(
    value,
    new Set(
      type === 'create'
        ? ['type', 'event']
        : type === 'update'
          ? ['type', 'uid', 'recurrenceId', 'scope', 'patch']
          : type === 'delete'
            ? ['type', 'uid', 'recurrenceId', 'scope']
            : type === 'respond'
              ? ['type', 'uid', 'recurrenceId', 'attendee', 'participation', 'comment']
              : [],
    ),
  )
  if (type === 'create') eventFields(input.event, true)
  else if (type === 'update' || type === 'delete' || type === 'respond') {
    calendarSelector({
      uid: input.uid,
      ...(input.recurrenceId !== undefined ? { recurrenceId: input.recurrenceId } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
    })
    if (type === 'update') eventFields(input.patch, false)
    if (type === 'respond') {
      if (
        !text(input.attendee, 'Responding address', 2048).trim() ||
        typeof input.participation !== 'string' ||
        !participations.has(input.participation)
      )
        throw new Error('Choose a responding participant and response.')
      if (input.comment !== undefined) text(input.comment, 'Response comment', 4096, true)
    }
  } else throw new Error('Choose create, update, delete or respond.')
  budget(input)
  return input as unknown as CalendarMutation
}
export function calendarMutationOptions(value: unknown): CalendarMutationOptions {
  const input = object(value, new Set(['expectedRevision', 'queueMethod']))
  calendarRevision(input.expectedRevision)
  if (
    input.queueMethod !== undefined &&
    (typeof input.queueMethod !== 'string' || !methods.has(input.queueMethod))
  )
    throw new Error('Choose a supported calendar message type.')
  return input as unknown as CalendarMutationOptions
}
export function calendarAgendaQuery(value: unknown): CalendarAgendaQuery {
  const input = object(value, new Set(['calendarId', 'start', 'end', 'viewTimeZone']))
  if (input.calendarId !== undefined) calendarId(input.calendarId)
  const start = text(input.start, 'Range start', 64),
    end = text(input.end, 'Range end', 64)
  const startMs = Date.parse(start),
    endMs = Date.parse(end)
  if (
    !/(Z|[+-]\d\d:\d\d)$/.test(start) ||
    !/(Z|[+-]\d\d:\d\d)$/.test(end) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    endMs - startMs > 366 * 86400000
  )
    throw new Error(
      'Choose an increasing date range of up to 366 days with an explicit time offset.',
    )
  if (input.viewTimeZone !== undefined) text(input.viewTimeZone, 'Display time zone', 128)
  return input as unknown as CalendarAgendaQuery
}
