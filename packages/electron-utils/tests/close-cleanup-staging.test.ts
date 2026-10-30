import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloseCleanupQueue,
  type CloseCleanupStatus,
  type CloseCleanupTask,
} from '../src/close-cleanup'
import { copyCloseCustodyReceipt } from '../src/close-custody-providers'
const token = '12345678-1234-4234-8234-123456789abc'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const persist = vi.fn<(status: CloseCleanupStatus) => void>(),
    prepare = vi.fn(async () => false),
    purge = vi.fn(async () => {})
  const queue = new CloseCleanupQueue({
    persist,
    prepare,
    purge,
    warning: () => {},
    timeoutMs: 100,
  })
  const task: CloseCleanupTask = {
    id: 'main-stage',
    module: 'sheets',
    ownerKey: '7',
    source: 'native',
    generation: 3,
    token,
    documentPath: null,
    custody: { provider: 'native' },
    run: vi.fn(async () => {}),
  }
  return { queue, task, persist, prepare, purge }
}
function restoredFixture() {
  const status: CloseCleanupStatus = {
    id: 'custody',
    module: 'pdf',
    ownerKey: '7',
    source: 'A',
    generation: 1,
    token,
    documentPath: null,
    custody: true,
    capturedEntry: { module: 'pdf', documentPath: null, sha256: 'a'.repeat(64) },
    phase: 'canceled',
    updatedAt: new Date().toISOString(),
  }
  const purge = vi.fn(async () => {})
  // A recovered record uses the same reservation implementation as a new close.
  return {
    status,
    purge,
    queue: new CloseCleanupQueue({
      persist: () => {},
      prepare: async () => false,
      purge,
      warning: () => {},
      timeoutMs: 100,
      recovered: [status],
    }),
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('synchronous custody admission and actual provider settlement', () => {
  it('returns ownership immediately and indexes lineage before drain/preparation awaits', async () => {
    const f = fixture(),
      gate = deferred()
    f.task.ready = gate.promise
    const admission = f.queue.begin(f.task)
    expect(admission.id).toBe(f.task.id)
    expect(f.queue.query({ module: 'sheets', ids: [f.task.id] })).toHaveLength(1)
    expect(f.prepare).not.toHaveBeenCalled()
    gate.resolve()
    const handle = await admission.ready
    await admission.actualSettled
    handle.cancel()
  })
  it('cancel refuses ready promptly but retains actual drain/provider work until real settlement', async () => {
    const f = fixture(),
      gate = deferred(),
      entered = deferred()
    f.prepare.mockImplementation(async () => {
      entered.resolve()
      await gate.promise
      return false
    })
    const admission = f.queue.begin(f.task),
      refused = expect(admission.ready).rejects.toThrow()
    await entered.promise
    let settled = false
    void admission.actualSettled.then(() => {
      settled = true
    })
    admission.cancel('outer close veto')
    await refused
    expect(settled).toBe(false)
    expect(f.queue.hasPending()).toBe(true)
    expect(f.task.run).not.toHaveBeenCalled()
    gate.resolve()
    await admission.actualSettled
    expect(settled).toBe(true)
    expect(f.queue.hasPending()).toBe(false)
  })
  it('ready timeout cannot masquerade as actual provider finalization', async () => {
    const f = fixture(),
      work = deferred(),
      finalizer = deferred(),
      entered = deferred()
    f.prepare.mockImplementation(async () => {
      entered.resolve()
      try {
        await work.promise
        return false
      } finally {
        await finalizer.promise
      }
    })
    const admission = f.queue.begin(f.task),
      refused = expect(admission.ready).rejects.toThrow('timed out')
    await entered.promise
    let settled = false
    void admission.actualSettled.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(100)
    await refused
    expect(settled).toBe(false)
    work.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    finalizer.resolve()
    await admission.actualSettled
    expect(settled).toBe(true)
    expect(f.task.run).not.toHaveBeenCalled()
  })
  it('snapshots authority wrappers and callbacks before caller task reuse', async () => {
    const gate = deferred(),
      oldRun = vi.fn(async () => {}),
      newRun = vi.fn(async () => {}),
      observed: Array<{ token: string; module: string; provider?: string }> = []
    const queue = new CloseCleanupQueue({
        persist: () => {},
        prepare: async (task) => {
          observed.push({ token: task.token, module: task.module, provider: task.custody.provider })
          return false
        },
        purge: async () => {},
        warning: () => {},
        timeoutMs: 100,
      }),
      f = fixture()
    const input = {
      ...f.task,
      ready: gate.promise,
      run: oldRun,
      custody: { provider: 'native-original' },
    }
    const admission = queue.begin(input)
    input.token = 'changed'
    input.module = 'pdf'
    input.custody.provider = 'foreign'
    input.run = newRun
    gate.resolve()
    const handle = await admission.ready
    expect(observed).toEqual([{ token, module: 'sheets', provider: 'native-original' }])
    expect(handle.status()).toMatchObject({ token, module: 'sheets' })
    expect(handle.commitRemoval(() => true)).toBe(true)
    await handle.outcome
    expect(oldRun).toHaveBeenCalledTimes(1)
    expect(newRun).not.toHaveBeenCalled()
  })
  it('deep-clones accepted provider proof before later provider object mutation', async () => {
    const receipt = { snapshot: { revision: 7 } },
      persisted: CloseCleanupStatus[] = [],
      f = fixture()
    const queue = new CloseCleanupQueue({
      persist: (status) => {
        persisted.push(structuredClone(status))
      },
      prepare: async () => ({
        capturedEntry: { module: 'sheets', documentPath: null, sha256: 'a'.repeat(64) },
        provider: 'native',
        receipt,
      }),
      purge: async () => {},
      warning: () => {},
    })
    const handle = await queue.stage(f.task)
    handle.cancel()
    receipt.snapshot.revision = 99
    expect(handle.status().custodyReceipt).toEqual({ snapshot: { revision: 7 } })
    expect(handle.status().custodyReceipt).toEqual(persisted.at(-1)!.custodyReceipt)
  })
  it('includes real asynchronous admission maintenance in actualSettled', async () => {
    const gate = deferred(),
      persist = vi.fn<(status: CloseCleanupStatus) => void>()
    persist.mockImplementationOnce(() => {
      throw new Error('full')
    })
    const queue = new CloseCleanupQueue({
        persist,
        prepare: async () => false,
        purge: async () => {},
        warning: () => {},
        timeoutMs: 100,
        maintenanceAdmission: () => gate.promise,
      }),
      f = fixture()
    const admission = queue.begin(f.task),
      refused = expect(admission.ready).rejects.toThrow()
    let settled = false
    void admission.actualSettled.then(() => {
      settled = true
    })
    admission.cancel()
    await refused
    expect(settled).toBe(false)
    gate.resolve()
    await admission.actualSettled
    expect(settled).toBe(true)
  })
})
describe('separate main-owned publication and editor handoff budgets', () => {
  it('allows cold editor parse beyond the I/O budget after publication succeeds', async () => {
    const f = restoredFixture(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore', {
        ioTimeoutMs: 100,
        handoffTimeoutMs: 120_000,
      })
    await r.run(async () => {
      r.beforePublication()
      r.created()
    })
    await vi.advanceTimersByTimeAsync(5_000)
    const activate = vi.fn(() => true)
    expect(r.commitHandoff(activate)).toBe(true)
    expect(activate).toHaveBeenCalledTimes(1)
  })
  it('expires the final handoff independently and refuses a late parsed-editor activation', async () => {
    const f = restoredFixture(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore', {
        ioTimeoutMs: 100,
        handoffTimeoutMs: 1_000,
      })
    await r.run(async () => {
      r.beforePublication()
      r.created()
    })
    await vi.advanceTimersByTimeAsync(1_000)
    const activate = vi.fn(() => true)
    expect(r.commitHandoff(activate)).toBe(false)
    expect(activate).not.toHaveBeenCalled()
    await expect(
      f.queue.retire({ module: 'pdf', ids: [f.status.id] }, 'redaction'),
    ).rejects.toThrow('needs review')
  })
  it('rejects an outer I/O result on deadline while retaining the actual writer reservation', async () => {
    const f = restoredFixture(),
      gate = deferred(),
      entered = deferred(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore', {
        ioTimeoutMs: 100,
        handoffTimeoutMs: 120_000,
      })
    const writing = r.run(async () => {
        r.beforePublication()
        entered.resolve()
        await gate.promise
        r.created()
      }),
      refused = expect(writing).rejects.toThrow('I/O interval expired')
    await entered.promise
    await vi.advanceTimersByTimeAsync(100)
    await refused
    expect(f.queue.hasPending()).toBe(true)
    let retired = false
    const retiring = f.queue
        .retire({ module: 'pdf', ids: [f.status.id] }, 'redaction')
        .finally(() => {
          retired = true
        }),
      incomplete = expect(retiring).rejects.toThrow('needs review')
    await Promise.resolve()
    expect(retired).toBe(false)
    gate.resolve()
    await incomplete
    expect(f.purge).not.toHaveBeenCalled()
  })
  it.each([0, -1, 120_001, Number.NaN])('refuses invalid main handoff budget %s', (budget) => {
    const f = restoredFixture()
    expect(() =>
      f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore', { handoffTimeoutMs: budget }),
    ).toThrow('main-owned restoration budget')
  })
})

describe('bounded canonical provider proof', () => {
  it('rejects receipt values which could serialize differently from accepted proof', () => {
    expect(() => copyCloseCustodyReceipt({ revision: Number.NaN })).toThrow('non-finite')
    expect(() => copyCloseCustodyReceipt({ revision: undefined })).toThrow('plain JSON')
    expect(() => copyCloseCustodyReceipt({ time: new Date() })).toThrow('plain JSON')
    expect(() =>
      copyCloseCustodyReceipt({
        get revision() {
          throw new Error('must not evaluate getter')
        },
      }),
    ).toThrow('accessors')
    expect(() => copyCloseCustodyReceipt({ parts: new Array(1_000_000) })).toThrow(
      'bounded plain JSON arrays',
    )
    expect(() => copyCloseCustodyReceipt({ parts: new Array(2) })).toThrow('dense data values')
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => copyCloseCustodyReceipt(cyclic)).toThrow('cycles')
  })
  it('keeps __proto__ as an inert JSON data key without mutating the proof prototype', () => {
    const value = copyCloseCustodyReceipt(
      JSON.parse('{"__proto__":{"trusted":false},"revision":7}'),
    )
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.isFrozen(value)).toBe(true)
    expect(value.revision).toBe(7)
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true)
  })
})
