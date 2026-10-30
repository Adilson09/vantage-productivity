/** Portable document API: Rust revisions own state; the shared package writer owns OOXML surgery. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { withAtomicSaveQueue } from '@vantage/electron-utils/atomic-write'

import { validateDocumentPayload } from '../shared/document-checkpoint'
import type { WorkbookSaveRequest } from '../shared/desktop-api'
import { MAX_SAVE_EDITS } from '../shared/ipc-channels'
import type { DocumentNativeClient, NativeDocumentSnapshot } from './document-native-contract'
import type { EditRecalcRead } from './xlsx-edit-contract'
import type { XlsxSidecarClient } from './xlsx-sidecar-client'
import {
  WorkbookDocumentRecovery,
  type DocumentCheckpointResult,
} from './workbook-document-recovery'
import { writeDocumentSavePipeline } from './document-save-pipeline'
import {
  writeWorkbookDocumentPackage,
  type DocumentPackageWriteInput,
  type DocumentPackageWriteResult,
  type DocumentWriteSession,
} from './workbook-document-writer'

export interface SpreadsheetNativeClient
  extends
    DocumentNativeClient,
    Pick<
      XlsxSidecarClient,
      | 'open'
      | 'close'
      | 'readRange'
      | 'archiveManifest'
      | 'readEntries'
      | 'scanEntries'
      | 'saveArchive'
    > {
  recalcDocument(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly revision: number
    readonly reads: readonly EditRecalcRead[]
    readonly materializedPath?: string
  }): Promise<unknown>
  auditPreservation(input: {
    readonly sourcePath: string
    readonly targetPath: string
    readonly allowedChangedEntries: readonly string[]
  }): Promise<unknown>
}

export interface SpreadsheetBackendConfig {
  readonly client: SpreadsheetNativeClient
  readonly privateRoot: string
  readonly tempRoot: string
  readonly encryptOoxml: (bytes: Buffer, password: string) => Buffer
  readonly decryptOoxml?: (bytes: Buffer, password: string) => Promise<Buffer>
  readonly atomicWriteFile: (path: string, bytes: Buffer) => Promise<unknown>
  /** Supply the streaming publisher for large unencrypted workbooks. */
  readonly atomicCopyFile?: (sourcePath: string, targetPath: string) => Promise<unknown>
  readonly withNativeSaveRecovery: <T>(path: string, write: () => Promise<T>) => Promise<T>
  readonly writePackage?: (input: DocumentPackageWriteInput) => Promise<DocumentPackageWriteResult>
  readonly onWarning?: (message: string, error?: unknown) => void
}

export interface SpreadsheetDocumentHandle {
  readonly id: string
  readonly revision: number
  readonly sourceFingerprint: string
  readonly sheets: readonly { readonly id: string; readonly name: string }[]
}

type Handle = string | Pick<SpreadsheetDocumentHandle, 'id'>
type Reader = DocumentWriteSession & {
  readonly sessionId: string
  readonly sheetExtents: ReadonlyMap<
    string,
    { readonly rowCount: number; readonly columnCount: number }
  >
}
type FormulaValue = WorkbookSaveRequest['formulaValues'][number]
interface LiveDocument {
  id: string
  ownerId: string
  documentId: string
  revision: number
  sourceFingerprint: string
  originalPath: string
  originalFingerprint: string | null
  directory: string
  reader: Reader
  sheets: { id: string; name: string }[]
  candidateId: string | null
  inheritedCandidateId?: string
  uncertain: boolean
  lost: boolean
  saving: boolean
  closing: boolean
  closed: boolean
  allowWriteBack: boolean
  calculation?: { revision: number; values: Map<string, FormulaValue> } | undefined
  calculationWithheld?: { revision: number; reasons: string[] } | undefined
  calculations: Set<Promise<unknown>>
}

const readerSchema = z
  .object({
    sessionId: z.string().uuid(),
    sheets: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            rowCount: z.number().int().positive().max(1_048_576),
            columnCount: z.number().int().positive().max(16_384),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough()
const nativeSnapshotSchema = z.object({
  apiVersion: z.literal(1),
  documentId: z.string().min(1),
  revision: z.number().int().nonnegative().safe(),
  sourceFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sheets: z.array(z.object({ id: z.string(), name: z.string() })),
  payload: z.unknown(),
})
const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const rangeSchema = z
  .object({
    startRow: z.number().int().min(0).max(1_048_575),
    endRow: z.number().int().min(0).max(1_048_575),
    startColumn: z.number().int().min(0).max(16_383),
    endColumn: z.number().int().min(0).max(16_383),
  })
  .refine(
    (range) =>
      range.endRow >= range.startRow &&
      range.endColumn >= range.startColumn &&
      (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) <= 20_000,
  )
const calculatedValueSchema = z.union([
  z.number().finite(),
  z.string().max(10_000),
  z.boolean(),
  z.null(),
  z.object({ error: z.string().min(1).max(32) }).strict(),
])
const calculatedCellSchema = z
  .object({
    sheet: z.string().min(1),
    row: z.number().int().min(0).max(1_048_575),
    column: z.number().int().min(0).max(16_383),
    formatted: z.string(),
    number: z.number().finite().optional(),
    isError: z.boolean(),
    isFormula: z.boolean(),
    value: calculatedValueSchema,
  })
  .passthrough()
  .refine((cell) => cell.isError === (typeof cell.value === 'object' && cell.value !== null), {
    message: 'A calculated error must carry its typed spreadsheet error value.',
  })
const calculationProvenanceSchema = z.object({
  cacheWritebackAllowed: z.boolean(),
  calculationCompleteness: z.enum(['complete', 'unverified']),
  cacheWritebackReasons: z.array(z.string().min(1).max(64)).max(32),
})
const readCoverageSchema = z
  .object({
    indexingComplete: z.boolean(),
    indexedThroughRow: z.number().int().min(0).max(1_048_575).nullable(),
  })
  .passthrough()
const READ_INDEX_TIMEOUT_MS = 30_000
const READ_INDEX_POLL_MS = 100

export class SpreadsheetBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SpreadsheetBackendError'
  }
}

function fail(code: string, message: string, details?: unknown): never {
  throw new SpreadsheetBackendError(code, message, details)
}
function identity(path: string): string {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
}
function absolute(path: string): string {
  if (!isAbsolute(path)) fail('invalid_path', 'A spreadsheet path must be absolute.')
  return resolve(path)
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}
async function maybeDigest(path: string): Promise<string | null> {
  try {
    return await digest(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function changedEntries(
  first: DocumentPackageWriteResult,
  last?: DocumentPackageWriteResult,
): string[] {
  return [
    ...new Set(
      [first, ...(last ? [last] : [])].flatMap((result) => [
        ...result.touchedEntries,
        ...result.removedEntries,
        ...result.addedEntries,
      ]),
    ),
  ]
}
function formulaKey(cell: Pick<FormulaValue, 'sheetId' | 'row' | 'column'>): string {
  return JSON.stringify([cell.sheetId, cell.row, cell.column])
}

export class SpreadsheetDocumentBackend {
  private readonly recovery: WorkbookDocumentRecovery
  private readonly entries = new Map<string, LiveDocument>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly tempRoot: string

  constructor(private readonly config: SpreadsheetBackendConfig) {
    this.tempRoot = absolute(config.tempRoot)
    if (/^(?:\\\\|\/\/)/.test(config.tempRoot))
      fail('invalid_path', 'The spreadsheet temporary directory must be local.')
    this.recovery = new WorkbookDocumentRecovery({
      privateRoot: join(absolute(config.privateRoot), 'documents'),
      nativeClient: config.client,
    })
  }

  capabilities() {
    return {
      apiVersion: 1,
      authority: 'Rust',
      formats: ['xlsx', 'xlsm'],
      transport: 'stdio',
      checkpoints: 'complete typed workbook payloads',
      recovery: 'SQLite for unencrypted documents',
      reads: 'revision-pinned materialized workbook views',
      formulaEngine: 'IronCalc',
      preservation: 'native package-part and relationship audit before publication',
      operations: [
        'open',
        'checkpoint',
        'snapshot',
        'read',
        'recalculate',
        'save',
        'close',
        'candidates',
        'recover',
      ],
      dependentSavePhases:
        'private and rebound to the reopened worksheet layout before one publication',
      pythonClient: true,
      workbookCodeExecution: false,
      vbaExecution: false,
      comAutomation: false,
      limits: [
        'Formula support follows the installed formula engine.',
        'Read and calculation viewports are limited to 20,000 cells per request.',
      ],
    } as const
  }

  private warn(message: string, error?: unknown): void {
    try {
      this.config.onWarning?.(message, error)
    } catch {
      /* Logging never changes an acknowledged result. */
    }
  }
  private handle(entry: LiveDocument): SpreadsheetDocumentHandle {
    return {
      id: entry.id,
      revision: entry.revision,
      sourceFingerprint: entry.sourceFingerprint,
      sheets: structuredClone(entry.sheets),
    }
  }
  private entry(handle: Handle): LiveDocument {
    const id = typeof handle === 'string' ? handle : handle.id
    const entry = this.entries.get(id)
    if (!entry || entry.closed || entry.closing)
      fail('document_closed', 'This spreadsheet handle is closed.')
    return entry
  }
  private current(entry: LiveDocument, revision: number): void {
    if (entry.closed || entry.closing)
      fail('document_closed', 'This spreadsheet handle closed during the operation.')
    if (entry.lost)
      fail(
        'session_lost',
        'The in-memory spreadsheet authority was lost. Open a new handle before continuing.',
      )
    if (entry.uncertain)
      fail(
        'checkpoint_outcome_unknown',
        'Retry the interrupted checkpoint before reading or saving this document.',
      )
    if (entry.revision !== revision)
      fail('revision_conflict', 'The spreadsheet changed during the operation.', {
        currentRevision: entry.revision,
      })
  }
  private enqueue<T>(id: string, run: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(run)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(id, settled)
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return result
  }
  private async temporary(): Promise<string> {
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 })
    return mkdtemp(join(await realpath(this.tempRoot), 'vantage-document-'))
  }
  private async cleanup(directory: string): Promise<void> {
    const root = await realpath(this.tempRoot)
    const canonical = await realpath(directory)
    const child = relative(root, canonical)
    if (child === '' || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child))
      fail(
        'invalid_path',
        'Refusing to remove a directory outside the private spreadsheet workspace.',
      )
    await rm(canonical, { recursive: true, force: true })
  }
  private async reader(path: string, password?: string): Promise<Reader> {
    const result = readerSchema.parse(await this.config.client.open(path, 'en'))
    return {
      sessionId: result.sessionId,
      snapshotPath: path,
      sheetNames: new Map(result.sheets.map((sheet) => [sheet.id, sheet.name])),
      sheetExtents: new Map(
        result.sheets.map((sheet) => [
          sheet.id,
          {
            rowCount: sheet.rowCount,
            columnCount: sheet.columnCount,
          },
        ]),
      ),
      ...(password === undefined ? {} : { password }),
    }
  }

  async open(
    path: string,
    options: { readonly password?: string } = {},
  ): Promise<SpreadsheetDocumentHandle> {
    return this.openFrom(path, options)
  }

  private async openFrom(
    path: string,
    options: { readonly password?: string },
    origin?: {
      readonly path: string
      readonly fingerprint: string | null
      readonly allowWriteBack: boolean
    },
  ): Promise<SpreadsheetDocumentHandle> {
    const readPath = absolute(path)
    const originalPath = origin === undefined ? readPath : absolute(origin.path)
    if (!['.xlsx', '.xlsm'].includes(extname(readPath).toLowerCase()))
      fail('unsupported_format', 'The portable backend currently opens XLSX and XLSM workbooks.')
    const readFingerprint = await digest(readPath)
    const originalFingerprint = origin === undefined ? readFingerprint : origin.fingerprint
    const directory = await this.temporary()
    const sourcePath = join(directory, 'base.bin')
    let reader: Reader | undefined
    const id = randomUUID()
    try {
      const file = await open(readPath, 'r')
      const header = Buffer.alloc(8)
      try {
        await file.read(header, 0, 8, 0)
      } finally {
        await file.close()
      }
      if (header.equals(OLE_HEADER)) {
        if (options.password === undefined)
          fail('password_required', 'This workbook requires a password.')
        if (!this.config.decryptOoxml)
          fail('unsupported_encryption', 'This backend has no workbook decryption adapter.')
        await writeFile(
          sourcePath,
          await this.config.decryptOoxml(await readFile(readPath), options.password),
          { flag: 'wx', mode: 0o600 },
        )
      } else {
        await copyFile(readPath, sourcePath, constants.COPYFILE_EXCL)
        await chmod(sourcePath, 0o600)
        if ((await digest(sourcePath)) !== readFingerprint)
          fail('source_conflict', 'The workbook changed while its private snapshot was copied.')
      }
      if ((await digest(readPath)) !== readFingerprint)
        fail('source_conflict', 'The workbook changed while it was opening.')
      reader = await this.reader(sourcePath, options.password)
      const sourceFingerprint = await digest(sourcePath)
      const sheets = [...reader.sheetNames].map(([sheetId, name]) => ({ id: sheetId, name }))
      const info = await this.recovery.openDocument({
        ownerId: id,
        sessionId: reader.sessionId,
        originalPath,
        sourcePath,
        originalFingerprint,
        sheets,
        encrypted: options.password !== undefined,
      })
      if (info.sourceFingerprint !== sourceFingerprint || info.revision !== 0)
        fail('source_conflict', 'The native authority does not match this new workbook snapshot.')
      const entry: LiveDocument = {
        id: info.documentId,
        ownerId: id,
        documentId: info.documentId,
        revision: 0,
        sourceFingerprint,
        originalPath,
        originalFingerprint,
        directory,
        reader,
        sheets,
        candidateId: info.candidateId,
        uncertain: false,
        lost: false,
        saving: false,
        closed: false,
        closing: false,
        allowWriteBack: origin?.allowWriteBack ?? true,
        calculations: new Set(),
      }
      this.entries.set(entry.id, entry)
      return this.handle(entry)
    } catch (error) {
      if (reader) await this.config.client.close(reader.sessionId).catch(() => undefined)
      await this.recovery.forgetOwner(id).catch(() => undefined)
      await this.cleanup(directory).catch((cleanupError) =>
        this.warn('A private spreadsheet snapshot could not be removed.', cleanupError),
      )
      throw error
    }
  }

  async checkpoint(
    handle: Handle,
    payload: unknown,
    options: { readonly expectedRevision?: number; readonly commandId?: string } = {},
  ): Promise<DocumentCheckpointResult> {
    const entry = this.entry(handle)
    if (entry.saving)
      fail(
        'document_busy',
        'The workbook is being saved. Retry this checkpoint with the returned clean handle.',
      )
    const canonical = validateDocumentPayload(payload)
    return this.enqueue(entry.id, async () => {
      if (entry.closed) fail('document_closed', 'This spreadsheet handle is closed.')
      if (entry.lost)
        fail(
          'session_lost',
          'The in-memory spreadsheet authority was lost. Open a new handle before resubmitting edits.',
        )
      if (options.expectedRevision !== undefined && options.expectedRevision !== entry.revision)
        fail('revision_conflict', 'The expected spreadsheet revision changed.', {
          currentRevision: entry.revision,
        })
      const previousId = entry.documentId
      let result: DocumentCheckpointResult
      try {
        result = await this.recovery.checkpoint({
          ownerId: entry.ownerId,
          sessionId: entry.reader.sessionId,
          originalPath: entry.originalPath,
          originalFingerprint: entry.originalFingerprint,
          sourcePath: entry.reader.snapshotPath,
          sheets: entry.sheets,
          payload: canonical,
          encrypted: entry.reader.password !== undefined,
          ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
          actor: 'portable-backend',
        })
      } catch (error) {
        entry.uncertain = true
        entry.candidateId = this.recovery.candidateFor(entry.ownerId, entry.reader.sessionId)
        throw error
      }
      entry.documentId = result.documentId
      entry.revision = result.revision
      if (entry.calculation?.revision !== result.revision) entry.calculation = undefined
      if (entry.calculationWithheld?.revision !== result.revision)
        entry.calculationWithheld = undefined
      entry.candidateId = result.candidateId
      entry.uncertain = false
      if (previousId !== result.documentId)
        await this.config.client
          .closeDocument({ apiVersion: 1, documentId: previousId })
          .catch((error) =>
            this.warn('The superseded spreadsheet authority could not be closed.', error),
          )
      return result
    })
  }

  private checkedSnapshot(
    raw: unknown,
    entry: LiveDocument,
    documentId: string,
  ): NativeDocumentSnapshot {
    const snapshot = nativeSnapshotSchema.parse(raw)
    if (
      snapshot.documentId !== documentId ||
      snapshot.sourceFingerprint !== entry.sourceFingerprint ||
      JSON.stringify(snapshot.sheets) !== JSON.stringify(entry.sheets)
    )
      fail('source_conflict', 'The native snapshot belongs to another workbook.')
    return { ...snapshot, payload: validateDocumentPayload(snapshot.payload) }
  }

  async snapshot(handle: Handle, revision?: number): Promise<NativeDocumentSnapshot> {
    const entry = this.entry(handle)
    if (entry.lost)
      fail('session_lost', 'The prior in-memory spreadsheet revisions are no longer available.')
    if (entry.uncertain)
      fail(
        'checkpoint_outcome_unknown',
        'Retry the interrupted checkpoint before reading its snapshot.',
      )
    const documentId = entry.documentId
    try {
      return this.checkedSnapshot(
        await this.config.client.documentSnapshot({
          apiVersion: 1,
          documentId,
          ...(revision === undefined ? {} : { revision }),
        }),
        entry,
        documentId,
      )
    } catch (error) {
      const reopened = await this.recovery.openDocument({
        ownerId: entry.ownerId,
        sessionId: entry.reader.sessionId,
        originalPath: entry.originalPath,
        originalFingerprint: entry.originalFingerprint,
        sourcePath: entry.reader.snapshotPath,
        sheets: entry.sheets,
        encrypted: entry.reader.password !== undefined,
      })
      if (reopened.revision < entry.revision) {
        entry.lost = true
        fail(
          'session_lost',
          'The in-memory spreadsheet authority was lost. Its prior revisions cannot be recreated safely.',
        )
      }
      if (revision !== undefined && revision !== reopened.revision) throw error
      return this.checkedSnapshot(
        await this.config.client.documentSnapshot({
          apiVersion: 1,
          documentId,
          ...(revision === undefined ? {} : { revision }),
        }),
        entry,
        documentId,
      )
    }
  }

  private async materialize(
    entry: LiveDocument,
    snapshot: NativeDocumentSnapshot,
  ): Promise<{
    path: string
    mutation: DocumentPackageWriteResult
    cleanup: () => Promise<void>
  }> {
    const directory = await this.temporary()
    const path = join(directory, 'view.bin')
    const request: WorkbookSaveRequest = {
      ...this.materializedPayload(entry, snapshot),
      sessionId: entry.reader.sessionId,
      mode: 'save-as',
    }
    try {
      const mutation = await writeDocumentSavePipeline<Reader, DocumentPackageWriteResult>({
        sheetNames: (phase) => phase.sheetNames,
        session: entry.reader,
        request,
        targetPath: path,
        write: (session, payload, targetPath) =>
          (this.config.writePackage ?? writeWorkbookDocumentPackage)({
            client: this.config.client,
            session: { snapshotPath: session.snapshotPath, sheetNames: session.sheetNames },
            request: payload,
            targetPath,
            tempRoot: directory,
            encryptOoxml: this.config.encryptOoxml,
            atomicWriteFile: this.config.atomicWriteFile,
            withNativeSaveRecovery: (_target, write) => write(),
            verifyPreservation: false,
          }),
        openPhase: (phasePath) => this.reader(phasePath),
        closePhase: async (phase) => {
          await this.config.client.close(phase.sessionId)
        },
        phaseSessionId: (phase) => phase.sessionId,
        allocatePhase: async () => ({
          path: join(directory, 'structural-phase.bin'),
          cleanup: async () => {
            await rm(join(directory, 'structural-phase.bin'), { force: true })
          },
        }),
        beforePublish: () => this.current(entry, snapshot.revision),
        combineResults: (first, last) => ({
          touchedEntries: [...new Set([...first.touchedEntries, ...last.touchedEntries])],
          removedEntries: [...new Set([...first.removedEntries, ...last.removedEntries])],
          addedEntries: [...new Set([...first.addedEntries, ...last.addedEntries])],
        }),
        onCleanupError: (error) =>
          this.warn('A private spreadsheet save phase could not be cleaned up.', error),
      })
      this.current(entry, snapshot.revision)
      return { path, mutation, cleanup: () => this.cleanup(directory) }
    } catch (error) {
      await this.cleanup(directory).catch((cleanupError) =>
        this.warn('A failed private spreadsheet view could not be removed.', cleanupError),
      )
      throw error
    }
  }

  /** Derived values never change the Rust input revision or its recovery payload. */
  private materializedPayload(entry: LiveDocument, snapshot: NativeDocumentSnapshot) {
    const payload = validateDocumentPayload(snapshot.payload)
    const calculated = entry.calculation
    if (!calculated || calculated.revision !== snapshot.revision || calculated.values.size === 0)
      return payload
    const values = new Map(payload.formulaValues.map((cell) => [formulaKey(cell), cell]))
    for (const [key, cell] of calculated.values) values.set(key, cell)
    if (values.size > MAX_SAVE_EDITS)
      fail(
        'calculation_cache_limit',
        'The calculated formula cache exceeds the document save limit.',
      )
    return { ...payload, formulaValues: [...values.values()] }
  }

  private cacheCalculation(
    entry: LiveDocument,
    snapshot: NativeDocumentSnapshot,
    cells: readonly z.infer<typeof calculatedCellSchema>[],
  ): void {
    const payload = validateDocumentPayload(snapshot.payload)
    const names = new Map(entry.sheets.map((sheet) => [sheet.id, sheet.name]))
    for (const operation of payload.sheetOps) {
      if (operation.kind === 'add-sheet' || operation.kind === 'duplicate-sheet')
        names.set(operation.sheetId, operation.name)
      else if (operation.kind === 'rename-sheet') names.set(operation.sheetId, operation.newName)
      else if (operation.kind === 'remove-sheet') names.delete(operation.sheetId)
    }
    const byName = new Map<string, string>()
    for (const [id, name] of names) {
      if (byName.has(name))
        fail(
          'invalid_calculation_result',
          'The calculated worksheet name is ambiguous in this committed snapshot.',
        )
      byName.set(name, id)
    }
    const values = new Map(
      entry.calculation?.revision === snapshot.revision ? entry.calculation.values : undefined,
    )
    for (const cell of cells) {
      if (!cell.isFormula) continue
      const sheetId = byName.get(cell.sheet)
      if (!sheetId)
        fail(
          'invalid_calculation_result',
          'The calculated worksheet is absent from this committed snapshot.',
        )
      const value: FormulaValue = {
        sheetId,
        row: cell.row,
        column: cell.column,
        value: structuredClone(cell.value),
      }
      values.set(formulaKey(value), value)
    }
    const total = new Set([...payload.formulaValues.map(formulaKey), ...values.keys()]).size
    if (total > MAX_SAVE_EDITS)
      fail(
        'calculation_cache_limit',
        'The calculated formula cache exceeds the document save limit.',
      )
    this.current(entry, snapshot.revision)
    entry.calculation = { revision: snapshot.revision, values }
  }

  private async readReaderRange(
    reader: Reader,
    sheetId: string,
    requested: EditRecalcRead['range'],
    current: () => void,
  ): Promise<unknown> {
    const extent = reader.sheetExtents.get(sheetId)
    if (!extent) fail('unknown_sheet', 'This workbook has no worksheet with that identifier.')
    if (requested.startRow >= extent.rowCount || requested.startColumn >= extent.columnCount) {
      // Cells beyond the reader's effective extent are blank. Sheet-wide
      // metadata was not queried, so do not claim the index has completed.
      return {
        cells: [],
        rows: [],
        merges: [],
        hyperlinks: [],
        conditionalRules: [],
        autoFilter: null,
        autoFilterColumns: [],
        dataValidations: [],
        sheetProtection: null,
        rowBreaks: [],
        colBreaks: [],
        protectedRanges: [],
        pageSetup: null,
        indexedThroughRow: null,
        indexingComplete: false,
      }
    }
    const range = {
      ...requested,
      endRow: Math.min(requested.endRow, extent.rowCount - 1),
      endColumn: Math.min(requested.endColumn, extent.columnCount - 1),
    }
    const deadline = Date.now() + READ_INDEX_TIMEOUT_MS
    for (;;) {
      current()
      const result = await this.config.client.readRange({
        sessionId: reader.sessionId,
        sheetId,
        range,
      })
      current()
      const coverage = readCoverageSchema.safeParse(result)
      if (!coverage.success) {
        fail(
          'invalid_native_result',
          'The worksheet reader did not report valid row-index coverage.',
          coverage.error.issues,
        )
      }
      if (
        coverage.data.indexingComplete ||
        (coverage.data.indexedThroughRow !== null &&
          coverage.data.indexedThroughRow >= range.endRow)
      )
        return result
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        fail(
          'indexing_not_ready',
          'The worksheet has not finished indexing this range. Retry the read.',
          {
            indexedThroughRow: coverage.data.indexedThroughRow,
            requiredThroughRow: range.endRow,
            retryAfterMs: READ_INDEX_POLL_MS,
          },
        )
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(READ_INDEX_POLL_MS, remaining)),
      )
    }
  }

  async readRange(
    handle: Handle,
    read: { readonly sheetId: string; readonly range: EditRecalcRead['range'] },
  ) {
    const entry = this.entry(handle)
    const parsedRange = rangeSchema.safeParse(read.range)
    if (!parsedRange.success)
      fail('invalid_range', 'Read a valid spreadsheet viewport of at most 20,000 cells.')
    const requestedRange = parsedRange.data
    const revision = entry.revision
    const snapshot = await this.snapshot(handle, revision)
    this.current(entry, revision)
    if (
      revision === 0 &&
      !(entry.calculation?.revision === revision && entry.calculation.values.size > 0)
    ) {
      if (!entry.reader.sheetNames.has(read.sheetId))
        fail('unknown_sheet', 'This workbook has no worksheet with that identifier.')
      const result = await this.readReaderRange(entry.reader, read.sheetId, requestedRange, () =>
        this.current(entry, revision),
      )
      this.current(entry, revision)
      return { handleId: entry.id, revision, sheetId: read.sheetId, range: requestedRange, result }
    }
    const view = await this.materialize(entry, snapshot)
    let reader: Reader | undefined
    try {
      reader = await this.reader(view.path)
      let sheetId = read.sheetId
      if (!reader.sheetNames.has(sheetId)) {
        let name: string | undefined
        for (const operation of validateDocumentPayload(snapshot.payload).sheetOps) {
          if ('sheetId' in operation && operation.sheetId === sheetId) {
            if (operation.kind === 'add-sheet' || operation.kind === 'duplicate-sheet')
              name = operation.name
            else if (operation.kind === 'rename-sheet') name = operation.newName
          }
        }
        const assigned = [...reader.sheetNames].find(([, sheetName]) => sheetName === name)?.[0]
        if (!assigned)
          fail(
            'unknown_sheet',
            'The requested worksheet is not present in this committed snapshot.',
          )
        sheetId = assigned
      }
      const result = await this.readReaderRange(reader, sheetId, requestedRange, () =>
        this.current(entry, revision),
      )
      this.current(entry, revision)
      return { handleId: entry.id, revision, sheetId: read.sheetId, range: requestedRange, result }
    } finally {
      if (reader)
        await this.config.client
          .close(reader.sessionId)
          .catch((error) => this.warn('The private spreadsheet reader could not be closed.', error))
      await view
        .cleanup()
        .catch((error) => this.warn('The private spreadsheet view could not be removed.', error))
    }
  }

  async recalculate(handle: Handle, reads: readonly EditRecalcRead[], revision?: number) {
    const entry = this.entry(handle)
    if (entry.saving)
      fail(
        'document_busy',
        'The workbook is being saved. Calculate with the returned clean handle.',
      )
    const expected = revision ?? entry.revision
    if (
      reads.length > 1_000 ||
      reads.some((read) => !read.sheet || !rangeSchema.safeParse(read.range).success) ||
      reads.reduce(
        (count, read) =>
          count +
          (read.range.endRow - read.range.startRow + 1) *
            (read.range.endColumn - read.range.startColumn + 1),
        0,
      ) > 20_000
    ) {
      fail(
        'invalid_range',
        'Calculation reads must cover valid viewports totaling at most 20,000 cells.',
      )
    }
    this.current(entry, expected)
    const calculation = (async () => {
      const snapshot = await this.snapshot(handle, expected)
      let view: Awaited<ReturnType<SpreadsheetDocumentBackend['materialize']>> | undefined
      try {
        this.current(entry, expected)
        const input = {
          apiVersion: 1 as const,
          documentId: entry.documentId,
          revision: expected,
          reads,
        }
        let raw: unknown
        try {
          raw = await this.config.client.recalcDocument(input)
        } catch (error) {
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
          if (
            code !== 'document_requires_materialization' &&
            code !== 'calculation_budget_exceeded'
          )
            throw error
          this.current(entry, expected)
          view = await this.materialize(entry, snapshot)
          this.current(entry, expected)
          raw = await this.config.client.recalcDocument({ ...input, materializedPath: view.path })
        }
        this.current(entry, expected)
        const checked = z
          .object({
            workbookId: z.literal(entry.documentId),
            revision: z.literal(expected),
            cells: z.array(calculatedCellSchema).max(20_000),
          })
          .passthrough()
          .safeParse(raw)
        if (!checked.success) {
          entry.calculation = undefined
          entry.calculationWithheld = {
            revision: expected,
            reasons: ['invalid_calculation_result'],
          }
          fail(
            'invalid_calculation_result',
            'The native calculator did not return revision-bound typed cell results.',
            checked.error.issues,
          )
        }
        const result = checked.data
        this.current(entry, expected)
        const provenance = calculationProvenanceSchema.safeParse(result)
        const certified =
          provenance.success &&
          provenance.data.cacheWritebackAllowed &&
          provenance.data.calculationCompleteness === 'complete' &&
          provenance.data.cacheWritebackReasons.length === 0
        const previousDenial =
          entry.calculationWithheld?.revision === expected ? entry.calculationWithheld.reasons : []
        const reasons = [
          ...new Set([
            ...previousDenial,
            ...(certified
              ? []
              : provenance.success
                ? provenance.data.cacheWritebackReasons.length > 0
                  ? provenance.data.cacheWritebackReasons
                  : ['calculation_unverified']
                : ['native_provenance_missing_or_invalid']),
          ]),
        ].slice(0, 32)
        const allowed = certified && reasons.length === 0
        if (allowed) {
          try {
            this.cacheCalculation(entry, snapshot, result.cells)
          } catch (error) {
            entry.calculation = undefined
            entry.calculationWithheld = { revision: expected, reasons: ['cache_writeback_failed'] }
            throw error
          }
        } else {
          entry.calculation = undefined
          entry.calculationWithheld = { revision: expected, reasons }
        }
        return {
          ...result,
          handleId: entry.id,
          cacheWriteback: allowed ? ('allowed' as const) : ('withheld' as const),
          cacheWritebackAllowed: allowed,
          calculationCompleteness: allowed ? ('complete' as const) : ('unverified' as const),
          cacheWritebackReasons: reasons,
        }
      } finally {
        await view
          ?.cleanup()
          .catch((error) => this.warn('The calculation snapshot could not be removed.', error))
      }
    })()
    entry.calculations.add(calculation)
    try {
      return await calculation
    } finally {
      entry.calculations.delete(calculation)
    }
  }

  async save(handle: Handle, target: string, options: { readonly overwrite?: boolean } = {}) {
    const entry = this.entry(handle)
    if (entry.saving) fail('document_busy', 'This workbook already has a save in progress.')
    const targetPath = absolute(target)
    if (!['.xlsx', '.xlsm'].includes(extname(targetPath).toLowerCase()))
      fail('unsupported_format', 'Save this workbook as XLSX or XLSM.')
    if (extname(targetPath).toLowerCase() !== extname(entry.originalPath).toLowerCase()) {
      fail(
        'save_format_mismatch',
        'Keep the workbook package format when saving: XLSX stays XLSX and XLSM stays XLSM.',
      )
    }
    // Set before the first await/queue boundary. Earlier accepted checkpoints
    // finish first; later callers cannot receive an acknowledgement that the
    // close/rebase below would otherwise retire with the superseded handle.
    entry.saving = true
    try {
      return await this.enqueue(entry.id, () =>
        withAtomicSaveQueue(targetPath, async () => {
          // Calculations accepted before publication are acknowledged only after
          // their matching cache is ready. Later jobs are refused by the gate.
          await Promise.allSettled([...entry.calculations])
          const revision = entry.revision
          this.current(entry, revision)
          const sameOriginal = identity(targetPath) === identity(entry.originalPath)
          if (sameOriginal && !entry.allowWriteBack)
            fail(
              'source_conflict',
              'This recovered workbook requires Save As to preserve the current original.',
            )
          const targetFingerprint = await maybeDigest(targetPath)
          if (sameOriginal && targetFingerprint !== entry.originalFingerprint)
            fail('source_conflict', 'The original workbook changed. Save a separate copy.')
          if (!sameOriginal && targetFingerprint !== null && options.overwrite !== true)
            fail('file_exists', 'The destination already exists. Explicit overwrite is required.')
          const snapshot = await this.snapshot(entry.id, revision)
          const view = await this.materialize(entry, snapshot)
          let audit: unknown
          try {
            audit = await this.config.client.auditPreservation({
              sourcePath: entry.reader.snapshotPath,
              targetPath: view.path,
              allowedChangedEntries: changedEntries(view.mutation),
            })
            const checked = z
              .object({ preserved: z.boolean(), violations: z.array(z.unknown()) })
              .passthrough()
              .parse(audit)
            if (!checked.preserved || checked.violations.length > 0)
              fail(
                'preservation_failed',
                'The completed workbook did not pass its package preservation audit.',
                audit,
              )
            this.current(entry, revision)
            if ((await maybeDigest(targetPath)) !== targetFingerprint)
              fail(
                'source_conflict',
                'The destination changed while the workbook was being prepared.',
              )
            await this.config.withNativeSaveRecovery(targetPath, async () => {
              this.current(entry, revision)
              if (entry.reader.password !== undefined) {
                const bytes = this.config.encryptOoxml(
                  await readFile(view.path),
                  entry.reader.password,
                )
                await this.assertNativeRevision(entry, revision)
                await this.config.atomicWriteFile(targetPath, bytes)
              } else if (this.config.atomicCopyFile) {
                await this.assertNativeRevision(entry, revision)
                await this.config.atomicCopyFile(view.path, targetPath)
              } else {
                const bytes = await readFile(view.path)
                await this.assertNativeRevision(entry, revision)
                await this.config.atomicWriteFile(targetPath, bytes)
              }
            })
          } catch (error) {
            await view
              .cleanup()
              .catch((cleanupError) =>
                this.warn('The failed save snapshot could not be removed.', cleanupError),
              )
            throw error
          }
          const warnings: string[] = []
          let reopened: SpreadsheetDocumentHandle | null = null
          try {
            reopened = await this.open(
              targetPath,
              entry.reader.password === undefined ? {} : { password: entry.reader.password },
            )
          } catch (error) {
            warnings.push(
              'The workbook was saved, but reopening it failed. Open the saved file again before editing.',
            )
            this.warn(warnings[warnings.length - 1]!, error)
          }
          // Publication already succeeded: retirement/cleanup failures are warnings,
          // and the old handle always closes so its overlay cannot be applied twice.
          for (const id of new Set(
            [entry.candidateId, entry.inheritedCandidateId].filter(
              (id): id is string => id !== null && id !== undefined,
            ),
          )) {
            await this.recovery.retire(id).catch((error) => {
              warnings.push('The saved recovery checkpoint could not be retired.')
              this.warn(warnings[warnings.length - 1]!, error)
            })
          }
          await this.closeEntry(entry).catch((error) => {
            warnings.push('The previous workbook session could not be fully cleaned up.')
            this.warn(warnings[warnings.length - 1]!, error)
          })
          await view.cleanup().catch((error) => {
            warnings.push('The private save snapshot could not be removed.')
            this.warn(warnings[warnings.length - 1]!, error)
          })
          return {
            savedRevision: revision,
            targetPath,
            mutation: view.mutation,
            audit,
            handle: reopened,
            warnings,
          }
        }),
      )
    } finally {
      entry.saving = false
    }
  }

  private async assertNativeRevision(entry: LiveDocument, revision: number): Promise<void> {
    const latest = nativeSnapshotSchema.parse(
      await this.config.client.documentSnapshot({
        apiVersion: 1,
        documentId: entry.documentId,
      }),
    )
    if (
      latest.documentId !== entry.documentId ||
      latest.sourceFingerprint !== entry.sourceFingerprint
    ) {
      fail('source_conflict', 'The native authority changed source identity before publication.')
    }
    if (latest.revision !== revision)
      fail('revision_conflict', 'The native workbook advanced before publication.', {
        currentRevision: latest.revision,
      })
    this.current(entry, revision)
  }

  private async closeEntry(entry: LiveDocument): Promise<void> {
    entry.closed = true
    entry.calculation = undefined
    entry.calculationWithheld = undefined
    this.entries.delete(entry.id)
    const errors: unknown[] = []
    if (
      entry.revision === 0 &&
      !entry.uncertain &&
      entry.candidateId &&
      entry.candidateId !== entry.inheritedCandidateId
    ) {
      await this.recovery.retire(entry.candidateId).catch((error) => {
        errors.push(error)
      })
    }
    await this.recovery.forgetOwner(entry.ownerId).catch((error) => {
      errors.push(error)
    })
    await this.config.client
      .closeDocument({ apiVersion: 1, documentId: entry.documentId })
      .catch((error) => {
        errors.push(error)
      })
    await this.config.client.close(entry.reader.sessionId).catch((error) => {
      errors.push(error)
    })
    if (errors.length === 0) await this.cleanup(entry.directory)
    else
      throw new AggregateError(
        errors,
        'Some spreadsheet session resources remain for safe recovery.',
      )
  }

  async close(handle: Handle, options: { readonly discard?: boolean } = {}): Promise<void> {
    const entry = this.entry(handle)
    if (entry.saving)
      fail(
        'document_busy',
        'The workbook is being saved. Close the returned clean handle after publication.',
      )
    entry.closing = true
    await this.enqueue(entry.id, async () => {
      if (options.discard === true) {
        const candidate =
          entry.candidateId ?? this.recovery.candidateFor(entry.ownerId, entry.reader.sessionId)
        for (const id of new Set(
          [candidate, entry.inheritedCandidateId].filter(
            (id): id is string => id !== null && id !== undefined,
          ),
        ))
          await this.recovery.retire(id)
      }
      await this.closeEntry(entry)
    }).catch((error: unknown) => {
      if (!entry.closed) entry.closing = false
      throw error
    })
  }

  candidates(originalPath?: string) {
    return originalPath === undefined
      ? this.recovery.listAllCandidates()
      : this.recovery.listCandidates(absolute(originalPath))
  }

  async recover(candidateId: string, originalPath: string): Promise<SpreadsheetDocumentHandle> {
    const candidate = await this.recovery.readCandidate(candidateId, absolute(originalPath))
    // open() only reads the checked private base; no recovered package is
    // published to the user-visible original until an explicit save.
    const handle = await this.openFrom(
      candidate.pinnedBasePath,
      {},
      {
        path: originalPath,
        fingerprint: candidate.originalFingerprint,
        allowWriteBack: !candidate.sourceConflict && candidate.originalState === 'current',
      },
    )
    const entry = this.entry(handle)
    entry.inheritedCandidateId = candidateId
    try {
      await this.checkpoint(handle, candidate.snapshot.payload)
      return this.handle(entry)
    } catch (error) {
      await this.close(handle).catch(() => undefined)
      throw error
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.queues.values())
    await Promise.all(
      [...this.entries.keys()].map((id) =>
        this.close(id).catch((error) =>
          this.warn('A spreadsheet handle could not be fully closed.', error),
        ),
      ),
    )
  }
}
