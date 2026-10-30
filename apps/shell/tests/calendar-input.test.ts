import { describe, expect, it } from 'vitest'
import { calendarAgendaQuery, calendarId, calendarMutation, calendarMutationOptions, calendarName, calendarRevision, calendarSelector } from '../src/main/calendar-input'

const id = '4ac91de1-2e89-4dd0-a3b2-44c8d9bf02af'
describe('calendar IPC data boundaries', () => {
  it('keeps revision fencing and selected recurrence scope explicit', () => {
    expect(calendarId(id)).toBe(id)
    expect(calendarRevision(7)).toBe(7)
    expect(calendarSelector({ uid: 'meeting@example.test', recurrenceId: '2026-11-01T01:30:00', scope: 'this-and-future' })).toEqual({ uid: 'meeting@example.test', recurrenceId: '2026-11-01T01:30:00', scope: 'this-and-future' })
    expect(calendarMutationOptions({ expectedRevision: 7, queueMethod: 'REPLY' })).toEqual({ expectedRevision: 7, queueMethod: 'REPLY' })
  })
  it.each([undefined, null, NaN, Infinity, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1])('refuses an unusable expected revision %s', (revision) => {
    expect(() => calendarRevision(revision)).toThrow(/Reload/)
  })
  it('does not turn paths, whitespace or oversized values into storage identifiers', () => {
    expect(() => calendarId('../../private.sqlite3')).toThrow()
    expect(() => calendarId(`${id}\n`)).toThrow()
    expect(() => calendarName(' \t ')).toThrow()
    expect(() => calendarName('x'.repeat(129))).toThrow()
    expect(calendarName('  Work and family  ')).toBe('Work and family')
  })
  it('accepts rich local edits without accepting remote delivery credentials or transport functions', () => {
    const mutation = { type: 'create', event: { summary: 'Planning', start: '2026-11-01T01:30:00', end: '2026-11-01T02:30:00', timeZone: 'America/Toronto', disambiguation: 'earlier', organizer: { address: 'organizer@example.test' }, attendees: [{ address: 'guest@example.test', participation: 'NEEDS-ACTION', rsvp: true }], description: 'First line\nSecond line' } }
    expect(calendarMutation(mutation)).toEqual(mutation)
    expect(() => calendarMutation({ ...mutation, token: 'not-a-provider-token' })).toThrow(/unsupported field/)
    expect(() => calendarMutationOptions({ expectedRevision: 7, transport: { kind: 'provider' } })).toThrow(/unsupported field/)
  })
  it('rejects boxed enum values and prototype fields instead of coercing them', () => {
    expect(() => calendarSelector({ uid: 'x', scope: new String('series') })).toThrow()
    expect(() => calendarMutationOptions({ expectedRevision: 0, queueMethod: new String('REQUEST') })).toThrow()
    expect(() => calendarMutation(JSON.parse('{"type":"update","uid":"x","patch":{"__proto__":{"polluted":true}}}'))).toThrow(/unsupported field/)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
  it('bounds the encoded edit, including multibyte text and participant arrays', () => {
    const event = { summary: '界'.repeat(4096), start: '2027-01-01', end: '2027-01-02', location: '界'.repeat(4096), description: '界'.repeat(16384) }
    expect(() => calendarMutation({ type: 'create', event })).toThrow(/64 KiB/)
    expect(() => calendarMutation({ type: 'update', uid: 'x', patch: { attendees: Array.from({ length: 257 }, () => ({ address: 'a@example.test' })) } })).toThrow(/256/)
  })
  it('keeps invalid responses and multiline addresses out of scheduling changes', () => {
    expect(() => calendarMutation({ type: 'respond', uid: 'x', attendee: 'a@example.test\nATTENDEE:other', participation: 'ACCEPTED' })).toThrow()
    expect(() => calendarMutation({ type: 'respond', uid: 'x', attendee: 'a@example.test', participation: 'SENT' })).toThrow()
    expect(calendarMutation({ type: 'respond', uid: 'x', attendee: 'a@example.test', participation: 'TENTATIVE' })).toMatchObject({ participation: 'TENTATIVE' })
  })
  it('bounds agenda work before opening the store or spawning an operation', () => {
    const value = { calendarId: id, start: '2026-11-01T04:00:00.000Z', end: '2026-12-01T05:00:00.000Z', viewTimeZone: 'America/Toronto' }
    expect(calendarAgendaQuery(value)).toEqual(value)
    expect(() => calendarAgendaQuery({ ...value, end: '2030-01-01T00:00:00Z' })).toThrow(/366 days/)
    expect(() => calendarAgendaQuery({ ...value, start: '2026-11-01T00:00:00' })).toThrow(/time offset/)
    expect(() => calendarAgendaQuery({ ...value, maxIterations: Number.MAX_SAFE_INTEGER })).toThrow(/unsupported field/)
  })
})
