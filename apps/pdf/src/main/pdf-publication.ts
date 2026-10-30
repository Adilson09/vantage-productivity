import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readAtomicFileVersion, type AtomicFileVersion } from '@vantage/electron-utils/atomic-write'
import type { CloseLeaseTicket } from '@vantage/electron-utils/close-lease'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
export const samePdfFileVersion = (left: AtomicFileVersion | null, right: AtomicFileVersion | null): boolean =>
  left === null || right === null ? left === right : left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino && left.dev === right.dev && left.sha256 === right.sha256
export interface PdfLoadedFile {
  path: string
  version: AtomicFileVersion
  sha256: string
  readId: string
  session: string
  closeTicket?: CloseLeaseTicket
}
type Observe = (path: string) => Promise<AtomicFileVersion | null>
export async function assertPdfFileVersion(path: string, expected: AtomicFileVersion | null, observe: Observe = readAtomicFileVersion): Promise<void> {
  if (!samePdfFileVersion(await observe(path), expected)) throw new Error('The PDF changed, moved or was removed outside this view. Publication was refused; pending content was kept.')
}
/** A successful read is pinned BEFORE parsing. A failed candidate never replaces
 * the active loaded fingerprint. The content hash also covers large inputs whose
 * generic atomic publisher intentionally uses bounded metadata-only checking. */
export async function readPinnedPdf(path: string, observe: Observe = readAtomicFileVersion, read: (path: string) => Promise<Buffer> = readFile): Promise<{ bytes: Buffer; version: AtomicFileVersion; sha256: string }> {
  const version = await observe(path)
  if (!version) throw new Error('The PDF source is no longer available.')
  const bytes = await read(path), sha256 = digest(bytes)
  if (version.sha256 !== undefined && sha256 !== version.sha256) throw new Error('The PDF changed during its source read.')
  await assertPdfFileVersion(path, version, observe)
  return { bytes, version: Object.freeze({ ...version }), sha256 }
}
/** Verify the actual post-publication bytes too. Above the generic publisher's
 *32MiB hashing limit, stream only the known output size rather than copying it
 * into a second unbounded Buffer or adopting an arbitrary late replacement. */
export async function observePublishedPdf(path: string, bytes: Uint8Array): Promise<AtomicFileVersion> {
  const expectedHash = digest(bytes), version = await readAtomicFileVersion(path)
  if (!version || version.size !== bytes.byteLength) throw new Error('The published PDF changed before its own-write fingerprint could be retained.')
  if (version.sha256 !== undefined) {
    if (version.sha256 !== expectedHash) throw new Error('The saved PDF was replaced before readback.')
  } else {
    const hash = createHash('sha256'); let size = 0
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
      size += chunk.length
      if (size > bytes.byteLength) throw new Error('The saved PDF grew during its bounded own-write verification.')
      hash.update(chunk)
    }
    if (size !== bytes.byteLength || hash.digest('hex') !== expectedHash) throw new Error('The saved PDF changed during own-write verification.')
  }
  await assertPdfFileVersion(path, version)
  return Object.freeze({ ...version })
}
/** Main-only metadata; no renderer fingerprint can establish publication authority. */
export class PdfFileBindings {
  private readonly active = new Map<number, PdfLoadedFile>()
  private readonly candidates = new Map<number, Map<string, PdfLoadedFile>>()
  remember(owner: number, value: PdfLoadedFile): void {
    const candidates = this.candidates.get(owner) ?? new Map<string, PdfLoadedFile>()
    this.candidates.set(owner, candidates)
    const key = value.readId || `raw:${pathKey(value.path)}`
    candidates.delete(key)
    candidates.set(key, Object.freeze({ ...value, version: Object.freeze({ ...value.version }), ...(value.closeTicket ? { closeTicket: Object.freeze({ ...value.closeTicket }) } : {}) }))
    while (candidates.size > 4) candidates.delete(candidates.keys().next().value!)
  }
  candidate(owner: number, session: string, readId: string, rawPath?: string): PdfLoadedFile {
    const current = this.active.get(owner)
    const value = this.candidates.get(owner)?.get(readId || `raw:${pathKey(rawPath ?? '')}`) ?? (readId && current?.readId === readId ? current : undefined)
    if (!value || value.session !== session || (!readId && value.path !== rawPath)) throw new Error('The parsed PDF has no current main-owned source-read receipt. Reopen it before saving.')
    return value
  }
  isActive(owner: number, value: PdfLoadedFile): boolean { return this.active.get(owner) === value }
  activate(owner: number, candidate: PdfLoadedFile, session: string): void {
    this.active.set(owner, Object.freeze({ ...candidate, session, closeTicket: undefined }))
    this.candidates.delete(owner)
  }
  loaded(owner: number, session: string, path: string): PdfLoadedFile {
    const value = this.active.get(owner)
    if (!value || value.session !== session || value.path !== path) throw new Error('The PDF has no current loaded-file fingerprint. Reopen the source before saving; its pending content was kept.')
    return value
  }
  domain(owner: number, session: string, fallbackPath: string): string {
    const value = this.active.get(owner)
    return value?.session === session && value.version.ino > 0 ? `file:${value.version.dev}:${value.version.ino}` : `path:${pathKey(value?.session === session ? value.path : fallbackPath)}`
  }
  ownPublication(owner: number, expected: PdfLoadedFile, version: AtomicFileVersion, bytes: Uint8Array): void {
    if (this.active.get(owner) !== expected) return
    const sha256 = digest(bytes)
    if (version.sha256 !== undefined && version.sha256 !== sha256) throw new Error('The saved output changed before its own-write fingerprint could be recorded.')
    this.active.set(owner, Object.freeze({ ...expected, version: Object.freeze({ ...version }), sha256 }))
  }
  /** Trusted completed rename may change ctime, never the captured bytes/inode.
   * A mismatch invalidates saving until a new successful read; no old path is recreated. */
  renamed(owner: number, oldPath: string, newPath: string, observed: AtomicFileVersion | null): void {
    const value = this.active.get(owner)
    if (!value || value.path !== oldPath) return
    if (!observed || observed.size !== value.version.size || observed.mtimeMs !== value.version.mtimeMs || observed.ino !== value.version.ino || observed.dev !== value.version.dev || (observed.sha256 !== undefined && observed.sha256 !== value.sha256)) { this.active.delete(owner); return }
    this.active.set(owner, Object.freeze({ ...value, path: newPath, version: Object.freeze({ ...observed, ...(value.version.sha256 ? { sha256: value.version.sha256 } : {}) }) }))
  }
  retire(owner: number): void { this.active.delete(owner); this.candidates.delete(owner) }
}

/** Real serializer-to-publication fence used by BOTH native Save paths. The
 * publisher receives the immutable loaded/granted target fingerprint even if
 * serialization awaits and the destination disappears or is replaced. */
export async function publishPinnedPdf<Result>(options: {
  source: PdfLoadedFile
  target: { path: string; version: AtomicFileVersion | null }
  input: Uint8Array
  serialize(bytes: Uint8Array): Promise<Result>
  output(result: Result): Uint8Array
  verify(result: Result): Promise<void>
  current(): void
  publish(bytes: Buffer, expected: AtomicFileVersion | null): Promise<void>
  observe?: Observe
}): Promise<{ result: Result; bytes: Buffer }> {
  const input = Buffer.from(options.input)
  if (digest(input) !== options.source.sha256) throw new Error('The PDF serializer input differs from its loaded source. Publication was refused.')
  options.current()
  await assertPdfFileVersion(options.source.path, options.source.version, options.observe)
  options.current()
  const result = await options.serialize(input)
  await options.verify(result)
  const bytes = Buffer.from(options.output(result))
  await assertPdfFileVersion(options.source.path, options.source.version, options.observe)
  options.current()
  await options.publish(bytes, options.target.version)
  return { result, bytes }
}
