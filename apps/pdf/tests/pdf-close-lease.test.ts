// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseCleanupQueue } from '@vantage/electron-utils/close-cleanup'
import { PdfCloseCoordinator } from '../src/main/pdf-close'
import {
  encodePdfWorkspaceState,
  type PdfCloseRequest,
  type PdfCloseRelease,
} from '../src/shared/pdf-workspace'
import { completeWorkspace, emptyWorkspace } from './fixtures/pdf-workspace'

const token = 'd1157884-8ed7-4f8f-92cb-44467db408e0'
const stamp = { source: 'renderer-A', revision: '7' }
function fixture() {
  let request!: PdfCloseRequest,
    alive = true,
    producer = true,
    durable = true
  let source = 'main-session-A',
    resumes = 0
  const releases: PdfCloseRelease[] = [],
    order: string[] = []
  const queue = new CloseCleanupQueue({
    persist: (status) => {
      order.push(status.phase)
    },
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
        custody: { recoveryRoot: '/test/recovery', draftId: token },
        run: async () => {
          durable = false
        },
      })
      return {
        ready,
        actualSettled: ready.then(
          () => {},
          () => {},
        ),
        cancel: (reason?: string) => {
          void ready.then(
            (handle) => handle.cancel(reason),
            () => {},
          )
        },
      }
    },
    resume: (_owner, floor) => {
      if (floor.token !== token) return false
      producer = true
      resumes++
      return true
    },
    prepare: (_owner, value) => {
      request = value
    },
    release: (_owner, value) => releases.push(value),
    query: () => {},
  })
  const prepare = async (
    intent: 'discard' | 'clean' | 'save' = 'discard',
    state = emptyWorkspace(),
  ) => {
    const pending = coordinator.prepare(1, intent)
    expect(coordinator.claim(1, request.ticket)).toBe(true)
    await coordinator.prepared(1, {
      ticket: request.ticket,
      ok: true,
      stamp,
      draftFloor: { token, readId: 'read-A', throughSequence: 20 },
      state: encodePdfWorkspaceState(state),
    })
    return pending
  }
  return {
    coordinator,
    queue,
    prepare,
    releases,
    order,
    request: () => request,
    durable: () => durable,
    producer: () => producer,
    resumes: () => resumes,
    close: () => {
      alive = false
    },
    replace: () => {
      source = 'main-session-B'
    },
  }
}
afterEach(() => {
  vi.useRealTimers()
})
describe('PDF actual-removal close lease', () => {
  it('keeps the complete journal through preparation and a canceled outer close', async () => {
    const f = fixture(),
      receipt = await f.prepare()
    expect(f.durable()).toBe(true)
    expect(f.producer()).toBe(false)
    f.coordinator.cancel(1, receipt.ticket)
    expect(f.durable()).toBe(true)
    expect(f.producer()).toBe(true)
    expect(f.resumes()).toBe(1)
    expect(f.releases.at(-1)?.resumeRecovery).toBe(true)
  })
  it('registers cleanup before actual synchronous removal and reports it after owner destruction', async () => {
    const f = fixture(),
      receipt = await f.prepare()
    expect(receipt.cleanupId).toBeTruthy()
    expect(
      f.coordinator.complete(1, receipt, () => {
        expect(f.queue.hasPending()).toBe(true)
        expect(f.durable()).toBe(true)
        f.close()
        f.coordinator.destroy(1)
        return true
      }),
    ).toBe(true)
    expect((await f.queue.outcome(receipt.cleanupId!))?.phase).toBe('complete')
    expect(f.durable()).toBe(false)
    expect(f.resumes()).toBe(0)
    expect(f.releases.at(-1)?.closed).toBe(true)
  })
  it('retains recovery and restores its producer if actual host removal refuses', async () => {
    const f = fixture(),
      receipt = await f.prepare()
    expect(f.coordinator.complete(1, receipt, () => false)).toBe(false)
    expect(f.durable()).toBe(true)
    expect(f.producer()).toBe(true)
    expect((await f.queue.outcome(receipt.cleanupId!))?.phase).toBe('canceled')
  })
  it('refuses stale, duplicate or expired completion even with a clean dirty flag', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      receipt = await f.prepare('clean')
    await vi.advanceTimersByTimeAsync(5001)
    const remove = vi.fn(() => true)
    expect(f.coordinator.complete(1, receipt, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(f.durable()).toBe(true)
    expect(f.producer()).toBe(true)
  })
  it('independently rejects a supposedly clean complete state with child comments', async () => {
    const f = fixture(),
      pending = f.coordinator.prepare(1, 'save')
    const rejection = expect(pending).rejects.toThrow(/unrepresented/)
    expect(f.coordinator.claim(1, f.request().ticket)).toBe(true)
    await f.coordinator.prepared(1, {
      ticket: f.request().ticket,
      ok: true,
      stamp,
      state: encodePdfWorkspaceState(completeWorkspace()),
    })
    await rejection
    expect(f.durable()).toBe(true)
    expect(f.order).not.toContain('running')
  })
  it('does not turn a changed main source into actual-removal permission', async () => {
    const f = fixture(),
      receipt = await f.prepare()
    f.replace()
    const remove = vi.fn(() => true)
    expect(f.coordinator.complete(1, receipt, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(f.durable()).toBe(true)
  })
  it('retains a failed custody writer reservation until actual I/O settles, separately from caller failure', async () => {
    let request!: PdfCloseRequest, finish!: () => void
    const actual = new Promise<void>((resolve) => {
      finish = resolve
    })
    const coordinator = new PdfCloseCoordinator({
      alive: () => true,
      source: () => 'main-A',
      canReady: () => true,
      unpublished: () => false,
      draftToken: () => token,
      prepare: (_owner, value) => {
        request = value
      },
      release: () => {},
      query: () => {},
      resume: () => true,
      stage: () => ({
        ready: Promise.reject(new Error('reserved custody timeout')),
        actualSettled: actual,
        cancel: () => {},
      }),
    })
    const waiting = coordinator.prepare(1, 'discard'),
      rejected = expect(waiting).rejects.toThrow(/custody timeout/)
    expect(coordinator.claim(1, request.ticket)).toBe(true)
    await coordinator.prepared(1, {
      ticket: request.ticket,
      ok: true,
      stamp,
      draftFloor: { token, readId: 'read-A', throughSequence: 10 },
    })
    await rejected
    expect(coordinator.hasWriter(1)).toBe(true)
    await expect(coordinator.prepare(1, 'discard')).rejects.toThrow(/still finishing/)
    finish()
    await actual
    await Promise.resolve()
    expect(coordinator.hasWriter(1)).toBe(false)
    coordinator.destroy(1)
  })
})
