import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseCleanupQueue, type CloseCleanupStatus } from '../src/close-cleanup'
const token = '12345678-1234-4234-8234-123456789abc'
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture() {
  const status = (id: string): CloseCleanupStatus => ({
    id,
    module: 'docs',
    ownerKey: '7',
    source: 'A',
    generation: 1,
    token,
    documentPath: '/a.docx',
    custody: true,
    capturedEntry: { module: 'docs', documentPath: '/a.docx', sha256: 'a'.repeat(64) },
    phase: 'canceled',
    updatedAt: new Date().toISOString(),
  })
  const persist = vi.fn<(value: CloseCleanupStatus) => void>(),
    purge = vi.fn(async (_status: CloseCleanupStatus) => {}),
    warning = vi.fn()
  const queue = new CloseCleanupQueue({
    persist,
    prepare: async () => false,
    purge,
    warning,
    recovered: [status('one'), status('two')],
    timeoutMs: 100,
  })
  return { queue, persist, purge, warning }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('actual selected retirement and safe retry ownership', () => {
  it('indexes the selected record synchronously before actual purge can await', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred()
    f.purge.mockImplementation(async () => {
      expect(f.queue.retirementActivity('one').busy).toBe(true)
      entered.resolve()
      await gate.promise
    })
    const admission = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'selected')
    expect(f.queue.retirementActivity('one')).toMatchObject({ busy: true, retryable: false })
    expect(f.queue.hasPending()).toBe(true)
    await entered.promise
    gate.resolve()
    await admission.ready
    await admission.actualSettled
    expect(f.queue.status('one')?.phase).toBe('purged')
    expect(f.queue.status('two')?.phase).toBe('canceled')
  })
  it('retains a failed selected purge and allows a fresh checked retry only after actual settlement', async () => {
    const f = fixture()
    f.purge.mockRejectedValueOnce(new Error('provider refused stale private manifest'))
    const first = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'selected')
    await expect(first.ready).rejects.toThrow('stale private manifest')
    await first.actualSettled
    expect(f.queue.status('one')?.phase).toBe('retained')
    expect(f.queue.retirementActivity('one')).toMatchObject({ busy: false, retryable: true })
    const second = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'explicit retry')
    await second.ready
    expect(f.purge).toHaveBeenCalledTimes(2)
    expect(f.queue.retirementActivity('one')).toMatchObject({ busy: false, retryable: false })
    expect(f.queue.status('one')?.phase).toBe('purged')
  })
  it('caller timeout does not free actual purge or let an overlapping retry claim completion', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred()
    f.purge.mockImplementation(async () => {
      entered.resolve()
      await gate.promise
    })
    const first = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'selected'),
      timedOut = expect(first.ready).rejects.toThrow('timed out')
    await entered.promise
    let actual = false
    void first.actualSettled.then(() => {
      actual = true
    })
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
    expect(actual).toBe(false)
    expect(f.queue.retirementActivity('one')).toMatchObject({ busy: true, retryable: false })
    expect(f.queue.hasPending()).toBe(true)
    const overlap = f.queue.beginRetirement({ module: 'docs', ids: ['one', 'two'] }, 'overlap')
    await expect(overlap.ready).rejects.toThrow('earlier recovery removal')
    expect(f.purge).toHaveBeenCalledTimes(1)
    expect(f.queue.status('two')?.phase).toBe('canceled')
    gate.resolve()
    await first.actualSettled
    await overlap.actualSettled
    expect(actual).toBe(true)
    expect(f.queue.status('one')?.phase).toBe('purged')
    expect(f.queue.status('two')?.phase).toBe('canceled')
  })
  it('quit drain waits for the actual purge rather than its bounded caller outcome', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred()
    f.purge.mockImplementation(async () => {
      entered.resolve()
      await gate.promise
    })
    const removal = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'selected')
    await entered.promise
    let drained = false
    const drain = f.queue.drain().then((statuses) => {
      drained = true
      return statuses
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    gate.resolve()
    await removal.ready
    const statuses = await drain
    expect(statuses).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'one', phase: 'purged' })]),
    )
    expect(f.queue.hasPending()).toBe(false)
  })
  it('bounded quit drain preserves busy actual purge and later failure remains retryable', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred()
    f.purge.mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
    })
    const removal = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'selected'),
      timedOut = expect(removal.ready).rejects.toThrow('timed out')
    await entered.promise
    const drain = f.queue.drain()
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
    await drain
    expect(f.queue.hasPending()).toBe(true)
    expect(f.queue.retirementActivity('one').busy).toBe(true)
    gate.reject(new Error('late actual storage error'))
    await removal.actualSettled
    expect(f.queue.retirementActivity('one')).toMatchObject({ busy: false, retryable: true })
    expect(f.queue.status('one')?.phase).toBe('retained')
    await f.queue.retire({ module: 'docs', ids: ['one'] }, 'explicit retry')
    expect(f.queue.status('one')?.phase).toBe('purged')
  })
  it('independent selected IDs retain independent actual ownership', async () => {
    const f = fixture(),
      first = deferred(),
      second = deferred()
    f.purge.mockImplementation(async (status) => {
      await (status.id === 'one' ? first.promise : second.promise)
    })
    const one = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'one'),
      two = f.queue.beginRetirement({ module: 'docs', ids: ['two'] }, 'two')
    first.resolve()
    await one.ready
    expect(f.queue.retirementActivity('one').busy).toBe(false)
    expect(f.queue.retirementActivity('two').busy).toBe(true)
    second.resolve()
    await two.ready
    expect(f.queue.hasPending()).toBe(false)
  })
  it('never erases custody without a durable retiring intent', async () => {
    const f = fixture()
    f.persist.mockImplementation((status) => {
      if (status.phase === 'purging') throw new Error('status disk full')
    })
    const admission = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'selected')
    await expect(admission.ready).rejects.toThrow('status disk full')
    await admission.actualSettled
    expect(f.purge).not.toHaveBeenCalled()
    expect(f.queue.status('one')?.phase).toBe('retained')
    expect(f.queue.retirementActivity('one').retryable).toBe(true)
  })
  it('a failed purged-status publication needs a checked idempotent retry', async () => {
    const f = fixture()
    let fail = true
    f.persist.mockImplementation((status) => {
      if (fail && status.phase === 'purged') throw new Error('status publication failed')
    })
    const admission = f.queue.beginRetirement({ module: 'docs', ids: ['one'] }, 'selected')
    await expect(admission.ready).rejects.toThrow('status publication failed')
    await admission.actualSettled
    expect(f.queue.status('one')?.phase).toBe('retained')
    expect(f.queue.retirementActivity('one').retryable).toBe(true)
    fail = false
    await f.queue.retire({ module: 'docs', ids: ['one'] }, 'retry known selected id')
    expect(f.queue.status('one')?.phase).toBe('purged')
  })
  it('cannot forget a selected record while its grouped actual removal still runs', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred()
    f.purge.mockImplementation(async (status) => {
      if (status.id === 'two') {
        entered.resolve()
        await gate.promise
      }
    })
    const removal = f.queue.beginRetirement({ module: 'docs', ids: ['one', 'two'] }, 'group')
    await entered.promise
    expect(f.queue.status('one')?.phase).toBe('purged')
    expect(f.queue.forgetCompleted('one')).toBe(false)
    gate.resolve()
    await removal.ready
    expect(f.queue.forgetCompleted('one')).toBe(true)
  })
})
