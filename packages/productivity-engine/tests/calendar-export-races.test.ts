import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCalendar } from '../src/calendar'
import { CalendarWorkspace, CalendarWorkspaceBusyError } from '../src/calendar-workspace'

const gate = vi.hoisted(() => ({
  entered: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
}))
vi.mock('../../electron-utils/src/atomic-write', async (original) => {
  const real = await original<typeof import('../../electron-utils/src/atomic-write')>()
  return {
    ...real,
    atomicWriteFile: async (...args: Parameters<typeof real.atomicWriteFile>) => {
      gate.entered?.()
      if (gate.wait) await gate.wait
      return real.atomicWriteFile(...args)
    },
  }
})
const execute = promisify(execFile)
const folders: string[] = [],
  handles: CalendarWorkspace[] = []
afterEach(() => {
  gate.entered = undefined
  gate.wait = undefined
  for (const handle of handles.splice(0)) handle.close()
  for (const path of folders.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()))) throw new Error('Unsafe test cleanup')
    rmSync(path, { recursive: true, force: true })
  }
})
function fixture(): {
  workspace: CalendarWorkspace
  calendarId: string
  path: string
  origin: string
  original: string
} {
  const folder = mkdtempSync(join(tmpdir(), 'vantage-calendar-export-'))
  folders.push(folder)
  const path = join(folder, 'calendar.sqlite'),
    origin = join(folder, 'original.ics')
  const original = createCalendar([
    {
      uid: 'race',
      summary: 'Original',
      start: '2026-10-29T09:00:00Z',
      end: '2026-10-29T10:00:00Z',
    },
  ])
  writeFileSync(origin, original)
  const workspace = new CalendarWorkspace(path, { create: true })
  handles.push(workspace)
  const calendar = workspace.importCalendar(original, { name: 'Races', originPath: origin })
  workspace.mutateCalendar(
    calendar.id,
    { type: 'update', uid: 'race', patch: { summary: 'Local edit' } },
    { expectedRevision: 1 },
  )
  return { workspace, calendarId: calendar.id, path, origin, original }
}
function barrier(): { entered: Promise<void>; release: () => void } {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  gate.wait = new Promise<void>((resolve) => {
    release = resolve
  })
  gate.entered = entered
  return { entered: ready, release }
}

describe('calendar file export revision and outside-change fencing', () => {
  it('blocks in-process edits/close and a real independent SQLite writer during awaited publication', async () => {
    const item = fixture(),
      pause = barrier()
    const peer = new CalendarWorkspace(item.path)
    handles.push(peer)
    const publishing = item.workspace.exportToFile(item.calendarId, item.origin, {
      expectedRevision: 2,
    })
    await pause.entered
    try {
      expect(() =>
        peer.renameCalendar(item.calendarId, 'Concurrent', { expectedRevision: 2 }),
      ).toThrow(CalendarWorkspaceBusyError)
      expect(() => item.workspace.close()).toThrow(CalendarWorkspaceBusyError)
      const child = await execute(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA busy_timeout=50");let blocked=false;try{db.prepare("UPDATE calendars SET revision=99 WHERE id=?").run(process.argv[2])}catch(error){blocked=String(error.message).includes("locked")}db.close();process.stdout.write(JSON.stringify({blocked}));if(!blocked)process.exitCode=7',
          item.path,
          item.calendarId,
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000, maxBuffer: 4096 },
      )
      expect(JSON.parse(child.stdout)).toEqual({ blocked: true })
      expect(item.workspace.readCalendar(item.calendarId).revision).toBe(2)
      expect(readFileSync(item.origin, 'utf8')).toBe(item.original)
    } finally {
      pause.release()
    }
    await publishing
    expect(readFileSync(item.origin, 'utf8')).toContain('SUMMARY:Local edit')
    expect(item.workspace.readCalendar(item.calendarId).revision).toBe(2)
  })
  it('retains the outside file and unchanged DB revision when the file changes after fingerprinting', async () => {
    const item = fixture(),
      pause = barrier()
    const before = item.workspace.readCalendar(item.calendarId)
    const publishing = item.workspace.exportToFile(item.calendarId, item.origin, {
      expectedRevision: 2,
    })
    await pause.entered
    writeFileSync(item.origin, 'Outside edit after fingerprint')
    pause.release()
    const failure = (await publishing.catch((error: unknown) => error)) as {
      vantageCode: string
      recoveryPath: string
    }
    expect(failure).toMatchObject({ vantageCode: 'SAVE_NOT_PUBLISHED' })
    expect(readFileSync(failure.recoveryPath, 'utf8')).toContain('SUMMARY:Local edit')
    expect(readFileSync(item.origin, 'utf8')).toBe('Outside edit after fingerprint')
    expect(item.workspace.readCalendar(item.calendarId)).toEqual(before)
    expect(() =>
      item.workspace.renameCalendar(item.calendarId, 'After conflict', { expectedRevision: 2 }),
    ).not.toThrow()
  })
  it('reports actual file publication if a real read transaction prevents the later metadata commit', async () => {
    const item = fixture(),
      before = item.workspace.readCalendar(item.calendarId)
    const reader = new DatabaseSync(item.path)
    reader.exec('BEGIN')
    reader.prepare('SELECT source FROM calendars WHERE id=?').get(item.calendarId)
    try {
      await expect(
        item.workspace.exportToFile(item.calendarId, item.origin, { expectedRevision: 2 }),
      ).rejects.toMatchObject({ code: 'CALENDAR_EXPORTED_METADATA_PENDING', publishedRevision: 2 })
      expect(readFileSync(item.origin, 'utf8')).toContain('SUMMARY:Local edit')
      expect(item.workspace.readCalendar(item.calendarId)).toEqual(before)
    } finally {
      reader.exec('ROLLBACK')
      reader.close()
    }
  }, 20000)
})
