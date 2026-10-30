import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

export interface PdfFailureMarker {
  id: string
  ownerKey: string
  source: string
  generation: number
  token: string
  documentPath: string | null
  error: string
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const key = (id: string) => createHash('sha256').update(id).digest('hex') + '.json'
function valid(value: unknown): value is PdfFailureMarker {
  const v = value as PdfFailureMarker | null
  return (
    !!v &&
    Object.keys(v).sort().join(',') === 'documentPath,error,generation,id,ownerKey,source,token' &&
    typeof v.id === 'string' &&
    /^[a-zA-Z0-9:._-]{1,240}$/.test(v.id) &&
    typeof v.ownerKey === 'string' &&
    v.ownerKey.length <= 256 &&
    typeof v.source === 'string' &&
    v.source.length > 0 &&
    v.source.length <= 1024 &&
    Number.isSafeInteger(v.generation) &&
    v.generation >= 0 &&
    UUID.test(v.token) &&
    (v.documentPath === null ||
      (typeof v.documentPath === 'string' &&
        isAbsolute(v.documentPath) &&
        v.documentPath.length <= 4096 &&
        !v.documentPath.includes('\0'))) &&
    typeof v.error === 'string' &&
    v.error.length <= 4096
  )
}
/** Metadata only, granting NO payload deletion authority. This independent small
 * private inventory survives shared cleanup-status quota/admission failures.
 * Actual PDF/journal/custody maintenance still performs its own checked cleanup. */
export class PdfOwnedFailureMarkers {
  constructor(private readonly root: string) {}
  private directory(create = false): void {
    if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const info = lstatSync(this.root)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('PDF cleanup failure metadata cannot use a linked directory.')
  }
  private names(): string[] {
    try {
      this.directory()
    } catch (error) {
      if (absent(error)) return []
      throw error
    }
    const directory = opendirSync(this.root),
      names: string[] = []
    try {
      for (;;) {
        const entry = directory.readSync()
        if (!entry) return names
        if (names.length >= 256)
          throw new Error('PDF cleanup failure metadata exceeds its bounded inventory.')
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !/^(?:[a-f0-9]{64}\.json|[a-f0-9-]{36}\.pending)$/.test(entry.name)
        )
          throw new Error('Unexpected PDF cleanup failure metadata was retained for review.')
        names.push(entry.name)
      }
    } finally {
      directory.closeSync()
    }
  }
  private read(name: string): PdfFailureMarker {
    const path = join(this.root, name),
      info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024)
      throw new Error('PDF cleanup failure metadata is invalid or oversized.')
    const fd = openSync(path, 'r')
    try {
      const before = fstatSync(fd)
      if (
        !before.isFile() ||
        before.size > 16 * 1024 ||
        before.ino !== info.ino ||
        before.dev !== info.dev
      )
        throw new Error('PDF cleanup failure metadata changed before reading.')
      const buffer = Buffer.alloc(16 * 1024 + 1)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      const after = fstatSync(fd)
      if (
        length > 16 * 1024 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.ino !== after.ino
      )
        throw new Error('PDF cleanup failure metadata changed or grew beyond its bound.')
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
      )
      if (!valid(value) || key(value.id) !== name)
        throw new Error('PDF cleanup failure metadata does not match its owned identity.')
      return value
    } finally {
      closeSync(fd)
    }
  }
  record(value: PdfFailureMarker): void {
    if (!valid(value)) throw new Error('Invalid main-owned PDF cleanup failure marker.')
    this.directory(true)
    const names = this.names(),
      destination = key(value.id)
    if (
      !names.includes(destination) &&
      names.filter((name) => name.endsWith('.json')).length >= 128
    )
      throw new Error('The independent PDF cleanup failure inventory is full.')
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > 16 * 1024) throw new Error('PDF cleanup failure metadata exceeds its bound.')
    const temporary = join(this.root, randomUUID() + '.pending'),
      target = join(this.root, destination)
    let created = false
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      created = true
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, target)
      created = false
    } finally {
      if (created)
        try {
          unlinkSync(temporary)
        } catch {
          /* unique owned temporary remains visible to bounded inspection */
        }
    }
  }
  inspect(): PdfFailureMarker[] {
    return this.names()
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.read(name))
  }
  clearResolved(prefix: string): void {
    for (const value of this.inspect())
      if (value.id === prefix || value.id.startsWith(prefix + ':'))
        unlinkSync(join(this.root, key(value.id)))
  }
}
