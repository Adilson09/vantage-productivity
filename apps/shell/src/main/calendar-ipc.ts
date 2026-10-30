import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { CalendarWorkspace } from '../../../../packages/productivity-engine/src/calendar-workspace'
import {
  AsyncCalendarWorkspace,
  abortAllCalendarWorkers,
  initializeCalendarWorkspaceIsolated,
} from '../../../../packages/productivity-engine/src/calendar-isolated'
import type {
  CalendarRecord,
  CalendarWorkspaceOccurrence,
} from '../../../../packages/productivity-engine/src/calendar-types'
import {
  atomicWriteFile,
  readAtomicFileVersion,
} from '../../../../packages/electron-utils/src/atomic-write'
import {
  CALENDAR_CHANNELS,
  type CalendarAgendaItem,
  type CalendarRecordSummary,
} from '../shared/calendar-api'
import {
  calendarAgendaQuery,
  calendarId,
  calendarMutation,
  calendarMutationOptions,
  calendarName,
  calendarRevision,
  calendarSelector,
} from './calendar-input'

function summary(record: CalendarRecord | CalendarRecordSummary): CalendarRecordSummary {
  const { source: _source, ...value } = record as CalendarRecord
  return value
}
function responseBudget(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8 * 1024 * 1024)
    throw new Error(
      'This calendar result is too large to display. Choose a smaller range or one calendar.',
    )
}
function agendaItem(item: CalendarWorkspaceOccurrence): CalendarAgendaItem {
  return {
    calendarId: item.calendarId,
    calendarRevision: item.calendarRevision,
    uid: item.uid,
    recurrenceId: item.recurrenceId,
    instanceId: item.instanceId,
    summaryPreview: item.summary.slice(0, 256),
    locationPreview: item.location.slice(0, 256),
    previewTruncated: item.summary.length > 256 || item.location.length > 256,
    start: item.start,
    end: item.end,
    localStart: item.localStart,
    localEnd: item.localEnd,
    timeZone: item.timeZone,
    allDay: item.allDay,
    floating: item.floating,
    recurring: item.recurring,
    status: item.status.slice(0, 64),
  }
}
async function selectedCalendar(path: string): Promise<{ source: string; sha256: string }> {
  if (extname(path).toLowerCase() !== '.ics') throw new Error('Choose an iCalendar .ics file.')
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > 4 * 1024 * 1024)
      throw new Error('Choose a calendar smaller than 4 MiB.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(
        bytes,
        offset,
        Math.min(1024 * 1024, bytes.length - offset),
        offset,
      )
      if (!read.bytesRead) throw new Error('The selected calendar changed while reading.')
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('The selected calendar changed while reading.')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if ((await readAtomicFileVersion(path))?.sha256 !== sha256)
      throw new Error('The selected calendar changed while reading.')
    return {
      source: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      sha256,
    }
  } finally {
    await file.close()
  }
}
function fileName(name: string): string {
  return (
    (name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .slice(0, 80)
      .trim() || 'My calendar') + '.ics'
  )
}

export function registerCalendarIpc(
  hostFor: (event: IpcMainInvokeEvent) => BrowserWindow,
  readyForPublication: () => Promise<unknown>,
): void {
  let store: AsyncCalendarWorkspace | undefined
  let pending: Promise<AsyncCalendarWorkspace> | undefined
  let exporter: CalendarWorkspace | undefined
  let databasePath = ''
  const dialogs = new Set<number>()
  const workspace = (): Promise<AsyncCalendarWorkspace> => {
    if (store) return Promise.resolve(store)
    if (!pending)
      pending = (async () => {
        const directory = join(app.getPath('userData'), 'calendar')
        // Schema DDL and validation also stay off the main event loop. Existing
        // legacy stores win; new stores publish one closed, verified generation.
        const initialized = await initializeCalendarWorkspaceIsolated(directory, {
          workerPath: join(__dirname, 'calendar-child.js'),
          executable: process.execPath,
          deadlineMs: 30_000,
          maxHeapMb: 256,
        })
        databasePath = initialized.path
        store = new AsyncCalendarWorkspace({
          path: databasePath,
          workerPath: join(__dirname, 'calendar-child.js'),
          executable: process.execPath,
          deadlineMs: 5000,
          maxHeapMb: 256,
          maxOutputBytes: 8 * 1024 * 1024,
          workspaceOptions: { maxCalendars: 100, maxStoredEvents: 20000 },
        })
        return store
      })().catch((error) => {
        pending = undefined
        throw error
      })
    return pending
  }
  const modal = async <T>(
    event: IpcMainInvokeEvent,
    action: (host: BrowserWindow) => Promise<T>,
  ): Promise<T> => {
    const host = hostFor(event)
    if (dialogs.has(event.sender.id)) throw new Error('Finish the current calendar dialog first.')
    dialogs.add(event.sender.id)
    try {
      return await action(host)
    } finally {
      dialogs.delete(event.sender.id)
    }
  }
  app.once('will-quit', () => {
    abortAllCalendarWorkers()
    store?.dispose()
    // An interrupted publication is recovered by SQLite/atomic-file contracts.
    try {
      exporter?.close()
    } catch {
      /* The process is exiting during publication. */
    }
    store = undefined
  })

  ipcMain.handle(CALENDAR_CHANNELS.status, async (event) => {
    hostFor(event)
    const db = await workspace()
    const result = await db.metadata()
    responseBudget(result)
    return result
  })
  ipcMain.handle(CALENDAR_CHANNELS.create, async (event, name: unknown) => {
    hostFor(event)
    return summary(await (await workspace()).createCalendar({ name: calendarName(name) }))
  })
  ipcMain.handle(CALENDAR_CHANNELS.import, async (event) =>
    modal(event, async (host) => {
      const input = await dialog.showOpenDialog(host, {
        title: 'Import a calendar into this workspace',
        properties: ['openFile'],
        filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      })
      if (input.canceled || !input.filePaths[0]) return null
      const path = input.filePaths[0],
        source = await selectedCalendar(path)
      return summary(
        await (
          await workspace()
        ).importCalendar(source.source, {
          name: basename(path, extname(path)).slice(0, 128),
          originPath: path,
          originSha256: source.sha256,
        }),
      )
    }),
  )
  ipcMain.handle(
    CALENDAR_CHANNELS.rename,
    async (event, id: unknown, name: unknown, revision: unknown) => {
      hostFor(event)
      return summary(
        await (
          await workspace()
        ).renameCalendar(calendarId(id), calendarName(name), {
          expectedRevision: calendarRevision(revision),
        }),
      )
    },
  )
  ipcMain.handle(CALENDAR_CHANNELS.remove, async (event, id: unknown, revision: unknown) =>
    modal(event, async (host) => {
      const identifier = calendarId(id),
        expectedRevision = calendarRevision(revision),
        db = await workspace()
      const current = await db.readCalendar(identifier)
      const answer = await dialog.showMessageBox(host, {
        type: 'warning',
        title: 'Remove local calendar?',
        message: `Remove “${current.name}” and its saved local events?`,
        detail:
          'Export a copy first if you want to keep these local changes. Imported files are separate from this workspace.',
        buttons: ['Cancel', 'Remove local calendar'],
        cancelId: 0,
        defaultId: 0,
      })
      if (answer.response !== 1) return false
      await db.removeCalendar(identifier, { expectedRevision })
      return true
    }),
  )
  ipcMain.handle(CALENDAR_CHANNELS.agenda, async (event, value: unknown) => {
    hostFor(event)
    const query = calendarAgendaQuery(value),
      db = await workspace()
    const options = {
      start: query.start,
      end: query.end,
      viewTimeZone: query.viewTimeZone,
      maxOccurrences: 1000,
      maxIterations: 50_000,
      deadlineMs: 2000,
    }
    const result = query.calendarId
      ? await db.occurrences(query.calendarId, options)
      : await db.allOccurrences(options)
    const output = { occurrences: result.occurrences.map(agendaItem), warnings: result.warnings }
    responseBudget(output)
    return output
  })
  ipcMain.handle(CALENDAR_CHANNELS.event, async (event, id: unknown, value: unknown) => {
    hostFor(event)
    const identifier = calendarId(id),
      selector = calendarSelector(value),
      db = await workspace()
    const before = await db.readCalendar(identifier)
    const detail = await db.eventDetails(identifier, selector)
    const after = await db.readCalendar(identifier)
    if (before.revision !== after.revision)
      throw new Error('The calendar changed while loading this event. Refresh it before editing.')
    const result = { event: detail, calendar: summary(after) }
    responseBudget(result)
    return result
  })
  ipcMain.handle(
    CALENDAR_CHANNELS.mutate,
    async (event, id: unknown, value: unknown, rawOptions: unknown) => {
      const host = hostFor(event),
        identifier = calendarId(id),
        mutation = calendarMutation(value),
        options = calendarMutationOptions(rawOptions),
        db = await workspace()
      if (mutation.type === 'delete') {
        return modal(event, async () => {
          const detail = await db.eventDetails(identifier, {
            uid: mutation.uid,
            recurrenceId: mutation.recurrenceId,
            scope: mutation.scope,
          })
          const selectedScope = mutation.scope ?? (mutation.recurrenceId ? 'instance' : 'series')
          const scope =
            selectedScope === 'this-and-future'
              ? 'this and all future occurrences'
              : selectedScope === 'instance'
                ? 'this occurrence'
                : detail.recurring
                  ? 'the entire series'
                  : 'this event'
          const answer = await dialog.showMessageBox(host, {
            type: 'warning',
            title: 'Delete calendar event?',
            message: `Delete ${scope}?`,
            detail: detail.summary.slice(0, 512),
            buttons: ['Cancel', 'Delete from local calendar'],
            cancelId: 0,
            defaultId: 0,
          })
          if (answer.response !== 1) return null
          const result = await db.mutateCalendar(identifier, mutation, options)
          return { ...result, calendar: summary(result.calendar) }
        })
      }
      const result = await db.mutateCalendar(identifier, mutation, options)
      return { ...result, calendar: summary(result.calendar) }
    },
  )
  ipcMain.handle(CALENDAR_CHANNELS.applyMessage, async (event, id: unknown, revision: unknown) =>
    modal(event, async (host) => {
      const identifier = calendarId(id),
        expectedRevision = calendarRevision(revision),
        db = await workspace()
      const input = await dialog.showOpenDialog(host, {
        title: 'Apply an invitation, response or cancellation file',
        properties: ['openFile'],
        filters: [{ name: 'iCalendar message', extensions: ['ics'] }],
      })
      if (input.canceled || !input.filePaths[0]) return null
      const source = await selectedCalendar(input.filePaths[0])
      const current = await db.readCalendar(identifier)
      const answer = await dialog.showMessageBox(host, {
        type: 'question',
        title: 'Apply calendar message?',
        message: `Apply “${basename(input.filePaths[0])}” to “${current.name}”?`,
        detail: 'This updates the local calendar. No response or notification is sent.',
        buttons: ['Cancel', 'Apply to local calendar'],
        cancelId: 0,
        defaultId: 0,
      })
      if (answer.response !== 1) return null
      const result = await db.applySchedulingMessage(identifier, source.source, {
        expectedRevision,
      })
      return { ...result, calendar: summary(result.calendar) }
    }),
  )
  ipcMain.handle(
    CALENDAR_CHANNELS.export,
    async (event, id: unknown, revision: unknown, updateOriginal: unknown) =>
      modal(event, async (host) => {
        await readyForPublication()
        const identifier = calendarId(id),
          expectedRevision = calendarRevision(revision),
          db = await workspace()
        if (updateOriginal !== undefined && typeof updateOriginal !== 'boolean')
          throw new Error('Choose a new copy or update the imported file.')
        const current = await db.readCalendar(identifier)
        let path: string
        if (updateOriginal) {
          if (
            !current.originPath ||
            !current.originSha256 ||
            extname(current.originPath).toLowerCase() !== '.ics'
          )
            throw new Error('This calendar has no imported .ics file to update. Export a new copy.')
          const answer = await dialog.showMessageBox(host, {
            type: 'warning',
            title: 'Update linked calendar file?',
            message: 'Replace the linked file with these local calendar changes?',
            detail: current.originPath,
            buttons: ['Cancel', 'Update linked file'],
            cancelId: 0,
            defaultId: 0,
          })
          if (answer.response !== 1) return null
          path = current.originPath
        } else {
          const output = await dialog.showSaveDialog(host, {
            title: 'Export a new calendar copy',
            defaultPath: fileName(current.name),
            filters: [{ name: 'iCalendar', extensions: ['ics'] }],
          })
          if (output.canceled || !output.filePath) return null
          path = output.filePath
          if (extname(path).toLowerCase() !== '.ics' || existsSync(path))
            throw new Error('Choose a new .ics file for this export copy.')
        }
        exporter ??= new CalendarWorkspace(databasePath, {
          create: false,
          maxCalendars: 100,
          maxStoredEvents: 20_000,
        })
        return summary(
          await exporter.exportToFile(identifier, path, {
            expectedRevision,
            ...(updateOriginal ? { expectedOriginSha256: current.originSha256! } : {}),
          }),
        )
      }),
  )
  ipcMain.handle(CALENDAR_CHANNELS.exportMessage, async (event, id: unknown) =>
    modal(event, async (host) => {
      await readyForPublication()
      const db = await workspace(),
        identifier = calendarId(id)
      const source = await db.exportOutboxMessage(identifier)
      if (Buffer.byteLength(source, 'utf8') > 4 * 1024 * 1024)
        throw new Error('This outgoing calendar message exceeds the export budget.')
      const output = await dialog.showSaveDialog(host, {
        title: 'Export a prepared calendar message',
        defaultPath: 'Calendar message.ics',
        filters: [{ name: 'iCalendar message', extensions: ['ics'] }],
      })
      if (output.canceled || !output.filePath) return null
      if (extname(output.filePath).toLowerCase() !== '.ics' || existsSync(output.filePath))
        throw new Error('Choose a new .ics file for this message.')
      await atomicWriteFile(output.filePath, Buffer.from(source, 'utf8'), { expectedVersion: null })
      return output.filePath
    }),
  )
  ipcMain.handle(CALENDAR_CHANNELS.discardMessage, async (event, id: unknown) => {
    hostFor(event)
    await (await workspace()).discardOutbox(calendarId(id))
  })
}
