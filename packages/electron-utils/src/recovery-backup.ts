import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { listRecoveryEntries, readRecoveryEntry, type RecoveryEntry } from './recovery-vault'
import { publishExclusiveCopy } from './publish-exclusive'

const MAGIC = Buffer.from('VANTAGE-BACKUP1\0')
const MAX_BACKUP_BYTES = 384 * 1024 * 1024
const MAX_PLAIN_BYTES = 256 * 1024 * 1024
const MAX_ENTRY_BYTES = 32 * 1024 * 1024
const derive = promisify(scrypt)
interface BackupRecord { entry: RecoveryEntry; base64: string }
interface BackupData { format: 'vantage-recovery-backup'; version: 1; createdAt: string; records: BackupRecord[] }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

async function passwordKey(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024)
    throw new Error('Use a backup password between 8 and 1,024 characters')
  // Node defaults: scrypt N=16384, r=8, p=1. The versioned format fixes these
  // parameters; an untrusted backup can never select its own memory/work factor.
  return await derive(password.normalize('NFC'), salt, 32) as Buffer
}

async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > MAX_BACKUP_BYTES || before.size < MAGIC.length + 44)
      throw new Error('Recovery backup exceeds its size limit or is incomplete')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) throw new Error('Recovery backup changed while being read')
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Recovery backup changed while being read')
    return bytes
  } finally { await handle.close() }
}

async function publishNewCopy(destination: string, bytes: Buffer): Promise<void> {
  const temp = join(dirname(resolve(destination)), `${basename(destination)}.${randomUUID()}.backup.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let owned = false
  try {
    handle = await open(temp, 'wx', 0o600)
    owned = true
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await publishExclusiveCopy(temp, resolve(destination), { bytes: bytes.length, sha256: digest(bytes) })
  } finally {
    await handle?.close().catch(() => {})
    if (owned) await unlink(temp).catch(() => {})
  }
}

/** A portable encrypted export of saved-version history, separate from complete system backup. */
export async function exportRecoveryBackup(root: string, destination: string, password: string): Promise<{ entries: number; bytes: number }> {
  const rootPath = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
  const destinationPath = process.platform === 'win32' ? resolve(destination).toLowerCase() : resolve(destination)
  const child = relative(rootPath, destinationPath)
  if (child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)))
    throw new Error('Choose a backup destination outside the recovery storage folder')
  const records: BackupRecord[] = []
  let expanded = 0
  const entries = await listRecoveryEntries(root)
  if (entries.some((entry) => samePath(destination, entry.originalPath))) throw new Error('A recovery backup must use a separate new destination')
  for (const entry of entries) {
    const verified = await readRecoveryEntry(root, entry.id)
    expanded += verified.bytes.length
    if (expanded > 128 * 1024 * 1024) throw new Error('Portable recovery export is limited to 128 MiB of document payload')
    // Local cipher metadata has no meaning in a password-protected portable copy.
    const { encryption: _encryption, storedBytes: _storedBytes, ...portable } = verified.entry
    records.push({ entry: portable, base64: verified.bytes.toString('base64') })
  }
  const data: BackupData = { format: 'vantage-recovery-backup', version: 1, createdAt: new Date().toISOString(), records }
  const plain = Buffer.from(JSON.stringify(data))
  if (plain.length > MAX_PLAIN_BYTES) throw new Error('Portable recovery backup exceeds its serialization limit')
  const salt = randomBytes(16), nonce = randomBytes(12)
  const key = await passwordKey(password, salt)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.concat([MAGIC, salt]))
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const output = Buffer.concat([MAGIC, salt, nonce, cipher.getAuthTag(), encrypted])
    await publishNewCopy(destination, output)
    return { entries: records.length, bytes: output.length }
  } finally { key.fill(0); plain.fill(0) }
}

async function openBackup(path: string, password: string): Promise<BackupData> {
  const bytes = await readBounded(path)
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unsupported recovery backup format')
  const salt = bytes.subarray(MAGIC.length, MAGIC.length + 16)
  const nonce = bytes.subarray(MAGIC.length + 16, MAGIC.length + 28)
  const tag = bytes.subarray(MAGIC.length + 28, MAGIC.length + 44)
  const key = await passwordKey(password, salt)
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.concat([MAGIC, salt]))
    decipher.setAuthTag(tag)
    try { plain = Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 44)), decipher.final()]) }
    catch { throw new Error('The backup password is incorrect or the backup was altered') }
  } finally { key.fill(0) }
  if (plain.length > MAX_PLAIN_BYTES) throw new Error('Recovery backup exceeds its expanded limit')
  let data: BackupData
  try { data = JSON.parse(plain.toString('utf8')) as BackupData }
  finally { plain.fill(0) }
  if (data?.format !== 'vantage-recovery-backup' || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 384 || !Number.isFinite(Date.parse(data.createdAt)))
    throw new Error('Invalid recovery backup manifest')
  const ids = new Set<string>()
  let expanded = 0
  for (const record of data.records) {
    const entry = record?.entry
    if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id) ||
        typeof entry.originalPath !== 'string' || !isAbsolute(entry.originalPath) || entry.fileName !== basename(entry.originalPath) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_ENTRY_BYTES ||
        !Number.isFinite(Date.parse(entry.createdAt)) || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        typeof record.base64 !== 'string' || record.base64.length > Math.ceil(MAX_ENTRY_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.base64))
      throw new Error('Invalid recovery backup entry')
    const content = Buffer.from(record.base64, 'base64')
    if (content.length !== entry.bytes || digest(content) !== entry.sha256) throw new Error('Recovery backup content failed its integrity check')
    expanded += content.length
    if (expanded > 128 * 1024 * 1024) throw new Error('Recovery backup exceeds its payload limit')
    ids.add(entry.id)
  }
  return data
}

export async function inspectRecoveryBackup(path: string, password: string): Promise<{ createdAt: string; entries: RecoveryEntry[] }> {
  const data = await openBackup(path, password)
  return { createdAt: data.createdAt, entries: data.records.map((record) => record.entry) }
}

/** Restore drills use a new copy and compare the authenticated SHA256; originals are never overwritten. */
export async function restoreBackupCopy(path: string, password: string, id: string, destination: string): Promise<void> {
  const data = await openBackup(path, password)
  if (samePath(path, destination) || data.records.some((record) => samePath(destination, record.entry.originalPath)))
    throw new Error('Backup recovery must use a new copy separate from every original document')
  const record = data.records.find((record) => record.entry.id === id)
  if (!record) throw new Error('That document is not present in this recovery backup')
  await publishNewCopy(destination, Buffer.from(record.base64, 'base64'))
}
