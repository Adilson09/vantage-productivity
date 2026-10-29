import { existsSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'

export type SQLiteValue = null | string | number | bigint | Uint8Array
export interface ColumnSchema {
  name: string
  type: 'TEXT' | 'INTEGER' | 'REAL'
  required?: boolean
}
export interface TableSchema { name: string; columns: ColumnSchema[] }
export interface QueryResult {
  columns: string[]
  rows: Record<string, SQLOutputValue>[]
  truncated: boolean
}
export interface FormDefinition { name: string; table: string; fields: string[] }
export interface ReportDefinition {
  title: string
  sql: string
  parameters?: SQLInputValue[]
  maxRows?: number
}

const APPLICATION_ID = 0x56414e54
const TYPES = new Set(['TEXT', 'INTEGER', 'REAL'])
const MAX_ROWS = 10_000
const MAX_TEXT_BYTES = 2 * 1024 * 1024

function identifier(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name) || name.startsWith('sqlite_')) {
    throw new Error('Use an identifier beginning with a letter, followed by at most 62 letters, digits or underscores.')
  }
  return `"${name}"`
}

function scalar(value: unknown, column: ColumnSchema): SQLInputValue {
  if (value === undefined || value === null) {
    if (column.required) throw new Error(`${column.name} is required.`)
    return null
  }
  if (column.type === 'TEXT') {
    if (typeof value !== 'string') throw new Error(`${column.name} must be text.`)
    if (Buffer.byteLength(value) > MAX_TEXT_BYTES) throw new Error(`${column.name} exceeds the 2 MiB text limit.`)
    return value
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${column.name} must be a finite number.`)
  if (column.type === 'INTEGER' && !Number.isSafeInteger(value)) throw new Error(`${column.name} must be a safe integer.`)
  return value
}

export class RecordConflictError extends Error {
  constructor() { super('This record was changed or removed. Reload it before applying your changes.'); this.name = 'RecordConflictError' }
}

/** Local application database. SQL queries are trusted user input; result bounds are not CPU time limits. */
export class VantageDatabase {
  private readonly db: DatabaseSync
  private closed = false

  constructor(readonly path: string, options: { create?: boolean } = {}) {
    const memory = path === ':memory:'
    let created = false
    if (!memory && options.create) {
      // Exclusive creation avoids racing an existing database or clobbering another format.
      const fd = openSync(path, 'wx', 0o600)
      closeSync(fd)
      created = true
    } else if (!memory && !existsSync(path)) throw new Error('The database does not exist. Use create to make a new Vantage database.')
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path, { allowExtension: false, enableDoubleQuotedStringLiterals: false })
      this.db = db
      db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=2000;')
      if (memory || created) {
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          CREATE TABLE _vantage_objects (kind TEXT NOT NULL, name TEXT NOT NULL, definition TEXT NOT NULL, PRIMARY KEY(kind,name)) STRICT;`)
      } else {
        const id = db.prepare('PRAGMA application_id').get()?.application_id
        const version = db.prepare('PRAGMA user_version').get()?.user_version
        if (id !== APPLICATION_ID || version !== 1) throw new Error('This is not a supported Vantage database (schema version 1).')
        db.prepare('SELECT kind,name,definition FROM _vantage_objects LIMIT 1').all()
      }
    } catch (error) {
      db?.close()
      if (created) { try { unlinkSync(path) } catch { /* preserve the original initialization error */ } }
      throw error
    }
  }

  private assertOpen(): void { if (this.closed) throw new Error('The database is closed.') }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }

  private transaction<T>(operation: () => T): T {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  tables(): TableSchema[] {
    this.assertOpen()
    return this.db.prepare("SELECT definition FROM _vantage_objects WHERE kind='table' ORDER BY name").all()
      .map((row) => JSON.parse(String(row.definition)) as TableSchema)
  }

  private table(name: string): TableSchema {
    identifier(name)
    const schema = this.tables().find((item) => item.name.toLowerCase() === name.toLowerCase())
    if (!schema) throw new Error(`Table ${name} does not exist.`)
    return schema
  }

  createTable(schema: TableSchema): void {
    identifier(schema.name)
    if (!Array.isArray(schema.columns) || schema.columns.length < 1 || schema.columns.length > 128) throw new Error('A table needs 1 to 128 columns.')
    const names = new Set<string>()
    for (const column of schema.columns) {
      identifier(column.name)
      if (!TYPES.has(column.type)) throw new Error('Supported column types: TEXT, INTEGER, REAL.')
      if (names.has(column.name.toLowerCase())) throw new Error(`Duplicate column ${column.name}.`)
      names.add(column.name.toLowerCase())
    }
    const definitions = schema.columns.map((c) => `${identifier(c.name)} ${c.type}${c.required ? ' NOT NULL' : ''}`)
    this.transaction(() => {
      this.db.exec(`CREATE TABLE ${identifier(schema.name)} (_id INTEGER PRIMARY KEY, _version INTEGER NOT NULL DEFAULT 1, ${definitions.join(',')}) STRICT`)
      this.db.prepare('INSERT INTO _vantage_objects(kind,name,definition) VALUES (?,?,?)').run('table', schema.name, JSON.stringify(schema))
    })
  }

  insert(name: string, rows: Record<string, unknown>[]): number[] {
    const table = this.table(name)
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('At most 10,000 records may be inserted per operation.')
    const names = table.columns.map((c) => c.name)
    const insert = this.db.prepare(`INSERT INTO ${identifier(table.name)} (${names.map(identifier).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    return this.transaction(() => rows.map((row) => {
      if (Object.keys(row).some((key) => !names.includes(key))) throw new Error('A record contains unknown fields.')
      const result = insert.run(...table.columns.map((c) => scalar(row[c.name], c)))
      return Number(result.lastInsertRowid)
    }))
  }

  update(name: string, id: number, expectedVersion: number, patch: Record<string, unknown>): void {
    const table = this.table(name)
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(expectedVersion)) throw new Error('Record ID and expected version must be integers.')
    const fields = Object.keys(patch)
    if (!fields.length) throw new Error('At least one field is required.')
    const values = fields.map((key) => {
      const column = table.columns.find((c) => c.name === key)
      if (!column) throw new Error(`Unknown field ${key}.`)
      return scalar(patch[key], column)
    })
    const result = this.db.prepare(`UPDATE ${identifier(table.name)} SET ${fields.map((f) => `${identifier(f)}=?`).join(',')}, _version=_version+1 WHERE _id=? AND _version=?`).run(...values, id, expectedVersion)
    if (Number(result.changes) !== 1) throw new RecordConflictError()
  }

  remove(name: string, id: number, expectedVersion: number): void {
    const table = this.table(name)
    const result = this.db.prepare(`DELETE FROM ${identifier(table.name)} WHERE _id=? AND _version=?`).run(id, expectedVersion)
    if (Number(result.changes) !== 1) throw new RecordConflictError()
  }

  query(sql: string, parameters: SQLInputValue[] = [], maxRows = 1000): QueryResult {
    this.assertOpen()
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) throw new Error('Result limit must be 1 to 10,000 rows.')
    if (typeof sql !== 'string' || Buffer.byteLength(sql) > 32768 || !/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Enter one SELECT or WITH query, at most 32 KiB.')
    this.db.exec('PRAGMA query_only=ON')
    try {
      const statement = this.db.prepare(sql)
      // columns() arrived after the oldest supported Node 22 runtime. Older
      // runtimes can still return the complete field names on the first row.
      const columns = typeof statement.columns === 'function' ? statement.columns().map((column) => column.name) : []
      const rows: Record<string, SQLOutputValue>[] = []
      let truncated = false
      for (const row of statement.iterate(...parameters)) {
        if (rows.length === maxRows) { truncated = true; break }
        if (columns.length === 0) columns.push(...Object.keys(row))
        rows.push(row)
      }
      return { columns, rows, truncated }
    } finally { this.db.exec('PRAGMA query_only=OFF') }
  }

  saveForm(form: FormDefinition): void {
    if (!form.name || form.name.length > 100) throw new Error('Form names must contain 1 to 100 characters.')
    const table = this.table(form.table)
    if (!form.fields.length || form.fields.some((field) => !table.columns.some((c) => c.name === field))) throw new Error('Form fields must belong to the selected table.')
    this.db.prepare('INSERT INTO _vantage_objects(kind,name,definition) VALUES (?,?,?) ON CONFLICT(kind,name) DO UPDATE SET definition=excluded.definition').run('form', form.name, JSON.stringify(form))
  }

  forms(): FormDefinition[] {
    this.assertOpen()
    return this.db.prepare("SELECT definition FROM _vantage_objects WHERE kind='form' ORDER BY name").all().map((r) => JSON.parse(String(r.definition)) as FormDefinition)
  }

  renderForm(name: string, values: Record<string, unknown> = {}): string {
    const form = this.forms().find((f) => f.name === name)
    if (!form) throw new Error('The form does not exist.')
    const table = this.table(form.table)
    return `<form aria-label="${escapeHtml(form.name)}">${form.fields.map((name) => {
      const column = table.columns.find((c) => c.name === name)!
      return `<label>${escapeHtml(name)}<input name="${escapeHtml(name)}" type="${column.type === 'TEXT' ? 'text' : 'number'}"${column.type === 'REAL' ? ' step="any"' : ''}${column.required ? ' required' : ''} value="${escapeHtml(String(values[name] ?? ''))}"></label>`
    }).join('')}<button type="submit">Save record</button></form>`
  }

  renderReport(definition: ReportDefinition): QueryResult & { html: string } {
    const result = this.query(definition.sql, definition.parameters, definition.maxRows)
    return { ...result, html: renderQueryReport(definition.title, result) }
  }
}

export function renderQueryReport(title: string, result: QueryResult): string {
  const head = result.columns.map((name) => `<th scope="col">${escapeHtml(name)}</th>`).join('')
  const body = result.rows.map((row) => `<tr>${result.columns.map((name) => `<td>${escapeHtml(displayValue(row[name] ?? null))}</td>`).join('')}</tr>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;margin:2rem;color:#172836}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.5rem;border:1px solid #cbd5df}th{background:#eef3f7}@media print{body{margin:0}}</style></head><body><h1>${escapeHtml(title)}</h1><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${result.truncated ? '<p>Result limit reached; additional rows were omitted.</p>' : ''}</body></html>`
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) }
function displayValue(value: SQLOutputValue): string { return value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value === null ? '' : String(value) }

export function queryToCsv(result: QueryResult, protectFormulas = true): string {
  const cell = (value: string): string => {
    const safe = protectFormulas && /^[\s]*[=+@-]/.test(value) ? `'${value}` : value
    return `"${safe.replace(/"/g, '""')}"`
  }
  return [result.columns.map(cell).join(','), ...result.rows.map((row) => result.columns.map((name) => cell(displayValue(row[name] ?? null))).join(','))].join('\r\n') + '\r\n'
}
