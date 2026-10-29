import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWriteFile, atomicWriteVia, AtomicSaveError, getLastAtomicSaveReport, publishCompletedFile, readAtomicFileVersion, withAtomicSaveQueue } from '../src/atomic-write'
import { captureRecoverySnapshot, getRecoveryPolicy, getRecoveryVaultStatus, listRecoveryEntries, previewRecoveryEntry, readRecoveryEntry, restoreRecoveryCopy, setRecoveryPolicy } from '../src/recovery-vault'
import { createRecoveryCipher, enableRecoveryEncryption, setRecoveryCipher } from '../src/recovery-encryption'
import { exportRecoveryBackup, inspectRecoveryBackup, restoreBackupCopy } from '../src/recovery-backup'
import { discardDraftJournal, listDraftJournal, readDraftJournal, restoreDraftCopy, writeDraftJournal } from '../src/draft-journal'

// These cases fsync real storage; removable exFAT drives can need several
// seconds per commit. Keep the deadline bounded without mistaking I/O latency
// for a contract failure.
vi.setConfig({ testTimeout: 30_000 })

const capacity = vi.hoisted(() => ({ free: null as bigint | null }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, statfs: async (...args: Parameters<typeof real.statfs>) => capacity.free === null ? real.statfs(...args) : ({ bavail: capacity.free, bsize: 1n }) }
})
const prefix = join(tmpdir(), 'vantage-enhanced-recovery-')
let dir: string, root: string, oldRoot: string | undefined
beforeEach(async () => {
  dir = await mkdtemp(prefix); root = join(dir, 'vault')
  oldRoot = process.env.VANTAGE_RECOVERY_ROOT
  process.env.VANTAGE_RECOVERY_ROOT = root
  capacity.free = null
})
afterEach(async () => {
  setRecoveryCipher(root, null)
  if (oldRoot === undefined) delete process.env.VANTAGE_RECOVERY_ROOT
  else process.env.VANTAGE_RECOVERY_ROOT = oldRoot
  if (!dir.startsWith(prefix)) throw new Error('Unexpected cleanup location')
  await rm(dir, { recursive: true, force: true })
})

describe('first publication and bounded preferences', () => {
  it('captures the first saved bytes, then deduplicates the same baseline before the second save', async () => {
    const path = join(dir, 'new.md')
    await atomicWriteFile(path, Buffer.from('first saved document'))
    expect(getLastAtomicSaveReport(path)).toEqual({ published: true, recovery: 'first-save' })
    const [baseline] = await listRecoveryEntries(root)
    expect(baseline!.kind).toBe('first-save')
    await atomicWriteFile(path, Buffer.from('second saved document'))
    expect(await listRecoveryEntries(root)).toHaveLength(1)
    const destination = join(dir, 'baseline.md')
    await restoreRecoveryCopy(root, baseline!.id, destination)
    expect(await readFile(destination, 'utf8')).toBe('first saved document')
    expect(await readFile(path, 'utf8')).toBe('second saved document')
  })
  it('reports first-baseline failure as a history warning after a successful publication', async () => {
    const path = join(dir, 'new.md')
    capacity.free = 0n
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await atomicWriteFile(path, Buffer.from('published bytes'))
      expect(await readFile(path, 'utf8')).toBe('published bytes')
      expect(getLastAtomicSaveReport(path)).toMatchObject({ published: true, recovery: 'failed', warning: expect.stringContaining('document was saved') })
    } finally { warning.mockRestore() }
  })
  it('persists safe settings and prunes using the configured revision budget', async () => {
    await setRecoveryPolicy(root, { maxRevisionsPerFile: 2, maxEntries: 4, minFreeBytes: 0 })
    const path = join(dir, 'report.md')
    for (let revision = 0; revision < 4; revision++) {
      await writeFile(path, `revision ${revision}`)
      await captureRecoverySnapshot(path)
    }
    expect((await getRecoveryPolicy(root)).maxRevisionsPerFile).toBe(2)
    const entries = await listRecoveryEntries(root)
    expect(entries).toHaveLength(2)
    const status = await getRecoveryVaultStatus(root)
    expect(status.entries).toBe(2)
    expect(status.payloadBytes).toBe(20)
    expect(status.occupiedBytes).toBeGreaterThan(status.payloadBytes)
    expect(status.orphanBytes).toBe(0)
  })
  it('rejects policies above hard ceilings or an impossible per-document budget', async () => {
    await expect(setRecoveryPolicy(root, { maxEntries: 500 })).rejects.toThrow('range')
    await expect(setRecoveryPolicy(root, { maxVaultBytes: 1 })).rejects.toThrow('per-document')
    await expect(setRecoveryPolicy(root, { maxRevisionsPerFile: -1 })).rejects.toThrow('range')
    await expect(setRecoveryPolicy(root, { surprise: true } as never)).rejects.toThrow('Unknown')
    await expect(setRecoveryPolicy(root, JSON.parse('{"__proto__":1}'))).rejects.toThrow('Unknown')
  })
  it('respects the disk reserve before overwriting the current document', async () => {
    const path = join(dir, 'report.md')
    await writeFile(path, 'old bytes')
    capacity.free = 1n
    await expect(atomicWriteFile(path, Buffer.from('new bytes'))).rejects.toThrow('free disk space')
    expect(await readFile(path, 'utf8')).toBe('old bytes')
  })
  it('previews verified text while keeping Office bytes out of a misleading text preview', async () => {
    const path = join(dir, 'report.md')
    await writeFile(path, 'inspect this text')
    const entry = await captureRecoverySnapshot(path)
    expect(await previewRecoveryEntry(root, entry!.id)).toMatchObject({ text: 'inspect this text', truncated: false })
    const office = join(dir, 'report.docx')
    await writeFile(office, 'opaque Office container')
    const officeEntry = await captureRecoverySnapshot(office)
    expect((await previewRecoveryEntry(root, officeEntry!.id)).text).toBeNull()
    await writeFile(join(root, `${entry!.id}.bin`), Buffer.alloc(entry!.bytes, 'X'))
    await expect(previewRecoveryEntry(root, entry!.id)).rejects.toThrow('integrity')
  })
})

describe('shared save conflict contract', () => {
  it('refuses a stale loaded fingerprint and retains a complete separate rescue file', async () => {
    const path = join(dir, 'report.md')
    await writeFile(path, 'original document')
    const version = await readAtomicFileVersion(path)
    await writeFile(path, 'external changed document')
    const error = await atomicWriteFile(path, Buffer.from('local edits'), { expectedVersion: version }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AtomicSaveError)
    expect(error).toMatchObject({ code: 'VANTAGE_SAVE_CONFLICT', vantageCode: 'SAVE_NOT_PUBLISHED' })
    expect(await readFile(path, 'utf8')).toBe('external changed document')
    expect(await readFile((error as AtomicSaveError).recoveryPath, 'utf8')).toBe('local edits')
  })
  it('detects another writer changing the destination during a streaming save', async () => {
    const path = join(dir, 'report.md')
    await writeFile(path, 'before streaming')
    const error = await atomicWriteVia(path, async (temp) => {
      await writeFile(temp, 'completed streamed edits')
      await writeFile(path, 'outside edits')
    }).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'VANTAGE_SAVE_CONFLICT' })
    expect(await readFile(path, 'utf8')).toBe('outside edits')
    expect(await readFile((error as AtomicSaveError).recoveryPath, 'utf8')).toBe('completed streamed edits')
  })
  it('does not recreate a destination another program deleted during serialization', async () => {
    const path = join(dir, 'report.md')
    await writeFile(path, 'before deletion')
    const error = await atomicWriteVia(path, async (temp) => {
      await writeFile(temp, 'my edits')
      await rm(path)
    }).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'VANTAGE_SAVE_CONFLICT' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile((error as AtomicSaveError).recoveryPath, 'utf8')).toBe('my edits')
  })
  it('keeps a caller-declared new destination exclusive if a file appears before save', async () => {
    const path = join(dir, 'report.md')
    await writeFile(path, 'someone else created this')
    await expect(atomicWriteFile(path, Buffer.from('my new file'), { expectedVersion: null })).rejects.toMatchObject({ code: 'VANTAGE_SAVE_CONFLICT' })
    expect(await readFile(path, 'utf8')).toBe('someone else created this')
  })
  it('inherits the native serializer fingerprint in a nested publisher without deadlocking', async () => {
    const path = join(dir, 'book.xlsx'), temp = join(dir, 'native.tmp')
    await writeFile(path, 'original')
    const error = await withAtomicSaveQueue(path, async () => {
      await writeFile(temp, 'complete native output')
      await writeFile(path, 'outside change')
      await publishCompletedFile(temp, path)
    }).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'VANTAGE_SAVE_CONFLICT', recoveryPath: temp })
    expect(await readFile(temp, 'utf8')).toBe('complete native output')
    expect(await readFile(path, 'utf8')).toBe('outside change')
  })
})

describe('authenticated local recovery encryption', () => {
  it('encrypts payload bytes and refuses tampering or the wrong key', async () => {
    const key = randomBytes(32)
    const cipher = createRecoveryCipher(key)
    const plain = Buffer.from('private content')
    const encrypted = cipher.encrypt(plain)
    expect(encrypted.includes(plain)).toBe(false)
    expect(cipher.decrypt(encrypted)).toEqual(plain)
    const wrong = createRecoveryCipher(randomBytes(32))
    expect(() => wrong.decrypt(encrypted)).toThrow('key')
    encrypted[encrypted.length - 1] ^= 1
    expect(() => cipher.decrypt(encrypted)).toThrow('altered')
  })
  it('stores encrypted snapshots, verifies plaintext hashes, and restores a separate copy', async () => {
    setRecoveryCipher(root, createRecoveryCipher(randomBytes(32)))
    const path = join(dir, 'private.md')
    await writeFile(path, 'secret document')
    const entry = await captureRecoverySnapshot(path)
    expect(entry).toMatchObject({ encryption: 'aes-256-gcm', bytes: 15 })
    expect((await readFile(join(root, `${entry!.id}.bin`))).includes(Buffer.from('secret document'))).toBe(false)
    expect((await readRecoveryEntry(root, entry!.id)).bytes.toString()).toBe('secret document')
    await restoreRecoveryCopy(root, entry!.id, join(dir, 'copy.md'))
    expect(await readFile(join(dir, 'copy.md'), 'utf8')).toBe('secret document')
    setRecoveryCipher(root, null)
    await expect(readRecoveryEntry(root, entry!.id)).rejects.toThrow('Unlock')
  })
  it('persists only the OS-protected key and fails closed if an encrypted vault was not unlocked', async () => {
    // The test keystore is reversible solely to test the adapter contract; no production fallback exists.
    const store = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`protected:${value}`), decryptString: (value: Buffer) => value.toString().slice(10) }
    await enableRecoveryEncryption(root, store)
    const path = join(dir, 'protected.md')
    await writeFile(path, 'one')
    const entry = await captureRecoverySnapshot(path)
    setRecoveryCipher(root, null)
    await writeFile(path, 'two')
    await expect(captureRecoverySnapshot(path)).rejects.toThrow('Unlock')
    await enableRecoveryEncryption(root, store)
    expect((await readRecoveryEntry(root, entry!.id)).bytes.toString()).toBe('one')
    await expect(enableRecoveryEncryption(root, { ...store, isEncryptionAvailable: () => false })).rejects.toThrow('unavailable')
    await expect(enableRecoveryEncryption(root, { ...store, getSelectedStorageBackend: () => 'basic_text' })).rejects.toThrow('does not provide')
  })
})

describe('portable password protected history backup', () => {
  it('performs an export, independent password unlock and exact-byte restore drill', async () => {
    setRecoveryCipher(root, createRecoveryCipher(randomBytes(32)))
    const path = join(dir, 'report.md'), backup = join(dir, 'history.vantagebackup')
    await writeFile(path, 'version to protect')
    const entry = await captureRecoverySnapshot(path)
    expect(await exportRecoveryBackup(root, backup, 'a strong test password')).toMatchObject({ entries: 1 })
    expect((await readFile(backup)).includes(Buffer.from('version to protect'))).toBe(false)
    setRecoveryCipher(root, null)
    const manifest = await inspectRecoveryBackup(backup, 'a strong test password')
    expect(manifest.entries[0]!.sha256).toBe(entry!.sha256)
    await restoreBackupCopy(backup, 'a strong test password', entry!.id, join(dir, 'restored.md'))
    expect(await readFile(join(dir, 'restored.md'), 'utf8')).toBe('version to protect')
    await expect(restoreBackupCopy(backup, 'a strong test password', entry!.id, path)).rejects.toThrow('separate')
  })
  it('refuses wrong passwords, altered backups and replacing an existing destination', async () => {
    const path = join(dir, 'report.md'), backup = join(dir, 'history.vantagebackup')
    await writeFile(path, 'history bytes')
    await captureRecoverySnapshot(path)
    await exportRecoveryBackup(root, backup, 'test password 123')
    await expect(inspectRecoveryBackup(backup, 'wrong password')).rejects.toThrow('password')
    await expect(exportRecoveryBackup(root, backup, 'test password 123')).rejects.toMatchObject({ code: 'EEXIST' })
    const bytes = await readFile(backup)
    bytes[bytes.length - 1] ^= 1
    await writeFile(backup, bytes)
    await expect(inspectRecoveryBackup(backup, 'test password 123')).rejects.toThrow('altered')
    expect(await readFile(path, 'utf8')).toBe('history bytes')
  })
})

describe('bounded unsaved draft journal', () => {
  const request = (id: string = randomUUID(), bytes = Buffer.from('unsaved unnamed work')) => ({ id, module: 'markdown', documentPath: null, extension: '.md', bytes })
  it('journals unnamed work independently from saved versions and restores a separate copy', async () => {
    const draft = await writeDraftJournal(root, request())
    expect(await listRecoveryEntries(root)).toEqual([])
    expect(await listDraftJournal(root)).toHaveLength(1)
    expect((await readDraftJournal(root, draft!.id)).bytes.toString()).toBe('unsaved unnamed work')
    await restoreDraftCopy(root, draft!.id, join(dir, 'recovered.md'))
    expect(await readFile(join(dir, 'recovered.md'), 'utf8')).toBe('unsaved unnamed work')
    await expect(restoreDraftCopy(root, draft!.id, join(dir, 'recovered.md'))).rejects.toMatchObject({ code: 'EEXIST' })
  })
  it('updates one draft atomically, removes old payloads and verifies identical deduplication', async () => {
    const id = randomUUID()
    await writeDraftJournal(root, request(id, Buffer.from('one')))
    const latest = await writeDraftJournal(root, request(id, Buffer.from('two')))
    const duplicate = await writeDraftJournal(root, request(id, Buffer.from('two')))
    expect(duplicate!.payload).toBe(latest!.payload)
    expect((await readDraftJournal(root, id)).bytes.toString()).toBe('two')
    expect((await readdir(join(root, 'drafts'))).filter((file) => file.endsWith('.bin'))).toHaveLength(1)
    await discardDraftJournal(root, id)
    expect(await listDraftJournal(root)).toEqual([])
    expect(await readdir(join(root, 'drafts'))).toEqual([])
  })
  it('does not resurrect a draft if discard overtakes an in-flight journal request', async () => {
    const id = randomUUID()
    const pending = writeDraftJournal(root, request(id))
    const discard = discardDraftJournal(root, id)
    expect(await pending).toBeNull()
    await discard
    expect(await listDraftJournal(root)).toEqual([])
  })
  it('shares the OS-protected cipher and refuses corrupt draft bytes', async () => {
    setRecoveryCipher(root, createRecoveryCipher(randomBytes(32)))
    const draft = await writeDraftJournal(root, request())
    expect(draft!.encrypted).toBe(true)
    const path = join(root, 'drafts', draft!.payload)
    const bytes = await readFile(path)
    expect(bytes.includes(Buffer.from('unsaved unnamed work'))).toBe(false)
    bytes[bytes.length - 1] ^= 1
    await writeFile(path, bytes)
    await expect(readDraftJournal(root, draft!.id)).rejects.toThrow('altered')
  })
  it('rejects traversal identifiers, excessive payloads and original-path recovery', async () => {
    await expect(writeDraftJournal(root, request('../escape'))).rejects.toThrow('Invalid')
    await expect(writeDraftJournal(root, request(randomUUID(), Buffer.alloc(16 * 1024 * 1024 + 1)))).rejects.toThrow('limit')
    const path = join(dir, 'named.md')
    await writeFile(path, 'original')
    const draft = await writeDraftJournal(root, { ...request(), documentPath: path })
    await expect(restoreDraftCopy(root, draft!.id, path)).rejects.toThrow('new copy')
    expect(await readFile(path, 'utf8')).toBe('original')
  })
})
