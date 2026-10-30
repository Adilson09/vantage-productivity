import ICAL from 'ical.js'
import { randomUUID } from 'node:crypto'
import {
  attachCalendarTimeZones,
  calendarTimeFromInput,
  calendarWallEpoch,
  calendarWallTimeKind,
  createIanaTimeZoneComponent,
  isIanaTimeZone,
  parseCalendarWallTime,
  resolveCalendarWallTime,
} from './calendar-timezones'
import type {
  CalendarEventInput,
  CalendarOccurrenceOptions,
  CalendarParticipant,
} from './calendar-types'

type Component = InstanceType<typeof ICAL.Component>
type CalendarTime = InstanceType<typeof ICAL.Time>

export interface CalendarEventSummary {
  uid: string
  summary: string
  start: string
  end: string
  timeZone: string
  recurring: boolean
  allDay: boolean
}
export interface CalendarOccurrence {
  uid: string
  recurrenceId: string
  summary: string
  start: string
  end: string
  localStart: string
  localEnd: string
  timeZone: string
  allDay: boolean
  floating: boolean
  location: string
  description: string
  recurring: boolean
  recurrence: string | null
  status: string
  sequence: number
  organizer: CalendarParticipant | null
  attendees: CalendarParticipant[]
}
export type ExpansionOptions = CalendarOccurrenceOptions
export interface Contact {
  uid: string
  name: string
  emails: string[]
  phones: string[]
  organization: string
}
export type NewCalendarEvent = CalendarEventInput

const MAX_BYTES = 4 * 1024 * 1024
const MAX_COMPONENTS = 5000
const MAX_ITERATIONS = 50000

export function boundedCalendarSource(source: string): void {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_BYTES)
    throw new Error('Calendar/contact input exceeds 4 MiB.')
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(source))
    throw new Error('Calendar/contact input contains invalid control characters.')
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length > 50000) throw new Error('Calendar/contact input exceeds 50,000 lines.')
  let depth = 0
  let components = 0
  for (const line of lines) {
    if (line.length > 65536) throw new Error('A calendar/contact line exceeds 64 KiB.')
    if (/^BEGIN:/i.test(line)) {
      depth += 1
      components += 1
      if (depth > 12 || components > MAX_COMPONENTS)
        throw new Error('Calendar/contact component limit exceeded.')
    } else if (/^END:/i.test(line)) depth -= 1
    if (depth < 0) throw new Error('Calendar/contact components are unbalanced.')
  }
  if (depth !== 0) throw new Error('Calendar/contact components are unbalanced.')
}

export function parseCalendarSource(source: string): Component {
  boundedCalendarSource(source)
  const parsed = ICAL.parse(source.replace(/^\uFEFF/, ''))
  if (!Array.isArray(parsed) || parsed[0] !== 'vcalendar')
    throw new Error('Expected one VCALENDAR document.')
  const root = new ICAL.Component(parsed)
  if (String(root.getFirstPropertyValue('version')) !== '2.0')
    throw new Error('Only iCalendar version 2.0 is supported.')
  const validateDates = (component: Component): void => {
    const check = (value: unknown): void => {
      if (typeof value !== 'string') throw new Error('Invalid calendar date/time value.')
      parseCalendarWallTime(value.replace(/Z$/, ''))
    }
    for (const property of component.getAllProperties()) {
      const data = property.toJSON()
      if (data[2] === 'date' || data[2] === 'date-time') data.slice(3).forEach(check)
      if (data[2] === 'period')
        for (const value of data.slice(3)) {
          if (!Array.isArray(value)) throw new Error('Invalid RDATE period.')
          check(value[0])
          if (typeof value[1] === 'string' && !/^[+-]?P/.test(value[1])) check(value[1])
        }
      if (data[2] === 'recur')
        for (const value of data.slice(3))
          if (value && typeof value === 'object' && 'until' in value) check(value.until)
    }
    component.getAllSubcomponents().forEach(validateDates)
  }
  validateDates(root)
  attachCalendarTimeZones(root)
  const eventKeys = new Set<string>()
  for (const event of root.getAllSubcomponents('vevent')) {
    if (!event.getFirstPropertyValue('uid')) throw new Error('Each event requires a UID.')
    const uid = calendarText(event.getFirstPropertyValue('uid'), 'Event UID', 1024)
    if (/[\r\n]/.test(uid)) throw new Error('Event UID cannot contain line breaks.')
    if (event.getAllProperties('attendee').length > 256)
      throw new Error('An event may contain at most 256 attendees.')
    const recurrenceId = event.getFirstPropertyValue('recurrence-id') as CalendarTime | null
    const key = `${String(event.getFirstPropertyValue('uid'))}\u0000${recurrenceId ? calendarRecurrenceIdentifier(recurrenceId) : ''}`
    if (eventKeys.has(key)) throw new Error('Duplicate event UID/recurrence identifier.')
    eventKeys.add(key)
    const sequence = event.getFirstPropertyValue('sequence')
    if (event.getAllProperties('rrule').length > 1)
      throw new Error(
        'Multiple RRULE properties have undefined RFC5545 semantics; retain and split this source explicitly.',
      )
    if (
      sequence !== null &&
      (!Number.isSafeInteger(sequence) || Number(sequence) < 0 || Number(sequence) > 2147483647)
    )
      throw new Error('Invalid calendar SEQUENCE.')
    for (const property of event.getAllProperties('rrule')) {
      const rule = property.getFirstValue() as InstanceType<typeof ICAL.Recur>
      if (
        !['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(
          rule.freq,
        )
      )
        throw new Error('Unsupported recurrence frequency.')
      if (!Number.isSafeInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000)
        throw new Error('Invalid recurrence interval.')
      if (
        rule.count !== null &&
        rule.count !== undefined &&
        (!Number.isSafeInteger(rule.count) || rule.count < 1 || rule.count > 1000000)
      )
        throw new Error('Invalid recurrence COUNT.')
    }
  }
  return root
}
const calendar = parseCalendarSource

function cancelled(component: Component): boolean {
  return component.getFirstPropertyValue('status') === 'CANCELLED'
}
function eventOf(component: Component): InstanceType<typeof ICAL.Event> {
  return new ICAL.Event(component, { exceptions: [] })
}
function zone(time: CalendarTime): string {
  return time.isDate ? 'date' : time.zone.tzid === 'UTC' ? 'UTC' : time.zone.tzid
}
function localString(time: CalendarTime): string {
  return time.toString().replace(/Z$/, '')
}
export function calendarLocalEnd(start: CalendarTime, end: CalendarTime): string {
  return localString(
    !start.isDate && !floating(start) && !floating(end) ? end.convertToZone(start.zone) : end,
  )
}
export function calendarIsFloating(time: CalendarTime): boolean {
  return !time.isDate && time.zone.tzid === 'floating'
}
const floating = calendarIsFloating
export function calendarTimeEpoch(time: CalendarTime): number {
  return time.isDate || floating(time) ? calendarWallEpoch(time) : time.toJSDate().getTime()
}
const epoch = calendarTimeEpoch
export function calendarOutputTime(time: CalendarTime): string {
  return time.isDate || floating(time) ? localString(time) : time.toJSDate().toISOString()
}
const outputTime = calendarOutputTime
export function calendarRecurrenceIdentifier(time: CalendarTime): string {
  return time.isDate || floating(time)
    ? time.toString()
    : time.toJSDate().toISOString().replace('.000Z', 'Z')
}
export function calendarParticipant(
  property: InstanceType<typeof ICAL.Property>,
): CalendarParticipant {
  const name = property.getParameter('cn'),
    participation = property.getParameter('partstat'),
    role = property.getParameter('role'),
    rsvp = property.getParameter('rsvp')
  return {
    address: String(property.getFirstValue()),
    ...(name ? { name: String(name) } : {}),
    ...(participation
      ? {
          participation: String(participation) as NonNullable<CalendarParticipant['participation']>,
        }
      : {}),
    ...(role ? { role: String(role) } : {}),
    ...(rsvp ? { rsvp: String(rsvp).toUpperCase() === 'TRUE' } : {}),
  }
}
export function calendarText(value: unknown, label: string, max = 65536): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max || /\u0000/.test(value))
    throw new Error(`${label} must be text within ${max} bytes.`)
  return value
}
export function normalizeCalendarAddress(value: string): string {
  const input = calendarText(value, 'Calendar address', 2048)
  const address = /^mailto:/i.test(input) ? input.slice(7) : input
  if (!/^[^\s@<>?:]+@[^\s@<>?:]+$/.test(address))
    throw new Error('Local participants require an email address or mailto: calendar address.')
  return `mailto:${address}`
}
export function writeCalendarParticipant(
  component: Component,
  name: 'organizer' | 'attendee',
  input: CalendarParticipant,
): void {
  const address = normalizeCalendarAddress(input.address)
  let property = component
    .getAllProperties(name)
    .find((p) => String(p.getFirstValue()).toLowerCase() === address.toLowerCase())
  if (!property) {
    property = new ICAL.Property(name)
    component.addProperty(property)
  }
  property.setValue(address)
  if (input.name !== undefined)
    property.setParameter('cn', calendarText(input.name, 'Participant name', 1024))
  if (input.participation !== undefined) {
    if (!['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE'].includes(input.participation))
      throw new Error('Unsupported attendee participation status.')
    property.setParameter('partstat', input.participation)
  }
  if (input.role !== undefined) {
    if (!['CHAIR', 'REQ-PARTICIPANT', 'OPT-PARTICIPANT', 'NON-PARTICIPANT'].includes(input.role))
      throw new Error('Unsupported attendee role.')
    property.setParameter('role', input.role)
  }
  if (input.rsvp !== undefined) {
    if (typeof input.rsvp !== 'boolean') throw new Error('RSVP must be a boolean.')
    property.setParameter('rsvp', input.rsvp ? 'TRUE' : 'FALSE')
  }
}
export function ensureCalendarIanaDefinitions(root: Component): void {
  const existing = new Set(
    root.getAllSubcomponents('vtimezone').map((c) => String(c.getFirstPropertyValue('tzid'))),
  )
  const required = new Set<string>()
  const visit = (component: Component): void => {
    if (component.name === 'vtimezone') return
    for (const property of component.getAllProperties()) {
      const tzid = property.getParameter('tzid')
      if (tzid && !existing.has(String(tzid)) && isIanaTimeZone(String(tzid)))
        required.add(String(tzid))
    }
    component.getAllSubcomponents().forEach(visit)
  }
  visit(root)
  for (const name of required) root.addSubcomponent(createIanaTimeZoneComponent(name))
}

interface RecurrenceDate {
  time: CalendarTime
  periodEnd?: CalendarTime
}
function* recurrenceDates(
  component: Component,
  tick: () => void,
  beyond: (time: CalendarTime) => boolean,
): Generator<RecurrenceDate> {
  const start = component.getFirstPropertyValue('dtstart') as CalendarTime | null
  if (!start) throw new Error('A recurrence requires DTSTART.')
  if (component.hasProperty('exrule'))
    throw new Error(
      'Legacy EXRULE is preserved but cannot be expanded; convert it to explicit exclusions first.',
    )
  const excluded = new Set<string>()
  for (const property of component.getAllProperties('exdate'))
    for (const value of property.getValues()) {
      if (!(value instanceof ICAL.Time) || value.isDate !== start.isDate)
        throw new Error('EXDATE must share DTSTART value type.')
      excluded.add(calendarRecurrenceIdentifier(value))
    }
  // Explicit RDATE periods take precedence when the same recurrence identifier
  // also occurs in DTSTART or an RRULE, preserving their distinct duration.
  for (const property of component.getAllProperties('rdate'))
    for (const value of property.getValues()) {
      tick()
      const time = value instanceof ICAL.Period ? value.start : value
      if (!(time instanceof ICAL.Time) || time.isDate !== start.isDate)
        throw new Error('RDATE must share DTSTART value type.')
      if (!beyond(time) && !excluded.has(calendarRecurrenceIdentifier(time)))
        yield { time, ...(value instanceof ICAL.Period ? { periodEnd: value.getEnd() } : {}) }
    }
  if (!beyond(start) && !excluded.has(calendarRecurrenceIdentifier(start))) yield { time: start }
  for (const property of component.getAllProperties('rrule')) {
    const rule = property.getFirstValue() as InstanceType<typeof ICAL.Recur>
    const count = rule.count
    const uncounted = new ICAL.Recur(rule.toJSON())
    uncounted.count = null
    const iterator = uncounted.iterator(start)
    let valid = 0
    let time: CalendarTime | null
    while ((time = iterator.next())) {
      tick()
      if (beyond(time)) break
      // RFC5545 3.3.10 excludes rule-generated nonexistent local times and
      // excludes them from COUNT. An explicitly supplied DTSTART is retained.
      if (
        calendarWallTimeKind(time) === 'nonexistent' &&
        calendarRecurrenceIdentifier(time) !== calendarRecurrenceIdentifier(start)
      )
        continue
      if (count && ++valid > count) break
      if (!excluded.has(calendarRecurrenceIdentifier(time))) yield { time }
    }
  }
}
/** Bounded original instance lookup used for local detached mutations. */
export function calendarRecurrenceDates(
  component: Component,
  options: { endMs: number; maxIterations?: number; deadlineMs?: number },
): Generator<RecurrenceDate> {
  let iterations = 0
  const deadline = Date.now() + (options.deadlineMs ?? 2000)
  const tick = (): void => {
    if (++iterations > (options.maxIterations ?? 50000) || Date.now() > deadline)
      throw new Error(
        'Instance lookup limit reached; use a nearer recurrence or an existing detached exception.',
      )
  }
  return recurrenceDates(component, tick, (time) => epoch(time) > options.endMs)
}

export function inspectCalendar(source: string): {
  events: CalendarEventSummary[]
  warnings: string[]
} {
  const root = calendar(source)
  const warnings = new Set<string>()
  const events = root
    .getAllSubcomponents('vevent')
    .filter((c) => !cancelled(c))
    .map((component) => {
      const event = eventOf(component)
      if (!event.startDate) throw new Error(`Event ${event.uid} has no DTSTART.`)
      if (
        event.startDate.isDate !== event.endDate.isDate ||
        floating(event.startDate) !== floating(event.endDate)
      )
        throw new Error(
          `Event ${event.uid} start/end have incompatible date or floating-time kinds.`,
        )
      if (epoch(event.endDate) < epoch(event.startDate))
        throw new Error(`Event ${event.uid} ends before it starts.`)
      if (component.hasProperty('dtend') && epoch(event.endDate) === epoch(event.startDate))
        throw new Error(`Event ${event.uid} has an explicit DTEND that must be later than DTSTART.`)
      if (floating(event.startDate))
        warnings.add(
          'Floating event times are local wall times and have no UTC instant; range filtering uses their displayed dates.',
        )
      return {
        uid: event.uid,
        summary: event.summary ?? '',
        start: outputTime(event.startDate),
        end: outputTime(event.endDate),
        timeZone: zone(event.startDate),
        recurring: event.isRecurring(),
        allDay: event.startDate.isDate,
      }
    })
  if (root.getAllSubcomponents('vtodo').length)
    warnings.add('Tasks (VTODO) are preserved in export but are not expanded as calendar events.')
  return { events, warnings: [...warnings] }
}

/** No network, alarm, invitation or attachment is executed during import/expansion. */
export function expandCalendar(
  source: string,
  options: ExpansionOptions,
): { occurrences: CalendarOccurrence[]; warnings: string[] } {
  const startMs = Date.parse(options.start)
  const endMs = Date.parse(options.end)
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    !/(Z|[+-]\d\d:\d\d)$/.test(options.start) ||
    !/(Z|[+-]\d\d:\d\d)$/.test(options.end)
  )
    throw new Error('Use a valid increasing ISO date-time range with explicit UTC offset.')
  const maxOccurrences = options.maxOccurrences ?? 2000
  const maxIterations = options.maxIterations ?? 20000
  const deadlineMs = options.deadlineMs ?? 2000
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 5000)
    throw new Error('Calendar expansion deadline must be 10–5,000 ms.')
  const deadline = Date.now() + deadlineMs
  const viewZone = options.viewTimeZone ?? 'UTC'
  if (viewZone !== 'UTC' && !isIanaTimeZone(viewZone))
    throw new Error('The display time zone must be a supported IANA zone.')
  const filterEpoch = (time: CalendarTime): number =>
    (time.isDate || floating(time)) && viewZone !== 'UTC'
      ? Date.parse(
          resolveCalendarWallTime(
            `${localString(time)}${time.isDate ? 'T00:00:00' : ''}`,
            viewZone,
            'compatible',
          ).instant,
        )
      : epoch(time)
  if (
    !Number.isSafeInteger(maxOccurrences) ||
    maxOccurrences < 1 ||
    maxOccurrences > 10000 ||
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > MAX_ITERATIONS
  )
    throw new Error('Occurrence/iteration limits are outside the supported range.')
  const root = calendar(source)
  const warnings = new Set<string>()
  const components = root.getAllSubcomponents('vevent')
  const occurrences: CalendarOccurrence[] = []
  const sortEpoch = new Map<CalendarOccurrence, number>()
  const seen = new Set<string>()
  let iterations = 0
  let outputBytes = 0

  const add = (
    component: Component,
    original: CalendarTime,
    start: CalendarTime,
    end: CalendarTime,
  ): void => {
    if (cancelled(component)) return
    if (epoch(end) < epoch(start)) throw new Error('An event ends before it starts.')
    const startEpoch = filterEpoch(start),
      endEpoch = filterEpoch(end)
    if (
      startEpoch >= endMs ||
      (endEpoch <= startMs && startEpoch !== endEpoch) ||
      (startEpoch === endEpoch && startEpoch < startMs)
    )
      return
    const event = eventOf(component)
    const key = `${event.uid}\u0000${calendarRecurrenceIdentifier(original)}`
    if (seen.has(key)) return
    if (occurrences.length >= maxOccurrences)
      throw new Error(`Occurrence limit (${maxOccurrences}) reached; use a smaller range.`)
    seen.add(key)
    const master = components.find(
      (c) => !c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === event.uid,
    )
    const recurrence =
      component.getFirstPropertyValue('rrule') ?? master?.getFirstPropertyValue('rrule')
    if (floating(start))
      warnings.add(
        'Floating event times are local wall times and have no UTC instant; range filtering uses their displayed dates.',
      )
    const organizer =
      component.getFirstProperty('organizer') ?? master?.getFirstProperty('organizer')
    const attendees = component.getAllProperties('attendee')
    occurrences.push({
      uid: event.uid,
      recurrenceId: calendarRecurrenceIdentifier(original),
      summary: event.summary ?? '',
      start: outputTime(start),
      end: outputTime(end),
      localStart: localString(start),
      localEnd: calendarLocalEnd(start, end),
      timeZone: zone(start),
      allDay: start.isDate,
      floating: floating(start),
      location: event.location ?? '',
      description: event.description ?? '',
      recurring: Boolean(master && eventOf(master).isRecurring()),
      recurrence: recurrence ? String(recurrence) : null,
      status: String(component.getFirstPropertyValue('status') ?? 'CONFIRMED'),
      sequence: Number(
        component.getFirstPropertyValue('sequence') ??
          master?.getFirstPropertyValue('sequence') ??
          0,
      ),
      organizer: organizer ? calendarParticipant(organizer) : null,
      attendees: (attendees.length ? attendees : (master?.getAllProperties('attendee') ?? [])).map(
        calendarParticipant,
      ),
    })
    outputBytes += Buffer.byteLength(JSON.stringify(occurrences[occurrences.length - 1]), 'utf8')
    sortEpoch.set(occurrences[occurrences.length - 1]!, startEpoch)
    if (outputBytes > 4 * 1024 * 1024)
      throw new Error(
        'Calendar occurrence output exceeds 4 MiB; narrow the range or reduce large event text.',
      )
  }

  for (const component of components.filter((c) => !c.hasProperty('recurrence-id'))) {
    if (cancelled(component)) continue
    const uid = String(component.getFirstPropertyValue('uid'))
    const exceptions = components.filter(
      (c) => c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === uid,
    )
    const cancelledDates = new Set(
      exceptions
        .filter(cancelled)
        .map((c) =>
          calendarRecurrenceIdentifier(c.getFirstPropertyValue('recurrence-id') as CalendarTime),
        ),
    )
    const cancelledAfter = exceptions
      .filter(
        (c) =>
          cancelled(c) &&
          c.getFirstProperty('recurrence-id')?.getParameter('range') === 'THISANDFUTURE',
      )
      .map((c) => epoch(c.getFirstPropertyValue('recurrence-id') as CalendarTime))
    const event = new ICAL.Event(component, {
      strictExceptions: true,
      exceptions: exceptions.filter((c) => !cancelled(c)),
    })
    if (!event.startDate) throw new Error(`Event ${uid} has no DTSTART.`)
    if (!event.isRecurring()) {
      add(component, event.startDate, event.startDate, event.endDate)
      continue
    }
    const tick = (): void => {
      iterations++
      if (Date.now() > deadline)
        throw new Error('Calendar recurrence expansion deadline reached; use a narrower range.')
      if (iterations > maxIterations)
        throw new Error(
          `Recurrence iteration limit (${maxIterations}) reached; narrow the range or shorten the source recurrence.`,
        )
    }
    const negativeShifts = exceptions
      .filter(
        (c) =>
          !cancelled(c) &&
          c.getFirstProperty('recurrence-id')?.getParameter('range') === 'THISANDFUTURE',
      )
      .map((c) => {
        const item = eventOf(c)
        return Math.max(0, calendarWallEpoch(item.recurrenceId) - calendarWallEpoch(item.startDate))
      })
    const cutoff = endMs + Math.max(0, ...negativeShifts)
    for (const candidate of recurrenceDates(
      component,
      tick,
      (time) => filterEpoch(time) >= cutoff,
    )) {
      const next = candidate.time
      if (
        cancelledDates.has(calendarRecurrenceIdentifier(next)) ||
        cancelledAfter.some((at) => epoch(next) >= at)
      )
        continue
      const detail = event.getOccurrenceDetails(next)
      add(
        detail.item.component,
        next,
        detail.startDate,
        candidate.periodEnd && detail.item.component === component
          ? candidate.periodEnd
          : detail.endDate,
      )
    }
  }
  // Include moved and orphaned detached occurrences; deduplication uses their
  // original recurrence identifier rather than the new displayed start time.
  for (const component of components.filter(
    (c) => c.hasProperty('recurrence-id') && !cancelled(c),
  )) {
    const uid = component.getFirstPropertyValue('uid')
    const master = components.find(
      (c) => !c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === uid,
    )
    if (master && cancelled(master)) continue
    const original = component.getFirstPropertyValue('recurrence-id') as CalendarTime
    if (
      components.some(
        (c) =>
          c.getFirstPropertyValue('uid') === uid &&
          cancelled(c) &&
          c.getFirstProperty('recurrence-id')?.getParameter('range') === 'THISANDFUTURE' &&
          epoch(c.getFirstPropertyValue('recurrence-id') as CalendarTime) <= epoch(original),
      )
    )
      continue
    const event = eventOf(component)
    if (!event.startDate) throw new Error(`Event ${event.uid} exception has no DTSTART.`)
    add(component, event.recurrenceId, event.startDate, event.endDate)
  }
  occurrences.sort(
    (a, b) =>
      sortEpoch.get(a)! - sortEpoch.get(b)! ||
      a.uid.localeCompare(b.uid) ||
      a.recurrenceId.localeCompare(b.recurrenceId),
  )
  return { occurrences, warnings: [...warnings] }
}

/** Validate and preserve all original bytes, including unsupported properties, on a no-op export. */
export function exportCalendar(source: string): string {
  calendar(source)
  return source
}

export function createCalendar(events: NewCalendarEvent[]): string {
  if (events.length > 2000) throw new Error('At most 2,000 events may be created at once.')
  const root = new ICAL.Component('vcalendar')
  root.addPropertyWithValue('version', '2.0')
  root.addPropertyWithValue('prodid', '-//Vantage Productivity//Local Calendar 1.0//EN')
  for (const input of events) {
    const component = new ICAL.Component('vevent')
    const event = eventOf(component)
    event.uid = calendarText(input.uid ?? randomUUID(), 'Event UID', 1024)
    if (!event.uid || /[\r\n]/.test(event.uid))
      throw new Error('Event UID must be nonempty and contain no line breaks.')
    event.summary = calendarText(input.summary, 'Event summary')
    const readTime = (value: string): CalendarTime => {
      return calendarTimeFromInput(value, input.timeZone, input.disambiguation)
    }
    event.startDate = readTime(input.start)
    event.endDate = readTime(input.end)
    if (
      event.startDate.isDate !== event.endDate.isDate ||
      floating(event.startDate) !== floating(event.endDate) ||
      epoch(event.endDate) < epoch(event.startDate)
    )
      throw new Error(
        'Event start/end must share a date/floating type and have an increasing range.',
      )
    event.description = calendarText(input.description ?? '', 'Event description')
    event.location = calendarText(input.location ?? '', 'Event location')
    component.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
    if (input.recurrence) {
      if (
        input.timeZone &&
        event.startDate.zone.tzid === 'UTC' &&
        input.timeZone !== 'UTC' &&
        input.timeZone !== 'Etc/UTC'
      )
        throw new Error(
          'A later-fold recurring start must be represented by an explicit UTC series or a separate instance exception.',
        )
      component.addPropertyWithValue(
        'rrule',
        ICAL.Recur.fromString(calendarText(input.recurrence, 'Recurrence rule', 8192)),
      )
    }
    if (input.status) {
      if (!['TENTATIVE', 'CONFIRMED', 'CANCELLED'].includes(input.status))
        throw new Error('Unsupported event status.')
      component.addPropertyWithValue('status', input.status)
    }
    if (input.organizer) writeCalendarParticipant(component, 'organizer', input.organizer)
    if (
      input.attendees !== undefined &&
      (!Array.isArray(input.attendees) || input.attendees.length > 256)
    )
      throw new Error('At most 256 attendees are supported per event.')
    for (const attendee of input.attendees ?? [])
      writeCalendarParticipant(component, 'attendee', attendee)
    root.addSubcomponent(component)
  }
  ensureCalendarIanaDefinitions(root)
  const source = root.toString() + '\r\n'
  inspectCalendar(source)
  return source
}

export function updateCalendarEvent(
  source: string,
  uid: string,
  patch: { summary?: string; description?: string; location?: string },
  recurrenceId?: string,
): string {
  const root = calendar(source)
  const matching = root.getAllSubcomponents('vevent').filter((c) => {
    const id = c.getFirstPropertyValue('recurrence-id') as CalendarTime | null
    return (
      c.getFirstPropertyValue('uid') === uid &&
      (recurrenceId
        ? id &&
          (calendarRecurrenceIdentifier(id) === recurrenceId.replace('.000Z', 'Z') ||
            id.toString() === recurrenceId)
        : !id)
    )
  })
  if (matching.length !== 1) throw new Error('The event identifier must select exactly one event.')
  const component = matching[0]!
  for (const [key, value] of Object.entries(patch)) {
    if (
      !['summary', 'description', 'location'].includes(key) ||
      typeof value !== 'string' ||
      value.length > 65536
    )
      throw new Error(
        'Only summary, description and location text may be updated, at most 64 KiB each.',
      )
    component.updatePropertyWithValue(key, value)
  }
  component.updatePropertyWithValue(
    'sequence',
    Number(component.getFirstPropertyValue('sequence') ?? 0) + 1,
  )
  component.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(new Date(), true))
  component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  const output = `${source.startsWith('\uFEFF') ? '\uFEFF' : ''}${root.toString()}\r\n`
  calendar(output)
  return output
}

export function parseContacts(source: string): { contacts: Contact[]; warnings: string[] } {
  boundedCalendarSource(source)
  if (!source.trim()) return { contacts: [], warnings: [] }
  const parsed = ICAL.parse(source.replace(/^\uFEFF/, ''))
  const roots: unknown[] = typeof parsed[0] === 'string' ? [parsed] : parsed
  const contacts = roots.map((data) => {
    const component = new ICAL.Component(data as unknown[])
    if (component.name !== 'vcard') throw new Error('Contact import requires VCARD components.')
    const version = String(component.getFirstPropertyValue('version'))
    if (version !== '3.0' && version !== '4.0')
      throw new Error('Only vCard 3.0 and 4.0 are supported.')
    const organization = component.getFirstPropertyValue('org')
    return {
      uid: String(component.getFirstPropertyValue('uid') ?? ''),
      name: String(component.getFirstPropertyValue('fn') ?? ''),
      emails: component.getAllProperties('email').map((p) => String(p.getFirstValue())),
      phones: component.getAllProperties('tel').map((p) => String(p.getFirstValue())),
      organization: Array.isArray(organization)
        ? organization.join(' / ')
        : String(organization ?? ''),
    }
  })
  return {
    contacts,
    warnings: contacts.some((c) => !c.name) ? ['Some contacts have no formatted name.'] : [],
  }
}

export function exportContacts(contacts: Contact[]): string {
  if (contacts.length > MAX_COMPONENTS) throw new Error('At most 5,000 contacts may be exported.')
  const source =
    contacts
      .map((contact) => {
        const card = new ICAL.Component('vcard')
        card.addPropertyWithValue('version', '4.0')
        card.addPropertyWithValue('uid', contact.uid || randomUUID())
        card.addPropertyWithValue('fn', contact.name)
        if (contact.organization) card.addPropertyWithValue('org', [contact.organization])
        for (const email of contact.emails) card.addPropertyWithValue('email', email)
        for (const phone of contact.phones) card.addPropertyWithValue('tel', phone)
        return card.toString()
      })
      .join('\r\n') + '\r\n'
  parseContacts(source)
  return source
}
