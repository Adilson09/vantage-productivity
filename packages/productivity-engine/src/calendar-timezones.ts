import ICAL from 'ical.js'
import moment from 'moment-timezone'
import type { CalendarDisambiguation } from './calendar-types'

type Component = InstanceType<typeof ICAL.Component>
type CalendarTime = InstanceType<typeof ICAL.Time>
type CalendarZone = InstanceType<typeof ICAL.Timezone>
interface Transition {
  at: number
  before: number
  after: number
}
interface OffsetProvider {
  offsetAt(instant: number, year: number): number
  offsets(year: number): number[]
  transitions(year: number): Transition[]
}
export interface CalendarWallTimeResolution {
  instant: string
  offsetSeconds: number
  kind: 'unique' | 'ambiguous' | 'nonexistent'
  alternatives: string[]
}
export class CalendarTimeResolutionError extends Error {
  readonly code: 'CALENDAR_AMBIGUOUS_TIME' | 'CALENDAR_NONEXISTENT_TIME'
  constructor(
    readonly timeZone: string,
    readonly localTime: string,
    readonly resolution: CalendarWallTimeResolution,
  ) {
    super(
      `The local time ${localTime} is ${resolution.kind} in ${timeZone}; choose earlier or later explicitly.`,
    )
    this.name = 'CalendarTimeResolutionError'
    this.code =
      resolution.kind === 'ambiguous' ? 'CALENDAR_AMBIGUOUS_TIME' : 'CALENDAR_NONEXISTENT_TIME'
  }
}

const names = new Set(moment.tz.names())
const registered = new Map<string, CalendarZone>()
const providerByZone = new WeakMap<CalendarZone, OffsetProvider>()
const ianaProviders = new Map<string, OffsetProvider>()
export const calendarTimeZoneProvider = {
  name: 'moment-timezone',
  version: moment.tz.version,
  dataVersion: moment.tz.dataVersion,
  license: 'MIT',
  zoneCount: names.size,
  provenance: 'https://github.com/moment/moment-timezone',
} as const
export function listCalendarTimeZones(): string[] {
  return [...names].sort()
}
export function isIanaTimeZone(name: string): boolean {
  return names.has(name)
}

function utcDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  return date
}
export function calendarWallEpoch(
  time: Pick<CalendarTime, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>,
): number {
  return utcDate(time.year, time.month, time.day, time.hour, time.minute, time.second).getTime()
}
export function parseCalendarWallTime(value: string): CalendarTime {
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/.exec(value)
  if (!parts) throw new Error('Use a whole-second local date/time or YYYY-MM-DD date.')
  const [year, month, day, hour, minute, second] = parts.slice(1).map((part) => Number(part ?? 0))
  const date = utcDate(year!, month!, day!, hour!, minute!, second!)
  if (
    year! < 1 ||
    year! > 9999 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    throw new Error(
      'The calendar date/time is not a valid Gregorian date (leap seconds require explicit external handling).',
    )
  return ICAL.Time.fromString(value, undefined)
}
function localText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19)
}
function resolveWall(
  provider: OffsetProvider,
  local: CalendarTime,
  choice: CalendarDisambiguation,
): CalendarWallTimeResolution {
  const wall = calendarWallEpoch(local)
  const offsets = [...new Set(provider.offsets(local.year))]
  const candidates = offsets
    .map((offset) => ({ instant: wall - offset * 1000, offset }))
    .filter(({ instant, offset }) => provider.offsetAt(instant, local.year) === offset)
    .sort((a, b) => a.instant - b.instant)
  if (candidates.length) {
    const chosen = choice === 'later' ? candidates[candidates.length - 1]! : candidates[0]!
    return {
      instant: new Date(chosen.instant).toISOString(),
      offsetSeconds: chosen.offset,
      kind: candidates.length > 1 ? 'ambiguous' : 'unique',
      alternatives: candidates.map((c) => new Date(c.instant).toISOString()),
    }
  }
  for (const change of provider.transitions(local.year)) {
    const before = change.at + change.before * 1000
    const after = change.at + change.after * 1000
    if (after > before && wall >= before && wall < after) {
      const earlier = wall - change.after * 1000
      const later = wall - change.before * 1000
      const selected = choice === 'earlier' ? earlier : later
      return {
        instant: new Date(selected).toISOString(),
        offsetSeconds: (wall - selected) / 1000,
        kind: 'nonexistent',
        alternatives: [new Date(earlier).toISOString(), new Date(later).toISOString()],
      }
    }
  }
  throw new Error('The time-zone definition does not cover this local time.')
}

function ianaProvider(name: string): OffsetProvider {
  const cached = ianaProviders.get(name)
  if (cached) return cached
  if (!isIanaTimeZone(name))
    throw new Error(`Unknown IANA time zone ${name}; provide an embedded VTIMEZONE definition.`)
  const data = moment.tz.zone(name)!
  const transitions = data.untils
    .slice(0, -1)
    .map((at, index) => ({
      at,
      before: -Math.round(data.offsets[index]! * 60),
      after: -Math.round(data.offsets[index + 1]! * 60),
    }))
    .filter((t) => Number.isFinite(t.at))
  const offsets = [...new Set(data.offsets.map((v) => -Math.round(v * 60)))]
  const provider = {
    offsetAt: (at: number) => -Math.round(data.utcOffset(at) * 60),
    offsets: () => offsets,
    transitions: () => transitions,
  }
  ianaProviders.set(name, provider)
  return provider
}
function rawOffset(component: Component, name: string): number {
  const property = component.getFirstProperty(name)
  const value = property?.toJSON()[3]
  if (typeof value !== 'string' || !/^[+-]\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new Error('Invalid VTIMEZONE UTC offset.')
  const parts = value.slice(1).split(':').map(Number)
  if (parts[0]! > 23 || parts[1]! > 59 || (parts[2] ?? 0) > 59)
    throw new Error('Invalid VTIMEZONE UTC offset.')
  return (value[0] === '-' ? -1 : 1) * (parts[0]! * 3600 + parts[1]! * 60 + (parts[2] ?? 0))
}
function embeddedProvider(component: Component): OffsetProvider {
  let covered = 0
  let changes: Transition[] = []
  let offsets: number[] = []
  const ensure = (year: number): void => {
    if (covered >= year + 1) return
    const next: Transition[] = []
    let iterations = 0
    for (const observance of component.getAllSubcomponents()) {
      if (observance.name !== 'standard' && observance.name !== 'daylight')
        throw new Error('Unsupported VTIMEZONE observance component.')
      const start = observance.getFirstPropertyValue('dtstart') as CalendarTime | null
      if (!start || start.isDate || start.zone.tzid !== 'floating')
        throw new Error('VTIMEZONE observances require local DTSTART date-times.')
      const before = rawOffset(observance, 'tzoffsetfrom'),
        after = rawOffset(observance, 'tzoffsetto')
      const iterator = new ICAL.RecurExpansion({ component: observance, dtstart: start })
      let time: CalendarTime | null
      while ((time = iterator.next())) {
        if (++iterations > 20000) throw new Error('VTIMEZONE expansion exceeds 20,000 transitions.')
        next.push({ at: calendarWallEpoch(time) - before * 1000, before, after })
        if (time.year > year + 2) break
      }
    }
    next.sort((a, b) => a.at - b.at)
    if (!next.length) throw new Error('The VTIMEZONE definition has no usable observance.')
    for (let i = 1; i < next.length; i++)
      if (next[i]!.at === next[i - 1]!.at && next[i]!.after !== next[i - 1]!.after)
        throw new Error('Conflicting VTIMEZONE transitions.')
    changes = next.filter((t, i) => i === 0 || t.at !== next[i - 1]!.at)
    offsets = [...new Set(changes.flatMap((c) => [c.before, c.after]))]
    covered = year + 1
  }
  return {
    offsetAt(at, year) {
      ensure(year)
      let low = 0,
        high = changes.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (changes[mid]!.at <= at) low = mid + 1
        else high = mid
      }
      return low ? changes[low - 1]!.after : changes[0]!.before
    },
    offsets(year) {
      ensure(year)
      return offsets
    },
    transitions(year) {
      ensure(year)
      return changes
    },
  }
}
function makeZone(name: string, provider: OffsetProvider, component?: Component): CalendarZone {
  const zone = new ICAL.Timezone({ tzid: name, ...(component ? { component } : {}) })
  // ICAL's own offset class drops historical offset seconds. This adapter uses
  // provider transition seconds and RFC5545's first-fold/pre-gap interpretation.
  zone.utcOffset = (time: CalendarTime): number => {
    if (time.zone !== zone) return provider.offsetAt(calendarWallEpoch(time), time.year)
    return resolveWall(provider, time, 'compatible').offsetSeconds
  }
  providerByZone.set(zone, provider)
  return zone
}
export function ianaCalendarZone(name: string): CalendarZone {
  let zone = registered.get(name)
  if (!zone) {
    zone = makeZone(name, ianaProvider(name))
    registered.set(name, zone)
  }
  ICAL.TimezoneService.register(zone, name)
  return zone
}
export function resolveCalendarWallTime(
  local: string,
  timeZone: string,
  disambiguation: CalendarDisambiguation = 'reject',
): CalendarWallTimeResolution {
  if (!['reject', 'earlier', 'later', 'compatible'].includes(disambiguation))
    throw new Error('Unknown local-time disambiguation choice.')
  const time = parseCalendarWallTime(local)
  if (time.isDate)
    throw new Error('A time-zone resolution requires a date-time, not an all-day date.')
  const result = resolveWall(ianaProvider(timeZone), time, disambiguation)
  if (disambiguation === 'reject' && result.kind !== 'unique')
    throw new CalendarTimeResolutionError(timeZone, local, result)
  return result
}
export function calendarWallTimeKind(time: CalendarTime): CalendarWallTimeResolution['kind'] {
  const provider = providerByZone.get(time.zone)
  return !time.isDate && provider ? resolveWall(provider, time, 'compatible').kind : 'unique'
}
export function calendarTimeFromInput(
  value: string,
  timeZone?: string,
  disambiguation: CalendarDisambiguation = 'reject',
  existingZone?: CalendarZone,
): CalendarTime {
  if (!['reject', 'earlier', 'later', 'compatible'].includes(disambiguation))
    throw new Error('Unknown local-time disambiguation choice.')
  const normalized = value.replace(/\.000Z$/, 'Z')
  if (normalized.endsWith('Z')) {
    if (timeZone && timeZone !== 'UTC' && timeZone !== 'Etc/UTC')
      throw new Error(
        'Use a local wall time with an IANA time zone, or a UTC timestamp without a different time zone.',
      )
    const time = parseCalendarWallTime(normalized.slice(0, -1))
    if (time.isDate) throw new Error('UTC timestamps require a time of day.')
    time.zone = ICAL.Timezone.utcTimezone
    return time
  }
  const time = parseCalendarWallTime(normalized)
  if (time.isDate) {
    if (timeZone && timeZone !== 'date') throw new Error('All-day dates do not carry a time zone.')
    return time
  }
  if (!timeZone || timeZone === 'floating') return time
  const selectedZone = existingZone?.tzid === timeZone ? existingZone : ianaCalendarZone(timeZone)
  const provider = providerByZone.get(selectedZone)
  if (!provider) throw new Error('This timezone has no local calendar resolution provider.')
  const result = resolveWall(provider, time, disambiguation)
  if (disambiguation === 'reject' && result.kind !== 'unique')
    throw new CalendarTimeResolutionError(timeZone, normalized, result)
  if (result.kind === 'nonexistent') {
    const offset = provider.offsetAt(Date.parse(result.instant), time.year)
    const shifted = parseCalendarWallTime(localText(Date.parse(result.instant) + offset * 1000))
    shifted.zone = selectedZone
    return shifted
  }
  if (result.kind === 'ambiguous' && disambiguation === 'later') {
    // RFC5545 has no fold parameter. Preserve the selected later instant as UTC
    // rather than serializing an indistinguishable TZID local timestamp.
    return calendarTimeFromInput(result.instant)
  }
  time.zone = selectedZone
  return time
}

/** Attach per-document embedded definitions first; missing IANA zones use pinned tzdb. */
export function attachCalendarTimeZones(root: Component): void {
  const embedded = new Map<string, Component>()
  for (const component of root.getAllSubcomponents('vtimezone')) {
    const id = String(component.getFirstPropertyValue('tzid') ?? '')
    if (!id || embedded.has(id))
      throw new Error('VTIMEZONE identifiers must be present and unique.')
    embedded.set(id, component)
  }
  const documentZones = new Map<string, CalendarZone>()
  const getZone = (name: string): CalendarZone => {
    let zone = documentZones.get(name)
    if (!zone) {
      const definition = embedded.get(name)
      zone = definition
        ? makeZone(name, embeddedProvider(definition), definition)
        : ianaCalendarZone(name)
      documentZones.set(name, zone)
    }
    return zone
  }
  const visit = (component: Component): void => {
    if (component.name === 'vtimezone') return
    for (const property of component.getAllProperties()) {
      const name = property.getParameter('tzid')
      if (!name) continue
      const zone = getZone(String(name))
      for (const value of property.getValues()) {
        if (value instanceof ICAL.Time) value.zone = zone
        else if (value instanceof ICAL.Period) {
          value.start.zone = zone
          if (value.end) value.end.zone = zone
        }
      }
    }
    component.getAllSubcomponents().forEach(visit)
  }
  visit(root)
}

function offsetValue(seconds: number): string {
  const magnitude = Math.abs(seconds)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${seconds < 0 ? '-' : '+'}${pad(Math.floor(magnitude / 3600))}:${pad(Math.floor(magnitude / 60) % 60)}${magnitude % 60 ? `:${pad(magnitude % 60)}` : ''}`
}
/** Full published transition data, grouped by offset pair; not a machine-specific ICU projection. */
export function createIanaTimeZoneComponent(name: string): Component {
  const data = moment.tz.zone(name)
  if (!data || !isIanaTimeZone(name)) throw new Error('Unknown IANA time zone.')
  const root = new ICAL.Component('vtimezone')
  root.addPropertyWithValue('tzid', name)
  root.addPropertyWithValue('x-vantage-tzdb', moment.tz.dataVersion)
  const groups = new Map<string, { before: number; after: number; dates: string[] }>()
  for (let index = 0; index < data.untils.length - 1; index++) {
    const at = data.untils[index]!
    if (!Number.isFinite(at)) continue
    const before = -Math.round(data.offsets[index]! * 60),
      after = -Math.round(data.offsets[index + 1]! * 60)
    const date = localText(at + before * 1000)
    if (!/^\d{4}-/.test(date) || date < '0001-01-01T00:00:00') continue
    const key = `${before}/${after}`
    let group = groups.get(key)
    if (!group) {
      group = { before, after, dates: [] }
      groups.set(key, group)
    }
    group.dates.push(date)
  }
  const initial = -Math.round(data.offsets[0]! * 60)
  const baseline = new ICAL.Component('standard')
  baseline.addPropertyWithValue('dtstart', ICAL.Time.fromString('1600-01-01T00:00:00', undefined))
  baseline.addProperty(new ICAL.Property(['tzoffsetfrom', {}, 'utc-offset', offsetValue(initial)]))
  baseline.addProperty(new ICAL.Property(['tzoffsetto', {}, 'utc-offset', offsetValue(initial)]))
  root.addSubcomponent(baseline)
  for (const group of groups.values()) {
    const component = new ICAL.Component('standard')
    component.addPropertyWithValue('dtstart', ICAL.Time.fromString(group.dates[0]!, undefined))
    component.addProperty(
      new ICAL.Property(['tzoffsetfrom', {}, 'utc-offset', offsetValue(group.before)]),
    )
    component.addProperty(
      new ICAL.Property(['tzoffsetto', {}, 'utc-offset', offsetValue(group.after)]),
    )
    for (const date of group.dates)
      component.addPropertyWithValue('rdate', ICAL.Time.fromString(date, undefined))
    root.addSubcomponent(component)
  }
  return root
}
