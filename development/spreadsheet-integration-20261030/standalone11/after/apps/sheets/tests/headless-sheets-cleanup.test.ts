import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settleHeadlessSheetsCleanup } from '../src/main/headless-sheets-cleanup'
import { HeadlessSheetsOwnerWork } from '../src/main/headless-sheets-owner-work'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function flush() { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('headless spreadsheet genuine teardown boundaries', () => {
  it('gives ordinary owner cleanup its opportunity, then waits for actual native exit', async () => {
    const owner = deferred(), exit = deferred(), order: string[] = []
    const stop = vi.fn(() => { order.push('stop'); return exit.promise })
    const join = vi.fn(async () => { order.push('join') })
    let completed = false
    const cleanup = settleHeadlessSheetsCleanup({ ownerCleanup: owner.promise, joinNative: join, stopNative: stop, graceMs: 20 })
      .then(() => { completed = true })
    await flush()
    expect(order).toEqual([])
    owner.resolve(); await flush()
    expect(order).toEqual(['join', 'stop'])
    expect(completed).toBe(false)
    exit.resolve(); await cleanup
    expect(order).toEqual(['join', 'stop', 'join'])
    expect(completed).toBe(true)
  })

  it('uses grace expiry to start termination, never to settle an unresolved owner or drain', async () => {
    const owner = deferred(), exit = deferred(), native = deferred()
    const stop = vi.fn(() => exit.promise)
    let completed = false
    const cleanup = settleHeadlessSheetsCleanup({ ownerCleanup: owner.promise,
      joinNative: () => native.promise, stopNative: stop, graceMs: 20 }).then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(20)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(completed).toBe(false)
    exit.resolve(); await flush()
    expect(completed).toBe(false)
    owner.resolve(); await flush()
    expect(completed).toBe(false)
    native.resolve(); await cleanup
    expect(stop).toHaveBeenCalledTimes(2)
    expect(completed).toBe(true)
  })

  it('rethrows owner cleanup failure only after verified stop and the final native drain', async () => {
    const owner = deferred(), exit = deferred(), finalDrain = deferred()
    const failure = new Error('synthetic owner finalizer failure')
    const join = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => finalDrain.promise)
    const cleanup = settleHeadlessSheetsCleanup({ ownerCleanup: owner.promise,
      joinNative: join, stopNative: () => exit.promise, graceMs: 20 })
    let completed = false
    void cleanup.then(() => { completed = true }, () => { completed = true })
    owner.reject(failure); await flush()
    expect(completed).toBe(false)
    exit.resolve(); await flush()
    expect(completed).toBe(false)
    const rejected = expect(cleanup).rejects.toBe(failure)
    finalDrain.resolve(); await rejected
    expect(completed).toBe(true)
  })

  it('never returns an exit/profile-cleanup acknowledgment if a required owner finalizer is missing', async () => {
    const exit = deferred(), stop = vi.fn(() => exit.promise), join = vi.fn(async () => {})
    const missing = vi.fn()
    const cleanup = settleHeadlessSheetsCleanup({ ownerCleanup: undefined,
      onMissingOwner: missing, joinNative: join, stopNative: stop, graceMs: 20 })
    let completed = false
    void cleanup.then(() => { completed = true }, () => { completed = true })
    await flush()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(completed).toBe(false)
    exit.resolve(); await flush()
    expect(missing).toHaveBeenCalledTimes(1)
    expect(join).toHaveBeenCalledTimes(1)
    expect(completed).toBe(false)
  })

  it('can finalize setup-only failure after true native exit when owner registration never began', async () => {
    const exit = deferred(), stop = vi.fn(() => exit.promise), join = vi.fn(async () => {})
    const cleanup = settleHeadlessSheetsCleanup({ ownerCleanup: undefined, setupOnly: true,
      joinNative: join, stopNative: stop, graceMs: 20 })
    await flush()
    expect(stop).toHaveBeenCalledTimes(1)
    exit.resolve(); await cleanup
    expect(join).toHaveBeenCalledTimes(2)
  })

  it('waits accepted PDF JS after an export timeout/owner rejection and refuses late dispatch', async () => {
    const owner = deferred(), pdf = deferred(), tracker = new HeadlessSheetsOwnerWork()
    let registered = false
    const actualPdf = tracker.run(() => { registered = true; return pdf.promise })
    expect(registered).toBe(true)
    tracker.closeAdmission()
    const late = vi.fn(async () => {})
    await expect(tracker.run(late)).rejects.toThrow('owner is closing')
    expect(late).not.toHaveBeenCalled()
    const combined = tracker.joinOwner(owner.promise)
    let completed = false
    void combined.then(() => { completed = true }, () => { completed = true })
    const failure = new Error('renderer export timeout')
    owner.reject(failure); await flush()
    expect(completed).toBe(false)
    const rejected = expect(combined).rejects.toBe(failure)
    pdf.resolve(); await actualPdf; await rejected
    expect(completed).toBe(true)
  })

  it('joins a late-open continuation and its staging finalizer after owner teardown has finished', async () => {
    const owner = deferred(), nativeOpen = deferred(), readerExit = deferred(), staging = deferred()
    const tracker = new HeadlessSheetsOwnerWork()
    let stagingStarted = false, stagingRemoved = false
    const actualOpen = tracker.run(async () => {
      await nativeOpen.promise
      // The destroyed-owner branch must not release input staging until the
      // close/forced-stop promise confirms reader exit, even if base cleanup
      // already observed no session. These are injected lifetime barriers.
      await readerExit.promise
      stagingStarted = true
      await staging.promise
      stagingRemoved = true
    })
    const combined = tracker.joinOwner(owner.promise)
    let completed = false
    const cleanup = settleHeadlessSheetsCleanup({ ownerCleanup: combined,
      joinNative: async () => {}, stopNative: () => readerExit.promise, graceMs: 20 })
      .then(() => { completed = true })
    owner.resolve(); await flush()
    await vi.advanceTimersByTimeAsync(20)
    nativeOpen.resolve(); await flush()
    expect(stagingStarted).toBe(false)
    expect(completed).toBe(false)
    readerExit.resolve(); await flush()
    expect(stagingStarted).toBe(true)
    expect(stagingRemoved).toBe(false)
    expect(completed).toBe(false)
    staging.resolve(); await actualOpen; await cleanup
    expect(stagingRemoved).toBe(true)
    expect(completed).toBe(true)
  })
})
