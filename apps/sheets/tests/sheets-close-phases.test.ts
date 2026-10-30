import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SheetsCloseCoordinator } from '../src/main/sheets-close-coordinator'
import type { CapturedNativeCloseAuthority } from '../src/main/workbook-document-recovery'
import type { SheetsCloseSource, SheetsPrepareCloseRequest, SheetsPrepareCloseResult } from '../src/shared/sheets-close'
import type { CloseCleanupHandle, CloseCleanupStatus } from '../../../packages/electron-utils/src/close-cleanup'

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
interface Owner { id: string; alive: boolean; source: SheetsCloseSource }
function fixture(control: { rendererResult?: Promise<SheetsPrepareCloseResult>; rendererActual?: Promise<void>; cleanupActual?: Promise<void> } = {}) {
  const owner: Owner = { id: 'owner', alive: true, source: { lineage: '10000000-0000-4000-8000-000000000001',
    sessionId: '20000000-0000-4000-8000-000000000001', openedSha256: 'a'.repeat(64), documentPath: 'C:/synthetic/book.xlsx' } }
  const requests: SheetsPrepareCloseRequest[] = [], release = vi.fn(), report = vi.fn(), holds: Promise<void>[] = []
  let cancelled = false, cleanupRuns = 0, nativeRevision = 3, verify = true, busy = false, coverage = true, nativePending = false
  const nativeId = '30000000-0000-4000-8000-000000000001'
  const authority: CapturedNativeCloseAuthority = { id: nativeId, producer: nativeId, generation: 1, ownerId: owner.id,
    sessionId: owner.source.sessionId, originalPath: owner.source.documentPath!, encrypted: false, ready: Promise.resolve(),
    get cancelled() { return cancelled },
    attest: () => ({ documentId: nativeId, revision: nativeRevision, sourceFingerprint: `sha256:${'a'.repeat(64)}`, pending: nativePending, payloadSha256: 'b'.repeat(64) }),
    snapshotProof: async () => { throw new Error('This protocol fixture does not perform snapshot I/O.') },
    retireCapturedOnly: async () => { cleanupRuns++ },
    cancel: async () => { cancelled = true }, resume: async () => { cancelled = true }, settled: async () => undefined }
  let phase: CloseCleanupStatus['phase'] = 'staged'
  const status = (): CloseCleanupStatus => ({ id: 'cleanup', module: 'sheets', ownerKey: owner.id, source: owner.source.lineage,
    generation: 1, token: nativeId, documentPath: owner.source.documentPath, phase, updatedAt: '2026-10-30T00:00:00Z', custody: true })
  const cleanup: CloseCleanupHandle = { id: 'cleanup', status, outcome: Promise.resolve(status()),
    cancel: () => { phase = 'canceled' }, commitRemoval: remove => {
      const removed = remove(); if (removed) { cleanupRuns++; phase = 'complete' }; return removed
    } }
  const coor = new SheetsCloseCoordinator<Owner>({ alive: value => value.alive, current: value => ({ ...value.source }), sourceBusy: () => busy,
    coverageComplete: () => coverage, prepareRenderer: (value, request) => {
      requests.push(request)
      const result: SheetsPrepareCloseResult = { current: true, published: false, clean: true, intent: request.intent,
        closeLease: { ticket: request.ticket, stamp: { source: 'generation', revision: '7' }, source: value.source, payloadSha256: 'b'.repeat(64) } }
      return { result: control.rendererResult ?? Promise.resolve(result), actualSettled: control.rendererActual ?? Promise.resolve() }
    }, releaseRenderer: release, capture: () => authority, verifyCapturedRevision: () => verify,
    stagePersistent: () => ({ ready: Promise.resolve(cleanup), actualSettled: control.cleanupActual ?? Promise.resolve(), cancel: () => { phase = 'canceled' } }),
    stageMemory: () => { throw new Error('This fixture is unprotected.') },
    holdNativeUntilSettled: (_owner, actual) => { holds.push(actual) }, report, prepareTimeoutMs: 120_000, readyTimeoutMs: 5_000 })
  return { owner, coor, requests, release, report, holds, cleanupRuns: () => cleanupRuns,
    changeNative: () => { nativeRevision++ }, refuseProof: () => { verify = false },
    setBusy: () => { busy = true }, revokeCoverage: () => { coverage = false },
    setNativePending: () => { nativePending = true }, cancelCleanup: () => cleanup.cancel('test invalidated custody') }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('prepared and sealed Sheets close phases (source-only protocol regressions)', () => {
  it('prepared survives more than5s within the original120s budget and seal starts its own5s window', async () => {
    const f = fixture(), prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true })
    expect(prepared.phase).toBe('prepared')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(f.coor.isPrepared(f.owner, prepared)).toBe(true)
    expect(f.cleanupRuns()).toBe(0)
    const ready = f.coor.seal(f.owner, prepared)!
    expect(ready.phase).toBe('ready')
    expect(ready).not.toBe(prepared)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(f.coor.complete(f.owner, ready, () => true)).toBe(true)
    expect(f.cleanupRuns()).toBe(1)
  })

  it('expired original prompt cannot start a late renderer Save or reserve a fresh grace period', async () => {
    const f = fixture(), prompt = f.coor.beginPrompt(f.owner, { deferSeal: true })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(f.coor.isPromptCurrent(f.owner, prompt)).toBe(false)
    await expect(f.coor.prepareReserved(f.owner, prompt, 'save')).rejects.toThrow('original native close reservation')
    expect(f.requests).toHaveLength(0)
    const next = f.coor.beginPrompt(f.owner)
    f.coor.endPrompt(f.owner, prompt, false)
    expect(f.coor.isPromptCurrent(f.owner, next)).toBe(true)
    f.coor.endPrompt(f.owner, next, false)
  })

  it('direct completion of prepared, copied receipts and wrong-owner receipts never calls removal', async () => {
    const f = fixture(), prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true }), remove = vi.fn(() => true)
    const other: Owner = { ...f.owner, id: 'different-owner' }
    expect(f.coor.complete(f.owner, prepared, remove)).toBe(false)
    expect(f.coor.seal(other, prepared)).toBeNull()
    expect(f.coor.seal(f.owner, structuredClone(prepared))).toBeNull()
    expect(f.coor.isPrepared(f.owner, prepared)).toBe(true)
    const ready = f.coor.seal(f.owner, prepared)!
    expect(f.coor.complete(other, ready, remove)).toBe(false)
    expect(f.coor.complete(f.owner, structuredClone(ready), remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(f.cleanupRuns()).toBe(0)
    f.coor.cancel(f.owner, ready.closeLease.ticket)
  })

  it('second seal cannot refresh or invalidate the already-started five-second ready window', async () => {
    const f = fixture(), prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true })
    const ready = f.coor.seal(f.owner, prepared)!
    await vi.advanceTimersByTimeAsync(4_000)
    expect(f.coor.seal(f.owner, prepared)).toBeNull()
    expect(f.coor.seal(f.owner, ready)).toBeNull()
    await vi.advanceTimersByTimeAsync(1_001)
    expect(f.coor.complete(f.owner, ready, () => true)).toBe(false)
    expect(f.cleanupRuns()).toBe(0)
  })

  it('prepared cannot seal after120s even when no ready window has started', async () => {
    const f = fixture(), prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(f.coor.isPrepared(f.owner, prepared)).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(f.coor.isPrepared(f.owner, prepared)).toBe(false)
    expect(f.coor.seal(f.owner, prepared)).toBeNull()
    expect(f.cleanupRuns()).toBe(0)
  })

  it('main abort/epoch veto after a prompt prevents any renderer writer or custody admission', async () => {
    const f = fixture(), controller = new AbortController()
    let current = true
    const prompt = f.coor.beginPrompt(f.owner, { deferSeal: true, signal: controller.signal, isCurrent: () => current })
    current = false
    await expect(f.coor.prepareReserved(f.owner, prompt, 'save')).rejects.toThrow('original native close reservation')
    controller.abort()
    f.coor.endPrompt(f.owner, prompt, false)
    expect(f.requests).toHaveLength(0)
    expect(f.cleanupRuns()).toBe(0)
  })

  it('seal revalidates the exact captured native revision and main ACK before issuing readiness', async () => {
    const f = fixture(), prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true })
    f.changeNative()
    expect(f.coor.seal(f.owner, prepared)).toBeNull()
    expect(f.coor.complete(f.owner, prepared, () => true)).toBe(false)
    expect(f.cleanupRuns()).toBe(0)
  })

  it('caller failure keeps actual renderer ownership until its independent finalizer settles', async () => {
    const result = deferred<SheetsPrepareCloseResult>(), actual = deferred<void>(), f = fixture({ rendererResult: result.promise, rendererActual: actual.promise })
    const preparing = f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true })
    result.reject(new Error('transport result timed out'))
    await expect(preparing).rejects.toThrow('transport result timed out')
    expect(f.holds).toContain(actual.promise)
    expect(() => f.coor.beginPrompt(f.owner)).toThrow('still finishing')
    actual.resolve(); await actual.promise; await Promise.resolve()
    const next = f.coor.beginPrompt(f.owner)
    f.coor.endPrompt(f.owner, next, false)
    expect(f.cleanupRuns()).toBe(0)
  })

  it('checks three prepared siblings locally without invoking their group predicate', async () => {
    const f = fixture(), owners = [f.owner, { ...f.owner, id: 'second' }, { ...f.owner, id: 'third' }]
    const prepared: { owner: Owner; receipt: Awaited<ReturnType<typeof f.coor.prepare>> }[] = []
    let queries = 0
    const isCurrent = () => { queries++; return prepared.every(item => f.coor.isPrepared(item.owner, item.receipt)) }
    for (const owner of owners) prepared.push({ owner, receipt: await f.coor.prepare(owner, 'save', undefined, undefined, { deferSeal: true, isCurrent }) })
    queries = 0
    expect(f.coor.isPrepared(prepared[0]!.owner, prepared[0]!.receipt)).toBe(true)
    expect(queries).toBe(0)
    for (const item of prepared) f.coor.cancel(item.owner, item.receipt.closeLease.ticket)
  })

  it('works inside the Root prepared-scan guard without recursive permission or external calls', async () => {
    const f = fixture()
    let checkingPrepared = false, recursivePermit = false
    const otherFamilyPrepared = vi.fn(() => true)
    const participants: (() => boolean)[] = [otherFamilyPrepared]
    const isCurrent = vi.fn(() => {
      if (checkingPrepared) { recursivePermit = true; return false }
      checkingPrepared = true
      try { return participants.every(isPrepared => isPrepared()) }
      finally { checkingPrepared = false }
    })
    const prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true, isCurrent })
    participants.push(() => f.coor.isPrepared(f.owner, prepared), otherFamilyPrepared)
    isCurrent.mockClear(); otherFamilyPrepared.mockClear()
    // Root sets this before it scans every family's prepared state.
    checkingPrepared = true
    expect(f.coor.isPrepared(f.owner, prepared)).toBe(true)
    checkingPrepared = false
    expect(isCurrent).not.toHaveBeenCalled()
    expect(recursivePermit).toBe(false)
    expect(isCurrent()).toBe(true)
    expect(isCurrent).toHaveBeenCalledTimes(1)
    expect(otherFamilyPrepared).toHaveBeenCalledTimes(2)
    expect(recursivePermit).toBe(false)
    f.coor.cancel(f.owner, prepared.closeLease.ticket)
  })

  it('a local query cannot substitute for the full group permission required to seal', async () => {
    const f = fixture()
    let permit = true
    const isCurrent = vi.fn(() => permit)
    const prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true, isCurrent })
    isCurrent.mockClear(); permit = false
    expect(f.coor.isPrepared(f.owner, prepared)).toBe(true)
    expect(isCurrent).not.toHaveBeenCalled()
    expect(f.coor.seal(f.owner, prepared)).toBeNull()
    expect(isCurrent).toHaveBeenCalled()
    expect(f.cleanupRuns()).toBe(0)
  })

  it('revoking group permission after sealing still prevents actual removal', async () => {
    const f = fixture()
    let permit = true
    const isCurrent = vi.fn(() => permit), remove = vi.fn(() => true)
    const prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true, isCurrent })
    const ready = f.coor.seal(f.owner, prepared)!
    expect(ready.phase).toBe('ready')
    permit = false; isCurrent.mockClear()
    expect(f.coor.complete(f.owner, ready, remove)).toBe(false)
    expect(isCurrent).toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(f.cleanupRuns()).toBe(0)
  })

  it.each(['source', 'owner', 'busy', 'coverage', 'ack', 'revision', 'pending', 'custody', 'abort'] as const)(
    'refuses changed local %s proof without asking the group', async (change) => {
      const f = fixture(), abort = new AbortController(), isCurrent = vi.fn(() => true)
      const prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true, isCurrent, signal: abort.signal })
      isCurrent.mockClear()
      if (change === 'source') f.owner.source = { ...f.owner.source, documentPath: 'C:/synthetic/other.xlsx' }
      if (change === 'owner') f.owner.alive = false
      if (change === 'busy') f.setBusy()
      if (change === 'coverage') f.revokeCoverage()
      if (change === 'ack') f.refuseProof()
      if (change === 'revision') f.changeNative()
      if (change === 'pending') f.setNativePending()
      if (change === 'custody') f.cancelCleanup()
      if (change === 'abort') abort.abort()
      expect(f.coor.isPrepared(f.owner, prepared)).toBe(false)
      expect(isCurrent).not.toHaveBeenCalled()
      expect(f.cleanupRuns()).toBe(0)
      f.coor.cancel(f.owner, prepared.closeLease.ticket)
    },
  )

  it('repeated local scans do not renew the original preparing deadline', async () => {
    const f = fixture(), isCurrent = vi.fn(() => true)
    const prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true, isCurrent })
    isCurrent.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    for (let i = 0; i < 8; i++) expect(f.coor.isPrepared(f.owner, prepared)).toBe(true)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.coor.isPrepared(f.owner, prepared)).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(f.coor.isPrepared(f.owner, prepared)).toBe(false)
    expect(isCurrent).not.toHaveBeenCalled()
    expect(f.cleanupRuns()).toBe(0)
  })

  it('fails closed if a full group callback tries to seal and remove reentrantly', async () => {
    const f = fixture(), remove = vi.fn(() => true)
    let armed = false, prepared: Awaited<ReturnType<typeof f.coor.prepare>> | undefined
    let nested: ReturnType<typeof f.coor.seal> | undefined
    const isCurrent = () => {
      if (armed && prepared) {
        armed = false
        nested = f.coor.seal(f.owner, prepared)
        if (nested) f.coor.complete(f.owner, nested, remove)
      }
      return true
    }
    prepared = await f.coor.prepare(f.owner, 'save', undefined, undefined, { deferSeal: true, isCurrent })
    armed = true
    expect(f.coor.seal(f.owner, prepared)).toBeNull()
    expect(nested).toBeNull()
    expect(remove).not.toHaveBeenCalled()
    expect(f.cleanupRuns()).toBe(0)
  })
})
