import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  abortAllCalendarWorkers,
  AsyncCalendarWorkspace,
  initializeCalendarWorkspaceIsolated,
} from '../src/calendar-isolated'
import { initializeCalendarWorkspaceDirectory } from '../src/calendar-initialize'
import { CalendarWorkspace } from '../src/calendar-workspace'

const base = process.env.VANTAGE_CALENDAR_TEST_ROOT ?? tmpdir()
const root = mkdtempSync(join(base, 'vantage-calendar-initialization-'))
const workerPath = join(root, 'calendar-child.cjs')
const receipts: Record<string, unknown>[] = []
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const initialize = (directory: string) =>
  initializeCalendarWorkspaceIsolated(directory, { workerPath })
async function prepared(directory: string) {
  const id = randomUUID()
  const stage = join(directory, 'workspace-v1.stage-' + id)
  await mkdir(stage, { recursive: true })
  const path = join(stage, 'workspace.sqlite3')
  const store = new CalendarWorkspace(path, { create: true })
  store.close()
  const bytes = await readFile(path)
  await writeFile(
    join(stage, 'ready.json'),
    JSON.stringify({
      version: 1,
      generation: id,
      database: 'workspace.sqlite3',
      schemaVersion: 1,
      initialBytes: bytes.length,
      initialSha256: hash(bytes),
    }),
  )
  return { stage, path, bytes }
}
async function spillAndKill(path: string): Promise<number | undefined> {
  const marker = join(root, randomUUID() + '.transaction-spilled')
  const program = [
    'const{DatabaseSync}=require("node:sqlite");const fs=require("node:fs");',
    'setTimeout(()=>process.exit(2),15000);const d=new DatabaseSync(' + JSON.stringify(path) + ');',
    'd.exec("PRAGMA cache_size=1; BEGIN IMMEDIATE");',
    'd.prepare("UPDATE calendars SET source=?").run("uncommitted".repeat(100000));',
    'fs.writeFileSync(' + JSON.stringify(marker) + ',"spilled");setInterval(()=>{},100);',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', program], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
  })
  const stopped = new Promise<void>((done, reject) => {
    child.once('error', reject)
    child.once('close', () => done())
  })
  try {
    const limit = performance.now() + 10000
    while (!existsSync(marker) && performance.now() < limit)
      await new Promise((done) => setTimeout(done, 25))
    expect(existsSync(marker)).toBe(true)
  } finally {
    child.kill('SIGKILL')
    await stopped
  }
  expect(existsSync(path + '-journal')).toBe(true)
  const readOnly = new DatabaseSync(path, { readOnly: true })
  try {
    expect(() => readOnly.prepare('PRAGMA application_id').get()).toThrow(
      expect.objectContaining({ errcode: 776 }),
    )
  } finally {
    readOnly.close()
  }
  return child.pid
}
beforeAll(async () => {
  const module = fileURLToPath(new URL('../src/calendar-worker.ts', import.meta.url))
  await build({
    stdin: {
      contents:
        'import {runCalendarWorker} from ' + JSON.stringify(module) + ';runCalendarWorker();',
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
afterEach(() => abortAllCalendarWorkers())
afterAll(async () => {
  if (process.env.VANTAGE_CALENDAR_INITIALIZATION_EVIDENCE)
    await writeFile(
      process.env.VANTAGE_CALENDAR_INITIALIZATION_EVIDENCE,
      JSON.stringify({ recordedAt: new Date().toISOString(), receipts }, null, 2) + '\n',
    )
  if (!resolve(root).startsWith(resolve(base) + sep + 'vantage-calendar-initialization-'))
    throw new Error('Unsafe temporary cleanup path')
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

describe('private calendar generation initialization', () => {
  it('keeps the caller responsive while a real worker initializes a closed generation', async () => {
    const directory = join(root, randomUUID())
    let ticks = 0,
      last = performance.now(),
      maxGapMs = 0
    const heartbeat = setInterval(() => {
      const now = performance.now()
      maxGapMs = Math.max(maxGapMs, now - last)
      last = now
      ticks++
    }, 10)
    const started = performance.now()
    let result
    try {
      result = await initialize(directory)
    } finally {
      clearInterval(heartbeat)
    }
    const setupElapsedMs = performance.now() - started
    expect(ticks).toBeGreaterThan(0)
    expect(result).toEqual({
      path: join(directory, 'workspace-v1', 'workspace.sqlite3'),
      layout: 'generation',
    })
    expect((await readdir(join(directory, 'workspace-v1'))).sort()).toEqual([
      'ready.json',
      'workspace.sqlite3',
    ])
    expect(await readdir(directory)).not.toContain('workspace.sqlite3')
    const db = new AsyncCalendarWorkspace({ path: result.path, workerPath, deadlineMs: 5000 })
    try {
      const created = await db.createCalendar({ name: 'Survives initialization' })
      expect((await db.metadata()).calendars.map((c) => c.id)).toEqual([created.id])
    } finally {
      db.dispose()
    }
    // The initial seal deliberately differs after a normal write; reopening
    // must validate SQLite rather than demand the original empty bytes.
    const seal = JSON.parse(await readFile(join(directory, 'workspace-v1', 'ready.json'), 'utf8'))
    const changed = await readFile(result.path)
    expect(hash(changed)).not.toBe(seal.initialSha256)
    const before = hash(changed)
    expect(await initialize(directory)).toEqual(result)
    expect(hash(await readFile(result.path))).toBe(before)
    receipts.push({
      kind: 'responsive-worker-schema-setup',
      setupElapsedMs,
      heartbeatTicks: ticks,
      maximumHeartbeatGapMs: maxGapMs,
      databaseClosedBeforePublication: true,
      initialHashNotReappliedAfterMutation: true,
    })
  }, 60000)

  it('prefers an existing legacy database without migrating or rewriting it', async () => {
    const directory = join(root, randomUUID())
    const generation = await initialize(directory)
    const path = join(directory, 'workspace.sqlite3')
    const legacy = new CalendarWorkspace(path, { create: true })
    legacy.createCalendar({ name: 'Existing legacy work' })
    legacy.close()
    const legacyBefore = hash(await readFile(path))
    const generationBefore = hash(await readFile(generation.path))
    expect(await initialize(directory)).toEqual({ path, layout: 'legacy' })
    expect(hash(await readFile(path))).toBe(legacyBefore)
    expect(hash(await readFile(generation.path))).toBe(generationBefore)
    receipts.push({ kind: 'legacy-priority', legacyUnchanged: true, generationUnchanged: true })
  }, 45000)

  it('fails closed on invalid legacy data even when a valid generation exists', async () => {
    const directory = join(root, randomUUID())
    const generation = await initialize(directory)
    const path = join(directory, 'workspace.sqlite3')
    await writeFile(path, 'retained foreign or incomplete legacy bytes')
    const before = await readFile(path)
    const generationBefore = hash(await readFile(generation.path))
    await expect(initialize(directory)).rejects.toMatchObject({
      code: 'CALENDAR_INITIALIZATION_RETAINED',
    })
    expect(await readFile(path)).toEqual(before)
    expect(hash(await readFile(generation.path))).toBe(generationBefore)
  }, 45000)

  it('recovers a sealed closed stage left before the directory publication', async () => {
    const directory = join(root, randomUUID())
    const fixture = await prepared(directory)
    expect((await readdir(fixture.stage)).sort()).toEqual(['ready.json', 'workspace.sqlite3'])
    const result = await initialize(directory)
    expect(result.layout).toBe('generation')
    expect(await readFile(result.path)).toEqual(fixture.bytes)
    expect(await readdir(directory)).toEqual(['workspace-v1'])
    receipts.push({
      kind: 'prepared-stage-interruption-recovery',
      bytesUnchanged: true,
      sealedClosedStagePublished: true,
    })
  }, 30000)

  it('retains incomplete staging bytes and makes the unresolved state visible', async () => {
    const directory = join(root, randomUUID())
    const stage = join(directory, 'workspace-v1.stage-' + randomUUID())
    await mkdir(stage, { recursive: true })
    const path = join(stage, 'workspace.sqlite3')
    await writeFile(path, 'unfinished private setup')
    const before = await readFile(path)
    await expect(initializeCalendarWorkspaceDirectory(directory, { waitMs: 0 })).rejects.toThrow(
      'retained',
    )
    expect(await readFile(path)).toEqual(before)
    expect(await readdir(directory)).toEqual([stage.slice(stage.lastIndexOf(sep) + 1)])
  })

  it('refuses a supposedly ready stage that still has SQLite sidecars', async () => {
    const directory = join(root, randomUUID())
    const fixture = await prepared(directory)
    const journal = fixture.path + '-journal'
    await writeFile(journal, 'retained interrupted journal')
    await expect(
      initializeCalendarWorkspaceDirectory(directory, { waitMs: 0 }),
    ).rejects.toMatchObject({ code: 'CALENDAR_INITIALIZATION_RETAINED' })
    expect(await readFile(fixture.path)).toEqual(fixture.bytes)
    expect(await readFile(journal, 'utf8')).toBe('retained interrupted journal')
    expect(await readdir(directory)).not.toContain('workspace-v1')
  })

  it('retains a changed private stage rather than accepting its old publication seal', async () => {
    const directory = join(root, randomUUID())
    const fixture = await prepared(directory)
    const changed = Buffer.concat([fixture.bytes, Buffer.from('unexpected extra bytes')])
    await writeFile(fixture.path, changed)
    await expect(
      initializeCalendarWorkspaceDirectory(directory, { waitMs: 0 }),
    ).rejects.toMatchObject({ code: 'CALENDAR_INITIALIZATION_RETAINED' })
    expect(await readFile(fixture.path)).toEqual(changed)
    expect(await readdir(directory)).not.toContain('workspace-v1')
  })

  it('validates a concurrent nonempty winner instead of replacing it', async () => {
    const directory = join(root, randomUUID())
    const attempts = await Promise.allSettled([initialize(directory), initialize(directory)])
    const successes = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    )
    expect(successes.length).toBeGreaterThan(0)
    const winner = successes[0]!
    expect(winner).toEqual({
      path: join(directory, 'workspace-v1', 'workspace.sqlite3'),
      layout: 'generation',
    })
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') expect(attempt.value).toEqual(winner)
      else {
        expect(attempt.reason).toMatchObject({
          name: 'CalendarWorkerError',
          code: 'CALENDAR_INITIALIZATION_RETAINED',
          mutationMayHaveCommitted: true,
        })
        expect(attempt.reason.message).toContain(
          '. Publication was interrupted or refused. Existing and private files were retained.',
        )
      }
    }
    const manifestPath = join(directory, 'workspace-v1', 'ready.json')
    const databaseBefore = hash(await readFile(winner.path))
    const manifestBefore = hash(await readFile(manifestPath))
    expect(await initialize(directory)).toEqual(winner)
    expect(hash(await readFile(winner.path))).toBe(databaseBefore)
    expect(hash(await readFile(manifestPath))).toBe(manifestBefore)
    receipts.push({
      kind: 'concurrent-generation-winner',
      sameWorkspace: true,
      winnerUnchanged: true,
      databaseSha256: databaseBefore,
      manifestSha256: manifestBefore,
      outcomes: attempts.map((attempt, index) =>
        attempt.status === 'fulfilled'
          ? { index, outcome: 'ready', ...attempt.value }
          : {
              index,
              outcome: 'retained',
              code: attempt.reason.code,
              message: attempt.reason.message,
              mutationMayHaveCommitted: attempt.reason.mutationMayHaveCommitted,
            },
      ),
    })
  }, 60000)

  it('never replaces an invalid nonempty published directory', async () => {
    const directory = join(root, randomUUID())
    const target = join(directory, 'workspace-v1')
    await mkdir(target, { recursive: true })
    const sentinel = join(target, 'keep-user-data')
    await writeFile(sentinel, 'untouched')
    await expect(initialize(directory)).rejects.toMatchObject({
      code: 'CALENDAR_INITIALIZATION_RETAINED',
    })
    expect(await readFile(sentinel, 'utf8')).toBe('untouched')
    expect(await readdir(target)).toEqual(['keep-user-data'])
    expect(await readdir(directory)).toEqual(['workspace-v1'])
  }, 30000)

  it('recovers a real killed transaction with a hot journal without replaying it', async () => {
    const directory = join(root, randomUUID())
    const original = await initialize(directory)
    const saved = new CalendarWorkspace(original.path)
    const calendar = saved.createCalendar({ name: 'Committed before crash' })
    saved.close()
    const crashedPid = await spillAndKill(original.path)
    expect(await initialize(directory)).toEqual(original)
    const verify = new CalendarWorkspace(original.path)
    try {
      const recovered = verify.readCalendar(calendar.id)
      expect(recovered.source).toBe(calendar.source)
      expect(recovered.revision).toBe(1)
      expect(verify.listCalendars()).toHaveLength(1)
    } finally {
      verify.close()
    }
    receipts.push({
      kind: 'real-hot-journal-recovery',
      childPid: crashedPid,
      transactionSpilledBeforeCrash: true,
      readonlyRecoveryError: 776,
      priorCommittedSourceRestored: true,
      revision: 1,
      replayed: false,
    })
  }, 60000)

  it('retains an unsupported schema after minimal SQLite hot-journal rollback without schema repair', async () => {
    const directory = join(root, randomUUID())
    await mkdir(directory)
    const path = join(directory, 'workspace.sqlite3')
    const store = new CalendarWorkspace(path, { create: true })
    const calendar = store.createCalendar({ name: 'Unsupported schema stays retained' })
    store.close()
    const alter = new DatabaseSync(path)
    try {
      alter.exec('ALTER TABLE calendars RENAME COLUMN name TO retained_name')
    } finally {
      alter.close()
    }
    await spillAndKill(path)
    await expect(initialize(directory)).rejects.toMatchObject({
      code: 'CALENDAR_INITIALIZATION_RETAINED',
    })
    const verify = new DatabaseSync(path, { readOnly: true })
    try {
      expect(
        verify
          .prepare('SELECT retained_name,source,revision FROM calendars WHERE id=?')
          .get(calendar.id),
      ).toEqual({ retained_name: calendar.name, source: calendar.source, revision: 1 })
      expect(
        verify
          .prepare('PRAGMA table_info(calendars)')
          .all()
          .map((c) => c.name),
      ).toContain('retained_name')
      expect(
        verify
          .prepare('PRAGMA table_info(calendars)')
          .all()
          .map((c) => c.name),
      ).not.toContain('name')
    } finally {
      verify.close()
    }
    expect(await readdir(directory)).not.toContain('workspace-v1')
    receipts.push({
      kind: 'unsupported-schema-hot-journal',
      schemaRepaired: false,
      priorCommittedDataRetained: true,
      newStoreCreated: false,
    })
  }, 60000)

  it('never recovers or rewrites foreign-header bytes even with a real hot journal', async () => {
    const directory = join(root, randomUUID())
    await mkdir(directory)
    const path = join(directory, 'workspace.sqlite3')
    const store = new CalendarWorkspace(path, { create: true })
    store.createCalendar({ name: 'Foreign header retained' })
    store.close()
    const alter = new DatabaseSync(path)
    try {
      alter.exec('PRAGMA application_id=123456')
    } finally {
      alter.close()
    }
    await spillAndKill(path)
    const databaseBefore = await readFile(path),
      journalBefore = await readFile(path + '-journal')
    await expect(initialize(directory)).rejects.toMatchObject({
      code: 'CALENDAR_INITIALIZATION_RETAINED',
    })
    expect((await readFile(path)).equals(databaseBefore)).toBe(true)
    expect((await readFile(path + '-journal')).equals(journalBefore)).toBe(true)
    expect(await readdir(directory)).not.toContain('workspace-v1')
    receipts.push({
      kind: 'foreign-header-hot-journal',
      databaseBytesUnchanged: true,
      journalBytesUnchanged: true,
      recovered: false,
    })
  }, 60000)

  it('reports an unexpected post-publish directory flush failure and preserves the generation for refresh', async () => {
    const directory = join(root, randomUUID())
    let syncCalls = 0
    await expect(
      initializeCalendarWorkspaceDirectory(directory, {
        syncPublishedDirectory: async (path) => {
          expect(path).toBe(directory)
          syncCalls++
          throw Object.assign(new Error('owned fixture directory flush failed'), { code: 'EIO' })
        },
      }),
    ).rejects.toMatchObject({ code: 'CALENDAR_INITIALIZATION_RETAINED' })
    expect(syncCalls).toBe(1)
    const published = join(directory, 'workspace-v1')
    expect((await readdir(published)).sort()).toEqual(['ready.json', 'workspace.sqlite3'])
    const databaseBefore = hash(await readFile(join(published, 'workspace.sqlite3')))
    const manifestBefore = await readFile(join(published, 'ready.json'), 'utf8')
    const result = await initialize(directory)
    expect(result.path).toBe(join(published, 'workspace.sqlite3'))
    expect(hash(await readFile(result.path))).toBe(databaseBefore)
    expect(await readFile(join(published, 'ready.json'), 'utf8')).toBe(manifestBefore)
    expect(await readdir(directory)).toEqual(['workspace-v1'])
    receipts.push({
      kind: 'post-publication-directory-flush-error',
      errorCode: 'CALENDAR_INITIALIZATION_RETAINED',
      generationRetained: true,
      refreshReplacesNothing: true,
      publicationRetried: false,
    })
  }, 30000)

  it('adopts a real peer winner when the sealed creator stage disappears before final verification', async () => {
    const directory = join(root, randomUUID())
    let announce!: (path: string) => void, resume!: () => void
    const announced = new Promise<string>((done) => (announce = done))
    const barrier = new Promise<void>((done) => (resume = done))
    const creator = initializeCalendarWorkspaceDirectory(directory, {
      onPrivateReady: async (stage) => {
        announce(stage)
        await barrier
      },
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const stage = await announced
    let winner
    try {
      expect((await readdir(stage)).sort()).toEqual(['ready.json', 'workspace.sqlite3'])
      winner = await initializeCalendarWorkspaceDirectory(directory, { waitMs: 0 })
      expect(await readdir(directory)).toEqual(['workspace-v1'])
    } finally {
      resume()
    }
    expect(await creator).toEqual({ value: winner })
    receipts.push({
      kind: 'deterministic-sealed-owner-handoff',
      realDirectoryBarrier: true,
      peerPublishedBeforeOwnerVerification: true,
      sameValidatedWinner: true,
    })
  }, 30000)

  for (const flushError of ['EIO', 'ENOENT'] as const)
    it(
      'keeps private directory flush ' +
        flushError +
        ' precise after a real peer publishes the stage',
      async () => {
        const directory = join(root, randomUUID())
        let announce!: (path: string) => void, resume!: () => void
        const announced = new Promise<string>((done) => (announce = done))
        const barrier = new Promise<void>((done) => (resume = done))
        const creator = initializeCalendarWorkspaceDirectory(directory, {
          syncPrivateDirectory: async (stage) => {
            announce(stage)
            await barrier
            throw Object.assign(new Error('owned private-directory flush fixture'), {
              code: flushError,
            })
          },
        }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        await announced
        let winner
        try {
          winner = await initializeCalendarWorkspaceDirectory(directory, { waitMs: 0 })
        } finally {
          resume()
        }
        const result = await creator
        if (flushError === 'EIO')
          expect(result).toMatchObject({ error: { code: 'CALENDAR_INITIALIZATION_RETAINED' } })
        else expect(result).toEqual({ value: winner })
        expect(await initializeCalendarWorkspaceDirectory(directory)).toEqual(winner)
        receipts.push({
          kind: 'private-flush-after-peer-publication',
          flushError,
          retainedError: flushError === 'EIO',
          winnerAdopted: flushError === 'ENOENT',
        })
      },
      30000,
    )

  it('keeps trusted initialization off the ordinary workspace method surface', async () => {
    const directory = join(root, randomUUID())
    const { path } = await initialize(directory)
    const db = new AsyncCalendarWorkspace({ path, workerPath })
    try {
      expect('initializeWorkspace' in db).toBe(false)
      await expect(db.call('initializeWorkspace' as never, [] as never)).rejects.toMatchObject({
        code: 'CALENDAR_METHOD',
      })
    } finally {
      db.dispose()
    }
  }, 30000)
})
