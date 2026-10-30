import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AsyncResource } from 'node:async_hooks'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAttestedFilePublication, withFilePublication, reserveFileMutation } from '../../../packages/electron-utils/src/file-publication-exclusion'
import { WorkbookPublicationLifecycle, type WorkbookPublicationDecision } from '../src/main/workbook-publication-lifecycle'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }
let root: string, target: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'vantage-publication-lifetime-test-')); target = join(root, 'saved.xlsx') })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('main-owned workbook publication lifetime (private successor sources)', () => {
  it('returns a saved offer while retaining output ownership through its exact adoption cleanup', async () => {
    const lifecycle = new WorkbookPublicationLifecycle(), cleanup = deferred<void>()
    let decision!: WorkbookPublicationDecision
    const result = withAttestedFilePublication({ targetPath: target }, () => ({
      result: lifecycle.run(async () => { await writeFile(target, 'saved'); decision = lifecycle.retainOffer(); return { ownedOffer: 'main-owned-id' } }),
      actualSettled: lifecycle.actualSettled,
    }))
    expect(await result).toEqual({ ownedOffer: 'main-owned-id' })
    const move = reserveFileMutation([{ path: target, kind: 'file' }])
    expect(move.isReady()).toBe(false); expect(lifecycle.isSettled()).toBe(false)
    decision.finishAfter(cleanup.promise); await flush()
    expect(move.isReady()).toBe(false)
    cleanup.resolve(); await lifecycle.actualSettled; await move.ready
    expect(move.isReady()).toBe(true); move.cancelPending()
  })

  it('a caller timeout cannot finish a still-running main body or authorize a file move', async () => {
    const lifecycle = new WorkbookPublicationLifecycle(), work = deferred<void>()
    const result = withAttestedFilePublication({ targetPath: target }, () => ({
      result: lifecycle.run(async () => { await work.promise; await writeFile(target, 'late completed output'); return true }),
      actualSettled: lifecycle.actualSettled,
    }))
    await expect(Promise.race([result, Promise.reject(new Error('caller deadline'))])).rejects.toThrow('caller deadline')
    const move = reserveFileMutation([{ path: target, kind: 'file' }])
    await flush(); expect(lifecycle.isSettled()).toBe(false); expect(move.isReady()).toBe(false)
    work.resolve(); expect(await result).toBe(true)
    await lifecycle.actualSettled; await move.ready; move.cancelPending()
    expect(await readFile(target, 'utf8')).toBe('late completed output')
  })

  it('owner loss joins teardown even after adoption has consumed the offer map entry', async () => {
    const lifecycle = new WorkbookPublicationLifecycle(), adoption = deferred<void>(), teardown = deferred<void>()
    let decision!: WorkbookPublicationDecision
    await withAttestedFilePublication({ targetPath: target }, () => ({
      result: lifecycle.run(async () => { decision = lifecycle.retainOffer(); return true }), actualSettled: lifecycle.actualSettled,
    }))
    decision.finishAfter(adoption.promise)
    // Mirrors destroyed(owner): every still-live lifecycle joins actual cleanup,
    // including an offer already removed from the sourceOffers map.
    lifecycle.hold(teardown.promise)
    const move = reserveFileMutation([{ path: target, kind: 'file' }])
    adoption.resolve(); await flush(); expect(lifecycle.isSettled()).toBe(false); expect(move.isReady()).toBe(false)
    teardown.resolve(); await lifecycle.actualSettled; await move.ready; move.cancelPending()
  })

  it('a stale second decision cannot replace the real rejection cleanup with an already-resolved promise', async () => {
    const lifecycle = new WorkbookPublicationLifecycle(), cleanup = deferred<void>()
    let decision!: WorkbookPublicationDecision
    await lifecycle.run(async () => { decision = lifecycle.retainOffer() })
    decision.finishAfter(cleanup.promise)
    decision.finishAfter(Promise.resolve())
    await flush(); expect(lifecycle.isSettled()).toBe(false)
    cleanup.resolve(); await lifecycle.actualSettled; expect(lifecycle.isSettled()).toBe(true)
  })

  it('rejection waits for all real filesystem finalizers even when cleanup reports a failure', async () => {
    const lifecycle = new WorkbookPublicationLifecycle(), native = deferred<void>(), marker = join(root, 'cleanup-finished')
    let decision!: WorkbookPublicationDecision
    await lifecycle.run(async () => { decision = lifecycle.retainOffer() })
    const failure = new Error('definitive native close failed')
    const actualCleanup = (async () => { try { await native.promise } finally { await writeFile(marker, 'finished') } })()
    decision.finishAfter(actualCleanup)
    await flush(); expect(lifecycle.isSettled()).toBe(false)
    native.reject(failure)
    await expect(actualCleanup).rejects.toBe(failure)
    await lifecycle.actualSettled
    expect(await readFile(marker, 'utf8')).toBe('finished')
  })

  it('an ALS-bound adoption finalizer continues its exact admitted target while a move drains it', async () => {
    const lifecycle = new WorkbookPublicationLifecycle()
    let decision!: WorkbookPublicationDecision, cleanup!: () => Promise<void>
    await withAttestedFilePublication({ targetPath: target }, () => ({
      result: lifecycle.run(async () => {
        decision = lifecycle.retainOffer()
        cleanup = AsyncResource.bind(async () => {
          await withFilePublication({ targetPath: target }, async () => { await writeFile(target, 'same admitted target') })
        })
      }), actualSettled: lifecycle.actualSettled,
    }))
    const move = reserveFileMutation([{ path: target, kind: 'file' }])
    expect(move.isReady()).toBe(false)
    const actualCleanup = cleanup(); decision.finishAfter(actualCleanup)
    await actualCleanup; await lifecycle.actualSettled; await move.ready
    expect(await readFile(target, 'utf8')).toBe('same admitted target'); move.cancelPending()
  })

  it('a post-publication host move starts after settlement without waiting on its own writer', async () => {
    const lifecycle = new WorkbookPublicationLifecycle(), cleanup = deferred<void>(), destination = join(root, 'renamed.xlsx')
    let decision!: WorkbookPublicationDecision
    await withAttestedFilePublication({ targetPath: target }, () => ({
      result: lifecycle.run(async () => { await writeFile(target, 'published'); decision = lifecycle.retainOffer() }),
      actualSettled: lifecycle.actualSettled,
    }))
    const hostHandoff = lifecycle.actualSettled.then(async () => {
      const move = reserveFileMutation([{ path: target, kind: 'file' }, { path: destination, kind: 'file' }])
      await move.run(async () => { await rename(target, destination) })
    })
    decision.finishAfter(cleanup.promise)
    cleanup.resolve(); await hostHandoff
    expect(await readFile(destination, 'utf8')).toBe('published')
  })

  it('a pre-dispatch refusal can settle without running a body or inventing an offer decision', async () => {
    const lifecycle = new WorkbookPublicationLifecycle()
    lifecycle.abandonBeforeStart(); await lifecycle.actualSettled
    expect(lifecycle.isSettled()).toBe(true)
    expect(() => lifecycle.run(async () => true)).toThrow('already been admitted')
    expect(() => lifecycle.retainOffer()).toThrow('before its main body returns')
  })
})
