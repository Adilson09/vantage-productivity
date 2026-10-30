// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseCleanupQueue } from '@vantage/electron-utils/close-cleanup'
import { PdfCloseCoordinator, type PdfCloseOptions } from '../src/main/pdf-close'
import {
  encodePdfWorkspaceState,
  type PdfCloseReceipt,
  type PdfCloseRequest,
  type PdfCloseRelease,
} from '../src/shared/pdf-workspace'
import { emptyWorkspace } from './fixtures/pdf-workspace'

const token = 'd1157884-8ed7-4f8f-92cb-44467db408e0',
  stamp = { source: 'renderer-A', revision: '7' }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const coordinators: PdfCloseCoordinator[] = []
function fixture(finalizer?: Promise<void>) {
  let request!: PdfCloseRequest,
    source = 'main-A',
    alive = true,
    current = true,
    producer = true,
    durable = true,
    queryId = ''
  const releases: PdfCloseRelease[] = [],
    dispatched: PdfCloseRequest[] = []
  const queue = new CloseCleanupQueue({
    persist: () => {},
    prepare: async () => true,
    purge: async () => {},
    warning: () => {},
    timeoutMs: 5000,
  })
  const coordinator = new PdfCloseCoordinator({
    alive: () => alive,
    source: () => source,
    canReady: () => true,
    unpublished: () => false,
    draftToken: () => (producer ? token : null),
    stage: (_owner, floor, id) => {
      expect(floor.token).toBe(token)
      producer = false
      const ready = queue.stage({
        id,
        module: 'pdf',
        ownerKey: '1',
        source: 'read-A',
        generation: 1,
        token,
        documentPath: null,
        custody: { recoveryRoot: '/reserved-recovery', draftId: token },
        run: async () => {
          durable = false
        },
      })
      return {
        ready,
        actualSettled: ready.then(() => finalizer),
        cancel: (reason) => {
          void ready.then(
            (handle) => handle.cancel(reason),
            () => {},
          )
        },
      }
    },
    resume: () => {
      producer = true
      return true
    },
    prepare: (_owner, value) => {
      request = value
      dispatched.push(value)
    },
    release: (_owner, value) => releases.push(value),
    query: (_owner, id) => {
      queryId = id
    },
  })
  coordinators.push(coordinator)
  const start = (options: PdfCloseOptions = {}) => {
    const pending = coordinator.prepare(1, 'discard', undefined, options)
    void pending.catch(() => {})
    expect(coordinator.claim(1, request.ticket)).toBe(true)
    return pending
  }
  const deliver = () =>
    coordinator.prepared(1, {
      ticket: request.ticket,
      ok: true,
      stamp,
      state: encodePdfWorkspaceState(emptyWorkspace()),
      draftFloor: { token, readId: 'read-A', throughSequence: 9 },
    })
  const prepare = async (options: PdfCloseOptions = {}) => {
    const pending = start(options)
    await deliver()
    return pending
  }
  return {
    coordinator,
    queue,
    start,
    deliver,
    prepare,
    request: () => request,
    queryId: () => queryId,
    releases,
    dispatched,
    current: () => current,
    cancelGroup: () => {
      current = false
    },
    replace: () => {
      source = 'main-B'
    },
    closed: () => {
      alive = false
    },
    durable: () => durable,
    producer: () => producer,
  }
}
afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.destroy(1)
  vi.useRealTimers()
})

describe('real PDF coordinator prepare → synchronous seal protocol', () => {
  it('a later prompt longer than5s does not consume ready time; completion requires the fresh sealed receipt', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      prepared = await f.prepare({ deferSeal: true })
    expect(prepared.phase).toBe('prepared')
    await vi.advanceTimersByTimeAsync(7000)
    expect(f.coordinator.isPrepared(1, prepared)).toBe(true)
    const remove = vi.fn(() => true)
    expect(f.coordinator.complete(1, prepared, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    const ready = f.coordinator.seal(1, prepared)!
    expect(ready.phase).toBe('ready')
    expect(ready).not.toBe(prepared)
    expect(f.coordinator.isPrepared(1, prepared)).toBe(false) // must not claim/invalidate an already-ready broker
    await vi.advanceTimersByTimeAsync(4999)
    expect(f.coordinator.complete(1, ready, remove)).toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
    expect((await f.queue.outcome(ready.cleanupId!))?.phase).toBe('complete')
  })
  it('preserves the original120s preparing deadline and the original5s ready deadline', async () => {
    vi.useFakeTimers()
    const first = fixture(),
      prepared = await first.prepare({ deferSeal: true })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(first.coordinator.isPrepared(1, prepared)).toBe(false)
    expect(first.coordinator.seal(1, prepared)).toBeNull()
    expect(first.durable()).toBe(true)
    expect(first.producer()).toBe(true)
    const next = fixture(),
      held = await next.prepare({ deferSeal: true }),
      ready = next.coordinator.seal(1, held)!
    expect(next.coordinator.seal(1, held)).toBeNull() // never rearms the5s timer
    await vi.advanceTimersByTimeAsync(5001)
    const remove = vi.fn(() => true)
    expect(next.coordinator.complete(1, ready, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(next.durable()).toBe(true)
  })
  it('individual Close starts ready only after actual custody finalizers, separately from caller-ready', async () => {
    vi.useFakeTimers()
    const actual = deferred(),
      f = fixture(actual.promise),
      pending = f.start()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    const processing = f.deliver()
    await vi.advanceTimersByTimeAsync(7000)
    expect(settled).toBe(false)
    expect(f.coordinator.hasWriter(1)).toBe(true)
    actual.resolve()
    await processing
    const ready = await pending
    expect(ready.phase).toBe('ready')
    await vi.advanceTimersByTimeAsync(4999)
    expect(f.coordinator.complete(1, ready, () => true)).toBe(true)
    await f.queue.outcome(ready.cleanupId!)
  })
  it('isPrepared is local and does not recursively invoke the Root member predicate', async () => {
    const f = fixture(),
      group = vi.fn(f.current),
      prepared = await f.prepare({ deferSeal: true, isCurrent: group })
    group.mockClear()
    expect(f.coordinator.isPrepared(1, prepared)).toBe(true)
    expect(group).not.toHaveBeenCalled()
    f.cancelGroup()
    expect(f.coordinator.seal(1, prepared)).toBeNull()
    expect(f.durable()).toBe(true)
    expect(f.producer()).toBe(true)
  })
  it('rejects forged phase/stamp and source replacement without consuming another valid receipt', async () => {
    const f = fixture(),
      prepared = await f.prepare({ deferSeal: true })
    const forged: PdfCloseReceipt = { ...prepared, phase: 'ready' },
      wrongStamp: PdfCloseReceipt = { ...prepared, stamp: { ...stamp, revision: '8' } }
    expect(f.coordinator.complete(1, forged, () => true)).toBe(false)
    expect(f.coordinator.seal(1, wrongStamp)).toBeNull()
    expect(f.coordinator.isPrepared(1, prepared)).toBe(true)
    f.replace()
    expect(f.coordinator.seal(1, prepared)).toBeNull()
    expect(f.durable()).toBe(true)
  })
  it('abort retains actual custody ownership after caller rejection until its real settlement', async () => {
    const actual = deferred(),
      signal = new AbortController(),
      f = fixture(actual.promise)
    const pending = f.start({ deferSeal: true, signal: signal.signal }),
      rejected = expect(pending).rejects.toThrow(/aborted/)
    const processing = f.deliver()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    signal.abort()
    await rejected
    expect(f.coordinator.hasWriter(1)).toBe(true)
    await expect(f.coordinator.prepare(1, 'discard')).rejects.toThrow(/still finishing/)
    expect(f.durable()).toBe(true)
    actual.resolve()
    await processing
    expect(f.coordinator.hasWriter(1)).toBe(false)
  })
  it('rejects late Save claims/results once the group became obsolete, without admitting custody', async () => {
    const f = fixture(),
      pending = f.start({ deferSeal: true, isCurrent: f.current })
    const oldRequest = f.request(),
      rejected = expect(pending).rejects.toThrow(/writer claim/)
    f.cancelGroup()
    expect(f.coordinator.claim(1, oldRequest.ticket)).toBe(false)
    await rejected
    expect(f.coordinator.hasWriter(1)).toBe(true) // renderer result has not actually settled
    await f.deliver()
    expect(f.coordinator.hasWriter(1)).toBe(false)
    expect(f.producer()).toBe(true)
    expect(f.durable()).toBe(true)
  })
  it('aborts a real pending query and ignores its late response', async () => {
    const f = fixture(),
      signal = new AbortController()
    const waiting = f.coordinator.query(1, { signal: signal.signal }),
      rejected = expect(waiting).rejects.toThrow(/canceled/),
      oldId = f.queryId()
    signal.abort()
    await rejected
    f.coordinator.queried(1, oldId, { stamp, pending: false, busy: false })
    const next = f.coordinator.query(1)
    f.coordinator.queried(1, f.queryId(), { stamp, pending: false, busy: false })
    expect(await next).toEqual({ stamp, pending: false, busy: false })
  })
})
