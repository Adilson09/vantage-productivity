import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const MAGIC = Buffer.from('VANTAGE-GCM1\0')
export interface RecoveryCipher {
  encrypt(bytes: Buffer): Buffer
  decrypt(bytes: Buffer): Buffer
}
const registry = globalThis as typeof globalThis & {
  __vantageRecoveryCiphers?: Map<string, RecoveryCipher>
}
const ciphers = (registry.__vantageRecoveryCiphers ??= new Map<string, RecoveryCipher>())
const keyFor = (root: string) =>
  process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)

export function setRecoveryCipher(root: string, cipher: RecoveryCipher | null): void {
  if (cipher) ciphers.set(keyFor(root), cipher)
  else ciphers.delete(keyFor(root))
}
export function recoveryCipherFor(root: string): RecoveryCipher | undefined {
  return ciphers.get(keyFor(root))
}
export function isEncryptedRecoveryPayload(bytes: Buffer): boolean {
  return bytes.subarray(0, MAGIC.length).equals(MAGIC)
}
/** AES-GCM authenticates both the format version and the payload. Keys stay in main-process memory. */
export function createRecoveryCipher(key: Buffer): RecoveryCipher {
  if (key.length !== 32) throw new Error('Recovery encryption requires a 256-bit key')
  const secret = Buffer.from(key)
  return {
    encrypt(bytes) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', secret, nonce)
      cipher.setAAD(MAGIC)
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
      return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted])
    },
    decrypt(bytes) {
      if (!isEncryptedRecoveryPayload(bytes) || bytes.length < MAGIC.length + 28)
        throw new Error('Invalid encrypted recovery payload')
      const decipher = createDecipheriv(
        'aes-256-gcm',
        secret,
        bytes.subarray(MAGIC.length, MAGIC.length + 12),
      )
      decipher.setAAD(MAGIC)
      decipher.setAuthTag(bytes.subarray(MAGIC.length + 12, MAGIC.length + 28))
      try {
        return Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 28)), decipher.final()])
      } catch {
        throw new Error('The recovery encryption key is unavailable or the payload was altered')
      }
    },
  }
}

export interface RecoveryKeyStore {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(bytes: Buffer): string
  getSelectedStorageBackend?(): string
}
/** Electron safeStorage is supplied by the shell, so this package remains Electron independent.
 * Missing/corrupt existing keys fail closed. Existing plaintext snapshots are not silently relabelled.
 */
export async function enableRecoveryEncryption(
  root: string,
  store: RecoveryKeyStore,
): Promise<void> {
  if (!store.isEncryptionAvailable())
    throw new Error('OS-protected encryption is unavailable on this device')
  if (store.getSelectedStorageBackend?.() === 'basic_text')
    throw new Error('The selected OS storage backend does not provide protected encryption')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const keyPath = join(root, 'protected-key.bin')
  let key: Buffer
  try {
    const handle = await open(keyPath, 'r')
    let protectedKey: Buffer
    try {
      if ((await handle.stat()).size > 16 * 1024)
        throw new Error('The protected recovery key is invalid')
      protectedKey = await handle.readFile()
    } finally {
      await handle.close()
    }
    const decoded = store.decryptString(protectedKey)
    if (!/^[a-f0-9]{64}$/.test(decoded)) throw new Error('The protected recovery key is invalid')
    key = Buffer.from(decoded, 'hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    key = randomBytes(32)
    const protectedKey = store.encryptString(key.toString('hex'))
    // Exclusive creation prevents two initializers from replacing a key already used by another.
    try {
      await writeFile(keyPath, protectedKey, { flag: 'wx', mode: 0o600 })
      const handle = await open(keyPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException)?.code === 'EEXIST')
        return enableRecoveryEncryption(root, store)
      throw writeError
    }
  }
  setRecoveryCipher(root, createRecoveryCipher(key))
  key.fill(0)
}
