import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from './helpers'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vantage-productivity-cli-'))
})
afterEach(() => {
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + '\\vantage-productivity-cli-') &&
    !resolve(directory).startsWith(resolve(tmpdir()) + '/vantage-productivity-cli-')
  )
    throw new Error('Unsafe temporary path.')
  rmSync(directory, { recursive: true, force: true })
})

describe('calendar, contacts and database CLI workflows', () => {
  it('creates, expands, edits and preserves a real iCalendar file', async () => {
    const events = join(directory, 'events.json'),
      calendar = join(directory, 'calendar.ics'),
      edited = join(directory, 'edited.ics')
    writeFileSync(
      events,
      JSON.stringify([
        {
          uid: 'event',
          summary: 'Planning',
          start: '2026-10-29T14:00:00Z',
          end: '2026-10-29T15:00:00Z',
          recurrence: 'FREQ=DAILY;COUNT=3',
        },
      ]),
    )
    expect((await run(['calendar', 'create', events, '--out', calendar, '--json'])).code).toBe(0)
    const expansion = await run([
      'calendar',
      'expand',
      calendar,
      '--start',
      '2026-10-29T00:00:00Z',
      '--end',
      '2026-11-02T00:00:00Z',
      '--json',
    ])
    expect(expansion.code).toBe(0)
    expect(expansion.json().detail.occurrences).toHaveLength(3)
    expect(
      (
        await run([
          'calendar',
          'update',
          calendar,
          '--uid',
          'event',
          '--summary',
          'Changed',
          '--out',
          edited,
          '--json',
        ])
      ).code,
    ).toBe(0)
    expect(readFileSync(edited, 'utf8')).toContain('SUMMARY:Changed')
    expect(readFileSync(calendar, 'utf8')).toContain('SUMMARY:Planning')
  })

  it('exports and reads contact cards', async () => {
    const json = join(directory, 'contacts.json'),
      card = join(directory, 'contacts.vcf')
    writeFileSync(
      json,
      JSON.stringify([
        { uid: 'id', name: 'Ada', emails: ['ada@example.test'], phones: [], organization: 'Team' },
      ]),
    )
    expect((await run(['contacts', 'export', json, '--out', card, '--json'])).code).toBe(0)
    const result = await run(['contacts', 'read', card, '--json'])
    expect(result.code).toBe(0)
    expect(result.json().detail.contacts[0]).toMatchObject({
      name: 'Ada',
      emails: ['ada@example.test'],
    })
  })

  it('creates tables, inserts records, executes an isolated aggregate and exports an escaped report', async () => {
    const schema = join(directory, 'schema.json'),
      rows = join(directory, 'rows.json'),
      db = join(directory, 'sales.vdb'),
      report = join(directory, 'report.html')
    writeFileSync(
      schema,
      JSON.stringify([
        {
          name: 'Sales',
          columns: [
            { name: 'Customer', type: 'TEXT', required: true },
            { name: 'Amount', type: 'REAL' },
          ],
        },
      ]),
    )
    writeFileSync(
      rows,
      JSON.stringify([
        { Customer: '<script>unsafe</script>', Amount: 10 },
        { Customer: 'Ada', Amount: 20 },
      ]),
    )
    expect((await run(['database', 'create', db, '--schema', schema, '--json'])).code).toBe(0)
    expect(
      (await run(['database', 'insert', db, '--table', 'Sales', '--rows', rows, '--json'])).code,
    ).toBe(0)
    const result = await run([
      'database',
      'query',
      db,
      '--sql',
      'SELECT SUM(Amount) AS total FROM Sales',
      '--json',
    ])
    expect(result.code).toBe(0)
    expect(result.json().detail.rows).toEqual([{ total: 30 }])
    expect(
      (
        await run([
          'database',
          'report',
          db,
          '--sql',
          'SELECT Customer,Amount FROM Sales',
          '--out',
          report,
          '--json',
        ])
      ).code,
    ).toBe(0)
    expect(readFileSync(report, 'utf8')).toContain('&lt;script&gt;unsafe&lt;/script&gt;')
  })

  it('refuses existing calendar outputs and writes outside allowed roots', async () => {
    const events = join(directory, 'events.json'),
      calendar = join(directory, 'calendar.ics')
    writeFileSync(events, '[]')
    writeFileSync(calendar, 'keep')
    expect((await run(['calendar', 'create', events, '--out', calendar, '--json'])).code).not.toBe(
      0,
    )
    expect(readFileSync(calendar, 'utf8')).toBe('keep')
    const result = await run(['calendar', 'read', calendar, '--json'], {
      env: { ...process.env, VANTAGE_ALLOWED_ROOTS: join(directory, 'restricted') },
    })
    expect(result.code).not.toBe(0)
    expect(result.json().message).toContain('outside')
  })
})
