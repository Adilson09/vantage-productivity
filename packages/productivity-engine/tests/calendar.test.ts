import { describe, expect, it } from 'vitest'
import {
  createCalendar,
  expandCalendar,
  exportCalendar,
  exportContacts,
  inspectCalendar,
  parseContacts,
  updateCalendarEvent,
} from '../src/calendar'

const wrap = (...lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tests//EN', ...lines, 'END:VCALENDAR', ''].join(
    '\r\n',
  )
const event = (...lines: string[]): string =>
  ['BEGIN:VEVENT', 'UID:demo', ...lines, 'END:VEVENT'].join('\r\n')
const range = { start: '2026-10-29T00:00:00Z', end: '2026-11-03T00:00:00Z' }
const zone = [
  'BEGIN:VTIMEZONE',
  'TZID:America/Toronto',
  'BEGIN:STANDARD',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n')

describe('ICAL.js-backed local calendar', () => {
  it('accepts the whole-second ISO timestamps produced by the desktop event form', () => {
    const source = createCalendar([
      {
        summary: 'Desktop event',
        start: '2026-10-29T14:00:00.000Z',
        end: '2026-10-29T15:00:00.000Z',
      },
    ])
    expect(inspectCalendar(source).events[0]).toMatchObject({
      start: '2026-10-29T14:00:00.000Z',
      end: '2026-10-29T15:00:00.000Z',
    })
  })
  it('creates, opens, expands, edits and exports a recurring calendar', () => {
    const source = createCalendar([
      {
        uid: 'demo',
        summary: 'Planning',
        start: '2026-10-29T14:00:00Z',
        end: '2026-10-29T15:00:00Z',
        recurrence: 'FREQ=DAILY;COUNT=3',
      },
    ])
    expect(inspectCalendar(source).events[0]).toMatchObject({
      uid: 'demo',
      summary: 'Planning',
      recurring: true,
      timeZone: 'UTC',
    })
    expect(expandCalendar(source, range).occurrences.map((o) => o.start)).toEqual([
      '2026-10-29T14:00:00.000Z',
      '2026-10-30T14:00:00.000Z',
      '2026-10-31T14:00:00.000Z',
    ])
    const updated = updateCalendarEvent(source, 'demo', { summary: 'Changed', location: 'Room 2' })
    expect(expandCalendar(updated, range).occurrences[1]).toMatchObject({
      summary: 'Changed',
      location: 'Room 2',
    })
    expect(updated).toContain('RRULE:FREQ=DAILY;COUNT=3')
    expect(exportCalendar(source)).toBe(source)
  })

  it('expands local recurrence across daylight saving time using embedded zone rules', () => {
    const source = wrap(
      zone,
      event(
        'SUMMARY:Local meeting',
        'DTSTART;TZID=America/Toronto:20261031T090000',
        'DTEND;TZID=America/Toronto:20261031T100000',
        'RRULE:FREQ=DAILY;COUNT=3',
      ),
    )
    const result = expandCalendar(source, range)
    expect(result.occurrences.map((o) => o.start)).toEqual([
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ])
    expect(result.occurrences.map((o) => o.localStart)).toEqual([
      '2026-10-31T09:00:00',
      '2026-11-01T09:00:00',
      '2026-11-02T09:00:00',
    ])
  })

  it('handles excluded dates, added dates and moved occurrence exceptions', () => {
    const source = wrap(
      event(
        'DTSTART:20261029T140000Z',
        'DTEND:20261029T150000Z',
        'RRULE:FREQ=DAILY;COUNT=4',
        'EXDATE:20261030T140000Z',
        'RDATE:20261102T140000Z',
      ),
      event(
        'RECURRENCE-ID:20261031T140000Z',
        'SUMMARY:Moved',
        'DTSTART:20261031T180000Z',
        'DTEND:20261031T190000Z',
      ),
    )
    const occurrences = expandCalendar(source, range).occurrences
    expect(occurrences.map((o) => o.start)).toEqual([
      '2026-10-29T14:00:00.000Z',
      '2026-10-31T18:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ])
    expect(occurrences[1]).toMatchObject({ summary: 'Moved', recurrenceId: '2026-10-31T14:00:00Z' })
  })

  it('includes an exception moved into range from an original recurrence after the range', () => {
    const source = wrap(
      event('DTSTART:20261029T140000Z', 'DTEND:20261029T150000Z', 'RRULE:FREQ=DAILY;COUNT=20'),
      event(
        'RECURRENCE-ID:20261110T140000Z',
        'SUMMARY:Moved early',
        'DTSTART:20261030T180000Z',
        'DTEND:20261030T190000Z',
      ),
    )
    expect(expandCalendar(source, range).occurrences.some((o) => o.summary === 'Moved early')).toBe(
      true,
    )
  })

  it('omits cancelled exceptions with no DTSTART', () => {
    const source = wrap(
      event('DTSTART:20261029T140000Z', 'DTEND:20261029T150000Z', 'RRULE:FREQ=DAILY;COUNT=3'),
      event('RECURRENCE-ID:20261030T140000Z', 'STATUS:CANCELLED'),
    )
    expect(expandCalendar(source, range).occurrences.map((o) => o.start)).toEqual([
      '2026-10-29T14:00:00.000Z',
      '2026-10-31T14:00:00.000Z',
    ])
  })

  it('keeps all-day exclusive ends and floating wall times explicit', () => {
    const source = wrap(
      event('DTSTART;VALUE=DATE:20261029', 'DTEND;VALUE=DATE:20261031'),
      'BEGIN:VEVENT\r\nUID:floating\r\nDTSTART:20261030T090000\r\nDTEND:20261030T100000\r\nEND:VEVENT',
    )
    const result = expandCalendar(source, range)
    expect(result.occurrences[0]).toMatchObject({
      allDay: true,
      start: '2026-10-29',
      end: '2026-10-31',
      timeZone: 'date',
    })
    expect(result.occurrences[1]).toMatchObject({
      floating: true,
      start: '2026-10-30T09:00:00',
      timeZone: 'floating',
    })
    expect(result.warnings.join(' ')).toContain('no UTC instant')
  })

  it('does not convert an unknown zone into a false instant', () => {
    const source = wrap(
      event('DTSTART;TZID=Unknown/Zone:20261029T090000', 'DTEND;TZID=Unknown/Zone:20261029T100000'),
    )
    expect(() => inspectCalendar(source)).toThrow('VTIMEZONE')
    expect(
      inspectCalendar(
        wrap(event('DTSTART;TZID=Etc/UTC:20261029T090000', 'DTEND;TZID=Etc/UTC:20261029T100000')),
      ).events[0],
    ).toMatchObject({ start: '2026-10-29T09:00:00.000Z', timeZone: 'Etc/UTC' })
  })

  it('refuses limits as errors instead of silently returning a partial expansion', () => {
    const source = wrap(
      event('DTSTART:20261029T140000Z', 'DTEND:20261029T150000Z', 'RRULE:FREQ=DAILY;COUNT=100'),
    )
    expect(() => expandCalendar(source, { ...range, maxOccurrences: 1 })).toThrow(
      'Occurrence limit',
    )
    expect(() => expandCalendar(source, { ...range, maxIterations: 1 })).toThrow('iteration limit')
    expect(() => expandCalendar(source, { ...range, maxOccurrences: -1 })).toThrow('limits')
    expect(() => expandCalendar(source, { start: '2026-10-29', end: '2026-11-01' })).toThrow(
      'explicit UTC offset',
    )
  })

  it('refuses malformed, oversized, duplicate or unsupported recurring input', () => {
    expect(() => inspectCalendar('BEGIN:VCALENDAR\r\nVERSION:2.0')).toThrow('unbalanced')
    expect(() => inspectCalendar('x'.repeat(4 * 1024 * 1024 + 1))).toThrow('4 MiB')
    expect(() =>
      inspectCalendar(wrap(event('DTSTART:20261029T090000Z'), event('DTSTART:20261030T090000Z'))),
    ).toThrow('Duplicate')
    expect(() =>
      inspectCalendar(wrap(event('DTSTART:20261029T090000Z', 'RRULE:FREQ=INVALID'))),
    ).toThrow()
    expect(() =>
      inspectCalendar(wrap(event('DTSTART:20261029T100000Z', 'DTEND:20261029T090000Z'))),
    ).toThrow('before')
  })

  it('preserves unknown properties, alarms and attachments on export without executing them', () => {
    const source = wrap(
      event(
        'DTSTART:20261029T090000Z',
        'X-CUSTOM:retain this',
        'ATTACH:https://example.invalid/file',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT15M',
        'DESCRIPTION:Reminder',
        'END:VALARM',
      ),
    )
    expect(exportCalendar(source)).toBe(source)
    expect(updateCalendarEvent(source, 'demo', { summary: 'Edit' })).toContain(
      'X-CUSTOM:retain this',
    )
  })
})

describe('local vCard contacts', () => {
  it('round-trips multiple contacts, unicode, punctuation and multiple email/phone values', () => {
    const contacts = [
      {
        uid: 'one',
        name: 'Zoë, Example',
        emails: ['zoe@example.test', 'work@example.test'],
        phones: ['tel:+15550001'],
        organization: 'Studio; North',
      },
      { uid: 'two', name: 'Ada', emails: [], phones: [], organization: '' },
    ]
    expect(parseContacts(exportContacts(contacts)).contacts).toEqual(contacts)
  })
  it('imports vCard 3.0 and safely preserves contact text', () => {
    const source = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:c',
      'FN:Example',
      'ORG:Team;Office',
      'EMAIL;TYPE=WORK:hello@example.test',
      'END:VCARD',
      '',
    ].join('\r\n')
    expect(parseContacts(source).contacts[0]).toMatchObject({
      name: 'Example',
      organization: 'Team / Office',
      emails: ['hello@example.test'],
    })
  })
  it('supports an empty address book and rejects non-contact input', () => {
    expect(parseContacts(exportContacts([]))).toEqual({ contacts: [], warnings: [] })
    expect(() => parseContacts(wrap())).toThrow('VCARD')
  })
})
