// Aster Office modification: never truncate the original after failed replacement;
// retain completed rescue files, serialize per-path saves and snapshot prior versions.
import { randomBytes } from 'node:crypto'
import {
  constants,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, open, rename, unlink, writeFile } from 'node:fs/promises'
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
// survives the rename onto the real document (genoffice#2145).
const tempPathBeside = (filePath: string) =>
  join(dirname(filePath), `${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)

export class AtomicSaveError extends Error {
  readonly asterCode = 'SAVE_NOT_PUBLISHED'
  readonly code: string
  constructor(
    readonly targetPath: string,
    readonly recoveryPath: string,
    cause: unknown,
  ) {
    super(
      `Could not safely replace "${targetPath}". The original was left unchanged. ` +
        `The completed new file is retained at "${recoveryPath}". Use Save As to keep a separate copy. ` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'AtomicSaveError'
    this.code = errorCode(cause) || 'ASTER_SAVE_NOT_PUBLISHED'
  }
}

const queueRegistry = globalThis as typeof globalThis & {
  __asterSaveQueues?: Map<string, Promise<unknown>>
}
const saveQueues = (queueRegistry.__asterSaveQueues ??= new Map<string, Promise<unknown>>())
export async function withAtomicSaveQueue<T>(filePath: string, save: () => Promise<T>): Promise<T> {
  const absolute = resolve(filePath)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const previous = saveQueues.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(save)
  saveQueues.set(key, pending)
  try {
    return await pending
  } finally {
    if (saveQueues.get(key) === pending) saveQueues.delete(key)
  }
}

async function publishCompletedTemp(tmp: string, filePath: string): Promise<void> {
  try {
    await captureRecoverySnapshot(filePath)
    await renameWithRetry(tmp, filePath)
  } catch (error) {
    // The fully written temp is deliberately retained. Never retry by opening
    // the original with 'w': an interrupted fallback would destroy its contents.
    throw new AtomicSaveError(filePath, tmp, error)
  }
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
 * network mounts. Aster refuses unsafe in-place replacement: the original
 * stays intact and an AtomicSaveError identifies the completed rescue temp.
 */
export async function atomicWriteFile(filePath: string, data: Buffer): Promise<void> {
  return withAtomicSaveQueue(filePath, async () => {
    const tmp = tempPathBeside(filePath)
    try {
      await writeFile(tmp, data, { flag: 'wx' })
      await syncFileBestEffort(tmp)
    } catch (error) {
      await removePartialTemp(tmp, error)
      throw error
    }
    await publishCompletedTemp(tmp, filePath)
  })
}

async function renameWithRetry(tmp: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
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
export async function atomicCopyFile(source: string, filePath: string): Promise<void> {
  return withAtomicSaveQueue(filePath, async () => {
    const tmp = tempPathBeside(filePath)
    try {
      await copyFile(source, tmp, constants.COPYFILE_EXCL)
      await syncFileBestEffort(tmp)
    } catch (error) {
      await removePartialTemp(tmp, error)
      throw error
    }
    await publishCompletedTemp(tmp, filePath)
  })
}

/**
 * The same contract for output that is produced as a stream rather than held
 * in one Buffer: `write` fills the sibling temp path (a large deck streams out
 * of JSZip chunk by chunk and never fits atomicWriteFile's single buffer), and
 * only a temp that `write` completed is synced and renamed over the target. A
 * writer that throws part-way leaves the target untouched, so a save that dies
 * mid-stream keeps the previous file on disk instead of a truncated one
 * (genoffice#2123).
 */
export async function atomicWriteVia(
  filePath: string,
  write: (tempPath: string) => Promise<void>,
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
    await publishCompletedTemp(tmp, filePath)
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
