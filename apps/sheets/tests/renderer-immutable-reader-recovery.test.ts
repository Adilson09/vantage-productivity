import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SheetsAppCloseSession } from '../src/renderer/sheets-app-close-session'
import { createEditJournal, recordSetRangeValues } from '../src/renderer/edit-journal'
import { bindJournalAuthoredAdmission } from '../src/renderer/workbook-authored-admission'
import type { DesktopApi, WorkbookFile } from '../src/shared/desktop-api'
import type { LazyWorkbookState } from '../src/renderer/univer-state'
import type { SaveContext } from '../src/renderer/save-actions'
import {
  configureWorkbookMutationAdmission, createWorkbookPublicationOwner,
  enqueueWorkbookPublication, enqueueWorkbookMutation, workbookWorkPending,
} from '../src/renderer/workbook-mutation-queue'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { vi.unstubAllGlobals() })

function fixture() {
  const source = { lineage: 'same-loaded-document', sessionId: '11111111-1111-4111-8111-111111111111',
    openedSha256: 'a'.repeat(64), documentPath: '/books/original.xlsx' }
  const oldFile = { sessionId: source.sessionId, sha256: source.openedSha256, path: source.documentPath,
    closeSource: source, needsSaveAs: false, restoredFromRecovery: false, sheets: [] } as unknown as WorkbookFile
  const journal = createEditJournal()
  recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'accepted before reader restart' } } })
  const state = { file: oldFile, editJournal: journal, flags: { preloadComplete: true },
    recalc: { overlay: new Map(), formulaCells: new Map() } } as unknown as LazyWorkbookState
  const reference = { current: state }
  const fresh = { ...source, sessionId: '22222222-2222-4222-8222-222222222222' }
  const replacement = { ...oldFile, sessionId: fresh.sessionId, closeSource: fresh,
    ownedOpen: { id: 'owned-immutable-reader', source: fresh } }
  const checkpoint = vi.fn(async () => ({ apiVersion: 1, documentId: '33333333-3333-4333-8333-333333333333',
    commandId: 'full-checkpoint', revision: 1, durable: true, candidateId: '33333333-3333-4333-8333-333333333333' }))
  const adopt = vi.fn(async () => true), reject = vi.fn(async () => {})
  const api = { recoverWorkbookReader: vi.fn(async () => replacement), checkpointWorkbookDocument: checkpoint,
    adoptWorkbookPublication: adopt, rejectWorkbookPublication: reject, notifyWorkbookCloseState: vi.fn() } as unknown as DesktopApi
  vi.stubGlobal('window', { desktopApi: api })
  const context: SaveContext = { lazyWorkbookRef: reference, univerRef: { current: null },
    setMessage: () => {}, openLazyWorkbook: vi.fn(), stashViewRestore: () => {}, documentDirty: () => true }
  const session = new SheetsAppCloseSession({ api: () => api, file: () => state.file,
    context: () => context, dirty: () => true, busy: (owner) => workbookWorkPending(owner), derived: () => false,
    coverageComplete: () => true, commitEditor: async () => true,
    save: async () => ({ ok: false }), report: vi.fn() })
  session.select(oldFile)
  bindJournalAuthoredAdmission(journal, session.admission)
  return { session, state, oldFile, journal, source, replacement, api, checkpoint, adopt, reject, context }
}

describe('real renderer immutable-reader recovery/adoption', () => {
  it('does not lend an ambient close ticket to automatic reader recovery or its checkpoint', async () => {
    const f = fixture()
    const ticket = { id: 'ambient-close', sequence: 1, source: 'sheets-renderer-1' }
    // Reproduce a close preparation that overlaps this independent recovery.
    // Exercise the real recovery/adoption path rather than calling its helper.
    Reflect.set(f.session, 'activeRequest', { requestId: 'ambient-request', ticket,
      intent: 'save', expectedSource: f.source })
    f.context.closeTicket = ticket
    f.context.writeContext = { origin: 'close' }
    await expect(f.session.recoverSameModel(f.state)).resolves.toBe(true)
    expect(f.api.recoverWorkbookReader).toHaveBeenCalledWith(f.oldFile.sessionId, { origin: 'automatic' })
    expect(f.checkpoint).toHaveBeenCalledTimes(1)
    expect(f.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: f.replacement.sessionId }),
      true,
      undefined,
      { origin: 'automatic' },
    )
    expect(f.adopt).toHaveBeenCalledTimes(1)
    expect(f.context.writeContext).toEqual({ origin: 'close' })
  })

  it('requires explicit close provenance before adoption binds an ambient close request', async () => {
    const f = fixture()
    const ticket = { id: 'ambient-close', sequence: 1, source: 'sheets-renderer-1' }
    Reflect.set(f.session, 'activeRequest', { requestId: 'ambient-request', ticket,
      intent: 'save', expectedSource: f.source })
    f.state.file = f.replacement
    f.session.select(f.replacement)
    await expect(f.session.finishAdoption(f.replacement)).resolves.toBe(true)
    expect(f.checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: f.replacement.sessionId }), true, undefined, { origin: 'manual' },
    )
    await expect(f.session.finishAdoption(f.replacement, { origin: 'close' })).resolves.toBe(true)
    expect(f.checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: f.replacement.sessionId }), true,
      expect.objectContaining({ requestId: 'ambient-request', ticket }), { origin: 'close' },
    )
    Reflect.set(f.session, 'activeRequest', null)
    f.checkpoint.mockClear()
    await expect(f.session.finishAdoption(f.replacement, { origin: 'close' })).resolves.toBe(false)
    expect(f.checkpoint).not.toHaveBeenCalled()
  })

  it('excludes publication work only for that owners fence, never a concurrent close inspection', async () => {
    const f = fixture(), owner = createWorkbookPublicationOwner()
    const stop = configureWorkbookMutationAdmission(f.session.admission)
    let queued: Promise<unknown> | undefined
    try {
      await enqueueWorkbookPublication(owner, async () => {
        await f.session.refreshFingerprint()
        const fence = f.session.captureOwnedPublicationFence(owner)
        expect(fence).not.toBeNull()
        expect(fence!.canAdopt()).toBe(true)
        expect(f.session.state()?.busy).toBe(true)
        queued = enqueueWorkbookMutation(() => true)
        expect(fence!.canAdopt()).toBe(false)
      })
      await queued
      expect(f.session.state()?.busy).toBe(false)
    } finally { stop() }
  })
  it('keeps the same model/journal and waits for the actual full checkpoint before adoption', async () => {
    const f = fixture(), entered = deferred<void>(), committed = deferred<Awaited<ReturnType<typeof f.checkpoint>>>()
    const receipt = await f.checkpoint()
    f.checkpoint.mockClear()
    f.checkpoint.mockImplementation(async () => { entered.resolve(undefined); return committed.promise })
    const epoch = f.session.admission.captureSource()
    const recovering = f.session.recoverSameModel(f.state)
    await entered.promise
    expect(f.adopt).not.toHaveBeenCalled()
    expect(f.state.editJournal).toBe(f.journal)
    committed.resolve(receipt)
    await expect(recovering).resolves.toBe(true)
    expect(f.adopt).toHaveBeenCalledTimes(1)
    expect(f.session.admission.captureSource()).toBe(epoch)
    recordSetRangeValues(f.journal, 'sheet-1', { 1: { 0: { v: 'accepted after restart' } } })
    expect(f.journal.cells.get('sheet-1')?.get('0:0')?.value).toBe('accepted before reader restart')
    expect(f.journal.cells.get('sheet-1')?.get('1:0')?.value).toBe('accepted after restart')
  })

  it('reverts only the offered reader metadata on checkpoint failure and preserves pending work', async () => {
    const f = fixture()
    f.checkpoint.mockRejectedValueOnce(new Error('unknown checkpoint acknowledgment'))
    await expect(f.session.recoverSameModel(f.state)).resolves.toBe(false)
    expect(f.state.file).toBe(f.oldFile)
    expect(f.state.editJournal).toBe(f.journal)
    expect(f.adopt).not.toHaveBeenCalled()
    expect(f.reject).toHaveBeenCalledWith('owned-immutable-reader')
    expect(f.session.state()?.source).toEqual(f.source)
  })

  it('refuses a changed loaded fingerprint even when replacement bytes are offered as a reader', async () => {
    const f = fixture()
    f.replacement.closeSource.openedSha256 = 'b'.repeat(64)
    await expect(f.session.recoverSameModel(f.state)).resolves.toBe(false)
    expect(f.checkpoint).not.toHaveBeenCalled()
    expect(f.adopt).not.toHaveBeenCalled()
    expect(f.state.file).toBe(f.oldFile)
    expect(f.reject).toHaveBeenCalledWith('owned-immutable-reader')
  })
})
