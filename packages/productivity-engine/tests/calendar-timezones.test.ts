import { describe, expect, it } from 'vitest'
import { createCalendar, expandCalendar, exportCalendar, inspectCalendar } from '../src/calendar'
import {
  calendarTimeZoneProvider,
  listCalendarTimeZones,
  resolveCalendarWallTime,
} from '../src/calendar-timezones'

const wrap = (...lines: string[]): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zone tests//EN',
    ...lines,
    'END:VCALENDAR',
    '',
  ].join('\r\n')
const event = (...lines: string[]): string =>
  ['BEGIN:VEVENT', 'UID:zone-test', ...lines, 'END:VEVENT'].join('\r\n')
const range = { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' }

describe('pinned full IANA timezone data', () => {
  it('records the actual pinned provider and resolves every published zone and alias in both seasons', () => {
    expect(calendarTimeZoneProvider).toMatchObject({
      name: 'moment-timezone',
      version: '0.6.6',
      dataVersion: '2026f',
      zoneCount: 597,
      license: 'MIT',
    })
    for (const zone of listCalendarTimeZones())
      for (const date of ['2026-01-15T12:00:00', '2026-07-15T12:00:00']) {
        const result = resolveCalendarWallTime(date, zone, 'compatible')
        expect(Number.isFinite(Date.parse(result.instant)), zone).toBe(true)
        expect(result.kind, zone).toBe('unique')
      }
  }, 20000)
  it.each([
    ['Asia/Kathmandu', '2026-01-15T09:00:00', '2026-01-15T03:15:00.000Z'],
    ['Pacific/Chatham', '2026-01-15T09:00:00', '2026-01-14T19:15:00.000Z'],
    ['Etc/GMT+5', '2026-01-15T09:00:00', '2026-01-15T14:00:00.000Z'],
    ['Europe/Dublin', '2026-01-15T09:00:00', '2026-01-15T09:00:00.000Z'],
    ['Europe/Dublin', '2026-07-15T09:00:00', '2026-07-15T08:00:00.000Z'],
    ['US/Eastern', '2026-07-15T09:00:00', '2026-07-15T13:00:00.000Z'],
    ['America/New_York', '1880-01-15T12:00:00', '1880-01-15T16:56:02.000Z'],
  ])('converts independent numeric reference %s %s', (zone, wall, expected) => {
    expect(resolveCalendarWallTime(wall, zone).instant).toBe(expected)
  })
  it('requires a choice for a repeated Toronto wall time and offers both real instants', () => {
    expect(() => resolveCalendarWallTime('2026-11-01T01:30:00', 'America/Toronto')).toThrow(
      'ambiguous',
    )
    expect(
      resolveCalendarWallTime('2026-11-01T01:30:00', 'America/Toronto', 'earlier'),
    ).toMatchObject({ instant: '2026-11-01T05:30:00.000Z', kind: 'ambiguous' })
    expect(resolveCalendarWallTime('2026-11-01T01:30:00', 'America/Toronto', 'later').instant).toBe(
      '2026-11-01T06:30:00.000Z',
    )
  })
  it('rejects a gap for interactive editing, with explicit earlier/later and RFC import interpretation', () => {
    expect(() => resolveCalendarWallTime('2026-03-08T02:30:00', 'America/Toronto')).toThrow(
      'nonexistent',
    )
    expect(
      resolveCalendarWallTime('2026-03-08T02:30:00', 'America/Toronto', 'earlier').instant,
    ).toBe('2026-03-08T06:30:00.000Z')
    expect(
      resolveCalendarWallTime('2026-03-08T02:30:00', 'America/Toronto', 'compatible').instant,
    ).toBe('2026-03-08T07:30:00.000Z')
    const source = wrap(
      event(
        'DTSTART;TZID=America/Toronto:20260308T023000',
        'DTEND;TZID=America/Toronto:20260308T043000',
      ),
    )
    expect(inspectCalendar(source).events[0]!.start).toBe('2026-03-08T07:30:00.000Z')
  })
  it('handles half-hour transitions and a skipped civil day', () => {
    expect(
      resolveCalendarWallTime('2026-04-05T01:45:00', 'Australia/Lord_Howe', 'earlier').instant,
    ).toBe('2026-04-04T14:45:00.000Z')
    expect(
      resolveCalendarWallTime('2026-04-05T01:45:00', 'Australia/Lord_Howe', 'later').instant,
    ).toBe('2026-04-04T15:15:00.000Z')
    expect(
      resolveCalendarWallTime('2026-10-04T02:15:00', 'Australia/Lord_Howe', 'compatible').instant,
    ).toBe('2026-10-03T15:45:00.000Z')
    expect(
      resolveCalendarWallTime('2011-12-30T12:00:00', 'Pacific/Apia', 'compatible').instant,
    ).toBe('2011-12-30T22:00:00.000Z')
  })
  it('creates a zone-aware series with real VTIMEZONE data and reopens across DST', () => {
    const source = createCalendar([
      {
        uid: 'series',
        summary: 'Morning',
        start: '2026-10-31T09:00:00',
        end: '2026-10-31T10:00:00',
        timeZone: 'America/Toronto',
        recurrence: 'FREQ=DAILY;COUNT=3',
      },
    ])
    expect(source).toContain('BEGIN:VTIMEZONE')
    expect(source).toContain('X-VANTAGE-TZDB:2026f')
    expect(
      expandCalendar(source, {
        start: '2026-10-30T00:00:00Z',
        end: '2026-11-04T00:00:00Z',
      }).occurrences.map((o) => o.start),
    ).toEqual(['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z'])
    expect(exportCalendar(source)).toBe(source)
  })
  it('uses first-fold RFC interpretation for imported local time', () => {
    const source = wrap(
      event(
        'DTSTART;TZID=America/Toronto:20261101T013000',
        'DTEND;TZID=America/Toronto:20261101T023000',
      ),
    )
    expect(inspectCalendar(source).events[0]!.start).toBe('2026-11-01T05:30:00.000Z')
  })
  it('preserves a later-fold choice as an unambiguous UTC instant', () => {
    const source = createCalendar([
      {
        summary: 'Later fold',
        start: '2026-11-01T01:30:00',
        end: '2026-11-01T02:30:00',
        timeZone: 'America/Toronto',
        disambiguation: 'later',
      },
    ])
    expect(inspectCalendar(source).events[0]!.start).toBe('2026-11-01T06:30:00.000Z')
  })
  it('preserves an imported BOM and all unknown bytes on unchanged export', () => {
    const source =
      '\uFEFF' +
      wrap(
        'X-ROOT;X-KEEP=yes:opaque',
        event('DTSTART;TZID=Asia/Kathmandu:20260115T090000', 'X-CUSTOM:retain'),
      )
    expect(exportCalendar(source)).toBe(source)
  })
  it('filters floating and all-day values in the chosen display zone without inventing UTC instants', () => {
    const source = wrap(
      event('DTSTART:20261030T003000', 'DTEND:20261030T010000'),
      'BEGIN:VEVENT\r\nUID:all-day\r\nDTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261031\r\nEND:VEVENT',
    )
    const result = expandCalendar(source, {
      start: '2026-10-30T04:00:00Z',
      end: '2026-10-31T04:00:00Z',
      viewTimeZone: 'America/Toronto',
    })
    expect(result.occurrences).toHaveLength(2)
    expect(result.occurrences.find((o) => o.uid === 'zone-test')).toMatchObject({
      floating: true,
      localStart: '2026-10-30T00:30:00',
      start: '2026-10-30T00:30:00',
    })
  })
  it('supports secondly, minutely and hourly recurrence under explicit limits', () => {
    for (const frequency of ['SECONDLY', 'MINUTELY', 'HOURLY']) {
      const source = wrap(event('DTSTART:20260101T090000Z', `RRULE:FREQ=${frequency};COUNT=3`))
      expect(expandCalendar(source, range).occurrences).toHaveLength(3)
    }
  })
  it('skips rule-generated nonexistent times without consuming COUNT', () => {
    const source = createCalendar([
      {
        summary: 'Before the gap',
        start: '2026-03-07T02:30:00',
        end: '2026-03-07T03:30:00',
        timeZone: 'America/Toronto',
        recurrence: 'FREQ=DAILY;COUNT=3',
      },
    ])
    expect(
      expandCalendar(source, {
        start: '2026-03-06T00:00:00Z',
        end: '2026-03-12T00:00:00Z',
      }).occurrences.map((o) => o.localStart),
    ).toEqual(['2026-03-07T02:30:00', '2026-03-09T02:30:00', '2026-03-10T02:30:00'])
  })
  it('retains explicit RDATE PERIOD duration instead of replacing it with the master duration', () => {
    const source = wrap(
      event(
        'DTSTART:20260115T090000Z',
        'DTEND:20260115T100000Z',
        'RDATE;VALUE=PERIOD:20260116T090000Z/PT3H',
      ),
    )
    const result = expandCalendar(source, range).occurrences
    expect(result.map((o) => [o.start, o.end])).toEqual([
      ['2026-01-15T09:00:00.000Z', '2026-01-15T10:00:00.000Z'],
      ['2026-01-16T09:00:00.000Z', '2026-01-16T12:00:00.000Z'],
    ])
  })
  it('preserves historical offset seconds after generated VTIMEZONE export and reopen', () => {
    const source = createCalendar([
      {
        summary: 'Historical offset',
        start: '1880-01-15T12:00:00',
        end: '1880-01-15T13:00:00',
        timeZone: 'America/New_York',
      },
    ])
    expect(inspectCalendar(source).events[0]!.start).toBe('1880-01-15T16:56:02.000Z')
  })
  it('respects an embedded definition over IANA without contaminating a later document', () => {
    const custom = [
      'BEGIN:VTIMEZONE',
      'TZID:America/Toronto',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0900',
      'TZOFFSETTO:+0900',
      'END:STANDARD',
      'END:VTIMEZONE',
    ].join('\r\n')
    const body = event('DTSTART;TZID=America/Toronto:20260115T090000')
    expect(inspectCalendar(wrap(custom, body)).events[0]!.start).toBe('2026-01-15T00:00:00.000Z')
    expect(inspectCalendar(wrap(body)).events[0]!.start).toBe('2026-01-15T14:00:00.000Z')
  })
  it('refuses malformed Gregorian input and unknown zones without changing source', () => {
    expect(() => resolveCalendarWallTime('2026-02-30T09:00:00', 'America/Toronto')).toThrow(
      'Gregorian',
    )
    expect(() => inspectCalendar(wrap(event('DTSTART:20260230T090000Z')))).toThrow('Gregorian')
    expect(() => resolveCalendarWallTime('2026-01-15T09:00:00', 'Unknown/Zone')).toThrow(
      'Unknown IANA',
    )
  })
})
