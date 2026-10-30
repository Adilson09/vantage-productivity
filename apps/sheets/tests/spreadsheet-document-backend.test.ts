import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbookSaveRequestSchema } from '../src/shared/desktop-api'
import {
  documentPayloadFromSave,
  type WorkbookDocumentPayload,
} from '../src/shared/document-checkpoint'
import type { DocumentNativeClient } from '../src/main/document-native-contract'
import type { DocumentPackageWriteInput } from '../src/main/workbook-document-writer'
import {
  SpreadsheetDocumentBackend,
  type SpreadsheetBackendConfig,
  type SpreadsheetNativeClient,
} from '../src/main/spreadsheet-document-backend'

interface Book {
  sheets: { id: string; name: string; rowCount?: number; columnCount?: number }[]
  cells: { row: number; column: number; value: unknown; formula?: string }[]
}
interface Document {
  documentId: string
  sourceFingerprint: string
  sheets: Book['sheets']
  revision: number
  payload: WorkbookDocumentPayload
  receipts: Record<string, unknown>
  storePath?: string
}
const emptyPayload = (): WorkbookDocumentPayload =>
  documentPayloadFromSave(
    workbookSaveRequestSchema.parse({
      sessionId: randomUUID(),
      mode: 'save-as',
      edits: [],
      structuralOps: [],
      chartEdits: [],
      visualEdits: [],
      visualAdditions: [],
      tableAdditions: [],
      pivotAdditions: [],
      sheetOps: [],
      sheetOrder: [],
      filterStates: [],
      hyperlinkEdits: [],
      cfStates: [],
      dvStates: [],
      pageSetupStates: [],
      noteStates: [],
      formulaValues: [],
      pivotCacheRefreshPaths: [],
      pivotRefreshUpdates: [],
      sheetProtections: [],
      definedNamesState: null,
    }),
  )
function payload(value: string | number | boolean | null): WorkbookDocumentPayload {
  return {
    ...emptyPayload(),
    edits: [{ sheetId: 'sheet-1', row: 0, column: 0, writeValue: true, value }],
  }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

class Native implements SpreadsheetNativeClient {
  documents = new Map<string, Document>()
  readers = new Map<string, { path: string; book: Book }>()
  materializedPaths: string[] = []
  readInputs: Parameters<SpreadsheetNativeClient['readRange']>[0][] = []
  readError?: Error
  readReplies: unknown[] = []
  readResult?: unknown
  onRead?: () => void
  auditInputs: {
    sourcePath: string
    targetPath: string
    allowedChangedEntries: readonly string[]
  }[] = []
  loseAck = false
  preserve = true
  duringAudit?: () => Promise<void>
  duringRecalc?: () => Promise<void>
  calculatedCells: unknown[] = [
    {
      sheet: 'Budget',
      row: 0,
      column: 0,
      formatted: '42',
      number: 42,
      value: 42,
      isError: false,
      isFormula: true,
    },
  ]
  recalcInputs: Parameters<SpreadsheetNativeClient['recalcDocument']>[0][] = []
  directRecalcErrorCode?: string
  provenance: Record<string, unknown> = {
    cacheWritebackAllowed: true,
    calculationCompleteness: 'complete',
    cacheWritebackReasons: [],
  }

  async open(path: string): Promise<unknown> {
    const book = JSON.parse(await readFile(path, 'utf8')) as Book
    book.sheets = book.sheets.map((sheet) => ({
      ...sheet,
      rowCount: Math.max(sheet.rowCount ?? 1, ...book.cells.map((cell) => cell.row + 1)),
      columnCount: Math.max(sheet.columnCount ?? 1, ...book.cells.map((cell) => cell.column + 1)),
    }))
    const sessionId = randomUUID()
    this.readers.set(sessionId, { path, book })
    return { sessionId, sheets: book.sheets }
  }
  async close(sessionId: string): Promise<void> {
    this.readers.delete(sessionId)
  }
  async readRange(input: Parameters<SpreadsheetNativeClient['readRange']>[0]): Promise<unknown> {
    this.readInputs.push(clone(input))
    if (this.readError) throw this.readError
    const reader = this.readers.get(input.sessionId)!
    const sheet = reader.book.sheets.find((sheet) => sheet.id === input.sheetId)
    if (!sheet) throw Object.assign(new Error('Unknown worksheet'), { code: 'unknown_sheet' })
    if (input.range.endRow >= sheet.rowCount! || input.range.endColumn >= sheet.columnCount!) {
      throw Object.assign(new Error('Range is outside the worksheet.'), { code: 'invalid_request' })
    }
    this.onRead?.()
    if (this.readReplies.length > 0) return clone(this.readReplies.shift())
    if (this.readResult !== undefined) return clone(this.readResult)
    this.materializedPaths.push(reader.path)
    return {
      cells: reader.book.cells.filter(
        (cell) =>
          cell.row >= input.range.startRow &&
          cell.row <= input.range.endRow &&
          cell.column >= input.range.startColumn &&
          cell.column <= input.range.endColumn,
      ),
      indexingComplete: true,
      indexedThroughRow: sheet.rowCount! - 1,
    }
  }
  async openDocument(input: Parameters<DocumentNativeClient['openDocument']>[0]): Promise<unknown> {
    const sourceFingerprint = hash(await readFile(input.sourcePath))
    let document: Document | undefined
    if (input.storePath) {
      try {
        document = JSON.parse(await readFile(input.storePath, 'utf8')) as Document
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else document = this.documents.get(input.documentId)
    const recovered = document !== undefined
    document ??= {
      documentId: input.documentId,
      sourceFingerprint,
      sheets: clone([...input.sheets]),
      revision: 0,
      payload: emptyPayload(),
      receipts: {},
      ...(input.storePath ? { storePath: input.storePath } : {}),
    }
    if (document.sourceFingerprint !== sourceFingerprint) throw new Error('Source conflict')
    this.documents.set(input.documentId, document)
    if (document.storePath) await writeFile(document.storePath, JSON.stringify(document))
    return {
      apiVersion: 1,
      documentId: input.documentId,
      sourceFingerprint,
      revision: document.revision,
      recovered,
      durable: input.storePath !== undefined,
    }
  }
  async checkpointDocument(
    input: Parameters<DocumentNativeClient['checkpointDocument']>[0],
  ): Promise<unknown> {
    const document = this.documents.get(input.documentId)!
    if (document.receipts[input.commandId]) return clone(document.receipts[input.commandId])
    if (document.revision !== input.expectedRevision) throw new Error('Revision conflict')
    document.revision += 1
    document.payload = clone(input.payload) as WorkbookDocumentPayload
    const result = {
      apiVersion: 1,
      documentId: input.documentId,
      commandId: input.commandId,
      revision: document.revision,
      durable: document.storePath !== undefined,
    }
    document.receipts[input.commandId] = result
    if (document.storePath) await writeFile(document.storePath, JSON.stringify(document))
    if (this.loseAck) {
      this.loseAck = false
      throw new Error('Unknown checkpoint outcome')
    }
    return result
  }
  async documentSnapshot(
    input: Parameters<DocumentNativeClient['documentSnapshot']>[0],
  ): Promise<unknown> {
    const document = this.documents.get(input.documentId)
    if (!document) throw new Error('Document not open')
    if (input.revision !== undefined && input.revision !== document.revision)
      throw new Error('Snapshot unavailable')
    return clone({
      apiVersion: 1,
      documentId: input.documentId,
      revision: document.revision,
      sourceFingerprint: document.sourceFingerprint,
      sheets: document.sheets,
      payload: document.payload,
    })
  }
  async documentCommandResult(
    input: Parameters<DocumentNativeClient['documentCommandResult']>[0],
  ): Promise<unknown> {
    return clone(this.documents.get(input.documentId)?.receipts[input.commandId] ?? null)
  }
  async closeDocument(
    input: Parameters<DocumentNativeClient['closeDocument']>[0],
  ): Promise<unknown> {
    return { closed: this.documents.delete(input.documentId) }
  }
  async recalcDocument(
    input: Parameters<SpreadsheetNativeClient['recalcDocument']>[0],
  ): Promise<unknown> {
    this.recalcInputs.push(clone(input))
    if (!input.materializedPath && this.directRecalcErrorCode)
      throw Object.assign(new Error('Native direct path refused'), {
        code: this.directRecalcErrorCode,
      })
    if (input.materializedPath) this.materializedPaths.push(input.materializedPath)
    await this.duringRecalc?.()
    return {
      workbookId: input.documentId,
      revision: input.revision,
      cells: clone(this.calculatedCells),
      ...clone(this.provenance),
    }
  }
  async auditPreservation(
    input: Parameters<SpreadsheetNativeClient['auditPreservation']>[0],
  ): Promise<unknown> {
    this.auditInputs.push(input)
    await this.duringAudit?.()
    return {
      preserved: this.preserve,
      violations: this.preserve
        ? []
        : [{ code: 'opaque_changed', message: 'Protected bytes changed.' }],
      preservedEntries: [],
    }
  }
  async archiveManifest(): Promise<unknown> {
    throw new Error('Mock package writer is injected')
  }
  async readEntries(): Promise<unknown> {
    throw new Error('Mock package writer is injected')
  }
  async scanEntries(): Promise<unknown> {
    throw new Error('Mock package writer is injected')
  }
  async saveArchive(): Promise<unknown> {
    throw new Error('Mock package writer is injected')
  }
}

let directory: string
let source: string
let native: Native
let backend: SpreadsheetDocumentBackend
let config: SpreadsheetBackendConfig
let writes: string[]
let packageRequests: DocumentPackageWriteInput['request'][]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vantage-portable-backend-'))
  source = join(directory, 'book.xlsx')
  await writeFile(
    source,
    JSON.stringify({
      sheets: [{ id: 'sheet-1', name: 'Budget' }],
      cells: [{ row: 0, column: 0, value: 'base' }],
    }),
  )
  native = new Native()
  writes = []
  packageRequests = []
  config = {
    client: native,
    privateRoot: join(directory, 'recovery'),
    tempRoot: join(directory, 'temporary'),
    encryptOoxml: vi.fn((bytes: Buffer, _password: string) =>
      Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), bytes]),
    ),
    decryptOoxml: async (bytes) => bytes.subarray(8),
    atomicWriteFile: async (path, bytes) => {
      writes.push(path)
      await writeFile(path, bytes)
    },
    atomicCopyFile: async (from, to) => {
      writes.push(to)
      await copyFile(from, to)
    },
    withNativeSaveRecovery: async <T>(_path: string, write: () => Promise<T>) => write(),
    writePackage: async (input: DocumentPackageWriteInput) => {
      packageRequests.push(clone(input.request))
      const book = JSON.parse(await readFile(input.session.snapshotPath, 'utf8')) as Book
      for (const operation of input.request.structuralOps) {
        if (operation.kind === 'insert-rows')
          for (const cell of book.cells)
            if (cell.row >= operation.index) cell.row += operation.count
      }
      for (const edit of input.request.edits) {
        if (!edit.writeValue) continue
        book.cells = book.cells.filter(
          (cell) => cell.row !== edit.row || cell.column !== edit.column,
        )
        book.cells.push({
          row: edit.row,
          column: edit.column,
          value: edit.value,
          ...(edit.formula === undefined ? {} : { formula: edit.formula }),
        })
      }
      for (const cached of input.request.formulaValues) {
        const cell = book.cells.find(
          (cell) =>
            cell.row === cached.row && cell.column === cached.column && cell.formula !== undefined,
        )
        if (cell) cell.value = cached.value
      }
      for (const operation of input.request.sheetOps) {
        if (operation.kind === 'rename-sheet') {
          const sheet = book.sheets.find((sheet) => sheet.id === operation.sheetId)
          if (sheet) sheet.name = operation.newName
        }
      }
      await writeFile(input.targetPath, JSON.stringify(book))
      return {
        touchedEntries: ['xl/worksheets/sheet1.xml'],
        removedEntries: ['xl/calcChain.xml'],
        addedEntries: ['xl/sharedStrings.xml'],
      }
    },
  }
  backend = new SpreadsheetDocumentBackend(config)
})

afterEach(async () => {
  await backend.shutdown()
  const checked = resolve(directory)
  if (
    !basename(checked).startsWith('vantage-portable-backend-') ||
    relative(resolve(tmpdir()), checked).startsWith('..')
  )
    throw new Error('Unexpected backend test directory')
  await rm(checked, { recursive: true, force: true })
})

describe('portable spreadsheet document backend', () => {
  it.each(['base', 'materialized'])(
    'waits for requested row coverage instead of returning partial %s cells as blanks',
    async (mode) => {
      const handle = await backend.open(source)
      if (mode === 'materialized') await backend.checkpoint(handle, payload('committed'))
      native.readReplies = [
        { cells: [], indexingComplete: false, indexedThroughRow: null },
        {
          cells: [{ row: 0, column: 0, value: mode === 'base' ? 'base' : 'committed' }],
          indexingComplete: false,
          indexedThroughRow: 0,
        },
      ]
      const read = await backend.readRange(handle, {
        sheetId: 'sheet-1',
        range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
      })
      expect(native.readInputs).toHaveLength(2)
      expect(read.result).toMatchObject({
        cells: [{ row: 0, column: 0, value: mode === 'base' ? 'base' : 'committed' }],
        indexingComplete: false,
        indexedThroughRow: 0,
      })
    },
  )

  it.each(['base', 'materialized'])(
    'reports a bounded not-ready error for a permanently partial %s index',
    async (mode) => {
      const handle = await backend.open(source)
      if (mode === 'materialized') await backend.checkpoint(handle, payload('committed'))
      native.readResult = { cells: [], indexingComplete: false, indexedThroughRow: null }
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      native.onRead = () => entered()
      vi.useFakeTimers()
      try {
        const failure = backend
          .readRange(handle, {
            sheetId: 'sheet-1',
            range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
          })
          .then(
            () => null,
            (error: unknown) => error,
          )
        await Promise.race([
          started,
          failure.then((error) => {
            throw error ?? new Error('Unexpected successful read')
          }),
        ])
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await failure).toMatchObject({
          code: 'indexing_not_ready',
          details: { indexedThroughRow: null, requiredThroughRow: 0 },
        })
        expect(native.readInputs.length).toBeGreaterThan(1)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each([
    { cells: [] },
    { cells: [], indexingComplete: false, indexedThroughRow: -1 },
    { cells: [], indexingComplete: true, indexedThroughRow: 0.5 },
  ])(
    'rejects missing or incoherent native coverage instead of inventing read completion: %j',
    async (result) => {
      const handle = await backend.open(source)
      native.readResult = result
      await expect(
        backend.readRange(handle, {
          sheetId: 'sheet-1',
          range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
        }),
      ).rejects.toMatchObject({ code: 'invalid_native_result' })
      expect(native.readInputs).toHaveLength(1)
    },
  )

  it('clamps base reads to native extents and returns coherent blank viewports without hiding unknown sheets or read failures', async () => {
    await writeFile(
      source,
      JSON.stringify({
        sheets: [{ id: 'sheet-1', name: 'Budget', rowCount: 2, columnCount: 3 }],
        cells: [
          { row: 0, column: 0, value: 'base' },
          { row: 1, column: 2, value: 'edge' },
        ],
      }),
    )
    const handle = await backend.open(source)
    const requested = { startRow: 0, endRow: 3, startColumn: 0, endColumn: 4 }
    const read = await backend.readRange(handle, { sheetId: 'sheet-1', range: requested })
    expect(read).toMatchObject({ revision: 0, sheetId: 'sheet-1', range: requested })
    expect(native.readInputs.at(-1)!.range).toEqual({
      startRow: 0,
      endRow: 1,
      startColumn: 0,
      endColumn: 2,
    })
    expect((read.result as { cells: Book['cells'] }).cells).toEqual([
      { row: 0, column: 0, value: 'base' },
      { row: 1, column: 2, value: 'edge' },
    ])
    const calls = native.readInputs.length
    const outside = { startRow: 10_000, endRow: 10_000, startColumn: 0, endColumn: 1 }
    expect(await backend.readRange(handle, { sheetId: 'sheet-1', range: outside })).toMatchObject({
      range: outside,
      result: {
        cells: [],
        rows: [],
        merges: [],
        hyperlinks: [],
        indexedThroughRow: null,
        indexingComplete: false,
      },
    })
    expect(native.readInputs).toHaveLength(calls)
    await expect(
      backend.readRange(handle, { sheetId: 'missing', range: outside }),
    ).rejects.toMatchObject({ code: 'unknown_sheet' })
    await expect(
      backend.readRange(handle, {
        sheetId: 'sheet-1',
        range: { startRow: 0, endRow: 20_000, startColumn: 0, endColumn: 0 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_range' })
    native.readError = Object.assign(new Error('Indexer failed'), { code: 'indexing_failed' })
    await expect(
      backend.readRange(handle, { sheetId: 'sheet-1', range: requested }),
    ).rejects.toMatchObject({ code: 'indexing_failed' })
  })

  it('clamps against the reopened materialized extent so committed cells beyond the base remain readable', async () => {
    const handle = await backend.open(source)
    const complete = payload('updated')
    complete.edits.push({
      sheetId: 'sheet-1',
      row: 4,
      column: 2,
      writeValue: true,
      value: 'extended cell',
    })
    await backend.checkpoint(handle, complete)
    const requested = { startRow: 3, endRow: 7, startColumn: 1, endColumn: 4 }
    const read = await backend.readRange(handle, { sheetId: 'sheet-1', range: requested })
    expect(read).toMatchObject({ revision: 1, sheetId: 'sheet-1', range: requested })
    expect(native.readInputs.at(-1)!.range).toEqual({
      startRow: 3,
      endRow: 4,
      startColumn: 1,
      endColumn: 2,
    })
    expect((read.result as { cells: Book['cells'] }).cells).toEqual([
      { row: 4, column: 2, value: 'extended cell' },
    ])
    const calls = native.readInputs.length
    expect(
      (
        await backend.readRange(handle, {
          sheetId: 'sheet-1',
          range: { startRow: 8, endRow: 8, startColumn: 0, endColumn: 1 },
        })
      ).result,
    ).toMatchObject({ cells: [], rows: [], indexingComplete: false })
    expect(native.readInputs).toHaveLength(calls)
  })

  it('retires repeated clean revision-zero opens while preserving completed and uncertain checkpoints', async () => {
    const documents = join(directory, 'recovery', 'documents')
    for (let index = 0; index < 3; index++) {
      const handle = await backend.open(source)
      await backend.close(handle)
      expect(await readdir(documents)).toEqual([])
    }
    const pending = await backend.open(source)
    await backend.checkpoint(pending, payload('retain completed checkpoint'))
    await backend.close(pending)
    expect(await backend.candidates(source)).toHaveLength(1)
    const uncertain = await backend.open(source)
    native.loseAck = true
    await expect(backend.checkpoint(uncertain, payload('retain unknown outcome'))).rejects.toThrow(
      'Unknown checkpoint outcome',
    )
    await backend.close(uncertain)
    expect(await backend.candidates(source)).toHaveLength(2)
  })

  it('uses the resident native calculation path for scalar revisions without exporting private workbooks', async () => {
    const handle = await backend.open(source)
    await backend.checkpoint(handle, payload(21))
    await backend.recalculate(handle, [
      { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
    ])
    await backend.recalculate(handle, [
      { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
    ])
    expect(packageRequests).toEqual([])
    expect(native.recalcInputs).toEqual([
      {
        apiVersion: 1,
        documentId: handle.id,
        revision: 1,
        reads: [
          { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
        ],
      },
      {
        apiVersion: 1,
        documentId: handle.id,
        revision: 1,
        reads: [
          { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
        ],
      },
    ])
  })

  it.each(['document_requires_materialization', 'calculation_budget_exceeded'])(
    'materializes only after the explicit native %s fallback code',
    async (code) => {
      const handle = await backend.open(source)
      await backend.checkpoint(handle, payload(21))
      native.directRecalcErrorCode = code
      const result = await backend.recalculate(handle, [
        { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
      ])
      expect(result.cacheWriteback).toBe('allowed')
      expect(native.recalcInputs).toHaveLength(2)
      expect(native.recalcInputs[0]!.materializedPath).toBeUndefined()
      const temporary = native.recalcInputs[1]!.materializedPath!
      expect(temporary).toMatch(/view\.bin$/)
      await expect(access(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(packageRequests).toHaveLength(1)
    },
  )

  it.each(['revision_conflict', 'native_read_failure'])(
    'propagates %s without exporting or retrying another calculation path',
    async (code) => {
      const handle = await backend.open(source)
      await backend.checkpoint(handle, payload(21))
      native.directRecalcErrorCode = code
      await expect(backend.recalculate(handle, [])).rejects.toMatchObject({ code })
      expect(packageRequests).toEqual([])
      expect(native.recalcInputs).toHaveLength(1)
    },
  )

  it('withholds false-zero previews from uncertified off-viewport precedents and invalidates earlier allowed caches', async () => {
    const handle = await backend.open(source)
    const complete = emptyPayload()
    complete.edits = [
      {
        sheetId: 'sheet-1',
        row: 0,
        column: 0,
        value: null,
        writeValue: true,
        formula: 'IFERROR(A5,0)',
      },
      {
        sheetId: 'sheet-1',
        row: 4,
        column: 0,
        value: null,
        writeValue: true,
        formula: 'UNSUPPORTED.TEST()',
      },
    ]
    complete.formulaValues = [{ sheetId: 'sheet-1', row: 0, column: 0, value: 777 }]
    await backend.checkpoint(handle, complete)
    const reads = [
      { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
    ]
    await backend.recalculate(handle, reads)
    expect(
      (
        (await backend.readRange(handle, { sheetId: 'sheet-1', range: reads[0]!.range }))
          .result as { cells: Book['cells'] }
      ).cells[0]!.value,
    ).toBe(42)
    native.provenance = {
      cacheWritebackAllowed: false,
      calculationCompleteness: 'unverified',
      cacheWritebackReasons: ['unsupported_function'],
    }
    native.calculatedCells = [
      {
        sheet: 'Budget',
        row: 0,
        column: 0,
        value: 0,
        number: 0,
        formatted: '0',
        isError: false,
        isFormula: false,
      },
    ]
    const unsafe = await backend.recalculate(handle, reads)
    expect(unsafe).toMatchObject({
      cacheWriteback: 'withheld',
      cacheWritebackAllowed: false,
      calculationCompleteness: 'unverified',
      cacheWritebackReasons: ['unsupported_function'],
    })
    expect(unsafe.cells[0]!.value).toBe(0)
    expect((await backend.snapshot(handle)).payload).toEqual(complete)
    native.provenance = {
      cacheWritebackAllowed: true,
      calculationCompleteness: 'complete',
      cacheWritebackReasons: [],
    }
    expect((await backend.recalculate(handle, reads)).cacheWriteback).toBe('withheld')
    const target = join(directory, 'uncertified.xlsx')
    const saved = await backend.save(handle, target)
    expect(
      (
        (await backend.readRange(saved.handle!, { sheetId: 'sheet-1', range: reads[0]!.range }))
          .result as { cells: Book['cells'] }
      ).cells[0]!.value,
    ).toBe(777)
    expect(packageRequests.at(-1)!.formulaValues).toEqual(complete.formulaValues)
  })

  it('fails closed on missing native certification metadata and preserves input formula caches', async () => {
    const handle = await backend.open(source)
    const complete = payload(null)
    complete.edits[0]!.formula = '21*2'
    complete.formulaValues = [{ sheetId: 'sheet-1', row: 0, column: 0, value: 777 }]
    await backend.checkpoint(handle, complete)
    native.provenance = {}
    expect(await backend.recalculate(handle, [])).toMatchObject({
      cacheWriteback: 'withheld',
      cacheWritebackAllowed: false,
      cacheWritebackReasons: ['native_provenance_missing_or_invalid'],
    })
    expect(
      (
        (
          await backend.readRange(handle, {
            sheetId: 'sheet-1',
            range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
          })
        ).result as { cells: Book['cells'] }
      ).cells[0]!.value,
    ).toBe(777)
  })

  it('uses revision-zero Rust state and materializes typed committed values without coercing text', async () => {
    const handle = await backend.open(source)
    expect(handle.revision).toBe(0)
    expect((await backend.snapshot(handle)).payload).toEqual(emptyPayload())
    const complete = emptyPayload()
    complete.edits = ['12', 12, true, null].map((value, column) => ({
      sheetId: 'sheet-1',
      row: 0,
      column,
      writeValue: true,
      value,
    }))
    const receipt = await backend.checkpoint(handle, complete, { expectedRevision: 0 })
    expect(receipt.documentId).toBe(handle.id)
    const result = await backend.readRange(handle, {
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 3 },
    })
    expect(
      (result.result as { cells: { value: unknown }[] }).cells.map((cell) => cell.value),
    ).toEqual(['12', 12, true, null])
    expect(native.materializedPaths.every((path) => path !== source)).toBe(true)
    expect(JSON.parse(await readFile(source, 'utf8')).cells[0].value).toBe('base')
    await expect(
      backend.checkpoint(handle, payload('stale'), { expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  it('audits allowed changed/removed/added parts before publishing once and rebases to a new clean handle', async () => {
    const handle = await backend.open(source)
    await backend.checkpoint(handle, payload('saved'))
    const saved = await backend.save(handle, source)
    expect(saved.savedRevision).toBe(1)
    expect(saved.handle).not.toBeNull()
    expect(saved.handle!.id).not.toBe(handle.id)
    expect(saved.handle!.revision).toBe(0)
    expect(writes).toEqual([source])
    expect(native.auditInputs[0]!.allowedChangedEntries).toEqual([
      'xl/worksheets/sheet1.xml',
      'xl/calcChain.xml',
      'xl/sharedStrings.xml',
    ])
    expect(JSON.parse(await readFile(source, 'utf8')).cells[0].value).toBe('saved')
    await expect(backend.snapshot(handle)).rejects.toMatchObject({ code: 'document_closed' })
    expect((await backend.snapshot(saved.handle!)).payload).toEqual(emptyPayload())
  })

  it('reads the materialized post-structure layout rather than the unchanged imported reader', async () => {
    const handle = await backend.open(source)
    const complete = emptyPayload()
    complete.structuralOps = [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 0, count: 1 }]
    await backend.checkpoint(handle, complete)
    const read = await backend.readRange(handle, {
      sheetId: 'sheet-1',
      range: {
        startRow: 1,
        endRow: 1,
        startColumn: 0,
        endColumn: 0,
      },
    })
    expect((read.result as { cells: unknown[] }).cells).toEqual([
      { row: 1, column: 0, value: 'base' },
    ])
    expect(JSON.parse(await readFile(source, 'utf8')).cells[0].row).toBe(0)
  })

  it('refuses checkpoints and discard while publication is blocked, then returns a clean handle', async () => {
    let publishing!: () => void
    let release!: () => void
    const enteredPublication = new Promise<void>((done) => {
      publishing = done
    })
    const gate = new Promise<void>((done) => {
      release = done
    })
    backend = new SpreadsheetDocumentBackend({
      ...config,
      atomicCopyFile: async (from, to) => {
        publishing()
        await gate
        await config.atomicCopyFile!(from, to)
      },
    })
    const handle = await backend.open(source)
    await backend.checkpoint(handle, payload('acknowledged before save'))
    const saving = backend.save(handle, source)
    try {
      // These calls happen before the save's first asynchronous step, proving
      // the publication gate also covers work waiting in the mutation queue.
      await expect(
        backend.checkpoint(handle, payload('must not be acknowledged')),
      ).rejects.toMatchObject({ code: 'document_busy' })
      await expect(backend.close(handle, { discard: true })).rejects.toMatchObject({
        code: 'document_busy',
      })
      await enteredPublication
      await expect(
        backend.checkpoint(handle, payload('still must not be acknowledged')),
      ).rejects.toMatchObject({ code: 'document_busy' })
      expect((await backend.snapshot(handle)).payload).toEqual(payload('acknowledged before save'))
      expect(native.documents.get(handle.id)!.revision).toBe(1)
      expect(JSON.parse(await readFile(source, 'utf8')).cells[0].value).toBe('base')
    } finally {
      release()
    }
    const saved = await saving
    expect(saved.savedRevision).toBe(1)
    expect(JSON.parse(await readFile(source, 'utf8')).cells[0].value).toBe(
      'acknowledged before save',
    )
    expect(saved.handle!.revision).toBe(0)
    expect((await backend.snapshot(saved.handle!)).payload).toEqual(emptyPayload())
    expect(
      (
        await backend.checkpoint(saved.handle!, payload('retry on clean handle'), {
          expectedRevision: 0,
        })
      ).revision,
    ).toBe(1)
  })

  it('finishes an already accepted checkpoint before pinning the save revision', async () => {
    const handle = await backend.open(source)
    const originalCheckpoint = native.checkpointDocument.bind(native)
    let checkpointing!: () => void
    let release!: () => void
    const enteredCheckpoint = new Promise<void>((done) => {
      checkpointing = done
    })
    const gate = new Promise<void>((done) => {
      release = done
    })
    vi.spyOn(native, 'checkpointDocument').mockImplementationOnce(async (request) => {
      checkpointing()
      await gate
      return originalCheckpoint(request)
    })
    const accepted = backend.checkpoint(handle, payload('accepted before save invocation'))
    await enteredCheckpoint
    const saving = backend.save(handle, source)
    release()
    expect((await accepted).revision).toBe(1)
    expect((await saving).savedRevision).toBe(1)
    expect(JSON.parse(await readFile(source, 'utf8')).cells[0].value).toBe(
      'accepted before save invocation',
    )
  })

  it('checks the latest native revision immediately before publishing and clears the save gate on refusal', async () => {
    const handle = await backend.open(source)
    await backend.checkpoint(handle, payload('pinned by save'))
    native.duringAudit = async () => {
      await native.checkpointDocument({
        apiVersion: 1,
        documentId: handle.id,
        commandId: randomUUID(),
        expectedRevision: 1,
        actor: 'separate-native-writer',
        payload: payload('advanced independently'),
      })
    }
    await expect(backend.save(handle, source)).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(writes).toEqual([])
    expect(JSON.parse(await readFile(source, 'utf8')).cells[0].value).toBe('base')
    // The failed publication did not leave the handle permanently busy.
    await backend.close(handle)
    const [candidate] = await backend.candidates(source)
    expect(candidate).toBeDefined()
  })

  it('allows checkpoint retries after a save fails before publication', async () => {
    const handle = await backend.open(source)
    await backend.checkpoint(handle, payload('one'))
    native.preserve = false
    await expect(backend.save(handle, source)).rejects.toMatchObject({
      code: 'preservation_failed',
    })
    expect(
      (await backend.checkpoint(handle, payload('two'), { expectedRevision: 1 })).revision,
    ).toBe(2)
    expect((await backend.snapshot(handle)).payload).toEqual(payload('two'))
  })

  it('refuses preservation failures and original changes without publishing or retiring recovery', async () => {
    const handle = await backend.open(source)
    await backend.checkpoint(handle, payload('recoverable'))
    native.preserve = false
    await expect(backend.save(handle, source)).rejects.toMatchObject({
      code: 'preservation_failed',
    })
    expect(writes).toEqual([])
    native.preserve = true
    native.duringAudit = () => writeFile(source, 'externally replaced workbook')
    await expect(backend.save(handle, source)).rejects.toMatchObject({ code: 'source_conflict' })
    expect(writes).toEqual([])
    expect((await backend.snapshot(handle)).payload).toEqual(payload('recoverable'))
    await backend.close(handle)
    expect(await backend.candidates(source)).toHaveLength(1)
  })

  it('reconciles a lost acknowledgement before allowing reads and reopens a durable authority after helper restart', async () => {
    const handle = await backend.open(source)
    native.loseAck = true
    await expect(backend.checkpoint(handle, payload('once'))).rejects.toThrow(
      'Unknown checkpoint outcome',
    )
    await expect(backend.snapshot(handle)).rejects.toMatchObject({
      code: 'checkpoint_outcome_unknown',
    })
    const retried = await backend.checkpoint(handle, payload('once'), { expectedRevision: 0 })
    expect(retried.revision).toBe(1)
    native.documents.clear()
    expect((await backend.snapshot(handle)).payload).toEqual(payload('once'))
  })

  it('rejects stale asynchronous calculation results after a newer checkpoint', async () => {
    const handle = await backend.open(source)
    await backend.checkpoint(handle, payload(1))
    let entered!: () => void
    let release!: () => void
    const enteredCalculation = new Promise<void>((done) => {
      entered = done
    })
    const gate = new Promise<void>((done) => {
      release = done
    })
    native.duringRecalc = async () => {
      entered()
      await gate
    }
    const calculation = backend.recalculate(handle, [
      { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
    ])
    await enteredCalculation
    await backend.checkpoint(handle, payload(2), { expectedRevision: 1 })
    release()
    await expect(calculation).rejects.toMatchObject({ code: 'revision_conflict' })
    const read = await backend.readRange(handle, {
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })
    expect((read.result as { cells: Book['cells'] }).cells[0]!.value).toBe(2)
    expect(packageRequests.at(-1)!.formulaValues).toEqual([])
  })

  it('keeps typed derived values at the same revision and saves cached formula results through reopen', async () => {
    const handle = await backend.open(source)
    const complete = emptyPayload()
    const values = [42, true, 'TRUE', '#N/A', { error: '#DIV/0!' }]
    complete.edits = values.map((_value, column) => ({
      sheetId: 'sheet-1',
      row: 0,
      column,
      writeValue: true,
      value: null,
      formula: column === 0 ? '21*2' : 'A1',
    }))
    complete.formulaValues = [{ sheetId: 'sheet-1', row: 0, column: 0, value: -1 }]
    await backend.checkpoint(handle, complete, { commandId: 'formula-inputs' })
    native.calculatedCells = values.map((value, column) => ({
      sheet: 'Budget',
      row: 0,
      column,
      value,
      formatted: String(typeof value === 'object' ? value.error : value),
      isError: typeof value === 'object',
      isFormula: true,
      ...(typeof value === 'number' ? { number: value } : {}),
    }))
    await backend.recalculate(handle, [
      { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 4 } },
    ])
    const snapshot = await backend.snapshot(handle)
    expect(snapshot.revision).toBe(1)
    expect(snapshot.payload).toEqual(complete)
    expect(native.documents.get(handle.id)!.revision).toBe(1)
    expect(Object.keys(native.documents.get(handle.id)!.receipts)).toEqual(['formula-inputs'])
    const read = await backend.readRange(handle, {
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 4 },
    })
    expect((read.result as { cells: Book['cells'] }).cells.map((cell) => cell.value)).toEqual(
      values,
    )
    const target = join(directory, 'calculated.xlsx')
    const saved = await backend.save(handle, target)
    expect(saved.savedRevision).toBe(1)
    expect(saved.handle!.revision).toBe(0)
    const reopened = await backend.readRange(saved.handle!, {
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 4 },
    })
    expect((reopened.result as { cells: Book['cells'] }).cells.map((cell) => cell.value)).toEqual(
      values,
    )
    expect((await backend.snapshot(saved.handle!)).payload).toEqual(emptyPayload())
    expect(packageRequests.at(-1)!.formulaValues.map((cell) => cell.value)).toEqual(values)
  })

  it('materializes a calculated revision-zero workbook and invalidates derived values on a newer checkpoint', async () => {
    await writeFile(
      source,
      JSON.stringify({
        sheets: [{ id: 'sheet-1', name: 'Budget' }],
        cells: [{ row: 0, column: 0, formula: '21*2', value: -1 }],
      }),
    )
    const handle = await backend.open(source)
    await backend.recalculate(handle, [
      { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
    ])
    const calculated = await backend.readRange(handle, {
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })
    expect((calculated.result as { cells: Book['cells'] }).cells[0]!.value).toBe(42)
    expect((await backend.snapshot(handle)).revision).toBe(0)
    const next = payload(7)
    next.edits[0]!.formula = '7'
    next.formulaValues = [{ sheetId: 'sheet-1', row: 0, column: 0, value: 7 }]
    await backend.checkpoint(handle, next)
    const changed = await backend.readRange(handle, {
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })
    expect((changed.result as { cells: Book['cells'] }).cells[0]!.value).toBe(7)
    expect(packageRequests.at(-1)!.formulaValues).toEqual(next.formulaValues)
  })

  it('maps calculated final worksheet names to stable IDs and clears derived caches for invalid typed results', async () => {
    const handle = await backend.open(source)
    const complete = payload(null)
    complete.edits[0]!.formula = '21*2'
    complete.sheetOps = [{ kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'Budget Next' }]
    complete.sheetOrder = ['sheet-1']
    await backend.checkpoint(handle, complete)
    native.calculatedCells = [
      {
        sheet: 'Budget Next',
        row: 0,
        column: 0,
        formatted: '42',
        value: 42,
        number: 42,
        isError: false,
        isFormula: true,
      },
    ]
    await backend.recalculate(handle, [
      { sheet: 'Budget Next', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
    ])
    native.calculatedCells = [
      {
        sheet: 'Budget Next',
        row: 0,
        column: 0,
        formatted: 'TRUE',
        isError: false,
        isFormula: true,
      },
    ]
    await expect(
      backend.recalculate(handle, [
        { sheet: 'Budget Next', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_calculation_result' })
    const target = join(directory, 'renamed-calculated.xlsx')
    await backend.save(handle, target)
    expect(packageRequests.at(-1)!.formulaValues).toEqual([])
    expect((JSON.parse(await readFile(target, 'utf8')) as Book).sheets[0]!.name).toBe('Budget Next')
    expect((JSON.parse(await readFile(target, 'utf8')) as Book).cells[0]!.value).toBeNull()
  })

  it('includes an earlier accepted calculation before save publication and refuses new jobs during publication', async () => {
    const handle = await backend.open(source)
    const complete = payload(null)
    complete.edits[0]!.formula = '21*2'
    await backend.checkpoint(handle, complete)
    let entered!: () => void
    let release!: () => void
    const enteredCalculation = new Promise<void>((done) => {
      entered = done
    })
    const gate = new Promise<void>((done) => {
      release = done
    })
    native.duringRecalc = async () => {
      entered()
      await gate
    }
    const calculation = backend.recalculate(handle, [
      { sheet: 'Budget', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
    ])
    await enteredCalculation
    const target = join(directory, 'calculation-before-save.xlsx')
    const saving = backend.save(handle, target)
    await expect(backend.recalculate(handle, [])).rejects.toMatchObject({ code: 'document_busy' })
    expect(writes).toEqual([])
    release()
    await calculation
    await saving
    expect((JSON.parse(await readFile(target, 'utf8')) as Book).cells[0]!.value).toBe(42)
  })

  it('treats an empty password as encryption and creates no durable plaintext recovery', async () => {
    const handle = await backend.open(source, { password: '' })
    expect((await backend.checkpoint(handle, payload('private'))).durable).toBe(false)
    const target = join(directory, 'encrypted.xlsx')
    const saved = await backend.save(handle, target)
    expect(config.encryptOoxml).toHaveBeenCalledWith(expect.any(Buffer), '')
    expect((await readFile(target)).subarray(0, 8)).toEqual(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    )
    expect(saved.handle).not.toBeNull()
    await expect(access(join(directory, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not invent old revisions after an encrypted in-memory authority is lost', async () => {
    const handle = await backend.open(source, { password: '' })
    await backend.checkpoint(handle, payload('memory only'))
    native.documents.clear()
    await expect(backend.snapshot(handle)).rejects.toMatchObject({ code: 'session_lost' })
    await expect(backend.snapshot(handle)).rejects.toMatchObject({ code: 'session_lost' })
    await expect(backend.checkpoint(handle, payload('must not rewind'))).rejects.toMatchObject({
      code: 'session_lost',
    })
    await backend.close(handle)
    await expect(access(join(directory, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers only into a private pending handle and requires Save As for a changed original', async () => {
    const first = await backend.open(source)
    await backend.checkpoint(first, payload('restored pending edit'))
    await backend.close(first)
    const [candidate] = await backend.candidates(source)
    await writeFile(source, 'new external original')
    const recovered = await backend.recover(candidate!.id, source)
    expect((await backend.snapshot(recovered)).payload).toEqual(payload('restored pending edit'))
    expect(await readFile(source, 'utf8')).toBe('new external original')
    await expect(backend.save(recovered, source)).rejects.toMatchObject({ code: 'source_conflict' })
    const copy = join(directory, 'recovered-copy.xlsx')
    expect((await backend.save(recovered, copy)).handle).not.toBeNull()
    expect(JSON.parse(await readFile(copy, 'utf8')).cells[0].value).toBe('restored pending edit')
    expect(await readFile(source, 'utf8')).toBe('new external original')
  })
})
