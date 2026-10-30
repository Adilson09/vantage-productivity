import ICAL from 'ical.js'
import { randomUUID } from 'node:crypto'
import {
  calendarIsFloating,
  calendarLocalEnd,
  calendarOutputTime,
  calendarParticipant,
  calendarRecurrenceDates,
  calendarRecurrenceIdentifier,
  calendarText,
  calendarTimeEpoch,
  createCalendar,
  ensureCalendarIanaDefinitions,
  inspectCalendar,
  normalizeCalendarAddress,
  parseCalendarSource,
  writeCalendarParticipant,
} from './calendar'
import { calendarTimeFromInput, parseCalendarWallTime } from './calendar-timezones'
import type {
  CalendarEventDetails,
  CalendarEventPatch,
  CalendarMutation,
  CalendarMutationScope,
  CalendarSchedulingMethod,
} from './calendar-types'

type Component = InstanceType<typeof ICAL.Component>
type CalendarTime = InstanceType<typeof ICAL.Time>
const clone = (component: Component): Component =>
  new ICAL.Component(JSON.parse(JSON.stringify(component.toJSON())))
const events = (root: Component): Component[] => root.getAllSubcomponents('vevent')
const event = (component: Component): InstanceType<typeof ICAL.Event> =>
  new ICAL.Event(component, { exceptions: [] })
const sequence = (component: Component): number =>
  Number(component.getFirstPropertyValue('sequence') ?? 0)
const now = (): CalendarTime =>
  ICAL.Time.fromJSDate(new Date(Math.floor(Date.now() / 1000) * 1000), true)
const serialize = (root: Component): string => {
  ensureCalendarIanaDefinitions(root)
  const source = root.toString() + '\r\n'
  inspectCalendar(source)
  return source
}
const idOf = (component: Component): string | null => {
  const id = component.getFirstPropertyValue('recurrence-id') as CalendarTime | null
  return id ? calendarRecurrenceIdentifier(id) : null
}
const matches = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const knownProperties = new Set([
  'uid',
  'dtstart',
  'dtend',
  'duration',
  'dtstamp',
  'sequence',
  'last-modified',
  'created',
  'summary',
  'description',
  'location',
  'rrule',
  'rdate',
  'exrule',
  'exdate',
  'recurrence-id',
  'organizer',
  'attendee',
  'status',
  'transp',
  'class',
  'priority',
  'url',
  'attach',
  'categories',
  'comment',
  'contact',
  'geo',
  'related-to',
  'request-status',
  'resources',
])

function masterOf(root: Component, uid: string): Component | undefined {
  return events(root).find(
    (c) => c.getFirstPropertyValue('uid') === uid && !c.hasProperty('recurrence-id'),
  )
}
function readRecurrenceId(value: string, master: Component): CalendarTime {
  const start = event(master).startDate
  if (!start) throw new Error('The recurring master has no DTSTART.')
  const normalized = value.replace(/\.000Z$/, 'Z')
  const time = normalized.endsWith('Z')
    ? calendarTimeFromInput(normalized)
    : parseCalendarWallTime(normalized)
  if (!normalized.endsWith('Z') && !time.isDate) time.zone = start.zone
  if (time.isDate !== start.isDate || calendarIsFloating(time) !== calendarIsFloating(start))
    throw new Error('RECURRENCE-ID must use the master event date/time kind.')
  return time
}
function findOccurrence(
  master: Component,
  original: CalendarTime,
): { start: CalendarTime; end: CalendarTime } {
  const item = event(master)
  if (!item.isRecurring()) throw new Error('A detached instance requires a recurring master.')
  const wanted = calendarRecurrenceIdentifier(original)
  for (const candidate of calendarRecurrenceDates(master, { endMs: calendarTimeEpoch(original) })) {
    const next = candidate.time
    if (calendarRecurrenceIdentifier(next) === wanted) {
      const end = candidate.periodEnd ?? next.clone()
      if (!candidate.periodEnd) end.addDuration(item.duration)
      return { start: next, end }
    }
  }
  throw new Error('RECURRENCE-ID is not an included instance of this series.')
}
function detached(
  root: Component,
  uid: string,
  recurrenceId: string,
  scope: CalendarMutationScope,
): Component {
  const master = masterOf(root, uid)
  if (!master) throw new Error('The recurring master does not exist.')
  const original = readRecurrenceId(recurrenceId, master)
  const key = calendarRecurrenceIdentifier(original)
  const existing = events(root).find(
    (c) => c.getFirstPropertyValue('uid') === uid && idOf(c) === key,
  )
  if (existing) {
    if (
      scope === 'instance' &&
      existing.getFirstProperty('recurrence-id')?.getParameter('range') === 'THISANDFUTURE'
    )
      throw new Error(
        'This instance is a THISANDFUTURE boundary; select the future range explicitly instead of silently changing its scope.',
      )
    if (scope === 'this-and-future')
      existing.getFirstProperty('recurrence-id')!.setParameter('range', 'THISANDFUTURE')
    return existing
  }
  const occurrence = findOccurrence(master, original)
  const component = clone(master)
  for (const name of ['rrule', 'rdate', 'exrule', 'exdate', 'recurrence-id'])
    component.removeAllProperties(name)
  const instance = event(component)
  instance.recurrenceId = original
  instance.startDate = occurrence.start
  instance.endDate = occurrence.end
  if (scope === 'this-and-future')
    component.getFirstProperty('recurrence-id')!.setParameter('range', 'THISANDFUTURE')
  root.addSubcomponent(component)
  return component
}
function target(
  root: Component,
  uid: string,
  recurrenceId?: string,
  scope: CalendarMutationScope = recurrenceId ? 'instance' : 'series',
): Component {
  if (!['instance', 'series', 'this-and-future'].includes(scope))
    throw new Error('Unsupported calendar mutation scope.')
  calendarText(uid, 'Event UID', 1024)
  if (scope === 'series') {
    const master = masterOf(root, uid)
    if (!master) throw new Error('The event does not exist.')
    return master
  }
  if (recurrenceId) return detached(root, uid, recurrenceId, scope)
  const master = masterOf(root, uid)
  if (master && !event(master).isRecurring()) return master
  throw new Error('Select an original recurrence identifier for an instance edit.')
}
export function describeCalendarEvent(
  source: string,
  selector: { uid: string; recurrenceId?: string; scope?: CalendarMutationScope },
): CalendarEventDetails {
  const root = parseCalendarSource(source)
  const component = target(root, selector.uid, selector.recurrenceId, selector.scope)
  const item = event(component)
  if (!item.startDate) throw new Error('This cancellation has no event start time.')
  const master = masterOf(root, selector.uid)
  const recurring = Boolean(master && event(master).isRecurring())
  const organizer = component.getFirstProperty('organizer') ?? master?.getFirstProperty('organizer')
  const attendees = component.getAllProperties('attendee')
  return {
    uid: selector.uid,
    recurrenceId: idOf(component),
    summary: item.summary ?? '',
    start: calendarOutputTime(item.startDate),
    end: calendarOutputTime(item.endDate),
    localStart: item.startDate.toString().replace(/Z$/, ''),
    localEnd: calendarLocalEnd(item.startDate, item.endDate),
    timeZone: item.startDate.isDate ? 'date' : item.startDate.zone.tzid,
    allDay: item.startDate.isDate,
    floating: calendarIsFloating(item.startDate),
    description: item.description ?? '',
    location: item.location ?? '',
    recurring,
    recurrence:
      String(
        component.getFirstPropertyValue('rrule') ?? master?.getFirstPropertyValue('rrule') ?? '',
      ) || null,
    status: String(component.getFirstPropertyValue('status') ?? 'CONFIRMED'),
    sequence: Number(
      component.getFirstPropertyValue('sequence') ?? master?.getFirstPropertyValue('sequence') ?? 0,
    ),
    organizer: organizer ? calendarParticipant(organizer) : null,
    attendees: (attendees.length ? attendees : (master?.getAllProperties('attendee') ?? [])).map(
      calendarParticipant,
    ),
  }
}
function stamp(component: Component, bump: boolean, minimum = 0): void {
  if (bump)
    component.updatePropertyWithValue('sequence', Math.max(sequence(component), minimum) + 1)
  component.updatePropertyWithValue('dtstamp', now())
  component.updatePropertyWithValue('last-modified', now())
}
function applyPatch(component: Component, patch: CalendarEventPatch): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('An event patch must be an object.')
  const allowed = new Set([
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
  for (const name of Object.keys(patch))
    if (!allowed.has(name)) throw new Error(`Unsupported event patch field ${name}.`)
  const item = event(component)
  for (const name of ['summary', 'description', 'location'] as const)
    if (patch[name] !== undefined)
      component.updatePropertyWithValue(name, calendarText(patch[name], `Event ${name}`))
  if (
    patch.timeZone !== undefined &&
    patch.timeZone !== item.startDate.zone.tzid &&
    (!patch.start || !patch.end)
  )
    throw new Error('Changing the time zone requires both explicit start and end wall times.')
  const oldDuration = item.duration
  const oldDateKind = item.startDate.isDate
  const existingZone = item.startDate.zone
  const timeZone = patch.timeZone ?? (item.startDate.isDate ? undefined : item.startDate.zone.tzid)
  if (patch.start !== undefined) {
    item.startDate = calendarTimeFromInput(
      patch.start,
      patch.timeZone === undefined &&
        (patch.start.endsWith('Z') || /^\d{4}-\d{2}-\d{2}$/.test(patch.start))
        ? undefined
        : timeZone,
      patch.disambiguation,
      existingZone,
    )
    if (oldDateKind !== item.startDate.isDate && patch.end === undefined)
      throw new Error('Changing between all-day and timed events requires an explicit end.')
    if (patch.end === undefined) {
      const end = item.startDate.clone()
      end.addDuration(oldDuration)
      item.endDate = end
    }
  }
  if (patch.end !== undefined)
    item.endDate = calendarTimeFromInput(
      patch.end,
      patch.timeZone === undefined &&
        (patch.end.endsWith('Z') || /^\d{4}-\d{2}-\d{2}$/.test(patch.end))
        ? undefined
        : timeZone,
      patch.disambiguation,
      existingZone,
    )
  if (
    component.hasProperty('rrule') &&
    patch.start &&
    !patch.start.endsWith('Z') &&
    timeZone &&
    !['UTC', 'Etc/UTC', 'floating'].includes(timeZone) &&
    item.startDate.zone.tzid === 'UTC'
  )
    throw new Error(
      'A later-fold recurring start requires an explicit UTC series or a separate instance exception; the existing series was retained.',
    )
  if (
    item.startDate.isDate !== item.endDate.isDate ||
    calendarIsFloating(item.startDate) !== calendarIsFloating(item.endDate) ||
    calendarTimeEpoch(item.endDate) < calendarTimeEpoch(item.startDate)
  )
    throw new Error('Event start/end must use the same date/floating kind and an increasing range.')
  if (patch.recurrence !== undefined) {
    component.removeAllProperties('rrule')
    if (patch.recurrence !== null && patch.recurrence !== '')
      component.addPropertyWithValue(
        'rrule',
        ICAL.Recur.fromString(calendarText(patch.recurrence, 'Recurrence rule', 8192)),
      )
  }
  if (patch.organizer !== undefined) {
    if (patch.organizer === null) component.removeAllProperties('organizer')
    else {
      const address = normalizeCalendarAddress(patch.organizer.address)
      for (const p of component.getAllProperties('organizer'))
        if (!matches(String(p.getFirstValue()), address)) component.removeProperty(p)
      writeCalendarParticipant(component, 'organizer', patch.organizer)
    }
  }
  if (patch.attendees !== undefined) {
    if (!Array.isArray(patch.attendees) || patch.attendees.length > 256)
      throw new Error('At most 256 attendees are supported per event.')
    const addresses = patch.attendees.map((a) => normalizeCalendarAddress(a.address).toLowerCase())
    if (new Set(addresses).size !== addresses.length)
      throw new Error('Attendee calendar addresses must be unique.')
    for (const p of component.getAllProperties('attendee'))
      if (!addresses.includes(String(p.getFirstValue()).toLowerCase())) component.removeProperty(p)
    for (const attendee of patch.attendees)
      writeCalendarParticipant(component, 'attendee', attendee)
  }
  if (patch.status !== undefined) {
    if (!['TENTATIVE', 'CONFIRMED', 'CANCELLED'].includes(patch.status))
      throw new Error('Unsupported event status.')
    component.updatePropertyWithValue('status', patch.status)
  }
}
export interface CalendarSourceMutationResult {
  source: string
  uid: string
  recurrenceId: string | null
  messageSource: string
  method: 'REQUEST' | 'REPLY' | 'CANCEL'
  respondent?: string
  warnings: string[]
}
export function mutateCalendarSource(
  source: string,
  mutation: CalendarMutation,
): CalendarSourceMutationResult {
  if (
    !mutation ||
    typeof mutation !== 'object' ||
    Array.isArray(mutation) ||
    !['create', 'update', 'delete', 'respond'].includes(mutation.type)
  )
    throw new Error('Use a create, update, delete or respond calendar mutation.')
  const root = parseCalendarSource(source)
  root.removeAllProperties('method')
  let component: Component
  let uid: string
  let messageSource: string
  let method: CalendarSourceMutationResult['method'] = 'REQUEST'
  let respondent: string | undefined
  if (mutation.type === 'create') {
    uid = mutation.event.uid ?? randomUUID()
    if (events(root).some((c) => c.getFirstPropertyValue('uid') === uid))
      throw new Error('The event UID already exists in this calendar.')
    const created = parseCalendarSource(createCalendar([{ ...mutation.event, uid }]))
    component = clone(events(created)[0]!)
    root.addSubcomponent(component)
    for (const zone of created.getAllSubcomponents('vtimezone'))
      if (
        !root
          .getAllSubcomponents('vtimezone')
          .some((c) => c.getFirstPropertyValue('tzid') === zone.getFirstPropertyValue('tzid'))
      )
        root.addSubcomponent(clone(zone))
    stamp(component, false)
  } else {
    uid = mutation.uid
    const scope =
      mutation.type === 'respond'
        ? mutation.recurrenceId
          ? 'instance'
          : 'series'
        : (mutation.scope ?? (mutation.recurrenceId ? 'instance' : 'series'))
    component = target(root, uid, mutation.recurrenceId, scope)
    if (mutation.type === 'update') {
      const detachedCount = events(root).filter(
        (c) => c.getFirstPropertyValue('uid') === uid && c.hasProperty('recurrence-id'),
      ).length
      const before = event(component)
      const schedule = {
        start: calendarTimeEpoch(before.startDate),
        end: calendarTimeEpoch(before.endDate),
        zone: before.startDate.zone.tzid,
        date: before.startDate.isDate,
        rule: String(component.getFirstPropertyValue('rrule') ?? ''),
      }
      let patch = mutation.patch
      if (component.hasProperty('recurrence-id') && patch.recurrence !== undefined) {
        const masterRule = String(masterOf(root, uid)?.getFirstPropertyValue('rrule') ?? '')
        if ((patch.recurrence ?? '') !== masterRule)
          throw new Error(
            'An instance/future exception cannot replace the series recurrence rule; split or edit the master explicitly.',
          )
        const { recurrence: _recurrence, ...fields } = patch
        patch = fields
      }
      applyPatch(component, patch)
      const after = event(component)
      const ruleChanged = String(component.getFirstPropertyValue('rrule') ?? '') !== schedule.rule
      const zoneChanged = after.startDate.zone.tzid !== schedule.zone
      if (
        scope === 'series' &&
        detachedCount &&
        (calendarTimeEpoch(after.startDate) !== schedule.start ||
          calendarTimeEpoch(after.endDate) !== schedule.end ||
          after.startDate.isDate !== schedule.date ||
          zoneChanged ||
          ruleChanged)
      )
        throw new Error(
          'A series with detached exceptions requires an explicit series split before its schedule/rule can change; original exceptions were retained.',
        )
      if (scope === 'this-and-future' && (ruleChanged || zoneChanged))
        throw new Error(
          'THISANDFUTURE cannot change the recurrence rule or time zone; split the series explicitly.',
        )
      stamp(component, true, sequence(masterOf(root, uid) ?? component))
    } else if (mutation.type === 'delete') {
      component.updatePropertyWithValue('status', 'CANCELLED')
      stamp(component, true, sequence(masterOf(root, uid) ?? component))
      method = 'CANCEL'
      messageSource = serialize(root)
      if (scope === 'series')
        for (const item of events(root).filter((c) => c.getFirstPropertyValue('uid') === uid))
          root.removeSubcomponent(item)
      return {
        source: `${source.startsWith('\uFEFF') ? '\uFEFF' : ''}${serialize(root)}`,
        uid,
        recurrenceId: idOf(component),
        messageSource,
        method,
        warnings: [],
      }
    } else {
      respondent = normalizeCalendarAddress(mutation.attendee)
      const matching = component
        .getAllProperties('attendee')
        .filter((p) => matches(String(p.getFirstValue()), respondent!))
      if (matching.length !== 1)
        throw new Error('A response must select exactly one existing attendee.')
      writeCalendarParticipant(component, 'attendee', {
        address: respondent,
        participation: mutation.participation,
        rsvp: false,
      })
      if (!component.hasProperty('sequence'))
        component.updatePropertyWithValue('sequence', sequence(masterOf(root, uid) ?? component))
      if (mutation.comment !== undefined)
        component.updatePropertyWithValue(
          'comment',
          calendarText(mutation.comment, 'Response comment'),
        )
      stamp(component, false)
      method = 'REPLY'
    }
  }
  messageSource = serialize(root)
  return {
    source: `${source.startsWith('\uFEFF') ? '\uFEFF' : ''}${messageSource}`,
    uid,
    recurrenceId: idOf(component),
    messageSource,
    method,
    ...(respondent ? { respondent } : {}),
    warnings: [],
  }
}

export function createSchedulingMessage(
  source: string,
  input: {
    uid: string
    recurrenceId?: string | null
    method: CalendarSchedulingMethod
    respondent?: string
  },
): string {
  const original = parseCalendarSource(source)
  const component = events(original).find(
    (c) => c.getFirstPropertyValue('uid') === input.uid && idOf(c) === (input.recurrenceId ?? null),
  )
  if (!component) throw new Error('The scheduling message event does not exist.')
  const root = new ICAL.Component('vcalendar')
  for (const property of original.getAllProperties())
    if (property.name !== 'method')
      root.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(property.toJSON()))))
  root.addPropertyWithValue('method', input.method)
  for (const zone of original.getAllSubcomponents('vtimezone')) root.addSubcomponent(clone(zone))
  const outgoing = clone(component)
  if (input.method === 'REQUEST' || input.method === 'REPLY' || input.method === 'CANCEL') {
    if (!outgoing.getFirstPropertyValue('organizer'))
      throw new Error(`${input.method} requires an organizer calendar address.`)
    normalizeCalendarAddress(String(outgoing.getFirstPropertyValue('organizer')))
  }
  if (input.method === 'REQUEST' && !outgoing.getAllProperties('attendee').length)
    throw new Error('REQUEST requires at least one attendee.')
  if (input.method === 'PUBLISH') outgoing.removeAllProperties('attendee')
  if (input.method === 'REPLY') {
    if (!input.respondent) throw new Error('REPLY requires the responding attendee.')
    for (const property of outgoing.getAllProperties('attendee'))
      if (!matches(String(property.getFirstValue()), input.respondent))
        outgoing.removeProperty(property)
    if (outgoing.getAllProperties('attendee').length !== 1)
      throw new Error('REPLY requires exactly one existing attendee.')
    const allowed = new Set([
      'uid',
      'organizer',
      'attendee',
      'dtstamp',
      'sequence',
      'dtstart',
      'dtend',
      'duration',
      'recurrence-id',
      'comment',
      'request-status',
    ])
    for (const property of outgoing.getAllProperties())
      if (knownProperties.has(property.name) && !allowed.has(property.name))
        outgoing.removeProperty(property)
    for (const sub of outgoing.getAllSubcomponents()) outgoing.removeSubcomponent(sub)
  }
  if (input.method === 'CANCEL') {
    outgoing.updatePropertyWithValue('status', 'CANCELLED')
    const allowed = new Set([
      'uid',
      'organizer',
      'attendee',
      'dtstamp',
      'sequence',
      'recurrence-id',
      'comment',
      'summary',
      'status',
    ])
    for (const property of outgoing.getAllProperties())
      if (knownProperties.has(property.name) && !allowed.has(property.name))
        outgoing.removeProperty(property)
    for (const sub of outgoing.getAllSubcomponents()) outgoing.removeSubcomponent(sub)
  }
  outgoing.updatePropertyWithValue('dtstamp', now())
  outgoing.updatePropertyWithValue(
    'sequence',
    Number(
      component.getFirstPropertyValue('sequence') ??
        masterOf(original, input.uid)?.getFirstPropertyValue('sequence') ??
        0,
    ),
  )
  root.addSubcomponent(outgoing)
  const result = root.toString() + '\r\n'
  parseCalendarSource(result)
  return result
}

function mergeUnknown(previous: Component | undefined, incoming: Component): Component {
  const result = clone(incoming)
  if (!previous) return result
  for (const property of previous.getAllProperties())
    if (!knownProperties.has(property.name) && !result.hasProperty(property.name))
      result.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(property.toJSON()))))
  for (const subcomponent of previous.getAllSubcomponents())
    if (!result.getFirstSubcomponent(subcomponent.name)) result.addSubcomponent(clone(subcomponent))
  return result
}
function timestamp(component: Component): number {
  const value = component.getFirstPropertyValue('dtstamp') as CalendarTime | null
  if (!value || value.isDate || value.zone.tzid !== 'UTC')
    throw new Error('Scheduling messages require a UTC DTSTAMP.')
  return calendarTimeEpoch(value)
}
export function applyCalendarSchedulingMessage(
  source: string,
  incomingSource: string,
): { source: string; applied: number; ignored: number; warnings: string[] } {
  const root = parseCalendarSource(source),
    incoming = parseCalendarSource(incomingSource)
  const method = String(incoming.getFirstPropertyValue('method') ?? '')
  if (!['PUBLISH', 'REQUEST', 'REPLY', 'CANCEL'].includes(method))
    throw new Error(
      'Local scheduling supports PUBLISH, REQUEST, REPLY and CANCEL; other methods are retained by callers without being applied.',
    )
  if (!events(incoming).length) throw new Error('The scheduling message has no VEVENT.')
  let applied = 0,
    ignored = 0
  const warnings: string[] = []
  for (const item of events(incoming)) {
    const uid = String(item.getFirstPropertyValue('uid'))
    const rid = idOf(item)
    const master = masterOf(root, uid)
    let current = events(root).find(
      (c) => c.getFirstPropertyValue('uid') === uid && idOf(c) === rid,
    )
    const existing = current ?? master
    const storedSequence = Number(
      existing?.getFirstPropertyValue('sequence') ?? master?.getFirstPropertyValue('sequence') ?? 0,
    )
    const incomingStamp = timestamp(item)
    if (method !== 'PUBLISH') {
      const organizer = String(item.getFirstPropertyValue('organizer') ?? '')
      if (!organizer) throw new Error(`${method} requires ORGANIZER.`)
      normalizeCalendarAddress(organizer)
      const existingOrganizer = existing?.getFirstPropertyValue('organizer')
      if (existingOrganizer && !matches(String(existingOrganizer), organizer))
        throw new Error(
          'The scheduling organizer differs from the stored organizer; apply it only after an explicit ownership change.',
        )
    }
    if (method === 'REPLY') {
      if (!existing || sequence(item) !== storedSequence) {
        ignored++
        warnings.push('An unmatched or different-sequence attendee response was not applied.')
        continue
      }
      if (!current && rid && master) current = detached(root, uid, rid, 'instance')
      current ??= existing
      const attendees = item.getAllProperties('attendee')
      if (attendees.length !== 1)
        throw new Error('A local REPLY must contain exactly one attendee.')
      const reply = calendarParticipant(attendees[0]!)
      const attendee = current
        .getAllProperties('attendee')
        .find((p) => matches(String(p.getFirstValue()), reply.address))
      if (!attendee)
        throw new Error('An attendee response cannot add an uninvited calendar address.')
      const priorStamp = Number(attendee.getParameter('x-vantage-reply-epoch') ?? 0)
      if (incomingStamp <= priorStamp) {
        ignored++
        continue
      }
      if (!reply.participation) throw new Error('REPLY requires an attendee PARTSTAT.')
      writeCalendarParticipant(current, 'attendee', {
        address: reply.address,
        participation: reply.participation,
        rsvp: false,
      })
      attendee.setParameter('x-vantage-reply-epoch', String(incomingStamp))
      for (const property of item.getAllProperties())
        if (!knownProperties.has(property.name) && !current.hasProperty(property.name))
          current.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(property.toJSON()))))
      applied++
      continue
    }
    if (
      existing &&
      (sequence(item) < storedSequence ||
        (sequence(item) === storedSequence &&
          incomingStamp <= (existing.hasProperty('dtstamp') ? timestamp(existing) : 0)))
    ) {
      ignored++
      continue
    }
    if (method === 'REQUEST' && !item.getAllProperties('attendee').length)
      throw new Error('REQUEST requires an attendee.')
    let replacement: Component
    if (method === 'CANCEL') {
      if (!current && rid && master)
        current = detached(
          root,
          uid,
          rid,
          item.getFirstProperty('recurrence-id')?.getParameter('range') === 'THISANDFUTURE'
            ? 'this-and-future'
            : 'instance',
        )
      replacement = current ? clone(current) : clone(item)
      replacement.updatePropertyWithValue('status', 'CANCELLED')
      replacement.updatePropertyWithValue('sequence', sequence(item))
      replacement.updatePropertyWithValue('dtstamp', item.getFirstPropertyValue('dtstamp'))
      const recurrence = item.getFirstProperty('recurrence-id')
      if (recurrence) {
        replacement.removeAllProperties('recurrence-id')
        replacement.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(recurrence.toJSON()))))
      }
    } else {
      if (!item.getFirstPropertyValue('dtstart'))
        throw new Error('An event request/publication requires DTSTART.')
      if (
        current?.getFirstProperty('recurrence-id')?.getParameter('range') === 'THISANDFUTURE' &&
        item.getFirstProperty('recurrence-id')?.getParameter('range') !== 'THISANDFUTURE'
      )
        throw new Error(
          'A future-range boundary cannot be replaced by an individual instance without an explicit series split.',
        )
      replacement = mergeUnknown(current, item)
    }
    if (current) root.removeSubcomponent(current)
    root.addSubcomponent(replacement)
    applied++
  }
  if (!applied) return { source, applied, ignored, warnings }
  root.removeAllProperties('method')
  for (const zone of incoming.getAllSubcomponents('vtimezone'))
    if (
      !root
        .getAllSubcomponents('vtimezone')
        .some((c) => c.getFirstPropertyValue('tzid') === zone.getFirstPropertyValue('tzid'))
    )
      root.addSubcomponent(clone(zone))
  return {
    source: `${source.startsWith('\uFEFF') ? '\uFEFF' : ''}${serialize(root)}`,
    applied,
    ignored,
    warnings,
  }
}
