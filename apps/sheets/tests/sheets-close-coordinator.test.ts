import { describe, expect, it, vi } from 'vitest'
import type {
  CloseCleanupHandle,
  CloseCleanupStatus,
} from '../../../packages/electron-utils/src/close-cleanup'
import type {
  SheetsPrepareCloseRequest,
  SheetsPrepareCloseResult,
} from '../src/shared/sheets-close'
import type { CapturedNativeCloseAuthority } from '../src/main/workbook-document-recovery'
import {
  SheetsCloseCoordinator,
  type SheetsRendererCloseAdmission,
} from '../src/main/sheets-close-coordinator'

const stamp = { source: 'renderer-epoch', revision: '18' }
const source = {
  lineage: 'main-lineage',
  sessionId: 'reader-1',
  openedSha256: 'a'.repeat(64),
  documentPath: 'C:/work/book.xlsx',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** In ordinary fixtures the result models actual completion; transport-timeout tests supply a separate real tail. */
function rendererAdmission(
  result: Promise<SheetsPrepareCloseResult>,
  actualSettled = result.then(
    () => undefined,
    () => undefined,
  ),
): SheetsRendererCloseAdmission {
  return { result, actualSettled }
}

function fixture(encrypted = false) {
  const run = vi.fn()
  const resume = vi.fn(async () => {})
  const cancelAuthority = vi.fn(async () => {})
  const authority = {
    id: '00000000-0000-4000-8000-000000000001',
    producer: '00000000-0000-4000-8000-000000000001',
    generation: 1,
    ownerId: '1',
    sessionId: source.sessionId,
    originalPath: source.documentPath,
    encrypted,
    ready: Promise.resolve(),
    cancelled: false,
    attest: () => ({
      documentId: '00000000-0000-4000-8000-000000000001',
      revision: 7,
      sourceFingerprint: `sha256:${source.openedSha256}`,
      payloadSha256: 'c'.repeat(64),
      pending: false,
    }),
    snapshotProof: vi.fn(),
    retireCapturedOnly: run,
    cancel: cancelAuthority,
    resume,
    settled: () => Promise.resolve(),
  } satisfies CapturedNativeCloseAuthority
  const status: CloseCleanupStatus = {
    id: 'cleanup-1',
    module: 'sheets',
    ownerKey: '1',
    source: source.lineage,
    generation: 1,
    token: authority.producer,
    documentPath: source.documentPath,
    phase: 'staged',
    updatedAt: '2026-10-30T00:00:00Z',
    custody: !encrypted,
  }
  const cleanupCancel = vi.fn()
  const cleanup: CloseCleanupHandle = {
    id: status.id,
    status: () => structuredClone(status),
    outcome: Promise.resolve(status),
    commitRemoval: (remove) => {
      const removed = remove()
      if (removed) run()
      return removed
    },
    cancel: cleanupCancel,
  }
  const admission = () => ({
    ready: Promise.resolve(cleanup),
    actualSettled: Promise.resolve(),
    cancel: vi.fn(),
  })
  const stagePersistent = vi.fn(admission)
  const stageMemory = vi.fn(admission)
  const capture = vi.fn(() => authority)
  const verifyCapturedRevision = vi.fn(() => true)
  const report = vi.fn()
  const result = (request: SheetsPrepareCloseRequest): SheetsPrepareCloseResult => ({
    current: true,
    intent: request.intent,
    published: request.intent === 'save',
    clean: request.intent === 'save',
    closeLease: {
      ticket: request.ticket,
      stamp: { ...stamp },
      source: { ...source },
      payloadSha256: 'c'.repeat(64),
    },
  })
  const prepareRenderer = vi.fn(
    (owner: number, request: SheetsPrepareCloseRequest): SheetsRendererCloseAdmission => {
      void owner
      return rendererAdmission(Promise.resolve(result(request)))
    },
  )
  const options = {
    alive: () => true,
    current: () => ({ ...source }),
    sourceBusy: () => false,
    coverageComplete: () => true,
    prepareRenderer,
    releaseRenderer: vi.fn(),
    capture,
    verifyCapturedRevision,
    stagePersistent,
    stageMemory,
    report,
    holdNativeUntilSettled: vi.fn(),
  }
  return {
    options,
    result,
    authority,
    capture,
    run,
    resume,
    cancelAuthority,
    cleanup,
    cleanupCancel,
    stagePersistent,
    stageMemory,
    prepareRenderer,
    verifyCapturedRevision,
  }
}

describe('main Sheets exact-revision close coordinator (source proposal)', () => {
  it('refuses Save success with retained late edits before capturing recovery', async () => {
    const f = fixture()
    f.prepareRenderer.mockImplementation((_owner, request) =>
      rendererAdmission(Promise.resolve({ ...f.result(request), clean: false })),
    )
    const close = new SheetsCloseCoordinator(f.options)
    await expect(close.prepare(1, 'save')).rejects.toThrow('changed')
    expect(f.capture).not.toHaveBeenCalled()
  })

  it('does not refresh an approved discard stamp after waiting', async () => {
    const f = fixture()
    const close = new SheetsCloseCoordinator(f.options)
    await expect(close.prepare(1, 'discard', { ...stamp, revision: '17' })).rejects.toThrow(
      'changed',
    )
    expect(f.capture).not.toHaveBeenCalled()
  })

  it('requires a main-owned checkpoint acknowledgment for the authored revision', async () => {
    const f = fixture()
    f.verifyCapturedRevision.mockReturnValue(false)
    const close = new SheetsCloseCoordinator(f.options)
    await expect(close.prepare(1, 'discard', stamp)).rejects.toThrow('uncertain')
    expect(f.run).not.toHaveBeenCalled()
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('refuses a captured native payload which differs from the locked full renderer payload', async () => {
    const f = fixture()
    f.authority.attest = () => ({
      documentId: f.authority.id,
      revision: 7,
      sourceFingerprint: `sha256:${source.openedSha256}`,
      payloadSha256: 'd'.repeat(64),
      pending: false,
    })
    const close = new SheetsCloseCoordinator(f.options)
    await expect(close.prepare(1, 'discard', stamp)).rejects.toThrow('uncertain')
    expect(f.run).not.toHaveBeenCalled()
  })

  it('retains the captured producer when actual removal returns false', async () => {
    const f = fixture()
    const close = new SheetsCloseCoordinator(f.options)
    const receipt = await close.prepare(1, 'discard', stamp)
    expect(close.complete(1, receipt, () => false)).toBe(false)
    expect(f.run).not.toHaveBeenCalled()
    expect(f.cleanupCancel).toHaveBeenCalled()
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('does not accept copied receipts or cross-owner removal', async () => {
    const f = fixture()
    const close = new SheetsCloseCoordinator(f.options)
    const receipt = await close.prepare(1, 'save')
    expect(close.complete(1, structuredClone(receipt), () => true)).toBe(false)
    expect(close.complete(2, receipt, () => true)).toBe(false)
    expect(f.run).not.toHaveBeenCalled()
    close.cancel(1, receipt.closeLease.ticket)
  })

  it('uses the memory-only stage without entering persisted provider runtime', async () => {
    const f = fixture(true)
    const close = new SheetsCloseCoordinator(f.options)
    const receipt = await close.prepare(1, 'discard', stamp)
    expect(receipt.cleanup.custody).toBe(false)
    expect(f.stageMemory).toHaveBeenCalledTimes(1)
    expect(f.stagePersistent).not.toHaveBeenCalled()
    expect(close.complete(1, receipt, () => true)).toBe(true)
    expect(f.run).toHaveBeenCalledTimes(1)
  })

  it('binds protected native and encrypted-source digests through the main ACK instead of equating them', async () => {
    const f = fixture(true)
    f.authority.attest = () => ({
      documentId: f.authority.id,
      revision: 7,
      sourceFingerprint: `sha256:${'b'.repeat(64)}`,
      payloadSha256: 'c'.repeat(64),
      pending: false,
    })
    const close = new SheetsCloseCoordinator(f.options)
    const receipt = await close.prepare(1, 'discard', stamp)
    expect(f.verifyCapturedRevision).toHaveBeenCalled()
    expect(receipt.nativeAuthorities[0]?.sourceFingerprint).toBe(`sha256:${'b'.repeat(64)}`)
    close.cancel(1, receipt.closeLease.ticket)
  })

  it('does not grant close when a timed-out renderer returns late', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const reply = deferred<SheetsPrepareCloseResult>()
      let request: SheetsPrepareCloseRequest | undefined
      f.prepareRenderer.mockImplementation((_owner, next) => {
        request = next
        return rendererAdmission(reply.promise)
      })
      const close = new SheetsCloseCoordinator({ ...f.options, prepareTimeoutMs: 10 })
      const preparing = close.prepare(1, 'save')
      const rejected = expect(preparing).rejects.toThrow('changed')
      await vi.advanceTimersByTimeAsync(11)
      await expect(close.prepare(1, 'save')).rejects.toThrow('writer')
      reply.resolve(f.result(request!))
      await rejected
      expect(f.capture).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks retry until timed-out capture I/O actually settles', async () => {
    const f = fixture()
    const actual = deferred<void>()
    const ready = deferred<CloseCleanupHandle>()
    const entered = deferred<void>()
    const cancel = vi.fn()
    f.stagePersistent.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return { ready: ready.promise, actualSettled: actual.promise, cancel }
    })
    const close = new SheetsCloseCoordinator(f.options)
    const preparing = close.prepare(1, 'save')
    const rejected = expect(preparing).rejects.toThrow('capture timed out')
    await entered.promise
    // A bounded capture caller can fail while the provider's real I/O is
    // still pending. Returning a receipt here would require actual settlement.
    ready.reject(new Error('capture timed out'))
    await rejected
    expect(cancel).toHaveBeenCalled()
    expect(f.options.holdNativeUntilSettled).toHaveBeenCalledWith(1, actual.promise)
    await expect(close.prepare(1, 'save')).rejects.toThrow(/capture is still.*settling/)
    expect(f.capture).toHaveBeenCalledTimes(1)
    actual.resolve(undefined)
    await actual.promise
    // Run the registered settlement/finalizer observer before retrying.
    await Promise.resolve()
    const receipt = await close.prepare(1, 'save')
    expect(f.capture).toHaveBeenCalledTimes(2)
    close.cancel(1, receipt.closeLease.ticket)
  })

  it('keeps a writer reserved after its caller RPC rejects until actual renderer work settles', async () => {
    const f = fixture()
    const actual = deferred<void>()
    f.prepareRenderer.mockImplementation(() =>
      rendererAdmission(Promise.reject(new Error('renderer RPC timed out')), actual.promise),
    )
    const close = new SheetsCloseCoordinator(f.options)
    await expect(close.prepare(1, 'save')).rejects.toThrow('renderer RPC timed out')
    await expect(close.prepare(1, 'save')).rejects.toThrow('writer')
    expect(f.capture).not.toHaveBeenCalled()
    expect(f.options.holdNativeUntilSettled).toHaveBeenCalledWith(1, actual.promise)

    actual.resolve(undefined)
    await actual.promise
    // The registered actual-settlement observer must run, not a fake caller timeout.
    await Promise.resolve()
    f.prepareRenderer.mockImplementation((_owner, request) =>
      rendererAdmission(Promise.resolve(f.result(request))),
    )
    const receipt = await close.prepare(1, 'save')
    expect(f.capture).toHaveBeenCalledTimes(1)
    close.cancel(1, receipt.closeLease.ticket)
  })

  it('waits for actual finalizer completion even when a renderer result has already arrived', async () => {
    const f = fixture()
    const actual = deferred<void>()
    f.prepareRenderer.mockImplementation((_owner, request) =>
      rendererAdmission(Promise.resolve(f.result(request)), actual.promise),
    )
    const close = new SheetsCloseCoordinator(f.options)
    const pending = close.prepare(1, 'save')
    await Promise.resolve()
    await Promise.resolve()
    expect(f.capture).not.toHaveBeenCalled()
    actual.resolve(undefined)
    const receipt = await pending
    expect(f.capture).toHaveBeenCalledTimes(1)
    close.cancel(1, receipt.closeLease.ticket)
  })
})
