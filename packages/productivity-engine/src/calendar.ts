import ICAL from 'ical.js'
import { randomUUID } from 'node:crypto'

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
}
export interface ExpansionOptions {
  start: string
  end: string
  maxOccurrences?: number
  maxIterations?: number
}
export interface Contact {
  uid: string
  name: string
  emails: string[]
  phones: string[]
  organization: string
}
export interface NewCalendarEvent {
  uid?: string
  summary: string
  start: string
  end: string
  description?: string
  location?: string
  recurrence?: string
}

const MAX_BYTES = 4 * 1024 * 1024
const MAX_COMPONENTS = 5000
const MAX_ITERATIONS = 50000

function boundedSource(source: string): void {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_BYTES)
    throw new Error('Calendar/contact input exceeds 4 MiB.')
  const lines = source.split(/\r?\n/)
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

function calendar(source: string): Component {
  boundedSource(source)
  const parsed = ICAL.parse(source)
  if (!Array.isArray(parsed) || parsed[0] !== 'vcalendar')
    throw new Error('Expected one VCALENDAR document.')
  const root = new ICAL.Component(parsed)
  if (String(root.getFirstPropertyValue('version')) !== '2.0')
    throw new Error('Only iCalendar version 2.0 is supported.')
  const eventKeys = new Set<string>()
  for (const event of root.getAllSubcomponents('vevent')) {
    if (!event.getFirstPropertyValue('uid')) throw new Error('Each event requires a UID.')
    const key = `${String(event.getFirstPropertyValue('uid'))}\u0000${String(event.getFirstPropertyValue('recurrence-id') ?? '')}`
    if (eventKeys.has(key)) throw new Error('Duplicate event UID/recurrence identifier.')
    eventKeys.add(key)
    // Unknown TZIDs silently become floating time in many parsers. Refuse to
    // assign an instant unless the file actually carries the zone definition.
    for (const property of event.getAllProperties()) {
      const tzid = property.getParameter('tzid')
      if (tzid && tzid !== 'UTC' && !root.getTimeZoneByID(String(tzid)))
        throw new Error(`Time zone ${String(tzid)} needs an embedded VTIMEZONE definition.`)
    }
    if (
      cancelled(event) &&
      event.getFirstProperty('recurrence-id')?.getParameter('range') === 'THISANDFUTURE'
    )
      throw new Error(
        'Cancellation of this and all future occurrences is not supported by local expansion; retain the original calendar and use its provider.',
      )
    for (const property of event.getAllProperties('rrule')) {
      const rule = property.getFirstValue() as InstanceType<typeof ICAL.Recur>
      if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq))
        throw new Error(
          'Local recurrence expansion supports daily, weekly, monthly and yearly rules.',
        )
      if (!Number.isSafeInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000)
        throw new Error('Invalid recurrence interval.')
    }
  }
  return root
}

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
function floating(time: CalendarTime): boolean {
  return !time.isDate && time.zone.tzid === 'floating'
}
function epoch(time: CalendarTime): number {
  return time.isDate || floating(time)
    ? Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second)
    : time.toJSDate().getTime()
}
function outputTime(time: CalendarTime): string {
  return time.isDate || floating(time) ? localString(time) : time.toJSDate().toISOString()
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
      if (epoch(event.endDate) < epoch(event.startDate))
        throw new Error(`Event ${event.uid} ends before it starts.`)
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
  const warnings = new Set(inspectCalendar(source).warnings)
  const components = root.getAllSubcomponents('vevent')
  const occurrences: CalendarOccurrence[] = []
  const seen = new Set<string>()
  let iterations = 0

  const add = (
    component: Component,
    original: CalendarTime,
    start: CalendarTime,
    end: CalendarTime,
  ): void => {
    if (cancelled(component)) return
    if (epoch(end) < epoch(start)) throw new Error('An event ends before it starts.')
    if (
      epoch(start) >= endMs ||
      (epoch(end) <= startMs && epoch(start) !== epoch(end)) ||
      (epoch(start) === epoch(end) && epoch(start) < startMs)
    )
      return
    const event = eventOf(component)
    const key = `${event.uid}\u0000${original.toString()}`
    if (seen.has(key)) return
    if (occurrences.length >= maxOccurrences)
      throw new Error(`Occurrence limit (${maxOccurrences}) reached; use a smaller range.`)
    seen.add(key)
    occurrences.push({
      uid: event.uid,
      recurrenceId: original.toString(),
      summary: event.summary ?? '',
      start: outputTime(start),
      end: outputTime(end),
      localStart: localString(start),
      localEnd: localString(end),
      timeZone: zone(start),
      allDay: start.isDate,
      floating: floating(start),
      location: event.location ?? '',
      description: event.description ?? '',
    })
  }

  for (const component of components.filter((c) => !c.hasProperty('recurrence-id'))) {
    if (cancelled(component)) continue
    const uid = String(component.getFirstPropertyValue('uid'))
    const exceptions = components.filter(
      (c) => c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === uid,
    )
    const cancelledDates = new Set(
      exceptions.filter(cancelled).map((c) => String(c.getFirstPropertyValue('recurrence-id'))),
    )
    const event = new ICAL.Event(component, {
      strictExceptions: true,
      exceptions: exceptions.filter((c) => !cancelled(c)),
    })
    if (!event.startDate) throw new Error(`Event ${uid} has no DTSTART.`)
    if (!event.isRecurring()) {
      add(component, event.startDate, event.startDate, event.endDate)
      continue
    }
    const iterator = event.iterator()
    let next: CalendarTime | null
    while ((next = iterator.next())) {
      iterations += 1
      if (iterations > maxIterations)
        throw new Error(
          `Recurrence iteration limit (${maxIterations}) reached; narrow the range or shorten the source recurrence.`,
        )
      // Detached exceptions are considered separately below even if their
      // original date lies outside the requested range.
      if (epoch(next) >= endMs) break
      if (cancelledDates.has(next.toString())) continue
      const detail = event.getOccurrenceDetails(next)
      add(detail.item.component, next, detail.startDate, detail.endDate)
    }
  }
  // Include moved and orphaned detached occurrences; deduplication uses their
  // original recurrence identifier rather than the new displayed start time.
  for (const component of components.filter(
    (c) => c.hasProperty('recurrence-id') && !cancelled(c),
  )) {
    const event = eventOf(component)
    if (!event.startDate) throw new Error(`Event ${event.uid} exception has no DTSTART.`)
    add(component, event.recurrenceId, event.startDate, event.endDate)
  }
  occurrences.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid))
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
    event.uid = input.uid ?? randomUUID()
    event.summary = input.summary
    const readTime = (value: string): CalendarTime => {
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(?:\.000)?Z)?$/.test(value))
        throw new Error(
          'New events require YYYY-MM-DD dates or UTC timestamps at whole-second precision (YYYY-MM-DDTHH:mm:ssZ).',
        )
      return ICAL.Time.fromString(value.replace(/\.000Z$/, 'Z'), undefined)
    }
    event.startDate = readTime(input.start)
    event.endDate = readTime(input.end)
    if (
      event.startDate.isDate !== event.endDate.isDate ||
      epoch(event.endDate) < epoch(event.startDate)
    )
      throw new Error('Event start/end must share a date type and have an increasing range.')
    event.description = input.description ?? ''
    event.location = input.location ?? ''
    component.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
    if (input.recurrence)
      component.addPropertyWithValue('rrule', ICAL.Recur.fromString(input.recurrence))
    root.addSubcomponent(component)
  }
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
  const matching = root
    .getAllSubcomponents('vevent')
    .filter(
      (c) =>
        c.getFirstPropertyValue('uid') === uid &&
        (recurrenceId
          ? String(c.getFirstPropertyValue('recurrence-id')) === recurrenceId
          : !c.hasProperty('recurrence-id')),
    )
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
  const output = root.toString() + '\r\n'
  calendar(output)
  return output
}

export function parseContacts(source: string): { contacts: Contact[]; warnings: string[] } {
  boundedSource(source)
  if (!source.trim()) return { contacts: [], warnings: [] }
  const parsed = ICAL.parse(source)
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
