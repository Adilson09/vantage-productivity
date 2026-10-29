import { readFileSync, statSync } from 'node:fs'
import { createCalendar, expandCalendar, exportCalendar, exportContacts, inspectCalendar, parseContacts, updateCalendarEvent, type Contact, type NewCalendarEvent } from '../../../productivity-engine/src/calendar'
import { queryDatabaseIsolated } from '../../../productivity-engine/src/database-isolated'
import { flagString, type ParsedArgs } from '../args'
import { resolveInput, resolveOutput, writeOutput } from '../fs'
import type { CommandContext, CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

function required(args: ParsedArgs, name: string): string {
  const value = flagString(args, name)
  if (!value) throw new CliError(EXIT.usage, `Missing --${name}.`)
  return value
}
function textInput(path: string | undefined, ctx: CommandContext): string {
  const resolved = resolveInput(path, ctx)
  if (statSync(resolved).size > 4 * 1024 * 1024) throw new CliError(EXIT.file, 'Input exceeds 4 MiB.')
  return readFileSync(resolved, 'utf8')
}
function jsonInput(path: string | undefined, ctx: CommandContext): unknown { return JSON.parse(textInput(path, ctx)) as unknown }
function output(args: ParsedArgs, ctx: CommandContext, bytes: string): string {
  const path = resolveOutput(required(args, 'out'), ctx, { fresh: true })
  writeOutput(path, bytes)
  return path
}

export const calendarCommand: CommandDef = {
  name: 'calendar',
  summary: 'Read, expand, create and edit local iCalendar files; embedded time zones and recurrence exceptions supported.',
  usage: 'calendar <read|expand|create|update|export> <file> [--start ISO --end ISO] [--out file.ics]',
  options: [
    { name: 'start', value: 'ISO', description: 'expand: range start with UTC offset' },
    { name: 'end', value: 'ISO', description: 'expand: exclusive range end with UTC offset' },
    { name: 'limit', value: 'n', description: 'expand: maximum occurrences (default 2,000)' },
    { name: 'uid', value: 'id', description: 'update: event UID' },
    { name: 'summary', value: 'text', description: 'update: replacement event summary' },
    { name: 'location', value: 'text', description: 'update: replacement event location' },
    { name: 'out', value: 'file', description: 'create/update/export: a new output file; existing files are refused' },
  ],
  async run(args, ctx) {
    const [action, file] = args.positionals
    if (action === 'create') {
      const events = jsonInput(file, ctx)
      if (!Array.isArray(events)) throw new CliError(EXIT.usage, 'The event JSON must be an array.')
      const source = createCalendar(events as NewCalendarEvent[])
      const path = output(args, ctx, source)
      return { summary: `Created calendar with ${events.length} events.`, detail: { path, ...inspectCalendar(source) } }
    }
    const source = textInput(file, ctx)
    if (action === 'read') { const detail = inspectCalendar(source); return { summary: `${detail.events.length} events.`, detail } }
    if (action === 'expand') {
      const detail = expandCalendar(source, { start: required(args, 'start'), end: required(args, 'end'), maxOccurrences: Number(flagString(args, 'limit') ?? 2000) })
      return { summary: `${detail.occurrences.length} occurrences.`, detail }
    }
    if (action === 'export') return { summary: 'Exported unchanged calendar source.', detail: { path: output(args, ctx, exportCalendar(source)) } }
    if (action === 'update') {
      const summary = flagString(args, 'summary'), location = flagString(args, 'location')
      const patch = { ...(summary === undefined ? {} : { summary }), ...(location === undefined ? {} : { location }) }
      if (!Object.keys(patch).length) throw new CliError(EXIT.usage, 'Use --summary or --location for an event update.')
      return { summary: 'Exported edited calendar.', detail: { path: output(args, ctx, updateCalendarEvent(source, required(args, 'uid'), patch)) } }
    }
    throw new CliError(EXIT.usage, 'Use calendar read, expand, create, update or export.')
  },
}

export const contactsCommand: CommandDef = {
  name: 'contacts',
  summary: 'Read vCard 3.0/4.0 contacts or export a local JSON contact array to vCard.',
  usage: 'contacts <read file.vcf|export contacts.json --out file.vcf>',
  options: [{ name: 'out', value: 'file', description: 'export: a new output vCard file' }],
  async run(args, ctx) {
    const [action, file] = args.positionals
    if (action === 'read') { const detail = parseContacts(textInput(file, ctx)); return { summary: `${detail.contacts.length} contacts.`, detail } }
    if (action === 'export') {
      const contacts = jsonInput(file, ctx)
      if (!Array.isArray(contacts)) throw new CliError(EXIT.usage, 'The contact JSON must be an array.')
      return { summary: `Exported ${contacts.length} contacts.`, detail: { path: output(args, ctx, exportContacts(contacts as Contact[])) } }
    }
    throw new CliError(EXIT.usage, 'Use contacts read or export.')
  },
}

export const databaseCommand: CommandDef = {
  name: 'database',
  summary: 'Create and query local SQLite-backed Vantage databases, import typed records and export safe HTML reports.',
  usage: 'database <create|tables|query|insert|form|report> <file.vdb> [options]',
  options: [
    { name: 'schema', value: 'JSON', description: 'create: file containing an array of {name,columns:[{name,type,required?}]} table schemas' },
    { name: 'sql', value: 'SQL', description: 'query/report: one read-only SELECT or WITH query' },
    { name: 'params', value: 'JSON', description: 'query/report: JSON array of query parameters' },
    { name: 'limit', value: 'n', description: 'query/report: maximum result rows (default 1,000)' },
    { name: 'timeout', value: 'ms', description: 'query: deadline (default 3,000 ms; maximum 30,000)' },
    { name: 'rows', value: 'JSON', description: 'insert: file containing an array of typed record objects' },
    { name: 'table', value: 'name', description: 'insert: target table' },
    { name: 'definition', value: 'JSON', description: 'form: file containing {name,table,fields} form definition' },
    { name: 'title', value: 'text', description: 'report: report title' },
    { name: 'out', value: 'file', description: 'report: new HTML output file' },
  ],
  async run(args, ctx) {
    const [action, file] = args.positionals
    if (action === 'create') {
      const schemas = jsonInput(required(args, 'schema'), ctx)
      if (!Array.isArray(schemas)) throw new CliError(EXIT.usage, 'Schema JSON must be an array of table schemas.')
      const path = resolveOutput(file, ctx, { fresh: true })
      const { VantageDatabase } = await import('../../../productivity-engine/src/database')
      const db = new VantageDatabase(path, { create: true })
      try { for (const schema of schemas) db.createTable(schema); return { summary: `Created ${schemas.length} tables.`, detail: { path, tables: db.tables() } } } finally { db.close() }
    }
    const path = resolveInput(file, ctx)
    if (action === 'query' || action === 'report') {
      const parameters = JSON.parse(flagString(args, 'params') ?? '[]') as (null | string | number)[]
      if (!Array.isArray(parameters)) throw new CliError(EXIT.usage, '--params must be a JSON array.')
      const result = await queryDatabaseIsolated(path, required(args, 'sql'), { parameters, maxRows: Number(flagString(args, 'limit') ?? 1000), timeoutMs: Number(flagString(args, 'timeout') ?? 3000) })
      if (action === 'query') return { summary: `${result.rows.length} records${result.truncated ? ' (limited)' : ''}.`, detail: { ...result } }
      const { renderQueryReport } = await import('../../../productivity-engine/src/database')
      const reportPath = output(args, ctx, renderQueryReport(flagString(args, 'title') ?? 'Vantage report', result))
      return { summary: `Exported ${result.rows.length} report records.`, detail: { path: reportPath, truncated: result.truncated } }
    }
    const { VantageDatabase } = await import('../../../productivity-engine/src/database')
    const db = new VantageDatabase(path)
    try {
      if (action === 'tables') return { summary: `${db.tables().length} tables.`, detail: { tables: db.tables(), forms: db.forms() } }
      if (action === 'insert') {
        const rows = jsonInput(required(args, 'rows'), ctx)
        if (!Array.isArray(rows)) throw new CliError(EXIT.usage, 'Record JSON must be an array.')
        const ids = db.insert(required(args, 'table'), rows)
        return { summary: `Inserted ${ids.length} records.`, detail: { ids } }
      }
      if (action === 'form') {
        const definition = jsonInput(required(args, 'definition'), ctx)
        db.saveForm(definition as Parameters<typeof db.saveForm>[0])
        return { summary: 'Saved form.', detail: { forms: db.forms() } }
      }
      throw new CliError(EXIT.usage, 'Use database create, tables, query, insert, form or report.')
    } finally { db.close() }
  },
}
