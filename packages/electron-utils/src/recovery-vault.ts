// Aster Office addition: bounded, local, previous-version snapshots and copy-only recovery.
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface RecoveryEntry {
  id: string
  originalPath: string
  fileName: string
  createdAt: string
  bytes: number
  sha256: string
}

export const RECOVERY_POLICY = {
  maxFileBytes: 32 * 1024 * 1024,
  maxVaultBytes: 128 * 1024 * 1024,
  maxRevisionsPerFile: 10,
  maxEntries: 128,
} as const

const DOCUMENT_EXTENSIONS = new Set([
  '.docx',
  '.docm',
  '.xlsx',
  '.xlsm',
  '.pptx',
  '.pptm',
  '.pdf',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.csv',
  '.tsv',
  '.odt',
  '.ods',
  '.odp',
])
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const registry = globalThis as typeof globalThis & {
  __asterRecoveryVaultLocks?: Map<string, Promise<unknown>>
}
const locks = (registry.__asterRecoveryVaultLocks ??= new Map<string, Promise<unknown>>())
const pathKey = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const isWithin = (root: string, path: string) => {
  const child = relative(pathKey(root), pathKey(path))
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const errno = (error: unknown) =>
  error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined

async function readStableFile(
  path: string,
  maximum: number,
  expectedBytes?: number,
): Promise<Buffer> {
  const descriptor = await open(path, 'r')
  try {
    const before = await descriptor.stat()
    if (
      !before.isFile() ||
      before.size > maximum ||
      (expectedBytes !== undefined && before.size !== expectedBytes)
    ) {
      throw new Error('Recovery data exceeds its size or integrity limit')
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await descriptor.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead)
        throw new Error('The file changed while its recovery data was being read')
      offset += read.bytesRead
    }
    const after = await descriptor.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('The file changed while its recovery data was being read')
    }
    return bytes
  } finally {
    await descriptor.close()
  }
}

async function flushFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function locked<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = pathKey(root)
  const previous = locks.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(operation)
  locks.set(key, pending)
  try {
    return await pending
  } finally {
    if (locks.get(key) === pending) locks.delete(key)
  }
}

function validEntry(value: unknown, id: string): value is RecoveryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<RecoveryEntry>
  return (
    entry.id === id &&
    typeof entry.originalPath === 'string' &&
    isAbsolute(entry.originalPath) &&
    entry.fileName === basename(entry.originalPath) &&
    typeof entry.createdAt === 'string' &&
    Number.isFinite(Date.parse(entry.createdAt)) &&
    typeof entry.bytes === 'number' &&
    Number.isSafeInteger(entry.bytes) &&
    entry.bytes >= 0 &&
    entry.bytes <= RECOVERY_POLICY.maxFileBytes &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256)
  )
}

async function entriesIn(root: string): Promise<RecoveryEntry[]> {
  let files
  try {
    files = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (errno(error) === 'ENOENT') return []
    throw error
  }
  const metadata = files.filter(
    (file) => file.isFile() && file.name.endsWith('.json') && ID.test(file.name.slice(0, -5)),
  )
  if (metadata.length > 512)
    throw new Error('The recovery vault exceeds its inspection limit. No document was overwritten.')
  const entries: RecoveryEntry[] = []
  for (const file of metadata) {
    const id = file.name.slice(0, -5)
    try {
      const metadataPath = join(root, file.name)
      const value: unknown = JSON.parse(
        (await readStableFile(metadataPath, 16 * 1024)).toString('utf8'),
      )
      if (!validEntry(value, id)) continue
      const blob = await stat(join(root, `${id}.bin`))
      if (!blob.isFile() || blob.size !== value.bytes) continue
      entries.push(value)
    } catch (error) {
      // Ignore incomplete/crash-written or invalid entries, but not an unreadable vault.
      if (errno(error) && errno(error) !== 'ENOENT') throw error
    }
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

export async function listRecoveryEntries(root: string): Promise<RecoveryEntry[]> {
  return locked(root, () => entriesIn(root))
}

async function removeEntry(root: string, entry: RecoveryEntry): Promise<void> {
  // Preserve provenance if removing the payload is refused. entriesIn verifies
  // blob existence, so a crash after removal safely hides stale metadata.
  await unlink(join(root, `${entry.id}.bin`)).catch((error: unknown) => {
    if (errno(error) !== 'ENOENT') throw error
  })
  await unlink(join(root, `${entry.id}.json`)).catch((error: unknown) => {
    if (errno(error) !== 'ENOENT') throw error
  })
}

async function prune(
  root: string,
  entries: RecoveryEntry[],
  keepId?: string,
): Promise<RecoveryEntry[]> {
  const counts = new Map<string, number>()
  const retained: RecoveryEntry[] = []
  for (const entry of entries) {
    const key = pathKey(entry.originalPath)
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count > RECOVERY_POLICY.maxRevisionsPerFile && entry.id !== keepId)
      await removeEntry(root, entry)
    else retained.push(entry)
  }
  let total = retained.reduce((sum, entry) => sum + entry.bytes, 0)
  while (retained.length > RECOVERY_POLICY.maxEntries || total > RECOVERY_POLICY.maxVaultBytes) {
    let index = retained.length - 1
    while (index >= 0 && retained[index]!.id === keepId) index -= 1
    if (index < 0) throw new Error('The recovery snapshot exceeds the vault budget')
    const [entry] = retained.splice(index, 1)
    await removeEntry(root, entry!)
    total -= entry!.bytes
  }
  return retained
}

async function reserveSnapshotRoom(
  root: string,
  entries: RecoveryEntry[],
  bytes: number,
  originalPath: string,
): Promise<RecoveryEntry[]> {
  // Count unindexed crash leftovers too: they must not let repeated interrupted
  // saves grow storage without bound. Unknown files are never deleted here.
  const blobs = (await readdir(root, { withFileTypes: true })).filter(
    (file) => file.isFile() && file.name.endsWith('.bin') && ID.test(file.name.slice(0, -4)),
  )
  if (blobs.length > 512) throw new Error('The recovery vault exceeds its inspection limit')
  let occupied = 0
  for (const blob of blobs) occupied += (await stat(join(root, blob.name))).size
  const remaining = [...entries]
  const key = pathKey(originalPath)
  let revisions = remaining.filter((entry) => pathKey(entry.originalPath) === key).length
  while (
    occupied + bytes > RECOVERY_POLICY.maxVaultBytes ||
    remaining.length >= RECOVERY_POLICY.maxEntries ||
    revisions >= RECOVERY_POLICY.maxRevisionsPerFile
  ) {
    let index = remaining.length - 1
    // Reserve this document's slot first; do not discard another document's
    // version merely because this one already has ten revisions.
    if (revisions >= RECOVERY_POLICY.maxRevisionsPerFile) {
      while (index >= 0 && pathKey(remaining[index]!.originalPath) !== key) index -= 1
    }
    const oldest = index < 0 ? undefined : remaining.splice(index, 1)[0]
    if (!oldest)
      throw new Error(
        'The recovery vault is full of incomplete or unindexed data. Save As to a new file to preserve your work.',
      )
    await removeEntry(root, oldest)
    occupied -= oldest.bytes
    if (pathKey(oldest.originalPath) === key) revisions -= 1
  }
  return remaining
}

/**
 * Called only after the new save temp is complete and before publishing it.
 * The root is supplied by the desktop shell through ASTER_RECOVERY_ROOT so
 * independently bundled editor modules share the same local history folder.
 * New files, non-document state and files larger than 32 MiB are excluded.
 * ASTER_RECOVERY_EXCLUDE_ROOT excludes the shell's application data tree so
 * background crash-recovery copies and caches never become document history.
 * A configured vault failure rejects replacement; Save As to a new file remains possible.
 */
export async function captureRecoverySnapshot(
  filePath: string,
  root = process.env.ASTER_RECOVERY_ROOT,
): Promise<RecoveryEntry | null> {
  if (!root || !DOCUMENT_EXTENSIONS.has(extname(filePath).toLowerCase())) return null
  const absolute = resolve(filePath)
  const excluded = process.env.ASTER_RECOVERY_EXCLUDE_ROOT
  if (excluded && isWithin(excluded, absolute)) return null
  return locked(root, async () => {
    let info
    try {
      info = await stat(absolute)
    } catch (error) {
      if (errno(error) === 'ENOENT') return null
      throw error
    }
    if (!info.isFile() || info.size > RECOVERY_POLICY.maxFileBytes) return null
    await mkdir(root, { recursive: true, mode: 0o700 })
    // Recover from a previous interrupted prune before allocating another snapshot.
    let entries = await prune(root, await entriesIn(root))
    const bytes = await readStableFile(absolute, RECOVERY_POLICY.maxFileBytes)
    const digest = hash(bytes)
    const last = entries.find((entry) => pathKey(entry.originalPath) === pathKey(absolute))
    if (last?.sha256 === digest) {
      const stored = await readStableFile(
        join(root, `${last.id}.bin`),
        RECOVERY_POLICY.maxFileBytes,
        last.bytes,
      )
      if (hash(stored) !== digest)
        throw new Error(
          'Existing recovery data failed its integrity check. The document was not overwritten.',
        )
      return last
    }
    entries = await reserveSnapshotRoom(root, entries, bytes.length, absolute)
    const entry: RecoveryEntry = {
      id: randomUUID(),
      originalPath: absolute,
      fileName: basename(absolute),
      createdAt: new Date(
        Math.max(Date.now(), entries.length ? Date.parse(entries[0]!.createdAt) + 1 : 0),
      ).toISOString(),
      bytes: bytes.length,
      sha256: digest,
    }
    const blob = join(root, `${entry.id}.bin`)
    const metadata = join(root, `${entry.id}.json`)
    const pending = `${metadata}.tmp`
    try {
      await writeFile(blob, bytes, { flag: 'wx', mode: 0o600 })
      await flushFile(blob)
      await writeFile(pending, JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
      await flushFile(pending)
      await rename(pending, metadata)
    } catch (error) {
      await unlink(pending).catch(() => {})
      await unlink(blob).catch(() => {})
      throw error
    }
    await prune(root, [entry, ...entries], entry.id)
    return entry
  })
}

/** Verify content and publish a NEW file only; never replace an original or another existing file. */
export async function restoreRecoveryCopy(
  root: string,
  id: string,
  destination: string,
): Promise<void> {
  if (!ID.test(id)) throw new Error('Invalid recovery entry')
  return locked(root, async () => {
    const entry = (await entriesIn(root)).find((candidate) => candidate.id === id)
    if (!entry) throw new Error('The recovery entry no longer exists')
    if (pathKey(destination) === pathKey(entry.originalPath))
      throw new Error('Recovery must be saved as a new copy, not over the original')
    const bytes = await readStableFile(
      join(root, `${id}.bin`),
      RECOVERY_POLICY.maxFileBytes,
      entry.bytes,
    )
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
      throw new Error('Recovery data failed its integrity check')
    const temp = join(
      dirname(resolve(destination)),
      `${basename(destination)}.${randomUUID()}.recovery.tmp`,
    )
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let ownsTemp = false
    try {
      handle = await open(temp, 'wx', 0o600)
      ownsTemp = true
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      // A hard link publishes exclusively and atomically on the destination filesystem.
      // Refuse filesystems without this facility rather than race an overwrite via rename.
      await link(temp, resolve(destination))
    } finally {
      await handle?.close().catch(() => {})
      if (ownsTemp) await unlink(temp).catch(() => {})
    }
  })
}
