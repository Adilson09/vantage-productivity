import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface DocumentLease {
  path: string
  owner: string
  token: string
  baseHash: string
  expiresAt: number
}
export interface CheckoutOptions {
  ttlMs?: number
}
export type PublishResult =
  | { status: 'published'; lease: DocumentLease }
  | { status: 'conflict'; conflictPath: string; expectedHash: string; actualHash: string }
export class DocumentLockedError extends Error {
  constructor(
    readonly owner: string,
    readonly expiresAt: number,
  ) {
    super(`Document is checked out by ${owner}.`)
    this.name = 'DocumentLockedError'
  }
}
export class CheckoutPermissionError extends Error {
  constructor() {
    super('The checkout token is missing, expired or belongs to another editor.')
    this.name = 'CheckoutPermissionError'
  }
}
export class CheckoutPublicationError extends Error {
  constructor(
    readonly rescuePath: string,
    cause: unknown,
  ) {
    super(
      `Could not publish the checked-out document. The completed new file is retained at ${rescuePath}.`,
      { cause },
    )
    this.name = 'CheckoutPublicationError'
  }
}

const LOCK_APPLICATION_ID = 0x564c4f43
function key(path: string): string {
  const actual = realpathSync(path)
  return process.platform === 'win32' ? actual.toLowerCase() : actual
}
function fileHash(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw new Error('Checkout supports regular documents up to 32 MiB.')
    const hash = createHash('sha256'),
      chunk = Buffer.alloc(65536)
    let total = 0,
      count: number
    while ((count = readSync(fd, chunk, 0, chunk.length, null))) {
      total += count
      if (total > 32 * 1024 * 1024)
        throw new Error('Checkout document grew beyond 32 MiB while reading.')
      hash.update(chunk.subarray(0, count))
    }
    const after = fstatSync(fd)
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
      throw new Error('Document changed while hashing; retry checkout.')
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

/** Cooperative local/shared-folder check-out, not real-time coauthoring or an authentication service. */
export class DocumentCheckoutRegistry {
  private readonly db: DatabaseSync
  private closed = false
  constructor(
    registryPath: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(registryPath), { recursive: true })
    const existed = existsSync(registryPath)
    this.db = new DatabaseSync(registryPath, { allowExtension: false })
    this.db.exec('PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF;')
    const id = this.db.prepare('PRAGMA application_id').get()?.application_id
    if (existed && id !== LOCK_APPLICATION_ID) {
      this.db.close()
      throw new Error('The checkout registry has an unsupported format.')
    }
    if (!existed)
      this.db.exec(`PRAGMA application_id=${LOCK_APPLICATION_ID};
      CREATE TABLE leases(path TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT NOT NULL, baseHash TEXT NOT NULL, expiresAt INTEGER NOT NULL) STRICT;`)
  }

  close(): void {
    if (!this.closed) {
      this.db.close()
      this.closed = true
    }
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private current(path: string): DocumentLease | undefined {
    const row = this.db
      .prepare('SELECT path,owner,token,baseHash,expiresAt FROM leases WHERE path=?')
      .get(path)
    return row
      ? {
          path: String(row.path),
          owner: String(row.owner),
          token: String(row.token),
          baseHash: String(row.baseHash),
          expiresAt: Number(row.expiresAt),
        }
      : undefined
  }
  private authorize(lease: DocumentLease): DocumentLease {
    const current = this.current(lease.path)
    if (
      !current ||
      current.token !== lease.token ||
      current.owner !== lease.owner ||
      current.expiresAt <= this.now()
    )
      throw new CheckoutPermissionError()
    return current
  }

  checkout(path: string, owner: string, options: CheckoutOptions = {}): DocumentLease {
    if (!owner || owner.length > 200) throw new Error('A checkout owner needs 1 to 200 characters.')
    const ttlMs = options.ttlMs ?? 15 * 60 * 1000
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24 * 60 * 60 * 1000)
      throw new Error('Checkout duration must be 1 second to 24 hours.')
    const canonical = key(path)
    return this.transaction(() => {
      const current = this.current(canonical)
      if (current && current.expiresAt > this.now())
        throw new DocumentLockedError(current.owner, current.expiresAt)
      const lease: DocumentLease = {
        path: canonical,
        owner,
        token: randomUUID(),
        baseHash: fileHash(canonical),
        expiresAt: this.now() + ttlMs,
      }
      this.db
        .prepare(
          'INSERT INTO leases(path,owner,token,baseHash,expiresAt) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET owner=excluded.owner,token=excluded.token,baseHash=excluded.baseHash,expiresAt=excluded.expiresAt',
        )
        .run(lease.path, lease.owner, lease.token, lease.baseHash, lease.expiresAt)
      return lease
    })
  }

  verify(lease: DocumentLease): { valid: true; unchanged: boolean; actualHash: string } {
    const current = this.authorize(lease)
    const actualHash = fileHash(current.path)
    return {
      valid: true,
      unchanged: actualHash === current.baseHash && lease.baseHash === current.baseHash,
      actualHash,
    }
  }

  renew(lease: DocumentLease, ttlMs = 15 * 60 * 1000): DocumentLease {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24 * 60 * 60 * 1000)
      throw new Error('Checkout duration must be 1 second to 24 hours.')
    return this.transaction(() => {
      const current = this.authorize(lease)
      const renewed = { ...current, expiresAt: this.now() + ttlMs }
      this.db
        .prepare('UPDATE leases SET expiresAt=? WHERE path=? AND token=?')
        .run(renewed.expiresAt, current.path, current.token)
      return renewed
    })
  }

  release(lease: DocumentLease): void {
    this.transaction(() => {
      this.authorize(lease)
      this.db.prepare('DELETE FROM leases WHERE path=? AND token=?').run(lease.path, lease.token)
    })
  }

  list(): Omit<DocumentLease, 'token'>[] {
    return this.db
      .prepare('SELECT path,owner,baseHash,expiresAt FROM leases WHERE expiresAt>? ORDER BY path')
      .all(this.now())
      .map((row) => ({
        path: String(row.path),
        owner: String(row.owner),
        baseHash: String(row.baseHash),
        expiresAt: Number(row.expiresAt),
      }))
  }

  /** Token checks and publication serialize cooperating writers in one SQLite transaction. */
  publish(lease: DocumentLease, bytes: Uint8Array): PublishResult {
    if (bytes.byteLength > 32 * 1024 * 1024)
      throw new Error('Checkout publication is limited to 32 MiB.')
    return this.transaction(() => {
      const current = this.authorize(lease)
      const actualHash = fileHash(current.path)
      if (actualHash !== current.baseHash || lease.baseHash !== current.baseHash) {
        const extension = extname(current.path)
        const conflictPath = join(
          dirname(current.path),
          `${basename(current.path, extension)}.conflict-${randomUUID()}${extension}`,
        )
        const fd = openSync(conflictPath, 'wx', 0o600)
        try {
          writeFileSync(fd, bytes)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        return { status: 'conflict', conflictPath, expectedHash: lease.baseHash, actualHash }
      }
      const temporary = join(
        dirname(current.path),
        `${basename(current.path)}.${randomUUID()}.vantage-rescue`,
      )
      const fd = openSync(temporary, 'wx', statSync(current.path).mode & 0o777)
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      // Nonparticipating applications can still write between this final hash
      // check and rename. The operating system offers no portable file CAS.
      if (fileHash(current.path) !== actualHash) {
        return {
          status: 'conflict',
          conflictPath: temporary,
          expectedHash: lease.baseHash,
          actualHash: fileHash(current.path),
        }
      }
      try {
        renameSync(temporary, current.path)
      } catch (error) {
        throw new CheckoutPublicationError(temporary, error)
      }
      const renewed = { ...current, baseHash: createHash('sha256').update(bytes).digest('hex') }
      this.db
        .prepare('UPDATE leases SET baseHash=? WHERE path=? AND token=?')
        .run(renewed.baseHash, current.path, current.token)
      return { status: 'published', lease: renewed }
    })
  }
}
