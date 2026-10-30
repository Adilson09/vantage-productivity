/**
 * Private proposal: immutable native snapshot custody, never SQLite/WAL copying.
 * Exactly three bounded files: pinned base, final full typed snapshot, receipt.
 * Command history is not cloned. Persisted data grants no close/write permission.
 * Abort/failure may leave a bounded, exclusively created partial target with no
 * verified receipt. Root must retain its status/admission charge until actual
 * I/O settlement and provide separate exact-owned partial maintenance. Full-
 * receipt purge below deliberately grants no authority to delete partial output.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  DocumentNativeClient,
  DocumentSheet,
  NativeDocumentSnapshot,
} from './document-native-contract'
import {
  canonicalDocumentPayload,
  isCapturedNativeCloseAuthority,
  type CapturedNativeCloseAuthority,
  type NativeCloseSnapshotProof,
} from './workbook-document-recovery'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface NativeCustodyLineage {
  id: string
  module: string
  ownerKey: string
  source: string
  generation: number
  token: string
  documentPath: string | null
}
export interface NativeCustodyTask extends NativeCustodyLineage {
  custody: { provider?: string; input?: unknown }
}
interface Binding {
  module: string
  documentPath: string | null
  sha256: string
}
/** Structural copy of the pending shared main-only CloseCustodyProvider seam. */
export interface NativeCloseCustodyProvider {
  id: string
  limits: { maxEntryBytes: number; maxTotalBytes: number; maxEntries: number }
  capture(context: {
    task: NativeCustodyTask
    targetRoot: string
    signal: AbortSignal
    reserve(bytes: number): void
  }): Promise<{ bytes: number; binding: Binding; receipt: { [key: string]: Json } } | null>
  validateReceipt(receipt: unknown): boolean
  purge(context: {
    status: { capturedEntry?: Binding }
    targetRoot: string
    receipt: unknown
    signal: AbortSignal
  }): Promise<void>
  captureInput(authority: CapturedNativeCloseAuthority, lineage?: NativeCustodyLineage): object
  /** Only CloseCleanupTask.run after successful exact-owner actual removal. */
  runCaptured(authority: CapturedNativeCloseAuthority, signal: AbortSignal): Promise<void>
  /**
   * Data handoff only. Root validates snapshot.payload with validateDocumentPayload
   * then uses the existing full workbook writer/materializer with this pinned
   * base. No persistent SQLite, output publication, or permission import occurs.
   */
  readCustody(
    targetRoot: string,
    receipt: unknown,
    signal: AbortSignal,
  ): Promise<NativeCloseSnapshotProof>
}
export interface NativeCustodyLimits {
  maxCheckpointBytes: number
  maxBaseBytes: number
  maxTotalBytes: number
  maxEntries: number
}
const MiB = 1024 * 1024,
  META = 128 * 1024,
  CHUNK = 64 * 1024
const defaults: NativeCustodyLimits = {
  maxCheckpointBytes: 256 * MiB,
  maxBaseBytes: 512 * MiB,
  maxTotalBytes: 4 * 1024 * MiB,
  maxEntries: 32,
}
const HASH = /^[0-9a-f]{64}$/,
  UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  FP = /^sha256:[0-9a-f]{64}$/
const names = {
  base: 'base.xlsx',
  snapshot: 'source-snapshot.json',
  receipt: 'custody.json',
} as const
interface FileProof {
  bytes: number
  sha256: string
}
interface Receipt {
  format: 1
  kind: 'sheets-native-close-snapshot-custody'
  producer: string
  generation: number
  originalPath: string
  originalFingerprint: string | null
  sourceDocumentId: string
  sourceRevision: number
  sourceFingerprint: string
  payloadSha256: string
  base: FileProof
  snapshot: FileProof
  reservedBytes: number
  commandHistory: 'not-cloned-current-snapshot-only'
  permissions: 'none-imported'
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function positive(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0
}
function nonnegative(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0
}
function hash(v: string | Buffer): string {
  return createHash('sha256').update(v).digest('hex')
}
function fail(message: string): never {
  throw new Error(`Native close custody: ${message}`)
}
function canonical(value: unknown): string {
  const encoded = JSON.stringify(canonicalDocumentPayload({ value }).value)
  if (encoded === undefined) fail('undefined data cannot be a custody proof.')
  return encoded
}
function identity(path: string): string {
  const v = resolve(path)
  return process.platform === 'win32' ? v.toLowerCase() : v
}
function sameFile(a: FileProof, b: FileProof): boolean {
  return a.bytes === b.bytes && a.sha256 === b.sha256
}
function validSheets(v: unknown): v is DocumentSheet[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 16_384) return false
  const ids = new Set<string>(),
    labels = new Set<string>()
  return v.every((s: unknown) => {
    if (
      !record(s) ||
      typeof s.id !== 'string' ||
      !s.id ||
      s.id.length > 512 ||
      typeof s.name !== 'string' ||
      !s.name ||
      s.name.length > 1024 ||
      ids.has(s.id) ||
      labels.has(s.name.toLowerCase())
    )
      return false
    ids.add(s.id)
    labels.add(s.name.toLowerCase())
    return true
  })
}
async function privateDirectory(path: string, create: boolean): Promise<string> {
  if (!isAbsolute(path) || /^(?:\\\\|\/\/)/.test(path))
    fail('a trusted absolute local directory is required.')
  const parent = dirname(resolve(path)),
    prior = await lstat(parent)
  if (
    !prior.isDirectory() ||
    prior.isSymbolicLink() ||
    identity(await realpath(parent)) !== identity(parent)
  )
    fail('a linked or relocated custody parent is refused.')
  if (create) await mkdir(path, { mode: 0o700 })
  const info = await lstat(path)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    identity(await realpath(path)) !== identity(path)
  )
    fail('a linked or relocated custody directory is refused.')
  return resolve(path)
}
async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EACCES'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      throw error
  } finally {
    await handle?.close()
  }
}
async function readBounded(
  path: string,
  maximum: number,
  signal: AbortSignal,
  collect = false,
): Promise<FileProof & { data?: Buffer }> {
  signal.throwIfAborted()
  const before = await lstat(path)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !nonnegative(before.size) ||
    before.size > maximum
  )
    fail('a captured file is linked, invalid, or over its byte budget.')
  const handle = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  const digest = createHash('sha256'),
    pieces: Buffer[] = []
  let bytes = 0
  try {
    const admitted = await handle.stat()
    if (admitted.ino !== before.ino || admitted.size !== before.size)
      fail('the captured file changed before opening.')
    for (;;) {
      signal.throwIfAborted()
      const buffer = Buffer.allocUnsafe(CHUNK),
        read = await handle.read(buffer, 0, CHUNK, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > maximum || bytes > before.size)
        fail('a captured file grew beyond its admitted bound.')
      const part = buffer.subarray(0, read.bytesRead)
      digest.update(part)
      if (collect) pieces.push(part)
    }
    const after = await handle.stat(),
      current = await lstat(path)
    if (
      bytes !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.isSymbolicLink()
    )
      fail('a captured file changed during verification.')
  } finally {
    await handle.close()
  }
  signal.throwIfAborted()
  return {
    bytes,
    sha256: digest.digest('hex'),
    ...(collect ? { data: Buffer.concat(pieces, bytes) } : {}),
  }
}
async function writeBounded(
  path: string,
  data: Buffer,
  maximum: number,
  signal: AbortSignal,
): Promise<void> {
  if (data.length > maximum) fail('serialized custody exceeds its byte budget.')
  signal.throwIfAborted()
  const handle = await open(path, 'wx', 0o600)
  try {
    for (let offset = 0; offset < data.length;) {
      signal.throwIfAborted()
      const size = Math.min(CHUNK, data.length - offset),
        written = await handle.write(data, offset, size, null)
      if (written.bytesWritten < 1 || written.bytesWritten > size)
        fail('custody write did not make bounded progress.')
      offset += written.bytesWritten
    }
    signal.throwIfAborted()
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function copyBounded(
  source: string,
  target: string,
  expected: FileProof,
  maximum: number,
  signal: AbortSignal,
): Promise<void> {
  if (expected.bytes > maximum) fail('the base exceeds its configured byte budget.')
  const before = await lstat(source)
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.bytes)
    fail('the pinned base changed before copying.')
  signal.throwIfAborted()
  const input = await open(
    source,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  let output: Awaited<ReturnType<typeof open>> | undefined
  const digest = createHash('sha256')
  let bytes = 0
  try {
    if ((await input.stat()).ino !== before.ino) fail('the pinned base changed before opening.')
    output = await open(target, 'wx', 0o600)
    for (;;) {
      signal.throwIfAborted()
      const buffer = Buffer.allocUnsafe(CHUNK),
        read = await input.read(buffer, 0, CHUNK, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > expected.bytes || bytes > maximum)
        fail('the pinned base grew beyond its reserved bytes.')
      digest.update(buffer.subarray(0, read.bytesRead))
      for (let offset = 0; offset < read.bytesRead;) {
        signal.throwIfAborted()
        const remaining = read.bytesRead - offset,
          written = await output.write(buffer, offset, remaining, null)
        if (written.bytesWritten < 1 || written.bytesWritten > remaining)
          fail('base copy did not make bounded progress.')
        offset += written.bytesWritten
      }
    }
    const after = await input.stat(),
      current = await lstat(source)
    if (
      bytes !== expected.bytes ||
      digest.digest('hex') !== expected.sha256 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.isSymbolicLink()
    )
      fail('the base differs from its drained native fingerprint.')
    signal.throwIfAborted()
    await output.sync()
  } finally {
    const closed = await Promise.allSettled([...(output ? [output.close()] : []), input.close()])
    for (const result of closed) if (result.status === 'rejected') throw result.reason
  }
}
async function inventory(directory: string, maximum: number): Promise<number> {
  const expected = new Set<string>(Object.values(names))
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!expected.delete(entry.name) || !entry.isFile() || entry.isSymbolicLink())
      fail('custody contains a sidecar or unexpected directory entry.')
    const info = await lstat(join(directory, entry.name))
    if (!info.isFile() || info.isSymbolicLink() || !nonnegative(info.size))
      fail('invalid custody inventory.')
    bytes += info.size
    if (!Number.isSafeInteger(bytes) || bytes > maximum)
      fail('the complete custody directory exceeds its reservation.')
  }
  if (expected.size) fail('custody is missing a required file.')
  return bytes
}
function receiptValue(v: unknown, limits: NativeCustodyLimits): v is Receipt {
  if (
    !record(v) ||
    v.format !== 1 ||
    v.kind !== 'sheets-native-close-snapshot-custody' ||
    typeof v.producer !== 'string' ||
    !UUID.test(v.producer) ||
    !positive(v.generation) ||
    v.sourceDocumentId !== v.producer ||
    !positive(v.sourceRevision) ||
    typeof v.originalPath !== 'string' ||
    !isAbsolute(v.originalPath) ||
    v.originalPath.length > 32_768 ||
    !(
      v.originalFingerprint === null ||
      (typeof v.originalFingerprint === 'string' && FP.test(v.originalFingerprint))
    ) ||
    typeof v.sourceFingerprint !== 'string' ||
    !FP.test(v.sourceFingerprint) ||
    typeof v.payloadSha256 !== 'string' ||
    !HASH.test(v.payloadSha256) ||
    v.commandHistory !== 'not-cloned-current-snapshot-only' ||
    v.permissions !== 'none-imported'
  )
    return false
  for (const [name, maximum] of [
    ['base', limits.maxBaseBytes],
    ['snapshot', limits.maxCheckpointBytes + META],
  ] as const) {
    const file = v[name]
    if (
      !record(file) ||
      !positive(file.bytes) ||
      file.bytes > maximum ||
      typeof file.sha256 !== 'string' ||
      !HASH.test(file.sha256)
    )
      return false
  }
  const base = v.base as unknown as FileProof,
    snapshot = v.snapshot as unknown as FileProof
  return (
    base.sha256 === v.sourceFingerprint.slice(7) &&
    v.reservedBytes === base.bytes + snapshot.bytes + META
  )
}

export function createNativeCloseCustodyProvider(
  options: {
    /** Main-factory compatibility only; snapshot custody performs no fresh native/store writes. */
    nativeClient?: DocumentNativeClient
    limits?: Partial<NativeCustodyLimits>
  } = {},
): NativeCloseCustodyProvider {
  const limits = { ...defaults, ...options.limits }
  for (const value of Object.values(limits))
    if (!positive(value)) fail('custody budgets must be positive safe integers.')
  if (limits.maxCheckpointBytes > 256 * MiB || limits.maxEntries > 128)
    fail('native checkpoint/entry bounds exceed the supported ceiling.')
  const maximum = limits.maxBaseBytes + limits.maxCheckpointBytes + 2 * META
  if (!Number.isSafeInteger(maximum) || maximum > limits.maxTotalBytes)
    fail('the total quota must cover one reserved entry.')
  const inputs = new WeakMap<
    object,
    { authority: CapturedNativeCloseAuthority; lineage?: NativeCustodyLineage }
  >()
  const verified = new WeakMap<
    CapturedNativeCloseAuthority,
    { targetRoot: string; receipt: Receipt }
  >()
  const verify = async (
    targetRoot: string,
    unknownReceipt: unknown,
    signal: AbortSignal,
  ): Promise<NativeCloseSnapshotProof> => {
    if (!receiptValue(unknownReceipt, limits)) fail('the persisted custody receipt is malformed.')
    const receipt = unknownReceipt
    signal.throwIfAborted()
    const directory = await privateDirectory(targetRoot, false)
    await inventory(directory, receipt.reservedBytes)
    const metadata = await readBounded(join(directory, names.receipt), META, signal, true)
    if (canonical(JSON.parse(metadata.data!.toString('utf8')) as unknown) !== canonical(receipt))
      fail('the selected receipt differs from stored metadata.')
    const base = await readBounded(join(directory, names.base), limits.maxBaseBytes, signal)
    const snapshot = await readBounded(
      join(directory, names.snapshot),
      limits.maxCheckpointBytes + META,
      signal,
      true,
    )
    if (!sameFile(base, receipt.base) || !sameFile(snapshot, receipt.snapshot))
      fail('custody file hash/size verification failed.')
    const raw: unknown = JSON.parse(snapshot.data!.toString('utf8'))
    if (
      !record(raw) ||
      raw.producer !== receipt.producer ||
      raw.generation !== receipt.generation ||
      raw.originalPath !== receipt.originalPath ||
      raw.originalFingerprint !== receipt.originalFingerprint ||
      !record(raw.snapshot) ||
      raw.snapshot.apiVersion !== 1 ||
      raw.snapshot.documentId !== receipt.sourceDocumentId ||
      raw.snapshot.revision !== receipt.sourceRevision ||
      raw.snapshot.sourceFingerprint !== receipt.sourceFingerprint ||
      !validSheets(raw.snapshot.sheets) ||
      !record(raw.snapshot.payload) ||
      hash(canonical(raw.snapshot.payload)) !== receipt.payloadSha256
    )
      fail('the full source snapshot proof is inconsistent.')
    if (Buffer.byteLength(canonical(raw.snapshot.payload), 'utf8') > limits.maxCheckpointBytes)
      fail('the full typed payload exceeds its bound.')
    signal.throwIfAborted()
    return {
      producer: receipt.producer,
      generation: receipt.generation,
      originalPath: receipt.originalPath,
      originalFingerprint: receipt.originalFingerprint,
      pinnedBasePath: join(directory, names.base),
      baseBytes: receipt.base.bytes,
      payloadSha256: receipt.payloadSha256,
      snapshot: raw.snapshot as unknown as NativeDocumentSnapshot,
    }
  }
  const provider: NativeCloseCustodyProvider = {
    id: 'sheets-native',
    limits: {
      maxEntryBytes: maximum,
      maxTotalBytes: limits.maxTotalBytes,
      maxEntries: limits.maxEntries,
    },
    captureInput: (authority, lineage) => {
      if (!isCapturedNativeCloseAuthority(authority))
        fail('capture requires a main-owned detached native authority.')
      const input = Object.freeze({})
      inputs.set(input, { authority, ...(lineage ? { lineage: { ...lineage } } : {}) })
      return input
    },
    validateReceipt: (receipt) => receiptValue(receipt, limits),
    capture: async ({ task, targetRoot, signal, reserve }) => {
      const token = task.custody.input,
        selected = typeof token === 'object' && token !== null ? inputs.get(token) : undefined
      if (!selected || task.custody.provider !== provider.id)
        fail('custody input is not owned by this main provider.')
      const authority = selected.authority
      // No ready/native call, disk probe, quota hook, or write for protected memory.
      if (authority.encrypted) return null
      if (
        task.module !== 'sheets' ||
        (selected.lineage
          ? canonical(taskLineage(task)) !== canonical(selected.lineage)
          : task.ownerKey !== authority.ownerId ||
            task.token !== authority.producer ||
            task.generation !== authority.generation ||
            task.documentPath !== authority.originalPath)
      )
        fail('the cleanup lineage does not match its exact captured producer.')
      signal.throwIfAborted()
      const proof = await authority.snapshotProof()
      signal.throwIfAborted()
      const attest = authority.attest(),
        payloadText = canonical(proof.snapshot.payload)
      if (
        !attest ||
        attest.pending ||
        !attest.payloadSha256 ||
        proof.payloadSha256 !== attest.payloadSha256 ||
        proof.snapshot.documentId !== attest.documentId ||
        proof.snapshot.revision !== attest.revision ||
        proof.snapshot.sourceFingerprint !== attest.sourceFingerprint ||
        hash(payloadText) !== proof.payloadSha256 ||
        proof.producer !== authority.producer ||
        proof.generation !== authority.generation ||
        proof.snapshot.documentId !== authority.id ||
        !positive(proof.snapshot.revision) ||
        !FP.test(proof.snapshot.sourceFingerprint) ||
        !validSheets(proof.snapshot.sheets) ||
        Buffer.byteLength(payloadText, 'utf8') > limits.maxCheckpointBytes
      )
        fail(
          'the native snapshot differs from its final acknowledged payload/source/revision or exceeds its limit.',
        )
      const data = Buffer.from(
        `${canonical({
          producer: proof.producer,
          generation: proof.generation,
          originalPath: proof.originalPath,
          originalFingerprint: proof.originalFingerprint,
          snapshot: proof.snapshot,
        })}\n`,
        'utf8',
      )
      if (
        data.length > limits.maxCheckpointBytes + META ||
        proof.baseBytes > limits.maxBaseBytes ||
        !positive(proof.baseBytes)
      )
        fail('the base or snapshot exceeds its configured byte budget.')
      const base = { bytes: proof.baseBytes, sha256: proof.snapshot.sourceFingerprint.slice(7) },
        snapshot = { bytes: data.length, sha256: hash(data) }
      const reservedBytes = base.bytes + snapshot.bytes + META
      const receipt: Receipt = {
        format: 1,
        kind: 'sheets-native-close-snapshot-custody',
        producer: authority.producer,
        generation: authority.generation,
        originalPath: proof.originalPath,
        originalFingerprint: proof.originalFingerprint,
        sourceDocumentId: proof.snapshot.documentId,
        sourceRevision: proof.snapshot.revision,
        sourceFingerprint: proof.snapshot.sourceFingerprint,
        payloadSha256: proof.payloadSha256,
        base,
        snapshot,
        reservedBytes,
        commandHistory: 'not-cloned-current-snapshot-only',
        permissions: 'none-imported',
      }
      const metadata = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8')
      if (!receiptValue(receipt, limits) || metadata.length > META)
        fail('the generated receipt exceeds its schema/byte bound.')
      // Every file length is known before quota admission and any target write.
      reserve(reservedBytes)
      signal.throwIfAborted()
      const directory = await privateDirectory(targetRoot, true)
      await copyBounded(
        proof.pinnedBasePath,
        join(directory, names.base),
        base,
        limits.maxBaseBytes,
        signal,
      )
      await writeBounded(
        join(directory, names.snapshot),
        data,
        limits.maxCheckpointBytes + META,
        signal,
      )
      await writeBounded(join(directory, names.receipt), metadata, META, signal)
      await syncDirectory(directory)
      await syncDirectory(dirname(directory))
      const bytes = await inventory(directory, reservedBytes)
      await verify(directory, receipt, signal)
      signal.throwIfAborted()
      verified.set(authority, { targetRoot: directory, receipt })
      return {
        bytes,
        binding: { module: task.module, documentPath: proof.originalPath, sha256: snapshot.sha256 },
        receipt: receipt as unknown as { [key: string]: Json },
      }
    },
    runCaptured: async (authority, signal) => {
      if (!isCapturedNativeCloseAuthority(authority))
        fail('retirement requires the original main-owned authority.')
      signal.throwIfAborted()
      if (!authority.encrypted) {
        const retained = verified.get(authority)
        if (!retained)
          fail('the original producer cannot retire before verified native custody exists.')
        await verify(retained.targetRoot, retained.receipt, signal)
      }
      signal.throwIfAborted()
      await authority.retireCapturedOnly(signal)
    },
    readCustody: verify,
    purge: async ({ status, targetRoot, receipt, signal }) => {
      const before = await lstat(targetRoot)
      await verify(targetRoot, receipt, signal)
      if (
        !receiptValue(receipt, limits) ||
        status.capturedEntry?.module !== 'sheets' ||
        status.capturedEntry.documentPath !== receipt.originalPath ||
        status.capturedEntry.sha256 !== receipt.snapshot.sha256
      )
        fail('purge does not match its stored binding.')
      const directory = await privateDirectory(targetRoot, false),
        current = await lstat(directory)
      if (before.ino !== current.ino || before.dev !== current.dev)
        fail('the directory was externally replaced; replacement bytes were retained.')
      signal.throwIfAborted()
      await rm(directory, { recursive: true, force: false })
    },
  }
  return provider
}
function taskLineage(task: NativeCustodyLineage): NativeCustodyLineage {
  return {
    id: task.id,
    module: task.module,
    ownerKey: task.ownerKey,
    source: task.source,
    generation: task.generation,
    token: task.token,
    documentPath: task.documentPath,
  }
}
