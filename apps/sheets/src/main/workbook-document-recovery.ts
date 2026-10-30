/** Private, opt-in recovery of complete workbook mutations. No candidate is applied automatically. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type {
  DocumentNativeClient,
  DocumentPayload,
  DocumentSheet,
  NativeDocumentInfo,
  NativeDocumentReceipt,
  NativeDocumentSnapshot,
} from './document-native-contract'

export type {
  DocumentNativeClient,
  DocumentPayload,
  NativeDocumentSnapshot,
} from './document-native-contract'

type OwnerId = string | number
type OriginalState = 'current' | 'changed' | 'missing' | 'unchecked'

export interface DocumentCheckpointInput {
  readonly ownerId: OwnerId
  readonly sessionId: string
  readonly originalPath: string
  readonly sourcePath: string
  /** Digest captured when the original opened; null means it did not exist. */
  readonly originalFingerprint?: string | null
  readonly sheets: readonly DocumentSheet[]
  readonly payload: DocumentPayload
  readonly encrypted?: boolean
  readonly actor?: string
  readonly commandId?: string
}

export interface DocumentCheckpointResult extends NativeDocumentReceipt {
  readonly candidateId: string | null
}

export interface DocumentRecoveryCandidate {
  readonly id: string
  readonly documentId: string
  readonly originalPath: string
  readonly sourceFingerprint: string
  /** Advisory until readCandidate reads the actual committed database head. */
  readonly revision: number
  readonly sourceConflict: boolean
  readonly originalState: OriginalState
  readonly createdAt: string
  readonly updatedAt: string
}

export interface DocumentRecoveryRead extends DocumentRecoveryCandidate {
  readonly pinnedBasePath: string
  readonly originalFingerprint: string | null
  readonly snapshot: NativeDocumentSnapshot
}

interface PendingManifest {
  commandId: string
  expectedRevision: number
  payloadHash: string
}

interface Manifest {
  version: 1
  id: string
  runtimeId: string
  ownerKeyHash: string
  originalPath: string
  originalPathHash: string
  originalFingerprint: string | null
  sourceFingerprint: string
  sheets: DocumentSheet[]
  revision: number
  pending: PendingManifest | null
  createdAt: string
  updatedAt: string
}

interface PendingCheckpoint extends PendingManifest {
  actor: string
  payload: DocumentPayload
}

interface LiveDocument {
  id: string
  ownerId: string
  key: string
  originalPath: string
  sourcePath: string
  originalFingerprint?: string | null
  sheets: DocumentSheet[]
  encrypted: boolean
  opened: boolean
  revision: number
  sourceFingerprint?: string
  manifest?: Manifest
  pending?: PendingCheckpoint
  last?: { payloadHash: string; receipt: NativeDocumentReceipt }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const MAX_MANIFEST_BYTES = 128 * 1024
const OPERATIONAL_FIELDS = new Set([
  'sessionId',
  'mode',
  'targetPath',
  'overwrite',
  'restoreWriteBack',
  'quiet',
  'defaultName',
  'csvContent',
  'editsTransferId',
])

export class DocumentRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DocumentRecoveryError'
  }
}

function fail(code: string, message: string): never {
  throw new DocumentRecoveryError(code, message)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim().length > 0
  )
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function sheetList(value: unknown): value is DocumentSheet[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16_384) return false
  const ids = new Set<string>()
  const names = new Set<string>()
  return value.every((sheet: unknown) => {
    if (
      !object(sheet) ||
      !identifier(sheet.id) ||
      typeof sheet.name !== 'string' ||
      sheet.name.length === 0 ||
      sheet.name.length > 1_024 ||
      ids.has(sheet.id) ||
      names.has(sheet.name.toLowerCase())
    )
      return false
    ids.add(sheet.id)
    names.add(sheet.name.toLowerCase())
    return true
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pathIdentity(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function absolutePath(path: string): string {
  if (!path || !isAbsolute(path)) fail('invalid_path', 'A workbook recovery path must be absolute.')
  return resolve(path)
}

function candidateId(id: string): void {
  if (!UUID.test(id)) fail('invalid_candidate', 'Invalid workbook recovery identifier.')
}

function sameSheets(left: readonly DocumentSheet[], right: readonly DocumentSheet[]): boolean {
  return (
    left.length === right.length &&
    left.every((sheet, index) => sheet.id === right[index]?.id && sheet.name === right[index]?.name)
  )
}

/** Canonical JSON both detaches caller-owned data and preserves complete typed mutations. */
export function canonicalDocumentPayload(payload: DocumentPayload): DocumentPayload {
  if (!object(payload))
    fail('invalid_payload', 'The workbook checkpoint payload must be an object.')
  const visiting = new Set<object>()
  const normalize = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'object' || value === null || visiting.has(value)) {
      fail('invalid_payload', 'The workbook checkpoint must contain finite JSON data.')
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      fail('invalid_payload', 'The workbook checkpoint must contain plain JSON objects.')
    }
    visiting.add(value)
    const normalized = Array.isArray(value)
      ? value.map(normalize)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
            .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
        )
    visiting.delete(value)
    return normalized
  }
  return normalize(
    Object.fromEntries(Object.entries(payload).filter(([key]) => !OPERATIONAL_FIELDS.has(key))),
  ) as DocumentPayload
}

async function fingerprint(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

function missing(error: unknown): boolean {
  return object(error) && error.code === 'ENOENT'
}

async function originalFingerprint(path: string): Promise<string | null> {
  try {
    return await fingerprint(path)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    // Windows does not expose directory fsync through Node. File fsync and
    // atomic replacement still complete before acknowledging a checkpoint.
    if (
      process.platform !== 'win32' ||
      !object(error) ||
      !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EACCES'].includes(String(error.code))
    )
      throw error
  } finally {
    await handle?.close()
  }
}

function nativeInfo(value: unknown, id: string): NativeDocumentInfo {
  if (
    !object(value) ||
    value.apiVersion !== 1 ||
    value.documentId !== id ||
    !revision(value.revision) ||
    typeof value.sourceFingerprint !== 'string' ||
    !FINGERPRINT.test(value.sourceFingerprint) ||
    typeof value.recovered !== 'boolean' ||
    typeof value.durable !== 'boolean'
  )
    fail('invalid_native_response', 'Invalid native document session response.')
  return value as unknown as NativeDocumentInfo
}

function nativeReceipt(value: unknown, id: string, commandId: string): NativeDocumentReceipt {
  if (
    !object(value) ||
    value.apiVersion !== 1 ||
    value.documentId !== id ||
    value.commandId !== commandId ||
    !revision(value.revision) ||
    value.revision === 0 ||
    typeof value.durable !== 'boolean'
  )
    fail('invalid_native_response', 'Invalid native document checkpoint receipt.')
  return value as unknown as NativeDocumentReceipt
}

function nativeSnapshot(value: unknown, manifest: Manifest): NativeDocumentSnapshot {
  if (
    !object(value) ||
    value.apiVersion !== 1 ||
    value.documentId !== manifest.id ||
    !revision(value.revision) ||
    value.sourceFingerprint !== manifest.sourceFingerprint ||
    !sheetList(value.sheets) ||
    !sameSheets(value.sheets, manifest.sheets) ||
    !object(value.payload)
  )
    fail('invalid_native_response', 'The recovered snapshot does not match its pinned workbook.')
  return {
    ...value,
    payload: canonicalDocumentPayload(value.payload),
  } as unknown as NativeDocumentSnapshot
}

function parseManifest(value: unknown, id: string): Manifest {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.id !== id ||
    typeof value.runtimeId !== 'string' ||
    !UUID.test(value.runtimeId) ||
    typeof value.ownerKeyHash !== 'string' ||
    !HASH.test(value.ownerKeyHash) ||
    typeof value.originalPath !== 'string' ||
    value.originalPath.length > 32_768 ||
    !isAbsolute(value.originalPath) ||
    typeof value.originalPathHash !== 'string' ||
    value.originalPathHash !== sha256(pathIdentity(value.originalPath)) ||
    !(
      value.originalFingerprint === null ||
      (typeof value.originalFingerprint === 'string' && FINGERPRINT.test(value.originalFingerprint))
    ) ||
    typeof value.sourceFingerprint !== 'string' ||
    !FINGERPRINT.test(value.sourceFingerprint) ||
    !sheetList(value.sheets) ||
    !revision(value.revision) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    fail(
      'invalid_manifest',
      'The workbook recovery manifest is malformed. Its files were preserved.',
    )
  }
  if (
    value.pending !== null &&
    (!object(value.pending) ||
      !identifier(value.pending.commandId) ||
      !revision(value.pending.expectedRevision) ||
      typeof value.pending.payloadHash !== 'string' ||
      !HASH.test(value.pending.payloadHash))
  ) {
    fail(
      'invalid_manifest',
      'The pending workbook checkpoint is malformed. Its files were preserved.',
    )
  }
  return value as unknown as Manifest
}

export class WorkbookDocumentRecovery {
  private readonly privateRoot: string
  private readonly native: DocumentNativeClient
  private readonly runtimeId = randomUUID()
  private readonly live = new Map<string, LiveDocument>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly ownerKeys = new Map<string, string>()
  private readonly trustedOriginals = new Map<string, string>()
  private canonicalRoot: string | undefined

  constructor(options: {
    readonly privateRoot: string
    readonly nativeClient: DocumentNativeClient
  }) {
    this.privateRoot = absolutePath(options.privateRoot)
    if (/^(?:\\\\|\/\/)/.test(options.privateRoot)) {
      fail('invalid_private_root', 'Workbook recovery requires an app-owned local directory.')
    }
    this.native = options.nativeClient
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return result
  }

  private async root(create: boolean): Promise<string | null> {
    if (create) await mkdir(this.privateRoot, { recursive: true, mode: 0o700 })
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(this.privateRoot)
    } catch (error) {
      if (!create && missing(error)) return null
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      fail(
        'invalid_private_root',
        'The recovery directory must be a private directory, not a link.',
      )
    const canonical = await realpath(this.privateRoot)
    if (
      this.canonicalRoot !== undefined &&
      pathIdentity(this.canonicalRoot) !== pathIdentity(canonical)
    ) {
      fail('invalid_private_root', 'The recovery directory changed its canonical location.')
    }
    this.canonicalRoot = canonical
    return canonical
  }

  private async directory(id: string, create = false): Promise<string> {
    candidateId(id)
    const root = await this.root(create)
    if (!root) fail('missing_candidate', 'The workbook recovery candidate is unavailable.')
    const path = join(root, id)
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 })
      } catch (error) {
        if (!object(error) || error.code !== 'EEXIST') throw error
      }
    }
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      fail('invalid_candidate', 'The recovery candidate must be a directory, not a link.')
    const canonical = await realpath(path)
    if (relative(root, canonical) !== id)
      fail('invalid_candidate', 'The recovery candidate escaped its private directory.')
    return canonical
  }

  private async regularFile(
    directory: string,
    name: string,
    allowMissing = false,
  ): Promise<string> {
    const path = join(directory, name)
    try {
      const info = await lstat(path)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        relative(directory, await realpath(path)) !== name
      ) {
        fail('invalid_candidate', 'A recovery file is not a private regular file.')
      }
    } catch (error) {
      if (!allowMissing || !missing(error)) throw error
    }
    return path
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    const directory = await this.directory(manifest.id)
    await this.regularFile(directory, 'manifest.json', true)
    const temporary = join(directory, `manifest-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, join(directory, 'manifest.json'))
      await syncDirectory(directory)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async readManifest(id: string): Promise<{ manifest: Manifest; directory: string }> {
    const directory = await this.directory(id)
    const path = await this.regularFile(directory, 'manifest.json')
    const handle = await open(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    )
    let value: unknown
    try {
      if ((await handle.stat()).size > MAX_MANIFEST_BYTES)
        fail(
          'invalid_manifest',
          'The workbook recovery manifest is too large. Its files were preserved.',
        )
      try {
        value = JSON.parse(await handle.readFile('utf8')) as unknown
      } catch (cause) {
        throw new DocumentRecoveryError(
          'invalid_manifest',
          'The workbook recovery manifest is unreadable. Its files were preserved.',
          { cause },
        )
      }
    } finally {
      await handle.close()
    }
    return { manifest: parseManifest(value, id), directory }
  }

  private baseName(manifest: Manifest): string {
    return `base-${manifest.sourceFingerprint.slice('sha256:'.length)}.xlsx`
  }

  private async prepare(state: LiveDocument): Promise<void> {
    if (state.encrypted || state.manifest) return
    const directory = await this.directory(state.id, true)
    const temporary = join(directory, `base-${randomUUID()}.tmp`)
    await copyFile(state.sourcePath, temporary, constants.COPYFILE_EXCL)
    await chmod(temporary, 0o600)
    const [copiedHash, sourceHash] = await Promise.all([
      fingerprint(temporary),
      fingerprint(state.sourcePath),
    ])
    if (copiedHash !== sourceHash)
      fail(
        'source_conflict',
        'The workbook source changed while its recovery base was being copied.',
      )
    const base = join(directory, `base-${copiedHash.slice('sha256:'.length)}.xlsx`)
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await this.regularFile(directory, `base-${copiedHash.slice('sha256:'.length)}.xlsx`)
      if ((await fingerprint(base)) !== copiedHash)
        fail('source_conflict', 'An existing pinned recovery base is inconsistent.')
      await rm(temporary)
    } catch (error) {
      if (!missing(error)) throw error
      await rename(temporary, base)
    }
    const now = new Date().toISOString()
    const manifest: Manifest = {
      version: 1,
      id: state.id,
      runtimeId: this.runtimeId,
      ownerKeyHash: sha256(`${this.runtimeId}:${state.key}`),
      originalPath: state.originalPath,
      originalPathHash: sha256(pathIdentity(state.originalPath)),
      originalFingerprint:
        state.originalFingerprint === undefined
          ? await originalFingerprint(state.originalPath)
          : state.originalFingerprint,
      sourceFingerprint: copiedHash,
      sheets: state.sheets,
      revision: 0,
      pending: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.writeManifest(manifest)
    state.manifest = manifest
    state.sourceFingerprint = copiedHash
    await syncDirectory(directory)
    await syncDirectory((await this.root(false))!)
  }

  private async storePaths(manifest: Manifest): Promise<{ sourcePath: string; storePath: string }> {
    const directory = await this.directory(manifest.id)
    const sourcePath = await this.regularFile(directory, this.baseName(manifest))
    const storePath = await this.regularFile(directory, 'document.sqlite', true)
    await this.regularFile(directory, 'document.sqlite-wal', true)
    await this.regularFile(directory, 'document.sqlite-shm', true)
    if ((await fingerprint(sourcePath)) !== manifest.sourceFingerprint) {
      fail(
        'source_conflict',
        'The pinned workbook recovery base no longer matches its fingerprint.',
      )
    }
    return { sourcePath, storePath }
  }

  private async openState(state: LiveDocument): Promise<void> {
    if (state.opened) return
    const paths = state.manifest
      ? await this.storePaths(state.manifest)
      : { sourcePath: state.sourcePath }
    const info = nativeInfo(
      await this.native.openDocument({
        apiVersion: 1,
        documentId: state.id,
        sheets: state.sheets,
        ...paths,
      }),
      state.id,
    )
    if (
      info.durable === state.encrypted ||
      (state.sourceFingerprint !== undefined && info.sourceFingerprint !== state.sourceFingerprint)
    ) {
      fail(
        'source_conflict',
        'The native recovery session does not match the pinned workbook or storage mode.',
      )
    }
    state.revision = info.revision
    state.sourceFingerprint = info.sourceFingerprint
    state.opened = true
  }

  private async complete(
    state: LiveDocument,
    pending: PendingCheckpoint,
    receipt: NativeDocumentReceipt,
  ): Promise<void> {
    if (receipt.revision !== pending.expectedRevision + 1 || receipt.durable === state.encrypted) {
      fail(
        'invalid_native_response',
        'The native checkpoint did not acknowledge its expected revision and storage mode.',
      )
    }
    if (state.revision > receipt.revision) {
      fail(
        'persistence_conflict',
        'Another writer advanced the recovery document beyond the pending checkpoint.',
      )
    }
    if (state.manifest) {
      const manifest = {
        ...state.manifest,
        revision: receipt.revision,
        pending: null,
        updatedAt: new Date().toISOString(),
      }
      await this.writeManifest(manifest)
      state.manifest = manifest
    }
    state.revision = receipt.revision
    state.last = { payloadHash: pending.payloadHash, receipt }
    delete state.pending
  }

  private async submit(
    state: LiveDocument,
    pending: PendingCheckpoint,
  ): Promise<NativeDocumentReceipt> {
    state.pending = pending
    if (state.manifest) {
      const manifest = {
        ...state.manifest,
        pending: {
          commandId: pending.commandId,
          expectedRevision: pending.expectedRevision,
          payloadHash: pending.payloadHash,
        },
        updatedAt: new Date().toISOString(),
      }
      await this.writeManifest(manifest)
      state.manifest = manifest
    }
    try {
      const receipt = nativeReceipt(
        await this.native.checkpointDocument({
          apiVersion: 1,
          documentId: state.id,
          commandId: pending.commandId,
          expectedRevision: pending.expectedRevision,
          actor: pending.actor,
          payload: pending.payload,
        }),
        state.id,
        pending.commandId,
      )
      await this.complete(state, pending, receipt)
      return receipt
    } catch (error) {
      // The helper may have committed just before its pipe broke. Retain the
      // exact command ID/payload, reopen the database, then query that receipt.
      state.opened = false
      throw error
    }
  }

  /** Explicit SDK opens may initialize a revision-zero authority without inventing an edit. */
  async openDocument(
    input: Omit<DocumentCheckpointInput, 'payload' | 'actor' | 'commandId'>,
  ): Promise<NativeDocumentInfo & { candidateId: string | null }> {
    const ownerId = String(input.ownerId)
    if (!identifier(ownerId) || !identifier(input.sessionId) || !sheetList(input.sheets))
      fail('invalid_request', 'Invalid workbook document session.')
    if (
      input.originalFingerprint !== undefined &&
      input.originalFingerprint !== null &&
      !FINGERPRINT.test(input.originalFingerprint)
    )
      fail('invalid_request', 'Invalid opening-time workbook fingerprint.')
    const originalPath = absolutePath(input.originalPath)
    const sourcePath = absolutePath(input.sourcePath)
    const sheets = input.sheets.map(({ id, name }) => ({ id, name }))
    const key = JSON.stringify([ownerId, input.sessionId])
    this.ownerKeys.set(key, ownerId)
    return this.enqueue(key, async () => {
      let state = this.live.get(key)
      if (!state) {
        state = {
          id: randomUUID(),
          ownerId,
          key,
          originalPath,
          sourcePath,
          sheets,
          ...(input.originalFingerprint === undefined
            ? {}
            : { originalFingerprint: input.originalFingerprint }),
          encrypted: input.encrypted === true,
          opened: false,
          revision: 0,
        }
        this.live.set(key, state)
      } else if (
        pathIdentity(state.originalPath) !== pathIdentity(originalPath) ||
        state.encrypted !== (input.encrypted === true) ||
        !sameSheets(state.sheets, sheets) ||
        (input.originalFingerprint !== undefined &&
          input.originalFingerprint !== state.manifest?.originalFingerprint &&
          input.originalFingerprint !== state.originalFingerprint)
      ) {
        fail(
          'source_conflict',
          'The reopened document does not match its existing recovery session.',
        )
      }
      await this.prepare(state)
      if (
        (await fingerprint(sourcePath)) !== state.sourceFingerprint &&
        state.sourceFingerprint !== undefined
      )
        fail('source_conflict', 'The workbook source changed before reopening its authority.')
      state.opened = false
      await this.openState(state)
      return {
        apiVersion: 1,
        documentId: state.id,
        revision: state.revision,
        sourceFingerprint: state.sourceFingerprint!,
        recovered: state.revision > 0,
        durable: !state.encrypted,
        candidateId: state.encrypted ? null : state.id,
      }
    })
  }

  async checkpoint(input: DocumentCheckpointInput): Promise<DocumentCheckpointResult> {
    const ownerId = String(input.ownerId)
    if (!identifier(ownerId) || !identifier(input.sessionId) || !sheetList(input.sheets)) {
      fail('invalid_request', 'Invalid workbook checkpoint owner, session, or worksheet mapping.')
    }
    if (input.commandId !== undefined && !identifier(input.commandId))
      fail('invalid_request', 'Invalid checkpoint command identifier.')
    if (
      input.originalFingerprint !== undefined &&
      input.originalFingerprint !== null &&
      !FINGERPRINT.test(input.originalFingerprint)
    )
      fail('invalid_request', 'Invalid opening-time workbook fingerprint.')
    const actor = input.actor ?? 'local-user'
    if (!identifier(actor)) fail('invalid_request', 'Invalid checkpoint actor.')
    const originalPath = absolutePath(input.originalPath)
    const sourcePath = absolutePath(input.sourcePath)
    const payload = canonicalDocumentPayload(input.payload)
    const payloadHash = sha256(JSON.stringify(payload))
    const sheets = input.sheets.map(({ id, name }) => ({ id, name }))
    const key = JSON.stringify([ownerId, input.sessionId])
    this.ownerKeys.set(key, ownerId)
    return this.enqueue(key, async () => {
      let state = this.live.get(key)
      if (!state) {
        state = {
          id: randomUUID(),
          ownerId,
          key,
          originalPath,
          sourcePath,
          sheets,
          ...(input.originalFingerprint === undefined
            ? {}
            : { originalFingerprint: input.originalFingerprint }),
          encrypted: input.encrypted === true,
          opened: false,
          revision: 0,
        }
        this.live.set(key, state)
      } else if (
        state.encrypted !== (input.encrypted === true) ||
        pathIdentity(state.originalPath) !== pathIdentity(originalPath) ||
        !sameSheets(state.sheets, sheets)
      ) {
        fail(
          'source_conflict',
          'An existing workbook session cannot change source identity, worksheet mapping, or encryption mode.',
        )
      }
      const capturedOriginal = state.manifest
        ? state.manifest.originalFingerprint
        : state.originalFingerprint
      if (
        input.originalFingerprint !== undefined &&
        capturedOriginal !== undefined &&
        input.originalFingerprint !== capturedOriginal
      ) {
        fail(
          'source_conflict',
          'An existing recovery session cannot change its opening-time original fingerprint.',
        )
      }
      if (!state.manifest && input.originalFingerprint !== undefined)
        state.originalFingerprint = input.originalFingerprint
      if (!state.manifest) state.sourcePath = sourcePath
      await this.prepare(state)
      if (!state.encrypted && (await fingerprint(sourcePath)) !== state.sourceFingerprint) {
        fail('source_conflict', 'The workbook source no longer matches this recovery session.')
      }
      await this.openState(state)
      if (state.pending) {
        const pending = state.pending
        let result: unknown
        try {
          result = await this.native.documentCommandResult({
            apiVersion: 1,
            documentId: state.id,
            commandId: pending.commandId,
          })
        } catch (error) {
          state.opened = false
          throw error
        }
        if (result !== null)
          await this.complete(state, pending, nativeReceipt(result, state.id, pending.commandId))
        else {
          if (state.revision !== pending.expectedRevision)
            fail(
              'persistence_conflict',
              'The workbook recovery revision changed without the pending command receipt.',
            )
          await this.submit(state, pending)
        }
      }
      if (
        state.last?.payloadHash === payloadHash &&
        (input.commandId === undefined || input.commandId === state.last.receipt.commandId)
      ) {
        return { ...state.last.receipt, candidateId: state.encrypted ? null : state.id }
      }
      const receipt = await this.submit(state, {
        commandId: input.commandId ?? randomUUID(),
        expectedRevision: state.revision,
        actor,
        payload,
        payloadHash,
      })
      return { ...receipt, candidateId: state.encrypted ? null : state.id }
    })
  }

  private async status(manifest: Manifest, trustedPath?: string): Promise<OriginalState> {
    if (trustedPath === undefined) return 'unchecked'
    if (sha256(pathIdentity(trustedPath)) !== manifest.originalPathHash)
      fail('source_conflict', 'The recovery candidate belongs to another original workbook path.')
    const current = await originalFingerprint(trustedPath)
    if (current === manifest.originalFingerprint) return 'current'
    return current === null ? 'missing' : 'changed'
  }

  private summary(manifest: Manifest, originalState: OriginalState): DocumentRecoveryCandidate {
    return {
      id: manifest.id,
      documentId: manifest.id,
      originalPath: manifest.originalPath,
      sourceFingerprint: manifest.sourceFingerprint,
      revision: manifest.revision,
      sourceConflict: originalState === 'changed' || originalState === 'missing',
      originalState,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    }
  }

  async listCandidates(originalPath: string): Promise<DocumentRecoveryCandidate[]> {
    const trustedPath = absolutePath(originalPath)
    const root = await this.root(false)
    if (!root) return []
    const originalPathHash = sha256(pathIdentity(trustedPath))
    const active = new Set([...this.live.values()].map((state) => state.id))
    const candidates: DocumentRecoveryCandidate[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        !UUID.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        active.has(entry.name)
      )
        continue
      try {
        const { manifest, directory } = await this.readManifest(entry.name)
        if (manifest.originalPathHash !== originalPathHash) continue
        if (manifest.revision === 0 && manifest.pending === null) continue
        await this.regularFile(directory, 'document.sqlite')
        this.trustedOriginals.set(manifest.id, trustedPath)
        candidates.push(this.summary(manifest, await this.status(manifest, trustedPath)))
      } catch {
        // Malformed, inaccessible, or incomplete candidates remain untouched.
        // readCandidate reports a concrete error when explicitly requested.
      }
    }
    return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** Startup inventory reads only private manifests; it never probes their original paths. */
  async listAllCandidates(): Promise<DocumentRecoveryCandidate[]> {
    const root = await this.root(false)
    if (!root) return []
    const active = new Set([...this.live.values()].map((state) => state.id))
    const candidates: DocumentRecoveryCandidate[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        !UUID.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        active.has(entry.name)
      )
        continue
      try {
        const { manifest, directory } = await this.readManifest(entry.name)
        if (manifest.revision === 0 && manifest.pending === null) continue
        await this.regularFile(directory, 'document.sqlite')
        candidates.push(this.summary(manifest, 'unchecked'))
      } catch {
        /* Incomplete or invalid data stays intact for explicit inspection. */
      }
    }
    return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async readCandidate(id: string, originalPath?: string): Promise<DocumentRecoveryRead> {
    candidateId(id)
    const active = [...this.live.values()].find((state) => state.id === id)
    return this.enqueue(active?.key ?? `candidate:${id}`, async () => {
      const { manifest, directory } = await this.readManifest(id)
      await this.regularFile(directory, 'document.sqlite')
      const paths = await this.storePaths(manifest)
      const opened = await this.native.openDocument({
        apiVersion: 1,
        documentId: id,
        sheets: manifest.sheets,
        ...paths,
      })
      try {
        const info = nativeInfo(opened, id)
        if (!info.durable || info.sourceFingerprint !== manifest.sourceFingerprint)
          fail('source_conflict', 'The native recovery database belongs to another workbook.')
        if (manifest.pending)
          await this.native.documentCommandResult({
            apiVersion: 1,
            documentId: id,
            commandId: manifest.pending.commandId,
          })
        const snapshot = nativeSnapshot(
          await this.native.documentSnapshot({ apiVersion: 1, documentId: id }),
          manifest,
        )
        if (snapshot.revision === 0)
          fail(
            'missing_checkpoint',
            'This workbook has no completed recovery checkpoint. Its files were preserved.',
          )
        const trustedPath =
          originalPath === undefined ? this.trustedOriginals.get(id) : absolutePath(originalPath)
        return {
          ...this.summary(
            { ...manifest, revision: snapshot.revision },
            await this.status(manifest, trustedPath),
          ),
          pinnedBasePath: paths.sourcePath,
          originalFingerprint: manifest.originalFingerprint,
          snapshot,
        }
      } finally {
        if (!active) await this.native.closeDocument({ apiVersion: 1, documentId: id })
      }
    })
  }

  async retire(id: string): Promise<void> {
    candidateId(id)
    const active = [...this.live.values()].find((state) => state.id === id)
    await this.enqueue(active?.key ?? `candidate:${id}`, async () => {
      if (active?.encrypted && !active.manifest) {
        // Protected documents deliberately have no manifest or disk store.
        // Retire their exact queued authority without even probing the root.
        await this.native.closeDocument({ apiVersion: 1, documentId: id })
        if (this.live.get(active.key) === active) this.live.delete(active.key)
        this.trustedOriginals.delete(id)
        // ownerKeys remains until owner teardown: a later checkpoint may
        // already be queued on this key and must still be included in flush.
        return
      }
      let candidate: Awaited<ReturnType<WorkbookDocumentRecovery['readManifest']>>
      try {
        candidate = await this.readManifest(id)
      } catch (error) {
        if (missing(error)) {
          if (active)
            fail(
              'missing_checkpoint',
              'The durable document manifest is missing. Its authority and recovery files were preserved.',
            )
          return
        }
        throw error
      }
      await this.native.closeDocument({ apiVersion: 1, documentId: id })
      // directory() canonicalizes and checks the UUID child immediately before
      // recursive removal. No path in an untrusted manifest chooses the target.
      const checked = await this.directory(id)
      if (checked !== candidate.directory)
        fail('invalid_candidate', 'The recovery directory changed before retirement.')
      await rm(checked, { recursive: true, force: false })
      if (active) this.live.delete(active.key)
      this.trustedOriginals.delete(id)
      await syncDirectory((await this.root(false))!)
    })
  }

  /** Unexpected window/helper closure preserves recovery files. */
  async forgetOwner(ownerId: OwnerId): Promise<void> {
    const normalized = String(ownerId)
    await this.flush(ownerId)
    const states = [...this.live.values()].filter((state) => state.ownerId === normalized)
    await Promise.all(
      states.map((state) =>
        this.enqueue(state.key, async () => {
          try {
            await this.native.closeDocument({ apiVersion: 1, documentId: state.id })
          } finally {
            state.opened = false
            if (this.live.get(state.key) === state) this.live.delete(state.key)
          }
        }),
      ),
    )
    for (const [key, owner] of this.ownerKeys) if (owner === normalized) this.ownerKeys.delete(key)
  }

  async flush(ownerId?: OwnerId, sessionId?: string): Promise<void> {
    if (ownerId === undefined) {
      await Promise.all(this.queues.values())
      return
    }
    if (sessionId !== undefined) {
      await this.queues.get(JSON.stringify([String(ownerId), sessionId]))
      return
    }
    const keys = new Set(
      [...this.ownerKeys].filter(([, owner]) => owner === String(ownerId)).map(([key]) => key),
    )
    await Promise.all([...this.queues].filter(([key]) => keys.has(key)).map(([, queue]) => queue))
  }

  /** Host bookkeeping only: this does not acknowledge an uncertain checkpoint. */
  candidateFor(ownerId: OwnerId, sessionId: string): string | null {
    const state = this.live.get(JSON.stringify([String(ownerId), sessionId]))
    return state?.manifest ? state.id : null
  }
}
