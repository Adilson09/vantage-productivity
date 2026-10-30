import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, opendir, readdir, rename } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CalendarWorkspace } from './calendar-workspace'
import {
  CALENDAR_GENERATION_DIRECTORY,
  CALENDAR_WORKSPACE_FILENAME,
  decodeCalendarJson,
  type CalendarInitializationResult,
} from './calendar-worker-protocol'

const APPLICATION_ID = 0x5643414c
const READY = 'ready.json'
const STAGE =
  /^workspace-v1\.stage-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const INITIAL_MAX_BYTES = 1024 * 1024
const STORED_MAX_BYTES = 512 * 1024 * 1024
const UNSUPPORTED_SYNC = new Set([
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EISDIR',
  'EPERM',
  'EACCES',
])
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code
interface InitialManifest {
  version: 1
  generation: string
  database: typeof CALENDAR_WORKSPACE_FILENAME
  schemaVersion: 1
  initialBytes: number
  initialSha256: string
}
export class CalendarInitializationError extends Error {
  readonly code = 'CALENDAR_INITIALIZATION_RETAINED'
  constructor(path: string, detail: string, cause?: unknown) {
    super(
      'Calendar setup needs attention at ' +
        path +
        '. ' +
        detail +
        ' Existing and private files were retained.',
      { cause },
    )
    this.name = 'CalendarInitializationError'
  }
}
async function entry(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined
    throw error
  }
}
async function flush(path: string, directory = false): Promise<void> {
  let handle
  try {
    handle = await open(path, directory ? 'r' : 'r+')
    await handle.sync()
  } catch (error) {
    // Directory/volume flush is best effort on Windows and exFAT. This does
    // not claim protection from every filesystem or hardware power loss.
    if (!directory || !UNSUPPORTED_SYNC.has(code(error) ?? '')) throw error
  } finally {
    await handle?.close()
  }
}
async function manifest(path: string): Promise<InitialManifest> {
  const info = await entry(path)
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new Error('The ready manifest is missing or invalid.')
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (before.size > 4096 || before.size !== info.size)
      throw new Error('The ready manifest changed.')
    const bytes = Buffer.alloc(before.size)
    let used = 0
    while (used < bytes.length) {
      const read = await file.read(bytes, used, bytes.length - used, used)
      if (!read.bytesRead) throw new Error('The ready manifest was truncated.')
      used += read.bytesRead
    }
    const after = await file.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('The ready manifest changed.')
    const value = decodeCalendarJson(bytes) as Partial<InitialManifest> | null
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 6 ||
      value.version !== 1 ||
      value.schemaVersion !== 1 ||
      value.database !== CALENDAR_WORKSPACE_FILENAME ||
      typeof value.generation !== 'string' ||
      !UUID.test(value.generation) ||
      !Number.isSafeInteger(value.initialBytes) ||
      Number(value.initialBytes) < 1 ||
      Number(value.initialBytes) > INITIAL_MAX_BYTES ||
      typeof value.initialSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.initialSha256)
    )
      throw new Error('The ready manifest is not supported.')
    return value as InitialManifest
  } finally {
    await file.close()
  }
}
async function digest(path: string): Promise<{ bytes: number; sha256: string }> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > INITIAL_MAX_BYTES)
    throw new Error('The initial database is not a bounded regular file.')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.length
    if (bytes > before.size || bytes > INITIAL_MAX_BYTES)
      throw new Error('The initial database grew.')
    hash.update(chunk)
  }
  const after = await lstat(path)
  if (
    bytes !== before.size ||
    before.size !== after.size ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error('The initial database changed.')
  return { bytes, sha256: hash.digest('hex') }
}
async function verifyDatabaseReadOnly(path: string, initial: boolean): Promise<void> {
  const info = await entry(path)
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size < 100 ||
    info.size > (initial ? INITIAL_MAX_BYTES : STORED_MAX_BYTES)
  )
    throw new Error('The saved database is not a supported regular SQLite file.')
  const db = new DatabaseSync(path, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=2000;')
    if (
      db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
      db.prepare('PRAGMA user_version').get()?.user_version !== 1
    )
      throw new Error('This is not a supported Vantage calendar database.')
    for (const [table, columns] of [
      [
        'calendars',
        [
          'id',
          'name',
          'revision',
          'source',
          'event_count',
          'warnings',
          'origin_path',
          'origin_sha256',
          'updated_at',
        ],
      ],
      [
        'outbox',
        [
          'id',
          'calendar_id',
          'calendar_revision',
          'uid',
          'recurrence_id',
          'method',
          'source',
          'state',
          'created_at',
          'attempts',
          'attempt_id',
          'attempt_expires',
          'error',
        ],
      ],
    ] as const) {
      const actual = db
        .prepare('PRAGMA table_info(' + table + ')')
        .all()
        .map((c) => c.name)
      if (actual.length !== columns.length || actual.some((name, i) => name !== columns[i]))
        throw new Error('The calendar schema does not match this version.')
      if (initial && db.prepare('SELECT COUNT(*) AS total FROM ' + table).get()?.total !== 0)
        throw new Error('A private initial database unexpectedly contains user records.')
    }
    if (db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok')
      throw new Error('SQLite integrity verification failed.')
  } finally {
    db.close()
  }
}
async function verifyDatabase(path: string, initial: boolean): Promise<void> {
  try {
    await verifyDatabaseReadOnly(path, initial)
  } catch (error) {
    // SQLITE_READONLY_ROLLBACK means SQLite needs its own atomic rollback
    // recovery, not a schema rewrite or a retry of the interrupted mutation.
    if (initial || (error as { errcode?: number }).errcode !== 776) throw error
    const journal = await entry(path + '-journal')
    if (
      !journal?.isFile() ||
      journal.isSymbolicLink() ||
      journal.size < 28 ||
      journal.size > STORED_MAX_BYTES + 65536
    )
      throw new Error('The interrupted database has no verifiable rollback journal.')
    const file = await open(path, 'r')
    try {
      const header = Buffer.alloc(100)
      const { bytesRead } = await file.read(header, 0, header.length, 0)
      if (
        bytesRead !== header.length ||
        header.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0' ||
        header.readUInt32BE(60) !== 1 ||
        header.readUInt32BE(68) !== APPLICATION_ID ||
        header[18] !== 1 ||
        header[19] !== 1
      )
        throw new Error('The interrupted database header is not this supported calendar format.')
    } finally {
      await file.close()
    }
    const recovered = new DatabaseSync(path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    })
    try {
      recovered.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=2000;')
      // This read asks SQLite to finish its own rollback. It performs no DDL,
      // version/schema assignment or replay of an application mutation.
      recovered.prepare('PRAGMA application_id').get()
    } finally {
      recovered.close()
    }
    await verifyDatabaseReadOnly(path, false)
  }
}

async function verifyGeneration(
  directory: string,
  initial: boolean,
): Promise<CalendarInitializationResult> {
  const info = await entry(directory)
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new Error('The generation is not a private directory.')
  const seal = await manifest(join(directory, READY))
  const path = join(directory, CALENDAR_WORKSPACE_FILENAME)
  if (initial) {
    if (STAGE.exec(basename(directory))?.[1] !== seal.generation)
      throw new Error('The private generation identity does not match its directory.')
    const names = await readdir(directory)
    if (
      names.length !== 2 ||
      !names.includes(READY) ||
      !names.includes(CALENDAR_WORKSPACE_FILENAME)
    )
      throw new Error('The private database has unclosed sidecars or incomplete setup files.')
    const actual = await digest(path)
    if (actual.bytes !== seal.initialBytes || actual.sha256 !== seal.initialSha256)
      throw new Error('The private database does not match its publication seal.')
  }
  // The seal certifies INITIAL publication only. Ordinary saved edits change
  // database bytes and must never be compared with that old initial hash.
  await verifyDatabase(path, initial)
  return { path, layout: 'generation' }
}
async function legacy(directory: string): Promise<CalendarInitializationResult | undefined> {
  const path = join(directory, CALENDAR_WORKSPACE_FILENAME)
  if (!(await entry(path))) return undefined
  try {
    await verifyDatabase(path, false)
  } catch (error) {
    throw new CalendarInitializationError(
      path,
      'The legacy database could not be verified; it was not migrated or replaced.',
      error,
    )
  }
  return { path, layout: 'legacy' }
}
async function published(directory: string): Promise<CalendarInitializationResult | undefined> {
  const path = join(directory, CALENDAR_GENERATION_DIRECTORY)
  if (!(await entry(path))) return undefined
  try {
    return await verifyGeneration(path, false)
  } catch (error) {
    throw new CalendarInitializationError(
      path,
      'The published generation could not be verified and was not replaced.',
      error,
    )
  }
}
async function publish(
  directory: string,
  stage: string,
  syncPublishedDirectory: (path: string) => Promise<void> = (path) => flush(path, true),
): Promise<CalendarInitializationResult> {
  const old = await legacy(directory)
  if (old) return old
  const winner = await published(directory)
  if (winner) return winner
  const destination = join(directory, CALENDAR_GENERATION_DIRECTORY)
  try {
    // Same-directory rename publishes the already closed database and manifest
    // together. A nonempty winning directory cannot be replaced by rename.
    await rename(stage, destination)
  } catch (error) {
    const existing = (await legacy(directory)) ?? (await published(directory))
    if (existing) return existing
    throw new CalendarInitializationError(stage, 'Publication was interrupted or refused.', error)
  }
  try {
    await syncPublishedDirectory(directory)
  } catch (error) {
    throw new CalendarInitializationError(
      destination,
      'The closed generation was published, but its directory flush failed. Refresh to verify the retained generation.',
      error,
    )
  }
  const result = (await legacy(directory)) ?? (await published(directory))
  if (!result)
    throw new CalendarInitializationError(
      stage,
      'The published generation disappeared before verification.',
    )
  return result
}

/** Trusted empty-store setup; call only from the bounded operation thread. */
export async function initializeCalendarWorkspaceDirectory(
  directory: string,
  options: {
    waitMs?: number
    /** Trusted durability adapter; never accepted through the JSON worker protocol. */
    syncPublishedDirectory?: (path: string) => Promise<void>
    syncPrivateDirectory?: (path: string) => Promise<void>
    /** Observe a closed and sealed private generation without exposing it through RPC. */
    onPrivateReady?: (path: string) => Promise<void>
  } = {},
): Promise<CalendarInitializationResult> {
  if (!isAbsolute(directory) || directory.includes('\0'))
    throw new Error('A trusted absolute calendar directory is required.')
  directory = resolve(directory)
  const waitMs = options.waitMs ?? 20_000
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 20_000)
    throw new Error('Invalid calendar setup wait budget.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const old = await legacy(directory)
  if (old) return old
  const current = await published(directory)
  if (current) return current
  const stages: string[] = []
  const folder = await opendir(directory)
  let observed = 0
  for await (const candidate of folder) {
    if (++observed > 1000)
      throw new CalendarInitializationError(directory, 'Too many setup entries need review.')
    if (STAGE.test(candidate.name)) {
      if (stages.length >= 8)
        throw new CalendarInitializationError(
          directory,
          'Too many private generations need review.',
        )
      stages.push(join(directory, candidate.name))
    }
  }
  if (stages.length) {
    const end = performance.now() + waitMs
    let lastError: unknown
    do {
      const existing = (await legacy(directory)) ?? (await published(directory))
      if (existing) return existing
      const ready: string[] = []
      let incomplete = false
      for (const stage of stages.sort()) {
        if (!(await entry(stage))) continue // A concurrent initializer published it.
        try {
          await verifyGeneration(stage, true)
          ready.push(stage)
        } catch (error) {
          incomplete = true
          lastError = error
        }
      }
      if (!incomplete && ready.length)
        return publish(directory, ready[0]!, options.syncPublishedDirectory)
      if (performance.now() >= end) break
      await new Promise((done) =>
        setTimeout(done, Math.min(100, Math.max(1, end - performance.now()))),
      )
    } while (true)
    throw new CalendarInitializationError(
      directory,
      'A private generation is incomplete or still being prepared. Refresh after setup finishes or review the retained folder.',
      lastError,
    )
  }
  const generation = randomUUID()
  const stage = join(directory, 'workspace-v1.stage-' + generation)
  await mkdir(stage, { mode: 0o700 })
  let sealed = false
  try {
    const path = join(stage, CALENDAR_WORKSPACE_FILENAME)
    const store = new CalendarWorkspace(path, { create: true })
    store.close()
    try {
      await flush(path)
    } catch (error) {
      throw new CalendarInitializationError(
        stage,
        'The closed database could not be flushed.',
        error,
      )
    }
    await verifyDatabase(path, true)
    const initial = await digest(path)
    const ready: InitialManifest = {
      version: 1,
      generation,
      database: CALENDAR_WORKSPACE_FILENAME,
      schemaVersion: 1,
      initialBytes: initial.bytes,
      initialSha256: initial.sha256,
    }
    const pendingReady = join(stage, 'ready.pending')
    const file = await open(pendingReady, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(ready))
      await file.sync()
    } catch (error) {
      throw new CalendarInitializationError(
        stage,
        'The ready manifest could not be flushed.',
        error,
      )
    } finally {
      await file.close()
    }
    // Only a closed, successfully flushed manifest announces a sealed stage.
    await rename(pendingReady, join(stage, READY))
    sealed = true
    try {
      await (options.syncPrivateDirectory ?? ((path) => flush(path, true)))(stage)
    } catch (error) {
      if (code(error) === 'ENOENT') throw error
      throw new CalendarInitializationError(
        stage,
        'The private generation directory flush failed.',
        error,
      )
    }
    await options.onPrivateReady?.(stage)
    await verifyGeneration(stage, true)
    return await publish(directory, stage, options.syncPublishedDirectory)
  } catch (error) {
    if (error instanceof CalendarInitializationError) throw error
    if (sealed) {
      let disappeared = false
      try {
        disappeared = !(await entry(stage))
      } catch {
        // An unreadable stage is not proof that a peer published it.
      }
      if (disappeared) {
        const winner = (await legacy(directory)) ?? (await published(directory))
        if (winner) return winner
      }
    }
    throw new CalendarInitializationError(stage, 'Private initialization did not complete.', error)
  }
}
