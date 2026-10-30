// Vantage Productivity modification: never truncate the original after failed replacement;
// retain completed rescue files, serialize per-path saves and snapshot prior versions.
import { createHash, randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  constants,
  createReadStream,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { captureRecoverySnapshot } from './recovery-vault'

/** Transient Windows codes: antivirus/indexer briefly locks the rename target. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400]

/**
 * Codes a refused fsync may surface with inside cloud-sync folders, under AV
 * locks or on filesystems without fsync. The bytes are already written, so a
 * refused flush only weakens power-loss durability and must not fail the save.
 */
const TOLERATED_SYNC_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EINVAL', 'ENOSYS'])

const errorCode = (error: unknown) =>
  error && typeof error === 'object' ? ((error as NodeJS.ErrnoException).code ?? '') : ''
const isRetryableRename = (error: unknown) => RETRYABLE_RENAME_CODES.has(errorCode(error))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// No leading dot: the macOS SMB client marks dot-files hidden and the flag
// survives the rename onto the real document (vantage#2145).
const tempPathBeside = (filePath: string) =>
  join(dirname(filePath), `${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)

export class AtomicSaveError extends Error {
  readonly vantageCode = 'SAVE_NOT_PUBLISHED'
  readonly code: string
  constructor(
    readonly targetPath: string,
    readonly recoveryPath: string,
    cause: unknown,
  ) {
    super(
      `Could not safely replace "${targetPath}". The existing destination was not overwritten by this save. ` +
        `The completed new file is retained at "${recoveryPath}". Use Save As to keep a separate copy. ` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'AtomicSaveError'
    this.code = errorCode(cause) || 'VANTAGE_SAVE_NOT_PUBLISHED'
  }
}

const queueRegistry = globalThis as typeof globalThis & {
  __vantageSaveQueues?: Map<string, Promise<unknown>>
  __vantageSaveContext?: AsyncLocalStorage<Map<string, AtomicFileVersion | null>>
  __vantageAtomicSaveReports?: Map<string, AtomicSaveReport>
}
const saveQueues = (queueRegistry.__vantageSaveQueues ??= new Map<string, Promise<unknown>>())
const saveContext = (queueRegistry.__vantageSaveContext ??= new AsyncLocalStorage<
  Map<string, AtomicFileVersion | null>
>())
export interface AtomicFileVersion {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  dev: number
  sha256?: string
}
export interface AtomicSaveOptions {
  /** The fingerprint observed when the document was loaded; null means a new destination. */
  expectedVersion?: AtomicFileVersion | null
}
export class AtomicSaveConflictError extends Error {
  readonly code = 'VANTAGE_SAVE_CONFLICT'
  constructor() {
    super(
      'The document changed on disk while saving. Save the retained new bytes as a separate conflict copy.',
    )
    this.name = 'AtomicSaveConflictError'
  }
}
const pathKey = (filePath: string) =>
  process.platform === 'win32' ? resolve(filePath).toLowerCase() : resolve(filePath)
/** Bounded hashing supplements timestamps for ordinary documents. Larger files
 * retain metadata conflict checks; cross-process check-out remains a separate capability.
 */
export async function readAtomicFileVersion(filePath: string): Promise<AtomicFileVersion | null> {
  let before
  try {
    before = await stat(filePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  if (!before.isFile()) throw new Error('The save destination is not a regular file')
  const version: AtomicFileVersion = {
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
    ino: before.ino,
    dev: before.dev,
  }
  if (before.size <= 32 * 1024 * 1024) {
    const hash = createHash('sha256')
    let observedBytes = 0
    for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
      observedBytes += chunk.length
      if (observedBytes > before.size || observedBytes > 32 * 1024 * 1024)
        throw new AtomicSaveConflictError()
      hash.update(chunk)
    }
    const after = await stat(filePath)
    if (
      observedBytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.ino !== before.ino
    )
      throw new AtomicSaveConflictError()
    version.sha256 = hash.digest('hex')
  }
  return version
}
async function assertVersion(filePath: string, expected: AtomicFileVersion | null): Promise<void> {
  const current = await readAtomicFileVersion(filePath)
  if (current === null && expected === null) return
  if (
    !current ||
    !expected ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ctimeMs !== expected.ctimeMs ||
    current.ino !== expected.ino ||
    current.dev !== expected.dev ||
    (expected.sha256 !== undefined && current.sha256 !== expected.sha256)
  )
    throw new AtomicSaveConflictError()
}
export interface AtomicSaveReport {
  published: true
  recovery: 'previous-version' | 'first-save' | 'not-applicable' | 'failed'
  warning?: string
}
const reports = (queueRegistry.__vantageAtomicSaveReports ??= new Map<string, AtomicSaveReport>())
export function getAtomicSaveReports(): { path: string; report: AtomicSaveReport }[] {
  return [...reports].map(([path, report]) => ({ path, report: { ...report } }))
}
export function getLastAtomicSaveReport(filePath: string): AtomicSaveReport | null {
  return (
    reports.get(
      process.platform === 'win32' ? resolve(filePath).toLowerCase() : resolve(filePath),
    ) ?? null
  )
}
export function recordAtomicSaveReport(filePath: string, report: AtomicSaveReport): void {
  const key = process.platform === 'win32' ? resolve(filePath).toLowerCase() : resolve(filePath)
  reports.delete(key)
  reports.set(key, report)
  if (reports.size > 256) reports.delete(reports.keys().next().value!)
}
export async function withAtomicSaveQueue<T>(filePath: string, save: () => Promise<T>): Promise<T> {
  const key = pathKey(filePath)
  // Native Sheets wraps its serializer and the shared publisher in the same
  // queue. A nested save in that operation inherits its original fingerprint.
  const parent = saveContext.getStore()
  if (parent?.has(key)) return save()
  const previous = saveQueues.get(key) ?? Promise.resolve()
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const versions = new Map(parent)
      versions.set(key, await readAtomicFileVersion(filePath))
      return saveContext.run(versions, save)
    })
  saveQueues.set(key, pending)
  try {
    return await pending
  } finally {
    if (saveQueues.get(key) === pending) saveQueues.delete(key)
  }
}

async function publishCompletedTemp(
  tmp: string,
  filePath: string,
  options: AtomicSaveOptions = {},
): Promise<void> {
  let firstPublication: boolean
  let previousVersion: boolean
  let completedDigest: string | undefined
  try {
    const expected =
      options.expectedVersion !== undefined
        ? options.expectedVersion
        : saveContext.getStore()?.get(pathKey(filePath))
    if (expected !== undefined) await assertVersion(filePath, expected)
    firstPublication = await stat(filePath).then(
      () => false,
      (error: unknown) => {
        if (errorCode(error) === 'ENOENT') return true
        throw error
      },
    )
    if (firstPublication) completedDigest = (await readAtomicFileVersion(tmp))?.sha256
    previousVersion = !!(await captureRecoverySnapshot(filePath))
    if (expected !== undefined) await assertVersion(filePath, expected)
    await renameWithRetry(
      tmp,
      filePath,
      expected !== undefined ? () => assertVersion(filePath, expected) : undefined,
    )
  } catch (error) {
    // The fully written temp is deliberately retained. Never retry by opening
    // the original with 'w': an interrupted fallback would destroy its contents.
    throw new AtomicSaveError(filePath, tmp, error)
  }
  // The first published document did not have a previous version. Capture its
  // complete bytes now, and never report a published write as a failed save if
  // the independent history operation fails after publication.
  if (firstPublication) {
    try {
      const baseline = await captureRecoverySnapshot(
        filePath,
        undefined,
        'first-save',
        completedDigest,
      )
      recordAtomicSaveReport(filePath, {
        published: true,
        recovery: baseline ? 'first-save' : 'not-applicable',
      })
    } catch (error) {
      const warning = `The document was saved, but its first recovery baseline could not be stored: ${error instanceof Error ? error.message : String(error)}`
      recordAtomicSaveReport(filePath, { published: true, recovery: 'failed', warning })
      console.warn('[vantage recovery]', warning)
    }
  } else
    recordAtomicSaveReport(filePath, {
      published: true,
      recovery: previousVersion ? 'previous-version' : 'not-applicable',
    })
  const context = saveContext.getStore()
  if (context?.has(pathKey(filePath))) {
    try {
      context.set(pathKey(filePath), await readAtomicFileVersion(filePath))
    } catch {
      /* Publication already completed. A later nested save will conservatively detect a conflict. */
    }
  }
}

/** Publish a serializer's completed same-directory temp through the same save
 * contract as buffer/stream writers. A refused publication retains this temp.
 */
export async function publishCompletedFile(
  temporaryPath: string,
  filePath: string,
  options: AtomicSaveOptions = {},
): Promise<void> {
  if (
    resolve(dirname(temporaryPath)) !== resolve(dirname(filePath)) ||
    pathKey(temporaryPath) === pathKey(filePath)
  )
    throw new Error('A completed save must use a distinct temporary file beside its destination')
  return withAtomicSaveQueue(filePath, async () => {
    await syncFileBestEffort(temporaryPath)
    await publishCompletedTemp(temporaryPath, filePath, options)
  })
}

async function removePartialTemp(tmp: string, error: unknown): Promise<void> {
  // An exclusive-creation collision is not a file owned by this save.
  if (errorCode(error) !== 'EEXIST') await unlink(tmp).catch(() => {})
}

async function syncFileBestEffort(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r+')
  } catch (error) {
    if (TOLERATED_SYNC_CODES.has(errorCode(error))) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!TOLERATED_SYNC_CODES.has(errorCode(error))) throw error
  } finally {
    await handle.close()
  }
}

function syncFileBestEffortSync(path: string): void {
  let descriptor: number
  try {
    descriptor = openSync(path, 'r+')
  } catch (error) {
    if (TOLERATED_SYNC_CODES.has(errorCode(error))) return
    throw error
  }
  try {
    fsyncSync(descriptor)
  } catch (error) {
    if (!TOLERATED_SYNC_CODES.has(errorCode(error))) throw error
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Same-dir temp file, best-effort fsync, then rename. Rename-over-existing fails
 * transiently on Windows (Defender/indexer locks: retry) and permanently on some
 * network mounts. Vantage refuses unsafe in-place replacement: the original
 * stays intact and an AtomicSaveError identifies the completed rescue temp.
 */
export async function atomicWriteFile(
  filePath: string,
  data: Buffer,
  options: AtomicSaveOptions = {},
): Promise<void> {
  return withAtomicSaveQueue(filePath, async () => {
    const tmp = tempPathBeside(filePath)
    try {
      await writeFile(tmp, data, { flag: 'wx' })
      await syncFileBestEffort(tmp)
    } catch (error) {
      await removePartialTemp(tmp, error)
      throw error
    }
    await publishCompletedTemp(tmp, filePath, options)
  })
}

async function renameWithRetry(
  tmp: string,
  filePath: string,
  checkBeforeRetry?: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await checkBeforeRetry?.()
    try {
      await rename(tmp, filePath)
      return
    } catch (error) {
      if (!isRetryableRename(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      await sleep(RENAME_RETRY_DELAYS_MS[attempt] ?? 0)
    }
  }
}

/** copyFile stays in the kernel, so a multi-hundred-MB file is never read into RAM */
export async function atomicCopyFile(
  source: string,
  filePath: string,
  options: AtomicSaveOptions = {},
): Promise<void> {
  return withAtomicSaveQueue(filePath, async () => {
    const tmp = tempPathBeside(filePath)
    try {
      await copyFile(source, tmp, constants.COPYFILE_EXCL)
      await syncFileBestEffort(tmp)
    } catch (error) {
      await removePartialTemp(tmp, error)
      throw error
    }
    await publishCompletedTemp(tmp, filePath, options)
  })
}

/**
 * The same contract for output that is produced as a stream rather than held
 * in one Buffer: `write` fills the sibling temp path (a large deck streams out
 * of JSZip chunk by chunk and never fits atomicWriteFile's single buffer), and
 * only a temp that `write` completed is synced and renamed over the target. A
 * writer that throws part-way leaves the target untouched, so a save that dies
 * mid-stream keeps the previous file on disk instead of a truncated one
 * (vantage#2123).
 */
export async function atomicWriteVia(
  filePath: string,
  write: (tempPath: string) => Promise<void>,
  options: AtomicSaveOptions = {},
): Promise<void> {
  return withAtomicSaveQueue(filePath, async () => {
    const tmp = tempPathBeside(filePath)
    try {
      await write(tmp)
      await syncFileBestEffort(tmp)
    } catch (error) {
      await removePartialTemp(tmp, error)
      throw error
    }
    await publishCompletedTemp(tmp, filePath, options)
  })
}

/**
 * Atomic replacement for small userData JSON state files (recents, stars, AI
 * settings). Same retry + retained rescue temp as atomicWriteFile; the retry
 * sleeps block the caller, which is acceptable for a few KB under a transient
 * Windows lock.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const json = JSON.stringify(value, null, 2)
  const tmp = tempPathBeside(filePath)
  const removeTemp = () => {
    try {
      unlinkSync(tmp)
    } catch {
      /* temp never created */
    }
  }
  try {
    writeFileSync(tmp, json, { encoding: 'utf8', flag: 'wx' })
    syncFileBestEffortSync(tmp)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') removeTemp()
    throw error
  }
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, filePath)
        return
      } catch (error) {
        if (!isRetryableRename(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
        sleepSync(RENAME_RETRY_DELAYS_MS[attempt] ?? 0)
      }
    }
  } catch (error) {
    throw new AtomicSaveError(filePath, tmp, error)
  }
}
