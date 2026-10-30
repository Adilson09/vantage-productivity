import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { recoveryCipherFor } from './recovery-encryption'
import { assertRecoveryFreeSpace, getRecoveryPolicy } from './recovery-policy'
import { publishExclusiveCopy } from './publish-exclusive'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_DRAFT_BYTES = 16 * 1024 * 1024
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024
const MAX_DRAFTS = 64
const modules = new Set(['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'])
const extensions = new Set([
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
  '.vpdfdraft',
  '.md',
  '.html',
  '.txt',
  '.json',
])
export interface DraftEntry {
  id: string
  module: string
  documentPath: string | null
  extension: string
  createdAt: string
  updatedAt: string
  bytes: number
  storedBytes: number
  sha256: string
  payload: string
  encrypted: boolean
}
const registry = globalThis as typeof globalThis & {
  __vantageDraftLocks?: Map<string, Promise<unknown>>
  __vantageDraftEpochs?: Map<string, number>
}
const locks = (registry.__vantageDraftLocks ??= new Map<string, Promise<unknown>>())
const epochs = (registry.__vantageDraftEpochs ??= new Map<string, number>())
const canonical = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const epochKey = (root: string, id: string) => `${canonical(root)}:${id}`
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const directory = (root: string) => join(root, 'drafts')
async function locked<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = canonical(root),
    prior = locks.get(key) ?? Promise.resolve()
  const pending = prior.catch(() => {}).then(operation)
  locks.set(key, pending)
  try {
    return await pending
  } finally {
    if (locks.get(key) === pending) locks.delete(key)
  }
}
async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum) throw new Error('Draft data exceeds its limit')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!part.bytesRead) throw new Error('Draft data changed while being read')
      offset += part.bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Draft data changed while being read')
    return bytes
  } finally {
    await handle.close()
  }
}
function validate(value: unknown): value is DraftEntry {
  if (!value || typeof value !== 'object') return false
  const item = value as DraftEntry
  return (
    ID.test(item.id) &&
    modules.has(item.module) &&
    extensions.has(item.extension) &&
    (item.documentPath === null ||
      (typeof item.documentPath === 'string' && isAbsolute(item.documentPath))) &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    Number.isFinite(Date.parse(item.updatedAt)) &&
    Number.isSafeInteger(item.bytes) &&
    item.bytes >= 0 &&
    item.bytes <= MAX_DRAFT_BYTES &&
    Number.isSafeInteger(item.storedBytes) &&
    item.storedBytes >= item.bytes &&
    item.storedBytes <= MAX_DRAFT_BYTES + 128 &&
    /^[a-f0-9]{64}$/.test(item.sha256) &&
    typeof item.encrypted === 'boolean' &&
    typeof item.payload === 'string' &&
    item.payload.startsWith(`${item.id}.`) &&
    item.payload.endsWith('.bin') &&
    ID.test(item.payload.slice(item.id.length + 1, -4))
  )
}
async function entriesIn(root: string): Promise<DraftEntry[]> {
  let files: string[]
  try {
    files = await readdir(directory(root))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
  if (files.length > 512) throw new Error('Draft journal exceeds its inspection limit')
  const result: DraftEntry[] = []
  for (const file of files) {
    if (!file.endsWith('.json') || !ID.test(file.slice(0, -5))) continue
    try {
      const data: unknown = JSON.parse(
        (await readBounded(join(directory(root), file), 16 * 1024)).toString('utf8'),
      )
      if (!validate(data) || data.id !== file.slice(0, -5)) continue
      const payload = await stat(join(directory(root), data.payload))
      if (payload.isFile() && payload.size === data.storedBytes) result.push(data)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code && code !== 'ENOENT') throw error
    }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
export async function listDraftJournal(root: string): Promise<DraftEntry[]> {
  return locked(root, () => entriesIn(root))
}
async function bytesFor(root: string, entry: DraftEntry, keyRoot = root): Promise<Buffer> {
  const payload = await readBounded(join(directory(root), entry.payload), MAX_DRAFT_BYTES + 128)
  const cipher = recoveryCipherFor(keyRoot)
  if (entry.encrypted && !cipher)
    throw new Error('Unlock OS-protected recovery storage to read this draft')
  const bytes = entry.encrypted ? cipher!.decrypt(payload) : payload
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
    throw new Error('Draft data failed its integrity check')
  return bytes
}
export async function readDraftJournal(
  root: string,
  id: string,
): Promise<{ entry: DraftEntry; bytes: Buffer }> {
  if (!ID.test(id)) throw new Error('Invalid draft identifier')
  return locked(root, async () => {
    const entry = (await entriesIn(root)).find((entry) => entry.id === id)
    if (!entry) throw new Error('That draft no longer exists')
    return { entry, bytes: await bytesFor(root, entry) }
  })
}
export async function writeDraftJournal(
  root: string,
  request: {
    id: string
    module: string
    documentPath: string | null
    extension: string
    bytes: Buffer
  },
): Promise<DraftEntry | null> {
  if (
    !ID.test(request.id) ||
    !modules.has(request.module) ||
    !extensions.has(request.extension) ||
    (request.documentPath !== null && !isAbsolute(request.documentPath)) ||
    request.bytes.length > MAX_DRAFT_BYTES
  )
    throw new Error('Invalid draft or draft exceeds its 16 MiB limit')
  const key = epochKey(root, request.id),
    epoch = epochs.get(key) ?? 0
  return locked(root, async () => {
    if ((epochs.get(key) ?? 0) !== epoch) return null
    await mkdir(directory(root), { recursive: true, mode: 0o700 })
    const entries = await entriesIn(root)
    const previous = entries.find((entry) => entry.id === request.id)
    const sha256 = digest(request.bytes)
    if (previous?.sha256 === sha256 && previous.documentPath === request.documentPath) {
      await bytesFor(root, previous)
      return previous
    }
    if (!previous && entries.length >= MAX_DRAFTS)
      throw new Error('The draft journal is full; recover or discard older drafts first')
    const cipher = recoveryCipherFor(root)
    if (
      !cipher &&
      (await stat(join(root, 'protected-key.bin')).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
          throw error
        },
      ))
    )
      throw new Error('Unlock OS-protected recovery storage before recording another draft')
    const payload = cipher ? cipher.encrypt(request.bytes) : request.bytes
    let occupied = 0
    for (const file of await readdir(directory(root)))
      occupied += (await stat(join(directory(root), file))).size
    if (occupied + payload.length + 16 * 1024 > MAX_JOURNAL_BYTES)
      throw new Error('The bounded draft journal is full')
    await assertRecoveryFreeSpace(root, payload.length + 16 * 1024, await getRecoveryPolicy(root))
    const now = new Date().toISOString()
    const entry: DraftEntry = {
      id: request.id,
      module: request.module,
      documentPath: request.documentPath,
      extension: request.extension,
      bytes: request.bytes.length,
      storedBytes: payload.length,
      sha256,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      payload: `${request.id}.${randomUUID()}.bin`,
      encrypted: !!cipher,
    }
    const blob = join(directory(root), entry.payload)
    const pending = join(directory(root), `${entry.id}.${randomUUID()}.tmp`)
    let committed = false
    try {
      await writeFile(blob, payload, { flag: 'wx', mode: 0o600 })
      let handle = await open(blob, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await writeFile(pending, JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
      handle = await open(pending, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      if ((epochs.get(key) ?? 0) !== epoch) return null
      await rename(pending, join(directory(root), `${entry.id}.json`))
      committed = true
      if (previous) await unlink(join(directory(root), previous.payload)).catch(() => {})
      return entry
    } finally {
      await unlink(pending).catch(() => {})
      if (!committed) await unlink(blob).catch(() => {})
    }
  })
}
export async function discardDraftJournal(
  root: string,
  id: string,
  options: { expectedSha256?: string } = {},
): Promise<void> {
  if (!ID.test(id)) throw new Error('Invalid draft identifier')
  if (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedSha256))
    throw new Error('Invalid expected draft hash')
  const key = epochKey(root, id)
  if (options.expectedSha256 === undefined) epochs.set(key, (epochs.get(key) ?? 0) + 1)
  return locked(root, async () => {
    const entry = (await entriesIn(root)).find((entry) => entry.id === id)
    if (options.expectedSha256 !== undefined) {
      if (!entry) {
        const metadata = await stat(join(directory(root), `${id}.json`)).then(
          () => true,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
            throw error
          },
        )
        const names = await readdir(directory(root)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
          throw error
        })
        if (metadata || names.some((name) => name.startsWith(`${id}.`) && name.endsWith('.bin')))
          throw new Error(
            'The current draft is incomplete; conditional cleanup preserved its bytes.',
          )
        return
      }
      // Verify the actual complete payload (including authenticated recovery
      // decryption), not imported metadata or a caller-provided original path.
      const actual = await bytesFor(root, entry)
      if (digest(actual) !== options.expectedSha256)
        throw new Error(
          'The draft changed after restoration; conditional cleanup preserved the newer entry.',
        )
      // Mismatch/absence cannot invalidate a concurrent newer writer's epoch.
      epochs.set(key, (epochs.get(key) ?? 0) + 1)
    }
    await unlink(join(directory(root), `${id}.json`)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    })
    if (entry)
      await unlink(join(directory(root), entry.payload)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      })
  })
}
export async function restoreDraftCopy(
  root: string,
  id: string,
  destination: string,
): Promise<void> {
  const { entry, bytes } = await readDraftJournal(root, id)
  if (entry.documentPath && canonical(destination) === canonical(entry.documentPath))
    throw new Error('Recover the draft to a new copy')
  const temp = join(
    dirname(resolve(destination)),
    `${basename(destination)}.${randomUUID()}.draft.tmp`,
  )
  let owns = false
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, 'wx', 0o600)
    owns = true
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await publishExclusiveCopy(temp, resolve(destination), {
      bytes: bytes.length,
      sha256: digest(bytes),
    })
  } finally {
    await handle?.close().catch(() => {})
    if (owns) await unlink(temp).catch(() => {})
  }
}

export interface DraftCustodyCapture {
  id: string
  module: string
  documentPath: string | null
  sha256: string
  payload: string
  bytes: number
  metadataSha256: string
  payloadSha256: string
  encrypted: boolean
}
/** Copy exact protected on-disk bytes under the journal lock; no plaintext backup. */
export async function captureDraftJournalCustody(
  root: string,
  id: string,
  targetRoot: string,
  signal?: AbortSignal,
  expected?: { module: string; documentPath: string | null; sha256?: string } | null,
  reserve?: (bytes: number) => void,
): Promise<DraftCustodyCapture | null> {
  if (!ID.test(id) || !isAbsolute(targetRoot) || canonical(root) === canonical(targetRoot))
    throw new Error('Invalid recovery custody destination.')
  return locked(root, async () => {
    signal?.throwIfAborted()
    const entry = (await entriesIn(root)).find((value) => value.id === id)
    if (!entry) {
      const metadata = await stat(join(directory(root), `${id}.json`)).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
          throw error
        },
      )
      const names = await readdir(directory(root)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
        throw error
      })
      if (metadata || names.some((name) => name.startsWith(`${id}.`) && name.endsWith('.bin')))
        throw new Error('The captured draft is incomplete; its existing bytes are retained.')
      return null
    }
    if (expected === null)
      throw new Error(
        'A complete journal exists without a corroborating main-owned write binding; its bytes are retained.',
      )
    if (
      expected &&
      (entry.module !== expected.module ||
        (entry.documentPath === null || expected.documentPath === null
          ? entry.documentPath !== expected.documentPath
          : canonical(entry.documentPath) !== canonical(expected.documentPath)))
    )
      throw new Error(
        'The captured journal does not match the main-owned stored module/path binding; its original bytes are retained.',
      )
    const metadata = await readBounded(join(directory(root), `${id}.json`), 16 * 1024)
    const parsed: unknown = JSON.parse(metadata.toString('utf8'))
    if (
      !validate(parsed) ||
      parsed.id !== id ||
      parsed.payload !== entry.payload ||
      parsed.module !== entry.module ||
      parsed.documentPath !== entry.documentPath ||
      parsed.sha256 !== entry.sha256
    )
      throw new Error('The captured draft changed during custody preparation.')
    const payload = await readBounded(join(directory(root), entry.payload), MAX_DRAFT_BYTES + 128)
    if (payload.length !== entry.storedBytes)
      throw new Error('The captured draft payload is incomplete.')
    // Existing journal integrity/protection must be valid; the backup itself is
    // still byte-for-byte encrypted whenever the original is encrypted.
    const cipher = recoveryCipherFor(root)
    if (entry.encrypted && !cipher)
      throw new Error('Unlock protected recovery storage before preparing custody.')
    const complete = entry.encrypted ? cipher!.decrypt(payload) : payload
    if (complete.length !== entry.bytes || digest(complete) !== entry.sha256)
      throw new Error('The complete captured journal failed its integrity check.')
    if (!expected?.sha256)
      throw new Error(
        'The complete journal has no corroborating main-owned payload hash; existing bytes are retained.',
      )
    if (digest(complete) !== expected.sha256)
      throw new Error(
        'The captured journal changed after the main-owned write; existing bytes are retained.',
      )
    signal?.throwIfAborted()
    await assertRecoveryFreeSpace(
      root,
      metadata.length + payload.length + 16 * 1024,
      await getRecoveryPolicy(root),
    )
    reserve?.(metadata.length + payload.length)
    await mkdir(directory(targetRoot), { recursive: true, mode: 0o700 })
    const writeOwned = async (name: string, bytes: Buffer) => {
      signal?.throwIfAborted()
      const handle = await open(join(directory(targetRoot), name), 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      signal?.throwIfAborted()
    }
    await writeOwned(entry.payload, payload)
    await writeOwned(`${id}.json`, metadata)
    return {
      id,
      module: entry.module,
      documentPath: entry.documentPath,
      sha256: entry.sha256,
      payload: entry.payload,
      bytes: metadata.length + payload.length,
      metadataSha256: digest(metadata),
      payloadSha256: digest(payload),
      encrypted: entry.encrypted,
    }
  })
}

export interface DraftCustodyRestoreOptions {
  expected: { module: string; documentPath: string | null; sha256: string }
  signal?: AbortSignal
  beforePublication?(): void
  created?(): void
}
/** A separate exclusive output may be partial after a crash; never delete a changed output path. */
export async function restoreDraftCustodyCopy(
  custodyRoot: string,
  keyRoot: string,
  id: string,
  destination: string,
  options: DraftCustodyRestoreOptions,
): Promise<{ entry: DraftEntry; sha256: string }> {
  if (!ID.test(id) || !isAbsolute(destination) || !options?.expected)
    throw new Error('Invalid bound custody restoration request.')
  options.signal?.throwIfAborted()
  const entry = (await entriesIn(custodyRoot)).find((value) => value.id === id)
  if (!entry) throw new Error('The retained custody copy is incomplete.')
  const expected = options.expected
  if (
    entry.module !== expected.module ||
    (entry.documentPath === null || expected.documentPath === null
      ? entry.documentPath !== expected.documentPath
      : canonical(entry.documentPath) !== canonical(expected.documentPath))
  )
    throw new Error('Retained custody no longer matches its verified stored lineage.')
  if (entry.documentPath && canonical(destination) === canonical(entry.documentPath))
    throw new Error('Restore retained custody to a separate copy.')
  const bytes = await bytesFor(custodyRoot, entry, keyRoot)
  if (digest(bytes) !== expected.sha256)
    throw new Error('Retained custody no longer matches its verified complete payload hash.')
  options.signal?.throwIfAborted()
  options.beforePublication?.()
  const output = await open(resolve(destination), 'wx', 0o600)
  let failed = false
  try {
    options.created?.()
    options.signal?.throwIfAborted()
    await output.writeFile(bytes)
    await output.sync()
    options.signal?.throwIfAborted()
    // Verification reads the visible path conservatively. A competing editor's
    // replacement refuses trust; it is preserved rather than rolled back.
    const visible = await readBounded(resolve(destination), MAX_DRAFT_BYTES)
    if (visible.length !== bytes.length || digest(visible) !== expected.sha256)
      throw new Error(
        'The separate output changed before its trusted handoff; its current contents are retained.',
      )
    return { entry, sha256: entry.sha256 }
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      await output.close()
    } catch (error) {
      if (!failed) throw error
    }
  }
}
