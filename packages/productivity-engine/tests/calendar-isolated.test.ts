import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  abortAllCalendarWorkers,
  AsyncCalendarWorkspace,
  CalendarWorkerError,
  expandCalendarSourceIsolated,
} from '../src/calendar-isolated'
import { CalendarWorkspace } from '../src/calendar-workspace'

const base =
  process.env.VANTAGE_CALENDAR_TEST_ROOT ??
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Temp')
    : tmpdir())
const root = mkdtempSync(join(base, 'vantage-calendar-isolated-'))
const workerPath = join(root, 'calendar-child.cjs')
const clients: AsyncCalendarWorkspace[] = []
const receipts: Record<string, unknown>[] = []
const range = {
  start: '2026-01-01T00:00:00Z',
  end: '2027-01-01T00:00:00Z',
  maxOccurrences: 100,
  maxIterations: 1000,
  deadlineMs: 1000,
}
const source = (rule = 'FREQ=DAILY;COUNT=2') =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vantage isolation test//EN',
    'BEGIN:VEVENT',
    'UID:meeting',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20260101T090000Z',
    'DTEND:20260101T100000Z',
    'SUMMARY:Original',
    'RRULE:' + rule,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
function saved(body?: string): { path: string; id: string } {
  const path = join(root, randomUUID() + '.sqlite3')
  const store = new CalendarWorkspace(path, { create: true })
  const calendar = store.createCalendar({ name: 'Local' })
  store.close()
  if (body) {
    const raw = new DatabaseSync(path)
    try {
      raw.prepare('UPDATE calendars SET source=?,event_count=1 WHERE id=?').run(body, calendar.id)
    } finally {
      raw.close()
    }
  }
  return { path, id: calendar.id }
}
function client(
  path: string,
  options: Partial<ConstructorParameters<typeof AsyncCalendarWorkspace>[0]> = {},
): AsyncCalendarWorkspace {
  const result = new AsyncCalendarWorkspace({ path, workerPath, deadlineMs: 10000, ...options })
  clients.push(result)
  return result
}
const publishReady = `const fs=require('node:fs');fs.writeSync(3,JSON.stringify({version:1,nonce:process.env.VANTAGE_CALENDAR_READY_NONCE,ready:true}));fs.closeSync(3);`
async function mock(program: string, readiness = publishReady): Promise<string> {
  const path = join(root, randomUUID() + '.cjs')
  await writeFile(
    path,
    `let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{const r=JSON.parse(text);${program}});${readiness}`,
  )
  return path
}
const metadataReply = `JSON.stringify({version:1,nonce:r.nonce,method:r.method,ok:true,result:{calendars:[],outbox:[]}})`
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function waitFor(predicate: () => boolean, maximum = 8000): Promise<void> {
  const end = Date.now() + maximum
  while (!predicate() && Date.now() < end) await new Promise((done) => setTimeout(done, 25))
  expect(predicate()).toBe(true)
}

beforeAll(async () => {
  const module = fileURLToPath(new URL('../src/calendar-worker.ts', import.meta.url))
  await build({
    stdin: {
      contents: `import {runCalendarWorker} from ${JSON.stringify(module)};runCalendarWorker();`,
      resolveDir: dirname(module),
      loader: 'ts',
    },
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'silent',
  })
}, 60000)
afterEach(() => {
  for (const value of clients.splice(0)) value.dispose()
  abortAllCalendarWorkers()
})
afterAll(async () => {
  abortAllCalendarWorkers()
  const receipt = process.env.VANTAGE_CALENDAR_ISOLATION_EVIDENCE
  if (receipt) {
    await mkdir(dirname(resolve(receipt)), { recursive: true })
    await writeFile(
      resolve(receipt),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          fixtureRule: 'FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30',
          receipts,
        },
        null,
        2,
      ) + '\n',
    )
  }
  if (!resolve(root).startsWith(resolve(base) + sep + 'vantage-calendar-isolated-'))
    throw new Error('Unsafe temporary cleanup path')
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

describe('real bounded calendar process and thread RPC', () => {
  it('persists edits across calls, returns body-free records and exposes raw ICS only explicitly', async () => {
    const { path, id } = saved(),
      db = client(path)
    expect(await db.metadata()).toMatchObject({ calendars: [{ id, revision: 1 }], outbox: [] })
    const imported = await db.importCalendar(source(), { name: 'Imported' })
    expect(imported).not.toHaveProperty('source')
    expect((await db.readCalendar(imported.id)).eventCount).toBe(1)
    expect((await db.occurrences(imported.id, range)).occurrences).toHaveLength(2)
    const detail = await db.eventDetails(imported.id, { uid: 'meeting' })
    expect(detail.summary).toBe('Original')
    const changed = await db.mutateCalendar(
      imported.id,
      { type: 'update', uid: 'meeting', scope: 'series', patch: { summary: 'Saved edit' } },
      { expectedRevision: 1 },
    )
    expect(changed.calendar).not.toHaveProperty('source')
    expect(changed.calendar.revision).toBe(2)
    expect(await db.exportCalendar(imported.id)).toContain('SUMMARY:Saved edit')
    expect(await db.listCalendars()).toHaveLength(2)
    expect('exportToFile' in db).toBe(false)
    expect('runLocalTestTransport' in db).toBe(false)
    expect('close' in db).toBe(false)
  }, 60000)

  it('previews an actual source without creating or opening a SQLite workspace', async () => {
    const result = await expandCalendarSourceIsolated(source(), range, {
      workerPath,
      deadlineMs: 10000,
    })
    expect(result.occurrences).toHaveLength(2)
    expect(result.occurrences[0]?.uid).toBe('meeting')
  }, 20000)

  it('kills an impossible recurrence during a real transaction and leaves SQLite unchanged', async () => {
    const { path, id } = saved(source('FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30'))
    const before = createHash('sha256').update(readFileSync(path)).digest('hex')
    const db = client(path, { deadlineMs: 4000 })
    const result = db
      .mutateCalendar(
        id,
        {
          type: 'update',
          uid: 'meeting',
          recurrenceId: '2026-03-01T09:00:00Z',
          scope: 'instance',
          patch: { summary: 'Must not commit' },
        },
        { expectedRevision: 1 },
      )
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
    const observer = new DatabaseSync(path)
    observer.exec('PRAGMA busy_timeout=0')
    let busy = false
    const limit = Date.now() + 5000
    try {
      while (!busy && Date.now() < limit) {
        try {
          observer.exec('BEGIN IMMEDIATE;ROLLBACK')
        } catch (error) {
          busy = /locked|busy/i.test(String(error))
        }
        if (!busy) await new Promise((done) => setTimeout(done, 20))
      }
    } finally {
      observer.close()
    }
    const outcome = await result
    expect(busy).toBe(true)
    expect('error' in outcome && outcome.error).toMatchObject({
      code: 'CALENDAR_DEADLINE',
      mutationMayHaveCommitted: true,
    })
    const verify = new DatabaseSync(path)
    try {
      expect(verify.prepare('SELECT revision,source FROM calendars WHERE id=?').get(id)).toEqual({
        revision: 1,
        source: source('FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30'),
      })
    } finally {
      verify.close()
    }
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before)
    receipts.push({
      kind: 'parent-hard-deadline',
      operationStarted: busy,
      errorCode:
        'error' in outcome && outcome.error instanceof CalendarWorkerError
          ? outcome.error.code
          : null,
      sqliteUnchanged: true,
      beforeSha256: before,
      afterSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    })
  }, 20000)

  it('self-terminates on the real impossible rule even after its Node parent exits', async () => {
    const { path, id } = saved(source('FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30'))
    const pidFile = join(root, randomUUID() + '.pid')
    const outputFile = join(root, randomUUID() + '.json')
    const driver = join(root, randomUUID() + '.cjs')
    const request = {
      version: 1,
      nonce: 'a'.repeat(32),
      method: 'mutateCalendar',
      args: [
        id,
        {
          type: 'update',
          uid: 'meeting',
          recurrenceId: '2026-03-01T09:00:00Z',
          scope: 'instance',
          patch: { summary: 'Must not commit' },
        },
        { expectedRevision: 1 },
      ],
      path,
      deadlineMs: 3000,
      maxHeapMb: 256,
      maxOutputBytes: 8388608,
    }
    await writeFile(
      driver,
      [
        `const{spawn}=require('node:child_process');const{writeFileSync,openSync,closeSync}=require('node:fs');const{DatabaseSync}=require('node:sqlite');`,
        `const output=openSync(${JSON.stringify(outputFile)},'wx');const c=spawn(process.execPath,['--max-old-space-size=256',${JSON.stringify(workerPath)}],{detached:true,windowsHide:true,stdio:['pipe',output,'ignore','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'',VANTAGE_CALENDAR_READY_NONCE:${JSON.stringify(request.nonce)}}});closeSync(output);let ready='';c.stdio[3].on('data',b=>{ready+=b;if(Buffer.byteLength(ready)>256)process.exit(2)});c.stdio[3].on('end',()=>{const r=JSON.parse(ready);if(r.version!==1||r.ready!==true||r.nonce!==${JSON.stringify(request.nonce)})process.exit(2);c.stdin.end(${JSON.stringify(JSON.stringify(request))})});`,
        `const observer=new DatabaseSync(${JSON.stringify(path)});observer.exec('PRAGMA busy_timeout=0');const end=Date.now()+15000;`,
        `const poll=setInterval(()=>{let busy=false;try{observer.exec('BEGIN IMMEDIATE;ROLLBACK')}catch(e){busy=/locked|busy/i.test(String(e))}if(busy){clearInterval(poll);observer.close();writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:c.pid,operationStarted:true}));c.unref();process.exit(0)}if(Date.now()>end){clearInterval(poll);observer.close();process.exit(2)}},10);`,
      ].join('\n'),
    )
    const parent = spawn(process.execPath, [driver], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    })
    await new Promise<void>((done, reject) => {
      parent.once('error', reject)
      parent.once('close', (code) =>
        code === 0 ? done() : reject(new Error('Fixture parent failed')),
      )
    })
    const marker = JSON.parse(await readFile(pidFile, 'utf8')) as {
      pid: number
      operationStarted: boolean
    }
    expect(marker.operationStarted).toBe(true)
    const pid = marker.pid
    try {
      expect(alive(pid)).toBe(true)
      await waitFor(() => !alive(pid), 10000)
      const reply = JSON.parse(await readFile(outputFile, 'utf8'))
      expect(reply).toMatchObject({
        ok: false,
        nonce: request.nonce,
        error: { code: 'CALENDAR_DEADLINE' },
      })
      const db = new DatabaseSync(path)
      try {
        expect(db.prepare('SELECT revision,source FROM calendars WHERE id=?').get(id)).toEqual({
          revision: 1,
          source: source('FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30'),
        })
      } finally {
        db.close()
      }
      receipts.push({
        kind: 'orphan-self-deadline',
        fixtureParentPid: parent.pid,
        childPid: pid,
        sqliteWriterLockObservedBeforeParentExit: marker.operationStarted,
        fixtureParentExited: true,
        childExited: !alive(pid),
        errorCode: reply.error.code,
        nonceMatched: reply.nonce === request.nonce,
        sqliteRevision: 1,
        sqliteSourceUnchanged: true,
      })
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 30000)
})

describe('calendar readiness and request delivery', () => {
  it('allows cold and delayed readiness without spending the processing budget', async () => {
    const { path } = saved()
    const worker = await mock(
      'process.stdout.write(' + metadataReply + ');',
      'setTimeout(()=>{' + publishReady + '},2000);',
    )
    const db = client(path, { workerPath: worker, deadlineMs: 1000, startupDeadlineMs: 10000 })
    const started = performance.now()
    expect(await db.metadata()).toEqual({ calendars: [], outbox: [] })
    expect(performance.now() - started).toBeGreaterThanOrEqual(2000)
  }, 20000)

  it('withholds all request bytes until the ready pipe has closed', async () => {
    const { path } = saved()
    const ready = join(root, randomUUID() + '.ready')
    const delivered = join(root, randomUUID() + '.delivered')
    const worker = await mock(
      'process.stdout.write(' + metadataReply + ');',
      'const fs=require("node:fs");process.stdin.on("data",()=>fs.writeFileSync(' +
        JSON.stringify(delivered) +
        ',"delivered"));fs.writeSync(3,JSON.stringify({version:1,nonce:process.env.VANTAGE_CALENDAR_READY_NONCE,ready:true}));fs.writeFileSync(' +
        JSON.stringify(ready) +
        ',"ready packet written");setTimeout(()=>fs.closeSync(3),1500);',
    )
    const db = client(path, { workerPath: worker, deadlineMs: 1000 })
    const operation = db.metadata()
    await waitFor(() => existsSync(ready))
    expect(existsSync(delivered)).toBe(false)
    expect(await operation).toEqual({ calendars: [], outbox: [] })
    expect(existsSync(delivered)).toBe(true)
  }, 20000)

  for (const [label, packet] of [
    ['wrong nonce', 'JSON.stringify({version:1,nonce:"0".repeat(32),ready:true})'],
    [
      'duplicate ready',
      'JSON.stringify({version:1,nonce:process.env.VANTAGE_CALENDAR_READY_NONCE,ready:true}).repeat(2)',
    ],
    [
      'duplicate keys',
      '\'{"version":1,"nonce":"\'+process.env.VANTAGE_CALENDAR_READY_NONCE+\'","ready":false,"ready":true}\'',
    ],
    [
      'extra keys',
      'JSON.stringify({version:1,nonce:process.env.VANTAGE_CALENDAR_READY_NONCE,ready:true,extra:true})',
    ],
    ['invalid UTF-8', 'Buffer.from([255])'],
    ['oversized ready', '"x".repeat(257)'],
  ] as const)
    it('rejects ' + label + ' before delivering a mutation', async () => {
      const { path } = saved()
      const delivered = join(root, randomUUID() + '.delivered')
      const worker = await mock(
        'throw new Error("A mutation must not have been delivered");',
        'const fs=require("node:fs");process.stdin.on("data",()=>fs.writeFileSync(' +
          JSON.stringify(delivered) +
          ',"delivered"));fs.writeSync(3,' +
          packet +
          ');fs.closeSync(3);setInterval(()=>{},100);',
      )
      const db = client(path, { workerPath: worker })
      await expect(db.createCalendar({ name: 'Do not create' })).rejects.toMatchObject({
        code: 'CALENDAR_READY_PROTOCOL',
        mutationMayHaveCommitted: false,
      })
      expect(existsSync(delivered)).toBe(false)
      const verify = new DatabaseSync(path, { readOnly: true })
      try {
        expect(verify.prepare('SELECT COUNT(*) AS total FROM calendars').get()?.total).toBe(1)
      } finally {
        verify.close()
      }
    })

  it('expires startup with no request delivery and reaps its owned child', async () => {
    const { path } = saved()
    const pidFile = join(root, randomUUID() + '.pid')
    const delivered = join(root, randomUUID() + '.delivered')
    const worker = await mock(
      'throw new Error("No request was expected");',
      'const fs=require("node:fs");fs.writeFileSync(' +
        JSON.stringify(pidFile) +
        ',String(process.pid));process.stdin.on("data",()=>fs.writeFileSync(' +
        JSON.stringify(delivered) +
        ',"delivered"));setInterval(()=>{},100);',
    )
    const db = client(path, { workerPath: worker, deadlineMs: 1000, startupDeadlineMs: 10000 })
    const pending = db.createCalendar({ name: 'Never sent' }).catch((error: unknown) => error)
    await waitFor(() => existsSync(pidFile))
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(await pending).toMatchObject({
      code: 'CALENDAR_STARTUP_DEADLINE',
      mutationMayHaveCommitted: false,
    })
    expect(existsSync(delivered)).toBe(false)
    await waitFor(() => !alive(pid))
    const verify = new DatabaseSync(path, { readOnly: true })
    try {
      expect(verify.prepare('SELECT COUNT(*) AS total FROM calendars').get()?.total).toBe(1)
    } finally {
      verify.close()
    }
    receipts.push({
      kind: 'startup-expiry-no-delivery',
      childPid: pid,
      childExited: !alive(pid),
      requestDelivered: false,
      possibleMutation: false,
    })
  }, 20000)

  it('still expires processing after valid delayed readiness and never retries the write', async () => {
    const { path } = saved()
    const delivered = join(root, randomUUID() + '.attempts')
    const worker = await mock(
      'require("node:fs").appendFileSync(' +
        JSON.stringify(delivered) +
        ',"one\\n");setInterval(()=>{},100);',
      'setTimeout(()=>{' + publishReady + '},1500);',
    )
    const db = client(path, { workerPath: worker, deadlineMs: 1000 })
    await expect(db.createCalendar({ name: 'One attempt' })).rejects.toMatchObject({
      code: 'CALENDAR_DEADLINE',
      mutationMayHaveCommitted: true,
    })
    expect((await readFile(delivered, 'utf8')).trim().split('\n')).toEqual(['one'])
    receipts.push({
      kind: 'ready-then-processing-deadline',
      requestDelivered: true,
      possibleMutation: true,
      replayed: false,
    })
  }, 20000)

  it('keeps queue time charged after delayed readiness instead of replenishing it', async () => {
    const { path } = saved()
    const entered = join(root, randomUUID() + '.entered')
    const release = join(root, randomUUID() + '.release')
    const delivered = join(root, randomUUID() + '.delivered')
    const blocked = await mock(
      'const fs=require("node:fs");fs.appendFileSync(' +
        JSON.stringify(entered) +
        ',"entered\\n");const t=setInterval(()=>{if(fs.existsSync(' +
        JSON.stringify(release) +
        ')){clearInterval(t);process.stdout.write(' +
        metadataReply +
        ')}},10);',
    )
    const blocker = client(path, { workerPath: blocked })
    const active = [blocker.metadata(), blocker.metadata()]
    await waitFor(
      () => existsSync(entered) && readFileSync(entered, 'utf8').trim().split('\n').length === 2,
    )
    const worker = await mock(
      'require("node:fs").writeFileSync(' +
        JSON.stringify(delivered) +
        ',"delivered");setTimeout(()=>process.stdout.write(' +
        metadataReply +
        '),1800);',
      'setTimeout(()=>{' + publishReady + '},2000);',
    )
    const db = client(path, { workerPath: worker, deadlineMs: 3000 })
    const pending = db.metadata().catch((error: unknown) => error)
    await new Promise((done) => setTimeout(done, 1800))
    await writeFile(release, 'release')
    await Promise.all(active)
    expect(await pending).toMatchObject({
      code: 'CALENDAR_DEADLINE',
      mutationMayHaveCommitted: false,
    })
    expect(existsSync(delivered)).toBe(true)
  }, 30000)

  it('persists one normal create and returns it from a fresh metadata call', async () => {
    const { path } = saved()
    const db = client(path, { deadlineMs: 5000 })
    const created = await db.createCalendar({ name: 'Created through readiness' })
    expect(created).toMatchObject({ name: 'Created through readiness', revision: 1, eventCount: 0 })
    expect(created).not.toHaveProperty('source')
    db.dispose()
    const reopened = client(path, { deadlineMs: 5000 })
    expect((await reopened.metadata()).calendars.filter((c) => c.id === created.id)).toEqual([
      created,
    ])
    const verify = new DatabaseSync(path, { readOnly: true })
    try {
      expect(
        verify.prepare('SELECT COUNT(*) AS total FROM calendars WHERE id=?').get(created.id)?.total,
      ).toBe(1)
    } finally {
      verify.close()
    }
  }, 30000)
})

describe('calendar RPC failure contracts', () => {
  for (const [label, program, code] of [
    [
      'wrong nonce',
      `process.stdout.write(JSON.stringify({version:1,nonce:'0'.repeat(32),method:r.method,ok:true,result:{calendars:[],outbox:[]}}));`,
      'CALENDAR_PROTOCOL',
    ],
    [
      'wrong result type',
      `process.stdout.write(JSON.stringify({version:1,nonce:r.nonce,method:r.method,ok:true,result:'not metadata'}));`,
      'CALENDAR_PROTOCOL',
    ],
    [
      'bad exit despite valid result',
      `process.stdout.write(${metadataReply});process.exitCode=7;`,
      'CALENDAR_PROCESS_FAILED',
    ],
    [
      'invalid UTF-8',
      `process.stdout.write(Buffer.concat([Buffer.from([255]),Buffer.from(${metadataReply})]));`,
      'CALENDAR_PROTOCOL',
    ],
    ['trailing JSON', `process.stdout.write(${metadataReply}+'{}');`, 'CALENDAR_PROTOCOL'],
    [
      'duplicate JSON keys',
      `process.stdout.write(${metadataReply}.replace('"ok":true','"ok":false,"ok":true'));`,
      'CALENDAR_PROTOCOL',
    ],
  ] as const)
    it('rejects ' + label + ' without echoing private diagnostics', async () => {
      const { path } = saved(),
        file = await mock(`process.stderr.write('private credential fixture');${program}`)
      const db = client(path, { workerPath: file })
      const error = await db.metadata().catch((error: unknown) => error)
      expect(error).toMatchObject({ code })
      expect(String(error)).not.toContain('private credential fixture')
    })

  it('kills output and stderr floods within their byte limits', async () => {
    const { path } = saved()
    for (const [program, code] of [
      [
        `process.stdout.write('x'.repeat(100000));setInterval(()=>{},100);`,
        'CALENDAR_OUTPUT_LIMIT',
      ],
      [
        `process.stderr.write('secret'.repeat(20000));setInterval(()=>{},100);`,
        'CALENDAR_DIAGNOSTIC_LIMIT',
      ],
    ] as const) {
      const file = await mock(program),
        db = client(path, { workerPath: file, maxOutputBytes: 1024 })
      await expect(db.metadata()).rejects.toMatchObject({ code })
    }
  })

  it('cancels and disposes exact owned processes and refuses future calls', async () => {
    const { path } = saved(),
      pidFile = join(root, randomUUID() + '.pid')
    const file = await mock(
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},100);`,
    )
    const db = client(path, { workerPath: file }),
      controller = new AbortController()
    const operation = db.metadata({ signal: controller.signal }).catch((error: unknown) => error)
    await waitFor(() => existsSync(pidFile))
    const pid = Number(await readFile(pidFile, 'utf8'))
    controller.abort()
    expect(await operation).toMatchObject({ code: 'CALENDAR_CANCELLED' })
    await waitFor(() => !alive(pid))
    receipts.push({
      kind: 'active-cancellation',
      childPid: pid,
      childExited: !alive(pid),
      errorCode: 'CALENDAR_CANCELLED',
    })
    db.dispose()
    await expect(db.metadata()).rejects.toMatchObject({ code: 'CALENDAR_DISPOSED' })
  })

  it('labels a lost response after a real committed write as uncertain and never retries', async () => {
    const { path, id } = saved()
    const file = await mock(
      `const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(r.path);d.prepare('UPDATE calendars SET name=?,revision=revision+1 WHERE id=?').run('Committed',r.args[0]);d.close();process.stdout.write('{incomplete');`,
    )
    const db = client(path, { workerPath: file })
    const failure = await db
      .renameCalendar(id, 'Committed', { expectedRevision: 1 })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CalendarWorkerError)
    expect(failure).toMatchObject({ mutationMayHaveCommitted: true })
    expect(String(failure)).toContain('changes may already have been saved')
    receipts.push({
      kind: 'committed-write-lost-response',
      uncertain: failure instanceof CalendarWorkerError && failure.mutationMayHaveCommitted,
      expectedSavedRevision: 2,
      replayed: false,
    })
    const raw = new DatabaseSync(path)
    try {
      expect(raw.prepare('SELECT name,revision FROM calendars WHERE id=?').get(id)).toEqual({
        name: 'Committed',
        revision: 2,
      })
    } finally {
      raw.close()
    }
  })

  it('caps the shared scheduler at two running and eight queued requests', async () => {
    const { path } = saved(),
      violation = join(root, randomUUID() + '.violation')
    const file = await mock(
      `const fs=require('node:fs');let slot;for(let i=0;i<2;i++){try{slot=r.path+'.slot'+i;fs.closeSync(fs.openSync(slot,'wx'));break}catch{slot=undefined}}if(!slot)fs.writeFileSync(${JSON.stringify(violation)},'too many');setTimeout(()=>{if(slot)fs.unlinkSync(slot);process.stdout.write(${metadataReply})},150);`,
    )
    // This case tests capacity, while the separate queue-expiry case tests
    // deadline accounting. Allow five cold runtime waves on a loaded host.
    const first = client(path, { workerPath: file, deadlineMs: 30000 }),
      second = client(path, { workerPath: file, deadlineMs: 30000 })
    const promises = Array.from({ length: 10 }, (_, i) => (i % 2 ? first : second).metadata())
    await expect(first.metadata()).rejects.toMatchObject({
      code: 'CALENDAR_BUSY',
      mutationMayHaveCommitted: false,
    })
    expect(await Promise.all(promises)).toHaveLength(10)
    expect(existsSync(violation)).toBe(false)
    receipts.push({
      kind: 'shared-queue-cap',
      runningCap: 2,
      queuedCap: 8,
      accepted: 10,
      eleventhRejected: true,
      concurrentCapViolated: false,
    })
  }, 30000)

  it('rejects functions, unknown methods and input limits before spawning', async () => {
    const { path } = saved(),
      marker = join(root, randomUUID() + '.marker')
    const file = await mock(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.stdout.write(${metadataReply});`,
    )
    const db = client(path, { workerPath: file })
    await expect(db.call('runLocalTestTransport' as never, [] as never)).rejects.toMatchObject({
      code: 'CALENDAR_METHOD',
    })
    await expect(
      db.createCalendar({ name: 'Invalid', source: (() => {}) as never }),
    ).rejects.toMatchObject({ code: 'CALENDAR_INPUT' })
    await expect(
      db.importCalendar('x'.repeat(8 * 1024 * 1024), { name: 'Large' }),
    ).rejects.toMatchObject({ code: 'CALENDAR_INPUT_LIMIT' })
    expect(existsSync(marker)).toBe(false)
  })

  it('counts queue wait against the deadline without starting an expired action', async () => {
    const { path } = saved()
    const marker = join(root, randomUUID() + '.not-started')
    const blocked = await mock('setInterval(()=>{},100);')
    const short = await mock(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.stdout.write(${metadataReply});`,
    )
    const long = client(path, { workerPath: blocked })
    const waiting = [
      long.metadata().catch((error: unknown) => error),
      long.metadata().catch((error: unknown) => error),
    ]
    const limited = client(path, { workerPath: short, deadlineMs: 100 })
    await expect(limited.metadata()).rejects.toMatchObject({
      code: 'CALENDAR_QUEUE_DEADLINE',
      mutationMayHaveCommitted: false,
    })
    expect(existsSync(marker)).toBe(false)
    long.abortAll()
    await Promise.all(waiting)
    receipts.push({ kind: 'queue-deadline', expiredBeforeSpawn: true, possibleMutation: false })
  })

  it('snapshots queued data and never invokes hooks added after validation', async () => {
    const { path, id } = saved()
    const blocked = await mock(`setTimeout(()=>process.stdout.write(${metadataReply}),800);`)
    const echo = await mock(
      `process.stdout.write(JSON.stringify({version:1,nonce:r.nonce,method:r.method,ok:true,result:{id:${JSON.stringify(id)},name:r.args[0].name,revision:1,eventCount:0,originPath:null,originSha256:null,updatedAt:new Date().toISOString(),warnings:[]}}));`,
    )
    const first = client(path, { workerPath: blocked })
    const active = [first.metadata(), first.metadata()]
    const db = client(path, { workerPath: echo })
    let hookRan = false
    const input: { name: string; toJSON?: () => unknown } = { name: 'Original queued data' }
    const queued = db.createCalendar(input)
    input.name = 'Changed after validation'
    input.toJSON = () => {
      hookRan = true
      return { name: 'Injected by hook' }
    }
    await Promise.all(active)
    expect((await queued).name).toBe('Original queued data')
    expect(hookRan).toBe(false)
    receipts.push({
      kind: 'queued-data-snapshot',
      callerMutationIgnored: true,
      lateToJsonHookInvoked: false,
    })
  })

  it('dispose cancels both running and queued requests without a spawn storm', async () => {
    const { path } = saved()
    const marker = join(root, randomUUID() + '.started')
    const file = await mock(
      `require('node:fs').appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');setInterval(()=>{},100);`,
    )
    const db = client(path, { workerPath: file })
    const waiting = Array.from({ length: 10 }, () => db.metadata().catch((error: unknown) => error))
    await waitFor(
      () => existsSync(marker) && readFileSync(marker, 'utf8').trim().split('\n').length === 2,
    )
    const pids = readFileSync(marker, 'utf8').trim().split('\n').map(Number)
    db.dispose()
    for (const result of await Promise.all(waiting))
      expect(result).toMatchObject({ code: 'CALENDAR_CANCELLED' })
    for (const pid of pids) await waitFor(() => !alive(pid))
    receipts.push({
      kind: 'dispose-active-and-queued',
      startedChildPids: pids,
      allStartedChildrenExited: pids.every((pid) => !alive(pid)),
      requestsCancelled: 10,
    })
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2)
    await expect(db.listCalendars()).rejects.toMatchObject({ code: 'CALENDAR_DISPOSED' })
  })
})
