import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCalendar } from '../../productivity-engine/src/calendar'
import { run } from './helpers'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vantage-calendar-cli-'))
})
afterEach(() => {
  if (!resolve(directory).startsWith(resolve(tmpdir())))
    throw new Error('Unsafe calendar CLI temporary directory.')
  rmSync(directory, { recursive: true, force: true })
})
const meeting = {
  uid: 'planning',
  summary: 'Planning',
  start: '2026-10-29T09:00:00',
  end: '2026-10-29T10:00:00',
  timeZone: 'America/Toronto',
  recurrence: 'FREQ=DAILY;COUNT=3',
  organizer: { address: 'organizer@example.test' },
  attendees: [{ address: 'alice@example.test' }],
}

describe('persistent calendar CLI and local scheduling workflow', () => {
  it('reports the actual pinned timezone provider without opening a file', async () => {
    const result = await run(['calendar', 'zones', '--json'])
    expect(result.code).toBe(0)
    expect(result.json().detail.provider).toMatchObject({
      version: '0.6.6',
      dataVersion: '2026f',
      zoneCount: 597,
    })
  })
  it('creates a persistent calendar, queues an invitation, reads the agenda/details and exports only to a local test folder', async () => {
    const store = join(directory, 'calendar.sqlite'),
      mutation = join(directory, 'create.json'),
      exported = join(directory, 'calendar.ics'),
      local = join(directory, 'local-test')
    const created = await run([
      'calendar',
      'workspace-create',
      store,
      '--name',
      'Planning',
      '--json',
    ])
    expect(created.code).toBe(0)
    const calendar = String(created.json().detail.calendar.id)
    writeFileSync(mutation, JSON.stringify({ type: 'create', event: meeting }))
    const changed = await run([
      'calendar',
      'workspace-mutate',
      store,
      '--calendar',
      calendar,
      '--revision',
      '1',
      '--mutation',
      mutation,
      '--queue-method',
      'REQUEST',
      '--json',
    ])
    expect(changed.code).toBe(0)
    expect(changed.json().detail.calendar).not.toHaveProperty('source')
    const agenda = await run([
      'calendar',
      'agenda',
      store,
      '--calendar',
      calendar,
      '--start',
      '2026-10-28T00:00:00Z',
      '--end',
      '2026-11-03T00:00:00Z',
      '--view-time-zone',
      'America/Toronto',
      '--limit',
      '20',
      '--deadline',
      '2000',
      '--json',
    ])
    expect(agenda.code).toBe(0)
    expect(agenda.json().detail.occurrences).toHaveLength(3)
    const details = await run([
      'calendar',
      'event',
      store,
      '--calendar',
      calendar,
      '--uid',
      'planning',
      '--json',
    ])
    expect(details.code).toBe(0)
    expect(details.json().detail.event).toMatchObject({
      summary: 'Planning',
      recurring: true,
      timeZone: 'America/Toronto',
    })
    expect(
      (
        await run([
          'calendar',
          'workspace-export',
          store,
          '--calendar',
          calendar,
          '--revision',
          '2',
          '--out',
          exported,
          '--json',
        ])
      ).code,
    ).toBe(0)
    expect(readFileSync(exported, 'utf8')).toContain('TZID:America/Toronto')
    const outbox = await run(['calendar', 'outbox', store, '--state', 'pending', '--json'])
    expect(outbox.json().detail.items).toHaveLength(1)
    expect(outbox.json().detail.items[0]).not.toHaveProperty('source')
    const test = await run([
      'calendar',
      'outbox-test',
      store,
      '--out',
      local,
      '--limit',
      '1',
      '--json',
    ])
    expect(test.code).toBe(0)
    expect(test.json().detail).toMatchObject({ delivered: 1, failed: 0 })
    expect(test.json().summary).toContain('no provider sends')
    expect(readdirSync(local)).toHaveLength(1)
    expect(readFileSync(join(local, readdirSync(local)[0]!), 'utf8')).toContain('METHOD:REQUEST')
  })
  it('imports and exports BOM bytes unchanged while retaining the imported origin', async () => {
    const store = join(directory, 'import.sqlite'),
      source = join(directory, 'original.ics'),
      copy = join(directory, 'copy.ics')
    const bytes =
      '\uFEFF' + createCalendar([{ summary: 'Source', start: '2026-10-29', end: '2026-10-30' }])
    writeFileSync(source, bytes)
    expect((await run(['calendar', 'workspace-create', store, '--json'])).code).toBe(0)
    const imported = await run([
      'calendar',
      'workspace-import',
      store,
      '--ics',
      source,
      '--name',
      'Imported',
      '--json',
    ])
    expect(imported.code).toBe(0)
    const id = String(imported.json().detail.calendar.id)
    const saved = await run([
      'calendar',
      'workspace-export',
      store,
      '--calendar',
      id,
      '--revision',
      '1',
      '--out',
      copy,
      '--json',
    ])
    expect(saved.code).toBe(0)
    expect(saved.json().detail.originPath).toBe(resolve(source))
    expect(readFileSync(copy)).toEqual(readFileSync(source))
  })
  it('refuses a stale revision and existing output without an explicit matching fingerprint', async () => {
    const store = join(directory, 'guard.sqlite'),
      mutation = join(directory, 'create.json'),
      output = join(directory, 'keep.ics')
    const created = await run(['calendar', 'workspace-create', store, '--json']),
      id = String(created.json().detail.calendar.id)
    writeFileSync(mutation, JSON.stringify({ type: 'create', event: meeting }))
    expect(
      (
        await run([
          'calendar',
          'workspace-mutate',
          store,
          '--calendar',
          id,
          '--revision',
          '1',
          '--mutation',
          mutation,
          '--json',
        ])
      ).code,
    ).toBe(0)
    const stale = await run([
      'calendar',
      'workspace-rename',
      store,
      '--calendar',
      id,
      '--revision',
      '1',
      '--name',
      'Stale',
      '--json',
    ])
    expect(stale.code).not.toBe(0)
    expect(stale.json().message).toContain('changed')
    writeFileSync(output, 'keep external copy')
    expect(
      (
        await run([
          'calendar',
          'workspace-export',
          store,
          '--calendar',
          id,
          '--revision',
          '2',
          '--out',
          output,
          '--json',
        ])
      ).code,
    ).not.toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('keep external copy')
  })
})
