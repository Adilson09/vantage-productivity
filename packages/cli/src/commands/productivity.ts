import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCalendar,
  expandCalendar,
  exportCalendar,
  exportContacts,
  inspectCalendar,
  parseContacts,
  updateCalendarEvent,
  type Contact,
  type NewCalendarEvent,
} from '../../../productivity-engine/src/calendar'
import { queryDatabaseIsolated } from '../../../productivity-engine/src/database-isolated'
import { CalendarWorkspace } from '../../../productivity-engine/src/calendar-workspace'
import { mutateCalendarSource } from '../../../productivity-engine/src/calendar-mutations'
import {
  calendarTimeZoneProvider,
  listCalendarTimeZones,
} from '../../../productivity-engine/src/calendar-timezones'
import type {
  CalendarMutation,
  CalendarOutboxState,
  CalendarSchedulingMethod,
} from '../../../productivity-engine/src/calendar-types'
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
  if (statSync(resolved).size > 4 * 1024 * 1024)
    throw new CliError(EXIT.file, 'Input exceeds 4 MiB.')
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(resolved))
}
function jsonInput(path: string | undefined, ctx: CommandContext): unknown {
  return JSON.parse(textInput(path, ctx)) as unknown
}
function output(args: ParsedArgs, ctx: CommandContext, bytes: string): string {
  const path = resolveOutput(required(args, 'out'), ctx, { fresh: true })
  writeOutput(path, bytes)
  return path
}

export const calendarCommand: CommandDef = {
  name: 'calendar',
  summary:
    'Local iCalendar/IANA tools, persistent calendar workspaces and a local-only scheduling outbox.',
  usage:
    'calendar <read|expand|create|update|mutate|export|zones|workspace-create|workspace-list|workspace-import|agenda|event|workspace-mutate|workspace-apply|workspace-export|workspace-rename|workspace-remove|outbox|outbox-export|outbox-discard|outbox-test> <file> [options]',
  options: [
    { name: 'start', value: 'ISO', description: 'expand: range start with UTC offset' },
    { name: 'end', value: 'ISO', description: 'expand: exclusive range end with UTC offset' },
    { name: 'limit', value: 'n', description: 'expand: maximum occurrences (default 2,000)' },
    { name: 'uid', value: 'id', description: 'update: event UID' },
    { name: 'summary', value: 'text', description: 'update: replacement event summary' },
    { name: 'location', value: 'text', description: 'update: replacement event location' },
    {
      name: 'out',
      value: 'file',
      description:
        'file export: new output path; outbox-test: new directory; workspace-export overwrite requires --expected-origin-sha',
    },
    {
      name: 'view-time-zone',
      value: 'IANA',
      description:
        'expand/agenda: display zone used to filter floating/all-day dates (default UTC)',
    },
    {
      name: 'deadline',
      value: 'ms',
      description: 'expand/agenda: cooperative calculation deadline, 10–5,000 ms (default 2,000)',
    },
    {
      name: 'recurrence-id',
      value: 'ISO',
      description: 'event/update: original recurrence identifier; UTC for zoned instances',
    },
    {
      name: 'scope',
      value: 'scope',
      description: 'event/update: instance, series or this-and-future',
    },
    {
      name: 'patch',
      value: 'JSON',
      description: 'update: file containing event field changes, including times/zone/attendees',
    },
    {
      name: 'mutation',
      value: 'JSON',
      description:
        'mutate/workspace-mutate: file containing a create/update/delete/respond mutation',
    },
    { name: 'calendar', value: 'id', description: 'workspace: selected persistent calendar UUID' },
    {
      name: 'name',
      value: 'text',
      description: 'workspace-create/import/rename: local calendar name',
    },
    {
      name: 'ics',
      value: 'file',
      description: 'workspace-import/apply: local ICS input; no account reads or sends',
    },
    {
      name: 'revision',
      value: 'n',
      description: 'workspace changes/export: expected current calendar revision',
    },
    {
      name: 'queue-method',
      value: 'method',
      description:
        'workspace-mutate: prepare local PUBLISH/REQUEST/REPLY/CANCEL bytes; never sends',
    },
    {
      name: 'expected-origin-sha',
      value: 'SHA256',
      description:
        'workspace-export: explicit current destination fingerprint for an acknowledged overwrite',
    },
    {
      name: 'state',
      value: 'state',
      description:
        'outbox: optional pending/inflight/failed/delivered/discarded local state filter',
    },
    { name: 'item', value: 'id', description: 'outbox-export/discard: selected outbox UUID' },
  ],
  async run(args, ctx) {
    const [action, file] = args.positionals
    if (action === 'zones')
      return {
        summary: `${calendarTimeZoneProvider.zoneCount} pinned IANA zones/aliases.`,
        detail: { provider: calendarTimeZoneProvider, zones: listCalendarTimeZones() },
      }
    if (workspaceCalendarActions.has(action ?? '')) return runCalendarWorkspace(args, ctx)
    if (action === 'create') {
      const events = jsonInput(file, ctx)
      if (!Array.isArray(events)) throw new CliError(EXIT.usage, 'The event JSON must be an array.')
      const source = createCalendar(events as NewCalendarEvent[])
      const path = output(args, ctx, source)
      return {
        summary: `Created calendar with ${events.length} events.`,
        detail: { path, ...inspectCalendar(source) },
      }
    }
    const source = textInput(file, ctx)
    if (action === 'read') {
      const detail = inspectCalendar(source)
      return { summary: `${detail.events.length} events.`, detail }
    }
    if (action === 'expand') {
      const detail = expandCalendar(source, {
        start: required(args, 'start'),
        end: required(args, 'end'),
        maxOccurrences: Number(flagString(args, 'limit') ?? 2000),
        deadlineMs: Number(flagString(args, 'deadline') ?? 2000),
        ...(flagString(args, 'view-time-zone')
          ? { viewTimeZone: required(args, 'view-time-zone') }
          : {}),
      })
      return { summary: `${detail.occurrences.length} occurrences.`, detail }
    }
    if (action === 'export')
      return {
        summary: 'Exported unchanged calendar source.',
        detail: { path: output(args, ctx, exportCalendar(source)) },
      }
    if (action === 'update') {
      const patchFile = flagString(args, 'patch')
      const recurrenceId = flagString(args, 'recurrence-id')
      if (patchFile || recurrenceId || flagString(args, 'scope')) {
        const patch = patchFile
          ? jsonInput(patchFile, ctx)
          : {
              ...(flagString(args, 'summary') !== undefined
                ? { summary: flagString(args, 'summary') }
                : {}),
              ...(flagString(args, 'location') !== undefined
                ? { location: flagString(args, 'location') }
                : {}),
            }
        const result = mutateCalendarSource(source, {
          type: 'update',
          uid: required(args, 'uid'),
          ...(recurrenceId ? { recurrenceId } : {}),
          ...(flagString(args, 'scope')
            ? { scope: required(args, 'scope') as 'instance' | 'series' | 'this-and-future' }
            : {}),
          patch: patch as Parameters<typeof updateCalendarEvent>[2],
        })
        return {
          summary: 'Exported edited calendar source.',
          detail: {
            path: output(args, ctx, result.source),
            uid: result.uid,
            recurrenceId: result.recurrenceId,
            warnings: result.warnings,
          },
        }
      }
      const summary = flagString(args, 'summary'),
        location = flagString(args, 'location')
      const patch = {
        ...(summary === undefined ? {} : { summary }),
        ...(location === undefined ? {} : { location }),
      }
      if (!Object.keys(patch).length)
        throw new CliError(EXIT.usage, 'Use --summary or --location for an event update.')
      return {
        summary: 'Exported edited calendar.',
        detail: {
          path: output(args, ctx, updateCalendarEvent(source, required(args, 'uid'), patch)),
        },
      }
    }
    if (action === 'mutate') {
      const result = mutateCalendarSource(
        source,
        jsonInput(required(args, 'mutation'), ctx) as CalendarMutation,
      )
      return {
        summary: 'Exported local calendar mutation; no messages were sent.',
        detail: {
          path: output(args, ctx, result.source),
          uid: result.uid,
          recurrenceId: result.recurrenceId,
          warnings: result.warnings,
        },
      }
    }
    throw new CliError(
      EXIT.usage,
      'Use calendar --help for file, workspace and local outbox actions.',
    )
  },
}

const workspaceCalendarActions = new Set([
  'workspace-create',
  'workspace-list',
  'workspace-import',
  'agenda',
  'event',
  'workspace-mutate',
  'workspace-apply',
  'workspace-export',
  'workspace-rename',
  'workspace-remove',
  'outbox',
  'outbox-export',
  'outbox-discard',
  'outbox-test',
])
async function runCalendarWorkspace(args: ParsedArgs, ctx: CommandContext) {
  const [action, file] = args.positionals
  const create = action === 'workspace-create'
  const path = create ? resolveOutput(file, ctx, { fresh: true }) : resolveInput(file, ctx)
  const workspace = new CalendarWorkspace(path, { create })
  const expectedRevision = (): number => {
    const value = Number(required(args, 'revision'))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new CliError(EXIT.usage, '--revision must be a positive integer.')
    return value
  }
  const calendarId = (): string => required(args, 'calendar')
  try {
    if (create) {
      const calendar = workspace.createCalendar({
        name: flagString(args, 'name') ?? 'Local calendar',
      })
      return {
        summary: 'Created local calendar workspace.',
        detail: {
          path,
          calendar: workspace.listCalendars().find((item) => item.id === calendar.id),
        },
      }
    }
    if (action === 'workspace-list')
      return {
        summary: 'Local calendar workspace.',
        detail: { calendars: workspace.listCalendars() },
      }
    if (action === 'workspace-import') {
      const sourcePath = resolveInput(required(args, 'ics'), ctx)
      const calendar = workspace.importCalendar(textInput(sourcePath, ctx), {
        name: required(args, 'name'),
        originPath: sourcePath,
      })
      const { source: _source, ...summary } = calendar
      return {
        summary: 'Imported local calendar; no external account was read.',
        detail: { calendar: summary },
      }
    }
    if (action === 'agenda') {
      const options = {
        start: required(args, 'start'),
        end: required(args, 'end'),
        maxOccurrences: Number(flagString(args, 'limit') ?? 2000),
        deadlineMs: Number(flagString(args, 'deadline') ?? 2000),
        ...(flagString(args, 'view-time-zone')
          ? { viewTimeZone: required(args, 'view-time-zone') }
          : {}),
      }
      const selected = flagString(args, 'calendar'),
        result = selected
          ? workspace.occurrences(selected, options)
          : workspace.allOccurrences(options)
      return { summary: `${result.occurrences.length} local occurrences.`, detail: result }
    }
    if (action === 'event')
      return {
        summary: 'Local event details.',
        detail: {
          event: workspace.eventDetails(calendarId(), {
            uid: required(args, 'uid'),
            ...(flagString(args, 'recurrence-id')
              ? { recurrenceId: required(args, 'recurrence-id') }
              : {}),
            ...(flagString(args, 'scope')
              ? { scope: required(args, 'scope') as 'series' | 'instance' | 'this-and-future' }
              : {}),
          }),
        },
      }
    if (action === 'workspace-mutate') {
      const method = flagString(args, 'queue-method')
      if (method && !['PUBLISH', 'REQUEST', 'REPLY', 'CANCEL'].includes(method))
        throw new CliError(EXIT.usage, 'Unsupported --queue-method.')
      const result = workspace.mutateCalendar(
        calendarId(),
        jsonInput(required(args, 'mutation'), ctx) as CalendarMutation,
        {
          expectedRevision: expectedRevision(),
          ...(method ? { queueMethod: method as CalendarSchedulingMethod } : {}),
        },
      )
      const { source: _source, ...calendar } = result.calendar
      return {
        summary: 'Applied local edit; any queued message remains local and unsent.',
        detail: { ...result, calendar },
      }
    }
    if (action === 'workspace-apply') {
      const result = workspace.applySchedulingMessage(
        calendarId(),
        textInput(required(args, 'ics'), ctx),
        { expectedRevision: expectedRevision() },
      )
      const { source: _source, ...calendar } = result.calendar
      return {
        summary: `Applied ${result.applied} local scheduling items; ignored ${result.ignored}.`,
        detail: { ...result, calendar },
      }
    }
    if (action === 'workspace-export') {
      const fingerprint = flagString(args, 'expected-origin-sha'),
        destination = resolveOutput(required(args, 'out'), ctx, { fresh: !fingerprint })
      const saved = await workspace.exportToFile(calendarId(), destination, {
        expectedRevision: expectedRevision(),
        ...(fingerprint ? { expectedOriginSha256: fingerprint } : {}),
      })
      return {
        summary: 'Exported local ICS copy.',
        detail: {
          path: destination,
          calendarId: saved.id,
          revision: saved.revision,
          originPath: saved.originPath,
          originSha256: saved.originSha256,
        },
      }
    }
    if (action === 'workspace-rename') {
      const { source: _source, ...calendar } = workspace.renameCalendar(
        calendarId(),
        required(args, 'name'),
        { expectedRevision: expectedRevision() },
      )
      return { summary: 'Renamed local calendar.', detail: { calendar } }
    }
    if (action === 'workspace-remove') {
      workspace.removeCalendar(calendarId(), { expectedRevision: expectedRevision() })
      return {
        summary: 'Removed selected local calendar and its local outbox.',
        detail: { calendarId: calendarId() },
      }
    }
    if (action === 'outbox')
      return {
        summary: 'Local-only outbox; no provider send transport.',
        detail: {
          items: workspace.listOutbox({
            ...(flagString(args, 'state')
              ? { state: required(args, 'state') as CalendarOutboxState }
              : {}),
            ...(flagString(args, 'calendar') ? { calendarId: calendarId() } : {}),
          }),
        },
      }
    if (action === 'outbox-export')
      return {
        summary: 'Exported local scheduling bytes; no message was sent.',
        detail: { path: output(args, ctx, workspace.exportOutboxMessage(required(args, 'item'))) },
      }
    if (action === 'outbox-discard')
      return {
        summary: 'Discarded the selected local queued message.',
        detail: { item: workspace.discardOutbox(required(args, 'item')) },
      }
    if (action === 'outbox-test') {
      const folder = resolveOutput(required(args, 'out'), ctx, { fresh: true })
      mkdirSync(folder)
      const result = await workspace.runLocalTestTransport(
        {
          kind: 'local-test',
          async deliver(item) {
            writeOutput(join(folder, `${item.id}.ics`), item.source)
          },
        },
        { limit: Number(flagString(args, 'limit') ?? 10) },
      )
      return {
        summary: 'Completed filesystem-only outbox test; no provider sends.',
        detail: { path: folder, ...result },
      }
    }
    throw new CliError(EXIT.usage, 'Unsupported local calendar workspace action.')
  } finally {
    workspace.close()
  }
}

export const contactsCommand: CommandDef = {
  name: 'contacts',
  summary: 'Read vCard 3.0/4.0 contacts or export a local JSON contact array to vCard.',
  usage: 'contacts <read file.vcf|export contacts.json --out file.vcf>',
  options: [{ name: 'out', value: 'file', description: 'export: a new output vCard file' }],
  async run(args, ctx) {
    const [action, file] = args.positionals
    if (action === 'read') {
      const detail = parseContacts(textInput(file, ctx))
      return { summary: `${detail.contacts.length} contacts.`, detail }
    }
    if (action === 'export') {
      const contacts = jsonInput(file, ctx)
      if (!Array.isArray(contacts))
        throw new CliError(EXIT.usage, 'The contact JSON must be an array.')
      return {
        summary: `Exported ${contacts.length} contacts.`,
        detail: { path: output(args, ctx, exportContacts(contacts as Contact[])) },
      }
    }
    throw new CliError(EXIT.usage, 'Use contacts read or export.')
  },
}

export const databaseCommand: CommandDef = {
  name: 'database',
  summary:
    'Create and query local SQLite-backed Vantage databases, import typed records and export safe HTML reports.',
  usage: 'database <create|tables|query|insert|form|report> <file.vdb> [options]',
  options: [
    {
      name: 'schema',
      value: 'JSON',
      description:
        'create: file containing an array of {name,columns:[{name,type,required?}]} table schemas',
    },
    { name: 'sql', value: 'SQL', description: 'query/report: one read-only SELECT or WITH query' },
    { name: 'params', value: 'JSON', description: 'query/report: JSON array of query parameters' },
    { name: 'limit', value: 'n', description: 'query/report: maximum result rows (default 1,000)' },
    {
      name: 'timeout',
      value: 'ms',
      description: 'query: deadline (default 3,000 ms; maximum 30,000)',
    },
    {
      name: 'rows',
      value: 'JSON',
      description: 'insert: file containing an array of typed record objects',
    },
    { name: 'table', value: 'name', description: 'insert: target table' },
    {
      name: 'definition',
      value: 'JSON',
      description: 'form: file containing {name,table,fields} form definition',
    },
    { name: 'title', value: 'text', description: 'report: report title' },
    { name: 'out', value: 'file', description: 'report: new HTML output file' },
  ],
  async run(args, ctx) {
    const [action, file] = args.positionals
    if (action === 'create') {
      const schemas = jsonInput(required(args, 'schema'), ctx)
      if (!Array.isArray(schemas))
        throw new CliError(EXIT.usage, 'Schema JSON must be an array of table schemas.')
      const path = resolveOutput(file, ctx, { fresh: true })
      const { VantageDatabase } = await import('../../../productivity-engine/src/database')
      const db = new VantageDatabase(path, { create: true })
      try {
        for (const schema of schemas) db.createTable(schema)
        return {
          summary: `Created ${schemas.length} tables.`,
          detail: { path, tables: db.tables() },
        }
      } finally {
        db.close()
      }
    }
    const path = resolveInput(file, ctx)
    if (action === 'query' || action === 'report') {
      const parameters = JSON.parse(flagString(args, 'params') ?? '[]') as (
        null | string | number
      )[]
      if (!Array.isArray(parameters))
        throw new CliError(EXIT.usage, '--params must be a JSON array.')
      const result = await queryDatabaseIsolated(path, required(args, 'sql'), {
        parameters,
        maxRows: Number(flagString(args, 'limit') ?? 1000),
        timeoutMs: Number(flagString(args, 'timeout') ?? 3000),
      })
      if (action === 'query')
        return {
          summary: `${result.rows.length} records${result.truncated ? ' (limited)' : ''}.`,
          detail: { ...result },
        }
      const { renderQueryReport } = await import('../../../productivity-engine/src/database')
      const reportPath = output(
        args,
        ctx,
        renderQueryReport(flagString(args, 'title') ?? 'Vantage report', result),
      )
      return {
        summary: `Exported ${result.rows.length} report records.`,
        detail: { path: reportPath, truncated: result.truncated },
      }
    }
    const { VantageDatabase } = await import('../../../productivity-engine/src/database')
    const db = new VantageDatabase(path)
    try {
      if (action === 'tables')
        return {
          summary: `${db.tables().length} tables.`,
          detail: { tables: db.tables(), forms: db.forms() },
        }
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
    } finally {
      db.close()
    }
  },
}
