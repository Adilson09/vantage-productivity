import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { queryDatabaseIsolated } from '../src/database-isolated'
import { queryToCsv, RecordConflictError, VantageDatabase } from '../src/database'

let directory: string
let path: string
let handles: VantageDatabase[]
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vantage-data-'))
  path = join(directory, 'records.vdb')
  handles = []
})
afterEach(() => {
  for (const db of handles) db.close()
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + '\\vantage-data-') &&
    !resolve(directory).startsWith(resolve(tmpdir()) + '/vantage-data-')
  )
    throw new Error('Unsafe temporary path.')
  rmSync(directory, { recursive: true, force: true })
})
function make(): VantageDatabase {
  const db = new VantageDatabase(path, { create: true })
  handles.push(db)
  db.createTable({
    name: 'Sales',
    columns: [
      { name: 'Customer', type: 'TEXT', required: true },
      { name: 'Amount', type: 'REAL' },
      { name: 'Units', type: 'INTEGER' },
    ],
  })
  return db
}

describe('local database records, queries, forms and reports', () => {
  it('persists real SQLite data and reopens the Vantage file', () => {
    const db = make()
    expect(db.insert('Sales', [{ Customer: 'Ada', Amount: 15.5, Units: 2 }])).toEqual([1])
    db.close()
    const reopened = new VantageDatabase(path)
    handles.push(reopened)
    expect(reopened.tables()[0]?.name).toBe('Sales')
    expect(reopened.query('SELECT * FROM Sales').rows[0]).toMatchObject({
      Customer: 'Ada',
      Amount: 15.5,
      Units: 2,
      _version: 1,
    })
    expect(readFileSync(path).subarray(0, 15).toString()).toBe('SQLite format 3')
  })

  it('never overwrites an existing file during create', () => {
    writeFileSync(path, 'keep these bytes')
    expect(() => new VantageDatabase(path, { create: true })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('keep these bytes')
  })

  it('refuses unrelated SQLite files', () => {
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE private_data(id INTEGER)')
    foreign.close()
    const before = readFileSync(path)
    expect(() => new VantageDatabase(path)).toThrow('not a supported Vantage database')
    expect(readFileSync(path)).toEqual(before)
  })

  it('rolls back a failed batch instead of publishing a partial import', () => {
    const db = make()
    expect(() => db.insert('Sales', [{ Customer: 'Ada', Amount: 5 }, { Amount: 7 }])).toThrow(
      'required',
    )
    expect(db.query('SELECT COUNT(*) AS n FROM Sales').rows[0]?.n).toBe(0)
  })

  it('validates identifiers, typed fields, duplicate columns and finite values', () => {
    const db = make()
    expect(() =>
      db.createTable({ name: 'x; DROP TABLE Sales', columns: [{ name: 'A', type: 'TEXT' }] }),
    ).toThrow('identifier')
    expect(() =>
      db.createTable({
        name: 'Dup',
        columns: [
          { name: 'Name', type: 'TEXT' },
          { name: 'name', type: 'TEXT' },
        ],
      }),
    ).toThrow('Duplicate')
    expect(() => db.insert('Sales', [{ Customer: 'Ada', Amount: Infinity }])).toThrow('finite')
    expect(() => db.insert('Sales', [{ Customer: 'Ada', Units: 1.5 }])).toThrow('integer')
    expect(() => db.insert('Sales', [{ Customer: 'Ada', Extra: 2 }])).toThrow('unknown')
    expect(() => db.insert('Sales', [{ Customer: 3 }])).toThrow('text')
  })

  it('binds strings and parameters without interpreting them as SQL', () => {
    const db = make()
    db.insert('Sales', [{ Customer: "O'Brien'; DROP TABLE Sales; --", Amount: 25 }])
    expect(
      db.query('SELECT Amount FROM Sales WHERE Customer=?', ["O'Brien'; DROP TABLE Sales; --"])
        .rows[0]?.Amount,
    ).toBe(25)
  })

  it('detects optimistic conflicts between two open sessions', () => {
    const db = make()
    db.insert('Sales', [{ Customer: 'Ada', Amount: 10 }])
    const other = new VantageDatabase(path)
    handles.push(other)
    other.update('Sales', 1, 1, { Amount: 20 })
    expect(() => db.update('Sales', 1, 1, { Amount: 30 })).toThrow(RecordConflictError)
    expect(() => db.remove('Sales', 1, 1)).toThrow(RecordConflictError)
    expect(db.query('SELECT Amount,_version FROM Sales').rows[0]).toMatchObject({
      Amount: 20,
      _version: 2,
    })
    db.remove('Sales', 1, 2)
    expect(db.query('SELECT * FROM Sales').rows).toEqual([])
  })

  it('enforces read-only queries and restores CRUD after rejection', () => {
    const db = make()
    expect(() => db.query('DELETE FROM Sales')).toThrow('SELECT')
    expect(() => db.query('WITH x AS (SELECT 1) DELETE FROM Sales')).toThrow()
    db.insert('Sales', [{ Customer: 'Still works' }])
    expect(db.query('SELECT COUNT(*) AS n FROM Sales').rows[0]?.n).toBe(1)
  })

  it('truncates results explicitly and supports aggregate queries', () => {
    const db = make()
    db.insert('Sales', [
      { Customer: 'A', Amount: 10 },
      { Customer: 'B', Amount: 20 },
      { Customer: 'C', Amount: 30 },
    ])
    const result = db.query('SELECT Customer FROM Sales ORDER BY _id', [], 2)
    expect(result).toMatchObject({ columns: ['Customer'], truncated: true })
    expect(result.rows.map((r) => r.Customer)).toEqual(['A', 'B'])
    expect(db.query('SELECT SUM(Amount) AS total FROM Sales').rows[0]?.total).toBe(60)
  })

  it('saves a form, validates its fields and escapes user content in rendered reports', () => {
    const db = make()
    db.insert('Sales', [{ Customer: '<script>evil()</script>', Amount: 7 }])
    db.saveForm({ name: 'New sale', table: 'Sales', fields: ['Customer', 'Amount'] })
    expect(db.forms()[0]?.fields).toEqual(['Customer', 'Amount'])
    expect(() => db.saveForm({ name: 'Bad', table: 'Sales', fields: ['Unknown'] })).toThrow(
      'fields',
    )
    const form = db.renderForm('New sale', { Customer: '" onfocus="bad' })
    expect(form).toContain('&quot; onfocus=&quot;bad')
    const report = db.renderReport({ title: '<Report>', sql: 'SELECT Customer,Amount FROM Sales' })
    expect(report.html).toContain('&lt;script&gt;evil()&lt;/script&gt;')
    expect(report.html).toContain('&lt;Report&gt;')
    expect(report.html).toContain('default-src')
    expect(report.html).not.toContain('<script>')
  })

  it('exports quoted CSV and protects spreadsheet formula interpretation by default', () => {
    const db = make()
    db.insert('Sales', [{ Customer: '=HYPERLINK("http://example.test")', Amount: 5 }])
    const result = db.query('SELECT Customer,Amount FROM Sales')
    expect(queryToCsv(result)).toContain('"\'=HYPERLINK(""http://example.test"")"')
    expect(queryToCsv(result, false)).toContain('"=HYPERLINK(')
  })
})

describe('isolated read-only query process', () => {
  it('queries a saved database and returns bounded serializable rows', async () => {
    const db = make()
    db.insert('Sales', [
      { Customer: 'Ada', Amount: 5 },
      { Customer: 'Lin', Amount: 9 },
    ])
    const result = await queryDatabaseIsolated(
      path,
      'SELECT Customer, Amount FROM Sales WHERE Amount > ? ORDER BY Amount',
      { parameters: [0], maxRows: 1 },
    )
    expect(result).toEqual({
      columns: ['Customer', 'Amount'],
      rows: [{ Customer: 'Ada', Amount: 5 }],
      truncated: true,
    })
  })

  it('kills an unbounded recursive query at its wall deadline', async () => {
    make()
    const start = Date.now()
    await expect(
      queryDatabaseIsolated(
        path,
        'WITH RECURSIVE forever(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM forever) SELECT SUM(x) FROM forever',
        { timeoutMs: 200 },
      ),
    ).rejects.toThrow('time limit')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('refuses writes and honors cancellation', async () => {
    make()
    await expect(
      queryDatabaseIsolated(path, 'WITH x AS (SELECT 1) DELETE FROM Sales'),
    ).rejects.toThrow('readonly')
    const controller = new AbortController()
    controller.abort()
    await expect(
      queryDatabaseIsolated(path, 'SELECT * FROM Sales', { signal: controller.signal }),
    ).rejects.toThrow('cancelled')
  })

  it('rejects SQLite allocations above its independent memory cap', async () => {
    make()
    await expect(
      queryDatabaseIsolated(path, 'SELECT randomblob(100000000) AS huge'),
    ).rejects.toThrow(/memory|valid result/i)
  })
})
