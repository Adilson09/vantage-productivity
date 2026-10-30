import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export interface PdfPrivateLineage {
  ownerKey: string
  source: string
  generation: number
  token: string
  documentPath: string | null
}
export interface PdfPrivateRecord {
  format: 'vantage.pdf-private-base'
  version: 1
  id: string
  instance: string
  pid: number
  directory: string
  bytes: number
  sha256: string
  phase: 'preparing' | 'ready' | 'retained'
  lineage: PdfPrivateLineage
  error?: string
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
function valid(value: unknown): value is PdfPrivateRecord {
  const record = value as PdfPrivateRecord | null,
    lineage = record?.lineage
  return (
    !!record &&
    record.format === 'vantage.pdf-private-base' &&
    record.version === 1 &&
    UUID.test(record.id) &&
    UUID.test(record.instance) &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    /^owner-[0-9]+-[a-zA-Z0-9]+$/.test(record.directory) &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes > 0 &&
    record.bytes <= 64 * 1024 * 1024 &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    ['preparing', 'ready', 'retained'].includes(record.phase) &&
    !!lineage &&
    typeof lineage.ownerKey === 'string' &&
    lineage.ownerKey.length <= 256 &&
    typeof lineage.source === 'string' &&
    lineage.source.length > 0 &&
    lineage.source.length <= 1024 &&
    Number.isSafeInteger(lineage.generation) &&
    lineage.generation >= 0 &&
    UUID.test(lineage.token) &&
    (lineage.documentPath === null ||
      (typeof lineage.documentPath === 'string' &&
        lineage.documentPath.length <= 4096 &&
        !lineage.documentPath.includes('\0'))) &&
    (record.error === undefined ||
      (typeof record.error === 'string' && record.error.length <= 4096))
  )
}
async function boundedJson(path: string): Promise<unknown> {
  const pathInfo = await lstat(path)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink())
    throw new Error('Linked private PDF ownership metadata is refused.')
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.size > 8192 ||
      before.ino !== pathInfo.ino ||
      before.dev !== pathInfo.dev
    )
      throw new Error('Private PDF ownership metadata changed or exceeds its limit.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead)
        throw new Error('Private PDF ownership metadata changed during reading.')
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino
    )
      throw new Error('Private PDF ownership metadata changed during reading.')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    await handle.close()
  }
}
/** Durable generated-file ownership. No imported envelope/destination path can
 * enter this registry. Discovery lists metadata only; deleting a selected orphan
 * requires a dead owner, a complete hash check and no live app reader. */
export class PdfPrivateBaseRegistry {
  private readonly instance = randomUUID()
  private readonly records = new Map<string, PdfPrivateRecord>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private admission: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly root: string,
    private readonly dependencies: {
      digest(bytes: Uint8Array): string
      read(path: string, maximum: number): Promise<Buffer>
      inUse(path: string): boolean
      retained(record: PdfPrivateRecord): void
      ownerAlive?(pid: number): boolean
    },
  ) {}
  private path(record: PdfPrivateRecord): string {
    if (!valid(record) || basename(record.directory) !== record.directory)
      throw new Error('Invalid private PDF ownership record.')
    const directory = join(this.root, record.directory)
    if (dirname(resolve(directory)) !== resolve(this.root))
      throw new Error('Private PDF ownership escaped its generated root.')
    return join(directory, 'base.pdf')
  }
  private async realDirectory(directory: string): Promise<void> {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Linked private PDF checkpoint directories are refused.')
  }
  private async persist(record: PdfPrivateRecord): Promise<void> {
    const path = this.path(record),
      directory = dirname(path)
    await this.realDirectory(this.root)
    await this.realDirectory(directory)
    const bytes = Buffer.from(JSON.stringify(record))
    if (bytes.length > 8192) throw new Error('Private PDF ownership metadata exceeds its limit.')
    const temporary = join(directory, `owner-${randomUUID()}.pending`),
      target = join(directory, 'owner.json')
    let created = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      created = true
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
      created = false
    } finally {
      if (created) await unlink(temporary).catch(() => {})
    }
  }
  private queue<Value>(id: string, action: () => Promise<Value>): Promise<Value> {
    const operation = (this.tails.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    this.tails.set(id, operation)
    void operation.then(
      () => {
        if (this.tails.get(id) === operation) this.tails.delete(id)
      },
      () => {
        if (this.tails.get(id) === operation) this.tails.delete(id)
      },
    )
    return operation
  }
  private admit<Value>(action: () => Promise<Value>): Promise<Value> {
    const work = this.admission.catch(() => {}).then(action)
    this.admission = work
    return work
  }
  async reserve(owner: number, bytes: Buffer): Promise<{ path: string; record: PdfPrivateRecord }> {
    return this.admit(() => this.reserveActual(owner, bytes))
  }
  private async reserveActual(
    owner: number,
    bytes: Buffer,
  ): Promise<{ path: string; record: PdfPrivateRecord }> {
    if (
      !Number.isSafeInteger(owner) ||
      owner < 0 ||
      !bytes.length ||
      bytes.length > 64 * 1024 * 1024
    )
      throw new Error('Invalid generated private PDF reservation.')
    if (this.records.size >= 128)
      throw new Error(
        'Private PDF ownership inventory is full. Review retained checkpoints before opening another workspace.',
      )
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.realDirectory(this.root)
    const directory = await mkdtemp(join(this.root, `owner-${owner}-`)),
      id = randomUUID()
    const record: PdfPrivateRecord = {
      format: 'vantage.pdf-private-base',
      version: 1,
      id,
      instance: this.instance,
      pid: process.pid,
      directory: basename(directory),
      bytes: bytes.length,
      sha256: this.dependencies.digest(bytes),
      phase: 'preparing',
      lineage: {
        ownerKey: `${this.instance}:${owner}`,
        source: `private-base:${id}`,
        generation: 0,
        token: id,
        documentPath: null,
      },
    }
    this.records.set(id, record)
    try {
      await this.persist(record)
      return { path: this.path(record), record: structuredClone(record) }
    } catch (error) {
      record.phase = 'retained'
      record.error = `Preparing owned private PDF metadata failed: ${String(error)}`.slice(0, 4096)
      this.dependencies.retained(structuredClone(record))
      throw error
    }
  }
  async ready(path: string): Promise<void> {
    const record = this.recordForPath(path)
    await this.queue(record.id, async () => {
      record.phase = 'ready'
      delete record.error
      await this.persist(record)
    })
  }
  bind(path: string, lineage: PdfPrivateLineage): void {
    const record = this.recordForPath(path)
    const next = { ...record, lineage: { ...lineage } }
    if (!valid(next)) throw new Error('Invalid main private-PDF lineage.')
    record.lineage = next.lineage
    void this.queue(record.id, async () => {
      try {
        await this.persist(record)
      } catch (error) {
        await this.retain(
          record,
          `The private checkpoint's ownership binding could not be persisted: ${String(error)}`,
        )
        throw error
      }
    }).catch(() => {})
  }
  private recordForPath(path: string): PdfPrivateRecord {
    const record = [...this.records.values()].find((record) => this.path(record) === path)
    if (!record) throw new Error('This private PDF path was not reserved by the app.')
    return record
  }
  record(path: string): PdfPrivateRecord {
    return structuredClone(this.recordForPath(path))
  }
  async drain(path?: string): Promise<void> {
    if (path) {
      const record = this.recordForPath(path)
      await this.tails.get(record.id)
      return
    }
    await Promise.all([...this.tails.values()])
  }
  private async retain(record: PdfPrivateRecord, message: string): Promise<void> {
    record.phase = 'retained'
    record.error = message.slice(0, 4096)
    // The original owner.json still identifies this bounded generated artifact if
    // storage itself refuses the updated error. App-owned status is separate.
    try {
      await this.persist(record)
    } finally {
      this.dependencies.retained(structuredClone(record))
    }
  }
  async remove(path: string, orphan = false): Promise<void> {
    const record = this.recordForPath(path)
    await this.queue(record.id, async () => {
      try {
        if (this.dependencies.inUse(path))
          throw new Error('This private PDF checkpoint still has a live editor reader.')
        if (record.instance !== this.instance) {
          if (!orphan)
            throw new Error('The private PDF checkpoint belongs to another app instance.')
          let alive = true
          if (this.dependencies.ownerAlive) alive = this.dependencies.ownerAlive(record.pid)
          else
            try {
              process.kill(record.pid, 0)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
            }
          if (alive)
            throw new Error(
              'The previous private-PDF owner is still alive or cannot be proven stopped.',
            )
        }
        const directory = dirname(path)
        await this.realDirectory(this.root)
        await this.realDirectory(directory)
        const manifest = await boundedJson(join(directory, 'owner.json'))
        if (
          !valid(manifest) ||
          manifest.id !== record.id ||
          manifest.sha256 !== record.sha256 ||
          manifest.bytes !== record.bytes ||
          manifest.instance !== record.instance
        )
          throw new Error('The private PDF ownership manifest changed; its bytes were retained.')
        const info = await lstat(path).catch((error) => {
          if (absent(error)) return null
          throw error
        })
        if (info) {
          if (!info.isFile() || info.isSymbolicLink() || info.size !== record.bytes)
            throw new Error('The private PDF checkpoint changed type or size.')
          const bytes = await this.dependencies.read(path, 64 * 1024 * 1024)
          if (this.dependencies.digest(bytes) !== record.sha256)
            throw new Error('The private PDF checkpoint changed bytes and was retained.')
          if (this.dependencies.inUse(path))
            throw new Error('A live editor still needs this private PDF checkpoint.')
          await unlink(path)
        }
        // Only named files are removed. Unexpected siblings survive with a visible
        // failure; there is no recursive deletion of a generated directory.
        const siblings = await readdir(directory)
        if (siblings.some((name) => name !== 'owner.json'))
          throw new Error('Unexpected files remain beside the private PDF checkpoint.')
        await unlink(join(directory, 'owner.json'))
        await rmdir(directory)
        this.records.delete(record.id)
      } catch (error) {
        await this.retain(record, `Checked private PDF cleanup is incomplete: ${String(error)}`)
        throw error
      }
    })
  }
  async discoverRetained(): Promise<PdfPrivateRecord[]> {
    return this.admit(() => this.discoverActual())
  }
  private async discoverActual(): Promise<PdfPrivateRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.realDirectory(this.root)
    const names = await readdir(this.root, { withFileTypes: true })
    if (names.length > 128)
      throw new Error(
        'Private PDF checkpoint inventory exceeds its bounded inspection limit; no broad cleanup was attempted.',
      )
    for (const name of names) {
      if (
        !name.isDirectory() ||
        name.isSymbolicLink() ||
        !/^owner-[0-9]+-[a-zA-Z0-9]+$/.test(name.name)
      )
        throw new Error('Unrecognized private PDF storage was retained for review.')
      if (
        [...this.records.values()].some(
          (record) => record.instance === this.instance && record.directory === name.name,
        )
      )
        continue
      const record = await boundedJson(join(this.root, name.name, 'owner.json'))
      if (!valid(record) || record.directory !== name.name)
        throw new Error('Unrecognized private PDF ownership metadata was retained.')
      if (record.instance === this.instance && this.records.has(record.id)) continue
      const known = this.records.get(record.id)
      if (known) {
        if (
          known.directory !== record.directory ||
          known.instance !== record.instance ||
          known.sha256 !== record.sha256
        )
          throw new Error('Duplicate private PDF ownership identity was retained.')
        continue
      }
      record.phase = 'retained'
      record.error =
        'A previous app session left this generated private checkpoint. Its owner and bytes must be checked before removal.'
      this.records.set(record.id, record)
      this.dependencies.retained(structuredClone(record))
    }
    return [...this.records.values()]
      .filter((record) => record.phase === 'retained')
      .map((record) => structuredClone(record))
  }
  async retry(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record || record.phase !== 'retained')
      throw new Error('That retained private PDF checkpoint is not available for checked cleanup.')
    await this.remove(this.path(record), true)
  }
  pathForId(id: string): string | undefined {
    const record = this.records.get(id)
    return record ? this.path(record) : undefined
  }
  hasRetainedFor(owner: number): boolean {
    return [...this.records.values()].some(
      (record) =>
        record.instance === this.instance &&
        record.directory.startsWith(`owner-${owner}-`) &&
        record.phase === 'retained',
    )
  }
}
