/** Private proposal source only: compose shared v2 helpers before running. */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CloseMutationBarrier } from '../../../packages/electron-utils/src/renderer-close-barrier'
import type { CloseLeaseTicket } from '../../../packages/electron-utils/src/close-lease'
import type { SheetsCloseSource, SheetsPrepareCloseRequest } from '../src/shared/sheets-close'
import {
  createSheetsCloseController,
  type SheetsAcceptedRecovery,
  type SheetsCloseControllerOptions,
  type SheetsPublicationFence,
} from '../src/renderer/sheets-close-controller'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(dirty = true) {
  let source: SheetsCloseSource | null = {
    lineage: 'main-owned-lineage-1',
    sessionId: 'reader-1',
    openedSha256: 'original-sha256',
    documentPath: '/private/original.xlsx',
  }
  let documentGeneration = 1
  let pending = dirty
  let busy = false
  let coverage = true
  let payload = {
    edits: dirty ? [{ address: 'A1', value: 'captured' }] : [],
    pageSetupStates: [] as { orientation: string }[],
  }
  const publishedPayloads: unknown[] = []
  const report = vi.fn()
  const cancel = vi.fn(async (_ticket: CloseLeaseTicket, _reason: string): Promise<void> => {})
  const barrier = new CloseMutationBarrier({
    source: () => `${source?.lineage ?? 'invalid-source'}:${documentGeneration}`,
    claim: async () => true,
    cancel: (ticket, reason) => cancel(ticket, reason),
    report,
  })
  const options: SheetsCloseControllerOptions = {
    barrier,
    current: () =>
      source === null
        ? null
        : {
            source,
            stamp: barrier.snapshot(),
            dirty: pending,
            busy,
            protectedMemoryOnly: false,
          },
    // The production adapter must hash the complete canonical DTO. This
    // small synthetic payload lets the test detect untracked metadata too.
    authoredPayloadSha256: () => createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    settleWork: vi.fn(async () => {}),
    coverageComplete: () => coverage,
    save: vi.fn(async (request: SheetsPrepareCloseRequest, fence: SheetsPublicationFence) => {
      if (!fence.canAdopt()) return { published: false, adopted: false }
      publishedPayloads.push(structuredClone(payload))
      source = {
        ...source!,
        sessionId: 'reader-2',
        openedSha256: 'published-sha256',
        documentPath: request.path ?? source!.documentPath,
      }
      documentGeneration++
      payload = { edits: [], pageSetupStates: [] }
      pending = false
      return { published: true, adopted: true, savedPath: source.documentPath! }
    }),
    flushAcceptedRecovery: vi.fn(async (expected: SheetsAcceptedRecovery) =>
      structuredClone(expected),
    ),
    cancel: (ticket, reason) => cancel(ticket, reason),
    invalidateSource: () => {
      source = null
      documentGeneration++
    },
  }
  const controller = createSheetsCloseController(options)
  let sequence = 0
  const request = (intent: 'save' | 'discard', path?: string): SheetsPrepareCloseRequest => {
    const current = controller.state()!
    return {
      ticket: { id: `close-${++sequence}`, sequence, source: current.source.lineage },
      intent,
      expectedSource: { ...current.source },
      ...(intent === 'discard' ? { approvedStamp: { ...current.stamp } } : {}),
      ...(path === undefined ? {} : { path, overwrite: true }),
    }
  }
  return {
    controller,
    options,
    barrier,
    cancel,
    report,
    request,
    publishedPayloads,
    source: () => source,
    payload: () => payload,
    setSource: (next: SheetsCloseSource) => {
      source = { ...next }
      documentGeneration++
    },
    setDirty: (next: boolean) => {
      pending = next
    },
    setBusy: (next: boolean) => {
      busy = next
    },
    setCoverage: (next: boolean) => {
      coverage = next
    },
    cell: (value: string) =>
      barrier.mutate(() => {
        payload.edits = [{ address: 'A1', value }]
        pending = true
      }),
    metadata: (orientation: string) =>
      barrier.mutate(() => {
        payload.pageSetupStates = [{ orientation }]
        pending = true
      }),
    // Deliberate missing producer instrumentation, to exercise the DTO fence.
    untrackedMetadata: (orientation: string) => {
      payload.pageSetupStates = [{ orientation }]
      pending = true
    },
  }
}

describe('Sheets close preparation proposal', () => {
  it('keeps a clean close locked through native acceptance until the exact main release', async () => {
    const f = fixture(false)
    const request = f.request('save')
    vi.mocked(f.options.flushAcceptedRecovery).mockImplementation(async (expected, ticket) => {
      expect(f.barrier.locked).toBe(true)
      expect(ticket).toEqual(request.ticket)
      return structuredClone(expected)
    })
    const result = await f.controller.prepare(request)
    expect(result).toMatchObject({ current: true, published: false, clean: true, intent: 'save' })
    expect(result.closeLease).toBeDefined()
    expect(f.options.save).not.toHaveBeenCalled()
    f.controller.release({ ...request.ticket, sequence: request.ticket.sequence + 10 })
    expect(f.barrier.locked).toBe(true)
    f.controller.release(request.ticket)
    expect(f.barrier.locked).toBe(false)
  })

  it('allows an attested owned Save As to replace the reader without changing lineage', async () => {
    const f = fixture()
    const request = f.request('save', '/private/saved-as.xlsx')
    const result = await f.controller.prepare(request)
    expect(result).toMatchObject({
      current: true,
      published: true,
      clean: true,
      savedPath: '/private/saved-as.xlsx',
    })
    expect(result.closeLease!.source).toMatchObject({
      lineage: request.expectedSource.lineage,
      sessionId: 'reader-2',
      openedSha256: 'published-sha256',
    })
    expect(result.closeLease!.source).not.toEqual(request.expectedSource)
    expect(f.options.flushAcceptedRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        source: result.closeLease!.source,
        stamp: result.closeLease!.stamp,
      }),
      request.ticket,
    )
  })

  it('refuses a Save-and-Close lease when a published save carries late pending cells', async () => {
    const f = fixture()
    vi.mocked(f.options.save).mockImplementation(async () => {
      f.setSource({ ...f.source()!, sessionId: 'reader-2', openedSha256: 'published-sha256' })
      f.cell('late retained cell')
      return { published: true, adopted: true, savedPath: '/private/original.xlsx' }
    })
    const result = await f.controller.prepare(f.request('save'))
    expect(result).toMatchObject({ current: true, published: true, clean: false })
    expect(result.closeLease).toBeUndefined()
    expect(f.payload().edits[0]!.value).toBe('late retained cell')
    expect(f.options.flushAcceptedRecovery).not.toHaveBeenCalled()
  })

  it('blocks pre-rebase adoption of late metadata even when the dirty count and barrier revision did not change', async () => {
    const f = fixture()
    const before = { ...f.source()! }
    vi.mocked(f.options.save).mockImplementation(async (_request, fence) => {
      const revision = f.barrier.snapshot().revision
      f.untrackedMetadata('landscape')
      expect(f.barrier.snapshot().revision).toBe(revision)
      expect(fence.canAdopt()).toBe(false)
      // Adapter keeps the old full source and native custody; no lossy rebase.
      return { published: true, adopted: false, savedPath: '/private/original.xlsx' }
    })
    const result = await f.controller.prepare(f.request('save'))
    expect(result.closeLease).toBeUndefined()
    expect(result.published).toBe(true)
    expect(f.source()).toEqual(before)
    expect(f.payload().pageSetupStates).toEqual([{ orientation: 'landscape' }])
  })

  it('includes work accepted before preparation when Save drains the full queue', async () => {
    const f = fixture()
    vi.mocked(f.options.settleWork).mockImplementation(async () => {
      f.metadata('landscape')
    })
    const result = await f.controller.prepare(f.request('save'))
    expect(result.closeLease).toBeDefined()
    expect(f.publishedPayloads[0]).toMatchObject({
      pageSetupStates: [{ orientation: 'landscape' }],
    })
  })

  it('never refreshes an approved Discard stamp after waiting for accepted work', async () => {
    const f = fixture()
    const wait = deferred<void>()
    vi.mocked(f.options.settleWork).mockImplementation(() => wait.promise)
    const request = f.request('discard')
    const result = f.controller.prepare(request)
    await Promise.resolve()
    f.cell('same-target later value')
    wait.resolve()
    const refused = await result
    expect(refused.closeLease).toBeUndefined()
    expect(refused.error).toContain('approved discard revision changed')
    expect(f.payload().edits[0]!.value).toBe('same-target later value')
    expect(f.options.flushAcceptedRecovery).not.toHaveBeenCalled()
  })

  it('rejects Discard after an owned reader rebase instead of silently approving its newer source', async () => {
    const f = fixture()
    vi.mocked(f.options.settleWork).mockImplementation(async () => {
      f.setSource({ ...f.source()!, sessionId: 'new-reader', openedSha256: 'new-sha' })
    })
    const result = await f.controller.prepare(f.request('discard'))
    expect(result.closeLease).toBeUndefined()
    expect(f.options.save).not.toHaveBeenCalled()
  })

  it('flushes exactly the approved dirty Discard snapshot under the lock without falsely marking it clean', async () => {
    const f = fixture()
    const request = f.request('discard')
    const result = await f.controller.prepare(request)
    expect(result).toMatchObject({
      current: true,
      published: false,
      clean: false,
      intent: 'discard',
    })
    expect(result.closeLease!.stamp).toEqual(request.approvedStamp)
    expect(f.options.flushAcceptedRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ source: request.expectedSource, stamp: request.approvedStamp }),
      request.ticket,
    )
    expect(f.options.save).not.toHaveBeenCalled()
  })

  it.each(['stamp', 'payload'] as const)(
    'refuses mismatched native acceptance %s and revokes permission',
    async (mismatch) => {
      const f = fixture(false)
      vi.mocked(f.options.flushAcceptedRecovery).mockImplementation(async (expected) => ({
        ...expected,
        ...(mismatch === 'stamp'
          ? { stamp: { ...expected.stamp, revision: 'wrong-native-correlation' } }
          : { payloadSha256: 'f'.repeat(64) }),
      }))
      const result = await f.controller.prepare(f.request('save'))
      expect(result.closeLease).toBeUndefined()
      expect(result.error).toContain('native checkpoint')
      expect(f.cancel).toHaveBeenCalled()
      expect(f.barrier.locked).toBe(false)
    },
  )

  it('rejects a current-state stamp that does not equal the acquired barrier stamp', async () => {
    const f = fixture(false)
    const current = f.options.current
    f.options.current = () => ({
      ...current()!,
      stamp: { source: f.barrier.snapshot().source, revision: 'not-the-barrier-revision' },
    })
    const result = await f.controller.prepare(f.request('save'))
    expect(result.closeLease).toBeUndefined()
    expect(f.options.flushAcceptedRecovery).not.toHaveBeenCalled()
    expect(f.barrier.locked).toBe(false)
  })

  it('does not refresh a changed Discard payload hash when an untracked metadata write leaves its stamp unchanged', async () => {
    const f = fixture()
    vi.mocked(f.options.settleWork).mockImplementation(async () => {
      f.untrackedMetadata('landscape')
    })
    const result = await f.controller.prepare(f.request('discard'))
    expect(result.closeLease).toBeUndefined()
    expect(result.error).toContain('approved discard revision changed')
  })

  it('refuses ambiguous busy state instead of ignoring other accepted work during publication', async () => {
    const f = fixture()
    vi.mocked(f.options.save).mockImplementation(async (_request, fence) => {
      f.setBusy(true)
      expect(fence.canAdopt()).toBe(false)
      return { published: true, adopted: false }
    })
    const result = await f.controller.prepare(f.request('save'))
    expect(result.closeLease).toBeUndefined()
  })

  it('keeps the barrier held after unknown ACK failure until main cancellation is acknowledged', async () => {
    const f = fixture(false)
    const entered = deferred<void>()
    const acknowledgement = deferred<void>()
    f.cancel.mockImplementation(() => acknowledgement.promise)
    vi.mocked(f.options.flushAcceptedRecovery).mockImplementation(async () => {
      entered.resolve()
      throw new Error('checkpoint acknowledgment is unknown')
    })
    const result = f.controller.prepare(f.request('save'))
    await entered.promise
    await Promise.resolve()
    expect(f.barrier.locked).toBe(true)
    acknowledgement.resolve()
    expect((await result).closeLease).toBeUndefined()
    expect(f.barrier.locked).toBe(false)
  })

  it('defers a programmatic authored commit until main invalidates an issued close lease', async () => {
    const f = fixture(false)
    const request = f.request('save')
    const prepared = await f.controller.prepare(request)
    expect(prepared.closeLease).toBeDefined()
    const acknowledgement = deferred<void>()
    let permission = true
    f.cancel.mockImplementation(async () => {
      await acknowledgement.promise
      permission = false
    })
    f.cell('accepted after ready')
    expect(permission).toBe(true)
    expect(f.payload().edits).toEqual([])
    expect(f.barrier.locked).toBe(true)
    acknowledgement.resolve()
    await acknowledgement.promise
    for (let index = 0; index < 8; index++) await Promise.resolve()
    expect(permission).toBe(false)
    expect(f.payload().edits[0]!.value).toBe('accepted after ready')
    expect(f.barrier.locked).toBe(false)
    expect(f.report).not.toHaveBeenCalled()
  })

  it('invalidates an explicit new source synchronously before awaiting main revocation', async () => {
    const f = fixture(false)
    await f.controller.prepare(f.request('save'))
    const acknowledgement = deferred<void>()
    f.cancel.mockImplementation(() => acknowledgement.promise)
    const opening = f.controller.invalidateSourceBeforeOpen()
    expect(f.controller.state()).toBeNull()
    expect(f.barrier.locked).toBe(true)
    acknowledgement.resolve()
    await opening
    expect(f.barrier.locked).toBe(false)
  })

  it('keeps a cancelled writer reserved until its actual save finishes', async () => {
    const f = fixture()
    const entered = deferred<void>()
    const finishing = deferred<{ published: boolean; adopted: boolean }>()
    vi.mocked(f.options.save).mockImplementation(async () => {
      entered.resolve()
      return finishing.promise
    })
    const request = f.request('save')
    const first = f.controller.prepare(request)
    await entered.promise
    f.controller.release(request.ticket)
    const second = await f.controller.prepare(f.request('save'))
    expect(second.closeLease).toBeUndefined()
    expect(second.error).toContain('Another close request')
    expect(f.options.save).toHaveBeenCalledTimes(1)
    finishing.resolve({ published: false, adopted: false })
    expect((await first).closeLease).toBeUndefined()
  })

  it('deduplicates identical preparation and ignores obsolete release tokens', async () => {
    const f = fixture(false)
    const first = f.request('save')
    const a = f.controller.prepare(first)
    expect(f.controller.prepare(structuredClone(first))).toBe(a)
    await a
    f.controller.release(first.ticket)
    const second = f.request('save')
    await f.controller.prepare(second)
    f.controller.release(first.ticket)
    expect(f.barrier.ticket).toEqual(second.ticket)
    expect(f.barrier.locked).toBe(true)
  })

  it('fails closed while broad authored routing or native attestation remains incomplete', async () => {
    const f = fixture(false)
    f.setCoverage(false)
    expect(f.controller.capturePublicationFence()).toBeNull()
    const result = await f.controller.prepare(f.request('save'))
    expect(result.closeLease).toBeUndefined()
    expect(result.error).toContain('coverage')
    expect(f.options.flushAcceptedRecovery).not.toHaveBeenCalled()
  })
})
