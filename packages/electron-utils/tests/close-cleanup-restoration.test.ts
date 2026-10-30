import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloseCleanupQueue,
  type CloseCleanupStatus,
  type CloseCleanupTask,
} from '../src/close-cleanup'
const sha = 'a'.repeat(64),
  token = '12345678-1234-4234-8234-123456789abc'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const status: CloseCleanupStatus = {
    id: 'main-1',
    module: 'pdf',
    ownerKey: '7',
    source: 'A',
    generation: 4,
    token,
    documentPath: '/active.pdf',
    capturedEntry: { module: 'pdf', documentPath: '/before-save-as.pdf', sha256: sha },
    custody: true,
    phase: 'canceled',
    updatedAt: new Date().toISOString(),
  }
  const persist = vi.fn<(value: CloseCleanupStatus) => void>(),
    purge = vi.fn(async () => {}),
    warning = vi.fn()
  const queue = new CloseCleanupQueue({
    persist,
    prepare: async () => false,
    purge,
    warning,
    recovered: [status],
    timeoutMs: 100,
  })
  return { queue, status, persist, purge, warning }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('source-bound restoration reservations and exact selected records', () => {
  it('reserves before the first read await and blocks purge until the actual writer verdict', async () => {
    const f = fixture(),
      gate = deferred(),
      started = deferred(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore-1')
    const writing = r.run(async () => {
      r.beforePublication()
      started.resolve()
      await gate.promise
      r.created()
      return 'published'
    })
    const rejected = expect(writing).rejects.toThrow('retired')
    await started.promise
    let terminal = false
    const retiring = f.queue
      .retire({ module: 'pdf', ids: [f.status.id] }, 'redaction')
      .finally(() => {
        terminal = true
      })
    const refused = expect(retiring).rejects.toThrow('needs review')
    await Promise.resolve()
    expect(terminal).toBe(false)
    expect(f.purge).not.toHaveBeenCalled()
    gate.resolve()
    await rejected
    await refused
    expect(f.queue.status(f.status.id)?.restoration).toMatchObject({
      phase: 'uncertain',
      publicationAttempted: true,
      created: true,
    })
    expect(f.purge).not.toHaveBeenCalled()
    expect(f.warning).toHaveBeenCalled()
  })
  it('retains an attempted output even if the publisher creates a file and throws before created callback', async () => {
    const f = fixture(),
      r = f.queue.reserveRestore(f.status.id, '/partial.pdf', 'restore-2')
    await expect(
      r.run(async () => {
        r.beforePublication()
        throw new Error('publisher reported late EIO')
      }),
    ).rejects.toThrow('late EIO')
    expect(f.queue.status(f.status.id)?.restoration).toMatchObject({
      phase: 'uncertain',
      publicationAttempted: true,
      created: false,
    })
    await expect(
      f.queue.retire({ module: 'pdf', ids: [f.status.id] }, 'redaction'),
    ).rejects.toThrow('needs review')
    expect(f.purge).not.toHaveBeenCalled()
  })
  it('does not invent a published artifact when read/decryption fails before publication', async () => {
    const f = fixture(),
      r = f.queue.reserveRestore(f.status.id, '/not-created.pdf', 'restore-3')
    await expect(
      r.run(async () => {
        throw new Error('cannot decrypt')
      }),
    ).rejects.toThrow('cannot decrypt')
    expect(f.queue.status(f.status.id)?.restoration).toMatchObject({
      phase: 'canceled',
      created: false,
    })
    await f.queue.retire({ module: 'pdf', ids: [f.status.id] }, 'redaction')
    expect(f.purge).toHaveBeenCalledTimes(1)
  })
  it('holds authority between publication and the actual synchronous editor handoff', async () => {
    const f = fixture(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore-4')
    await r.run(async () => {
      r.beforePublication()
      r.created()
    })
    expect(f.queue.hasPending()).toBe(true)
    const retire = f.queue.retire({ module: 'pdf', ids: [f.status.id] }, 'redaction'),
      refused = expect(retire).rejects.toThrow('needs review')
    const handoff = vi.fn(() => true)
    expect(r.commitHandoff(handoff)).toBe(false)
    expect(handoff).not.toHaveBeenCalled()
    await refused
  })
  it.each(['false', 'throw', 'thenable'] as const)(
    'does not manufacture a handoff for %s owner completion',
    async (kind) => {
      const f = fixture(),
        r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore-5')
      await r.run(async () => {
        r.beforePublication()
        r.created()
      })
      if (kind === 'false') expect(r.commitHandoff(() => false)).toBe(false)
      else if (kind === 'throw')
        expect(() =>
          r.commitHandoff(() => {
            throw new Error('owner replaced')
          }),
        ).toThrow('owner replaced')
      else
        expect(() =>
          r.commitHandoff((() => Promise.resolve(true)) as unknown as () => boolean),
        ).toThrow('synchronous Boolean')
      expect(f.queue.status(f.status.id)?.restoration?.phase).toBe('uncertain')
      await expect(
        f.queue.retire({ module: 'pdf', ids: [f.status.id] }, 'redaction'),
      ).rejects.toThrow('needs review')
    },
  )
  it('ends automatic ownership only after true synchronous handoff and never deletes the separate file', async () => {
    const f = fixture(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore-6'),
      handoff = vi.fn(() => true)
    await r.run(async () => {
      r.beforePublication()
      r.created()
    })
    expect(r.commitHandoff(handoff)).toBe(true)
    expect(f.queue.hasPending()).toBe(false)
    expect(r.commitHandoff(handoff)).toBe(false)
    expect(handoff).toHaveBeenCalledTimes(1)
    await f.queue.retire({ module: 'pdf', ids: [f.status.id] }, 'redaction')
    expect(f.purge).toHaveBeenCalledTimes(1)
  })
  it('a successful owner handoff remains true when its final durable status write fails', async () => {
    const f = fixture(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore-7')
    await r.run(async () => {
      r.beforePublication()
      r.created()
    })
    f.persist.mockImplementation((value) => {
      if (value.restoration?.phase === 'handed-off') throw new Error('disk full')
    })
    expect(r.commitHandoff(() => true)).toBe(true)
    expect(f.queue.hasPending()).toBe(false)
    expect(f.warning).toHaveBeenCalled()
    expect(f.queue.status(f.status.id)?.restoration?.phase).toBe('handed-off')
  })
  it('rejects repeat writers and expires a never-started reservation without inventing an output', async () => {
    const f = fixture(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore-8')
    await vi.advanceTimersByTimeAsync(100)
    await expect(r.run(async () => {})).rejects.toThrow('single-use')
    expect(f.queue.hasPending()).toBe(false)
    expect(f.queue.status(f.status.id)?.restoration?.phase).toBe('canceled')
    await f.queue.retire({ module: 'pdf', ids: [f.status.id] }, 'redaction')
  })
  it('keeps a timed-out actual publisher reserved until its terminal verdict', async () => {
    const f = fixture(),
      gate = deferred(),
      started = deferred(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore-9')
    const work = r.run(async () => {
        r.beforePublication()
        started.resolve()
        await gate.promise
        r.created()
      }),
      refused = expect(work).rejects.toThrow('I/O interval expired')
    await started.promise
    await vi.advanceTimersByTimeAsync(100)
    let done = false
    const retiring = f.queue
        .retire({ module: 'pdf', ids: [f.status.id] }, 'privacy')
        .finally(() => {
          done = true
        }),
      incomplete = expect(retiring).rejects.toThrow('needs review')
    await Promise.resolve()
    expect(done).toBe(false)
    gate.resolve()
    await refused
    await incomplete
  })
  it('requires explicit exact artifact review before a selected uncertain record can be purged', async () => {
    const f = fixture(),
      r = f.queue.reserveRestore(f.status.id, '/new.pdf', 'restore-10')
    await expect(
      r.run(async () => {
        r.beforePublication()
        throw new Error('late failure')
      }),
    ).rejects.toThrow()
    expect(() => f.queue.acknowledgeRestoreArtifact(f.status.id, 'different')).toThrow('reviewable')
    f.queue.acknowledgeRestoreArtifact(f.status.id, 'restore-10')
    await f.queue.retire({ module: 'pdf', ids: [f.status.id] }, 'user selected this copy')
    expect(f.purge).toHaveBeenCalledTimes(1)
  })
  it('selected IDs never broaden deletion to another record for the same source and path', async () => {
    const f = fixture()
    f.queue.recordFailure({ ...f.status, id: 'main-2' }, 'Another retained owned failure')
    const selected = f.queue.query({ module: 'pdf', ids: ['main-2'] })
    expect(selected.map((value) => value.id)).toEqual(['main-2'])
    await f.queue.retire({ module: 'pdf', ids: ['main-2'] }, 'selected')
    expect(f.queue.status('main-2')?.phase).toBe('purged')
    expect(f.queue.status(f.status.id)?.phase).toBe('canceled')
  })
  it('never exposes mutable nested receipt or captured-lineage objects', () => {
    const f = fixture(),
      visible = f.queue.status(f.status.id)!
    visible.capturedEntry!.sha256 = 'forged'
    expect(f.queue.status(f.status.id)?.capturedEntry?.sha256).toBe(sha)
  })
  it('uses a bounded provider preparation interval while retaining actual unsettled work after timeout', async () => {
    const gate = deferred(),
      started = deferred(),
      run = vi.fn(async () => {})
    const queue = new CloseCleanupQueue({
      persist: () => {},
      prepare: async () => {
        started.resolve()
        await gate.promise
        return false
      },
      purge: async () => {},
      warning: () => {},
      timeoutMs: 5,
      preparationTimeoutMs: () => 100,
    })
    const task: CloseCleanupTask = {
      id: 'long-native-copy',
      module: 'sheets',
      ownerKey: '7',
      source: 'native',
      generation: 1,
      token,
      documentPath: null,
      custody: { provider: 'native-test' },
      run,
    }
    const staging = queue.stage(task),
      refused = expect(staging).rejects.toThrow('timed out')
    await started.promise
    await vi.advanceTimersByTimeAsync(5)
    expect(queue.status(task.id)?.phase).toBe('preparing')
    await vi.advanceTimersByTimeAsync(95)
    await refused
    expect(queue.hasPending()).toBe(true)
    expect(run).not.toHaveBeenCalled()
    gate.resolve()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(queue.hasPending()).toBe(false)
  })
  it('keeps a newly indexed stage visible while full-record maintenance awaits', async () => {
    const gate = deferred(),
      persist = vi.fn<(status: CloseCleanupStatus) => void>(),
      prepare = vi.fn(async () => false)
    persist.mockImplementationOnce(() => {
      throw new Error('full')
    })
    const queue = new CloseCleanupQueue({
      persist,
      prepare,
      purge: async () => {},
      warning: () => {},
      maintenanceAdmission: () => gate.promise,
      timeoutMs: 100,
    })
    const task: CloseCleanupTask = {
      id: 'new',
      module: 'docs',
      ownerKey: '7',
      source: 'new-source',
      generation: 1,
      token,
      documentPath: null,
      custody: {},
      run: async () => {},
    }
    const staging = queue.stage(task),
      refused = expect(staging).rejects.toThrow()
    expect(queue.query({ module: 'docs', ids: ['new'] })).toHaveLength(1)
    const retiring = queue.retire({ module: 'docs', ids: ['new'] }, 'source retired')
    gate.resolve()
    await refused
    await retiring
    expect(prepare).not.toHaveBeenCalled()
  })
})
