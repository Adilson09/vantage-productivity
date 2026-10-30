/**
 * Real renderer collection/save flow plus real main prompt admission. Native
 * transport, adoption, and package writers are stubs: marker bytes below are
 * deliberately not XLSX files and establish no OOXML compatibility claim.
 */
import { createHash, webcrypto } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloseLeaseTicket } from '../../../packages/electron-utils/src/close-lease'
import { SheetsPromptWriteGate } from '../src/main/sheets-prompt-write-gate'
import {
  workbookSaveRequestSchema,
  type WorkbookCloseCheckpointBinding,
  type WorkbookFile,
  type WorkbookSaveRequest,
  type WorkbookWriteContext,
} from '../src/shared/desktop-api'
import { serializeWorkbookDocumentPayload } from '../src/shared/document-payload-canonical'
import {
  createEditJournal,
  journalSize,
  recordPageSetup,
  recordPivotAdd,
  recordSetRangeValues,
  recordStructuralOp,
  recordTableAdd,
  recordWorkbookProtection,
} from '../src/renderer/edit-journal'
import {
  collectWorkbookDocumentPayload,
  handleSave,
  type SaveContext,
} from '../src/renderer/save-actions'
import type { LazyWorkbookState } from '../src/renderer/univer-state'

const temporary: string[] = []
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sheets-automatic-prompt-boundary-'))
  temporary.push(directory)
  const target = join(directory, 'workbook.xlsx')
  const recoveryTarget = join(directory, 'recovery.marker')
  const checkpointTarget = join(directory, 'checkpoint.marker')
  const original = Buffer.from('unmodified source marker; not an XLSX fixture')
  const published = Buffer.from('stub package publication marker; not XLSX')
  await writeFile(target, original)

  const journal = createEditJournal()
  // These are accepted authored journal operations in their final coordinates.
  // The table/pivot would be held for a second phase by the legacy save path.
  recordStructuralOp(journal, 'sheet-1', { kind: 'insert-rows', index: 0, count: 1 })
  recordSetRangeValues(journal, 'sheet-1', { 1: { 0: { v: 'Region' }, 1: { v: 'Amount' } } })
  const table = {
    sheetId: 'sheet-1', name: 'AcceptedTable',
    area: { startRow: 1, endRow: 4, startColumn: 0, endColumn: 1 },
    columnNames: ['Region', 'Amount'], bandedRows: true,
  }
  const pivot = {
    sheetId: 'sheet-2', sourceSheetId: 'sheet-1', name: 'AcceptedPivot',
    sourceArea: { startRow: 1, endRow: 4, startColumn: 0, endColumn: 1 },
    location: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 },
    fieldNames: ['Region', 'Amount'], rowFieldIndices: [0], rowItems: ['East'],
    values: [{ fieldIndex: 1, agg: 'sum' as const }],
  }
  recordTableAdd(journal, table)
  recordPivotAdd(journal, pivot)
  recordPageSetup(journal, 'sheet-1', { orientation: 'landscape', header: { center: 'Accepted header' } })
  recordWorkbookProtection(journal, true, false)

  const file = {
    sessionId: '11111111-1111-4111-8111-111111111111', path: target, name: 'workbook.xlsx',
    sha256: createHash('sha256').update(original).digest('hex'),
    needsSaveAs: false, restoredFromRecovery: false,
    sheets: [{ id: 'sheet-1', name: 'Data' }, { id: 'sheet-2', name: 'Summary' }],
  } as unknown as WorkbookFile
  const state = {
    file, editJournal: journal, flags: { preloadComplete: true },
    recalc: { overlay: new Map(), formulaCells: new Map() },
  } as unknown as LazyWorkbookState
  const reference = { current: state }
  const open = vi.fn(async (
    offered: WorkbookFile,
    _options?: Parameters<SaveContext['openLazyWorkbook']>[1],
  ) => {
    reference.current = { ...state, file: offered, editJournal: createEditJournal() }
    return true
  })
  const ctx: SaveContext = {
    lazyWorkbookRef: reference, univerRef: { current: null },
    setMessage: vi.fn(), stashViewRestore: vi.fn(), openLazyWorkbook: open,
    requireOwnedAdoption: true, writeContext: { origin: 'automatic' },
    documentDirty: () => journalSize(reference.current.editJournal) > 0,
  }
  const snapshot = () => serializeWorkbookDocumentPayload(collectWorkbookDocumentPayload(ctx).payload)
  const acceptedSnapshot = snapshot()
  ctx.publicationFence = {
    source: { lineage: 'loaded-workbook', sessionId: file.sessionId,
      openedSha256: file.sha256, documentPath: target },
    stamp: { source: 'renderer-workbook', revision: '1' },
    payloadSha256: createHash('sha256').update(acceptedSnapshot).digest('hex'),
    canAdopt: () => reference.current === state && snapshot() === acceptedSnapshot,
  }

  const owner = { rendererId: 41 }
  const ticket: CloseLeaseTicket = { id: 'native-question-1', sequence: 1, source: 'renderer-workbook' }
  let activeClose: CloseLeaseTicket | undefined = ticket
  const cancel = vi.fn((_owner: typeof owner, exact: CloseLeaseTicket) => {
    gate.releasePrompt(owner, exact)
    activeClose = undefined
  })
  const gate = new SheetsPromptWriteGate<typeof owner>({
    alive: () => true,
    currentClose: () => activeClose,
    acceptsClose: () => false,
    // This fixture is the native-question interval, before close transport
    // claims a renderer writer. The transport itself is not under test here.
    assertTransportWriter: vi.fn(),
    cancelExactClose: cancel,
    actualSettled: async () => {},
  })
  gate.beginPrompt(owner, ticket)
  const admit = vi.fn((context: WorkbookWriteContext | undefined, closeTicket?: CloseLeaseTicket) =>
    gate.admit(owner, context, closeTicket))
  const authorize = async (context: WorkbookWriteContext | undefined, closeTicket?: CloseLeaseTicket) => {
    const admission = admit(context, closeTicket)
    await admission.ready
    gate.assert(owner, admission)
  }
  const packageWriter = vi.fn(async (path: string, bytes: Buffer) => { await writeFile(path, bytes) })
  const save = vi.fn(async (request: WorkbookSaveRequest, closeTicket?: CloseLeaseTicket, context?: WorkbookWriteContext) => {
    workbookSaveRequestSchema.parse(request)
    await authorize(context, closeTicket)
    await packageWriter(target, published)
    const next = { lineage: 'loaded-workbook', sessionId: '22222222-2222-4222-8222-222222222222',
      openedSha256: createHash('sha256').update(published).digest('hex'), documentPath: target }
    return { canceled: false as const, file: { ...file, sessionId: next.sessionId, sha256: next.openedSha256 },
      ownedPublication: { id: 'stub-owned-publication', source: next } }
  })
  const recovery = vi.fn(async (request: WorkbookSaveRequest, context?: WorkbookWriteContext) => {
    workbookSaveRequestSchema.parse(request)
    await authorize(context)
    await packageWriter(recoveryTarget, Buffer.from('stub recovery marker'))
    return { ok: true }
  })
  // Its presence selects the actual modern single-batch branch in SaveActions.
  const checkpoint = vi.fn(async (
    request: WorkbookSaveRequest, _dirty?: boolean,
    binding?: WorkbookCloseCheckpointBinding, context?: WorkbookWriteContext,
  ) => {
    workbookSaveRequestSchema.parse(request)
    await authorize(context, binding?.ticket)
    await packageWriter(checkpointTarget, Buffer.from('stub native checkpoint marker'))
    return { apiVersion: 1, documentId: '33333333-3333-4333-8333-333333333333',
      commandId: 'stub-full-checkpoint', revision: 1, durable: true,
      candidateId: '33333333-3333-4333-8333-333333333333' }
  })
  vi.stubGlobal('window', { desktopApi: {
    saveWorkbookEdits: save, writeWorkbookRecovery: recovery,
    checkpointWorkbookDocument: checkpoint, rejectWorkbookPublication: vi.fn(),
  } })
  return { target, recoveryTarget, checkpointTarget, original, published, journal, state, reference,
    ctx, snapshot, acceptedSnapshot, table, pivot, open, save, recovery, checkpoint, packageWriter, admit, cancel,
    cancelQuestion: () => { gate.releasePrompt(owner, ticket); activeClose = undefined },
  }
}

describe('automatic real SaveActions at the native close-question boundary', () => {
  it.each(['save', 'recovery', 'checkpoint'] as const)(
    'rejects automatic %s without publishing, adopting, or clearing accepted non-cell work',
    async (mode) => {
      const f = await fixture()
      await expect(handleSave(f.ctx, mode, true)).resolves.toMatchObject({ ok: false })
      expect(f.admit).toHaveBeenCalledExactlyOnceWith({ origin: 'automatic' }, undefined)
      expect(f.cancel).not.toHaveBeenCalled()
      expect(f.packageWriter).not.toHaveBeenCalled()
      expect(f.open).not.toHaveBeenCalled()
      expect(f.reference.current).toBe(f.state)
      expect(f.reference.current.editJournal).toBe(f.journal)
      expect(f.snapshot()).toBe(f.acceptedSnapshot)
      expect(await readFile(f.target)).toEqual(f.original)
      await expect(readFile(f.recoveryTarget)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(f.checkpointTarget)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.save).toHaveBeenCalledTimes(mode === 'save' ? 1 : 0)
      expect(f.recovery).toHaveBeenCalledTimes(mode === 'recovery' ? 1 : 0)
      expect(f.checkpoint).toHaveBeenCalledTimes(mode === 'checkpoint' ? 1 : 0)
    },
  )

  it('resumes after Cancel with one modern batch containing every accepted family', async () => {
    const f = await fixture()
    const expectedPayload = collectWorkbookDocumentPayload(f.ctx).payload
    await expect(handleSave(f.ctx, 'save', true)).resolves.toMatchObject({ ok: false })
    f.cancelQuestion()
    await expect(handleSave(f.ctx, 'save', true)).resolves.toMatchObject({
      ok: true, published: true, adopted: true, clean: true,
    })
    expect(f.save).toHaveBeenCalledTimes(2) // one refused attempt, one actual batch
    expect(f.packageWriter).toHaveBeenCalledExactlyOnceWith(f.target, f.published)
    const request = f.save.mock.calls[1]![0]
    expect(request.edits).toEqual(expectedPayload.edits)
    expect(request.structuralOps).toEqual(expectedPayload.structuralOps)
    expect(request.structuralOps).toEqual([
      expect.objectContaining({ sheetId: 'sheet-1', kind: 'insert-rows', index: 0, count: 1 }),
    ])
    expect(request.tableAdditions).toEqual([f.table])
    expect(request.pivotAdditions).toEqual([f.pivot])
    expect(request.pageSetupStates).toEqual([
      expect.objectContaining({ sheetId: 'sheet-1', orientation: 'landscape', header: { center: 'Accepted header' } }),
    ])
    expect(request.workbookProtectionState).toEqual({ lockStructure: true })
    expect(f.save.mock.calls[1]![1]).toBeUndefined()
    expect(f.save.mock.calls[1]![2]).toEqual({ origin: 'automatic' })
    expect(f.open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ownedOpen: expect.objectContaining({ id: 'stub-owned-publication' }) }),
      expect.objectContaining({ writeContext: { origin: 'automatic' }, deferPreviousRelease: true }),
    )
    expect(f.recovery).not.toHaveBeenCalled()
    expect(f.checkpoint).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
    expect(await readFile(f.target)).toEqual(f.published)
    expect(f.reference.current).not.toBe(f.state)
    expect(journalSize(f.reference.current.editJournal)).toBe(0)
  })
})
