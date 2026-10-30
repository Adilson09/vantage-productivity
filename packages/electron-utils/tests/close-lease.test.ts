import { describe, expect, it, vi } from 'vitest'
import { CloseLeaseBroker, type CloseLeaseTicket } from '../src/close-lease'
import {
  CloseMutationBarrier,
  installCloseInputFence,
  type CloseInputEvent,
} from '../src/renderer-close-barrier'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const ticket = (sequence = 1): CloseLeaseTicket => ({
  id: `close-${sequence}`,
  sequence,
  source: 'main-session-A',
})

function mainFixture() {
  const owner = { alive: true, source: 'main-session-A', renderer: 'renderer-A' }
  const callbacks: (() => void)[] = []
  const release = vi.fn()
  const broker = new CloseLeaseBroker<typeof owner>({
    alive: (value) => value.alive,
    source: (value) => value.source,
    validate: (value, _ticket, stamp) => value.renderer === stamp.source,
    release,
    setTimer: (callback) => {
      callbacks.push(callback)
      return callback
    },
    clearTimer: () => {},
  })
  return { owner, broker, release, callbacks, stamp: { source: 'renderer-A', revision: '7' } }
}

describe('main close authority', () => {
  it('does not grant readiness while a real writer is unsettled', () => {
    const f = mainFixture(),
      lease = f.broker.reserve(f.owner, 'first')
    expect(f.broker.ready(f.owner, lease, f.stamp)).toBe(false)
    expect(f.broker.hasWriter(f.owner)).toBe(true)
    expect(() => f.broker.reserve(f.owner, 'second')).toThrow('still finishing')
    f.broker.settle(f.owner, lease)
    expect(() => f.broker.reserve(f.owner, 'second')).not.toThrow()
  })

  it('retains a timed-out writer reservation until actual completion', () => {
    const f = mainFixture(),
      lease = f.broker.reserve(f.owner, 'first')
    f.callbacks[0]()
    expect(f.broker.claim(f.owner, lease)).toBe(false)
    expect(() => f.broker.reserve(f.owner, 'second')).toThrow()
    f.broker.settle(f.owner, lease)
    expect(f.broker.reserve(f.owner, 'second').sequence).toBeGreaterThan(lease.sequence)
  })

  it('never calls removal after ready expiry, even when a late caller still owns a receipt', () => {
    const f = mainFixture(),
      lease = f.broker.reserve(f.owner, 'first'),
      remove = vi.fn(() => true)
    f.broker.settle(f.owner, lease)
    expect(f.broker.ready(f.owner, lease, f.stamp)).toBe(true)
    f.callbacks[1]()
    expect(f.broker.complete(f.owner, lease, f.stamp, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledWith(f.owner, lease, 'ready expired')
  })

  it('removes the exact ready owner synchronously and cannot reuse that permission', () => {
    const f = mainFixture(),
      lease = f.broker.reserve(f.owner, 'first')
    f.broker.settle(f.owner, lease)
    expect(f.broker.ready(f.owner, lease, f.stamp)).toBe(true)
    const remove = vi.fn(() => {
      expect(f.release).not.toHaveBeenCalled()
      return true
    })
    expect(f.broker.complete(f.owner, lease, f.stamp, remove)).toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledWith(f.owner, lease, 'commit finished')
    expect(f.broker.complete(f.owner, lease, f.stamp, remove)).toBe(false)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it.each(['false', 'throw'] as const)(
    'releases on %s removal and leaves no reusable permission',
    (failure) => {
      const f = mainFixture(),
        lease = f.broker.reserve(f.owner, 'first')
      f.broker.settle(f.owner, lease)
      f.broker.ready(f.owner, lease, f.stamp)
      if (failure === 'false')
        expect(f.broker.complete(f.owner, lease, f.stamp, () => false)).toBe(false)
      else
        expect(() =>
          f.broker.complete(f.owner, lease, f.stamp, () => {
            throw new Error('remove failed')
          }),
        ).toThrow('remove failed')
      expect(f.release).toHaveBeenCalledWith(f.owner, lease, 'commit finished')
      expect(f.broker.complete(f.owner, lease, f.stamp, () => true)).toBe(false)
    },
  )

  it('refuses source/revision changes and never treats another sender as the owner', () => {
    const f = mainFixture(),
      lease = f.broker.reserve(f.owner, 'first'),
      remove = vi.fn(() => true)
    f.broker.settle(f.owner, lease)
    f.broker.ready(f.owner, lease, f.stamp)
    expect(f.broker.complete({ ...f.owner }, lease, f.stamp, remove)).toBe(false)
    expect(f.broker.complete(f.owner, lease, { ...f.stamp, revision: '8' }, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    const next = f.broker.reserve(f.owner, 'second')
    f.broker.settle(f.owner, next)
    f.broker.ready(f.owner, next, f.stamp)
    f.owner.source = 'main-session-B'
    expect(f.broker.complete(f.owner, next, f.stamp, remove)).toBe(false)
  })

  it('old cancellation cannot invalidate a newer ready lease', () => {
    const f = mainFixture(),
      first = f.broker.reserve(f.owner, 'first')
    f.broker.settle(f.owner, first)
    f.broker.cancel(f.owner, first)
    const second = f.broker.reserve(f.owner, 'second')
    f.broker.settle(f.owner, second)
    f.broker.ready(f.owner, second, f.stamp)
    f.broker.cancel(f.owner, first)
    expect(f.broker.complete(f.owner, second, f.stamp, () => true)).toBe(true)
  })

  it('does not issue release tombstones for invented future tickets', () => {
    const f = mainFixture(),
      lease = f.broker.reserve(f.owner, 'first')
    f.broker.cancel(f.owner, { ...lease, id: 'invented', sequence: lease.sequence + 100 })
    expect(f.release).not.toHaveBeenCalled()
    expect(f.broker.claim(f.owner, lease)).toBe(true)
  })
})

function browserFixture() {
  let source = 'renderer-A'
  const cancel = vi.fn(async (_ticket: CloseLeaseTicket, _reason: string) => {})
  const claim = vi.fn(async (_ticket: CloseLeaseTicket) => true)
  const report = vi.fn()
  const barrier = new CloseMutationBarrier({ source: () => source, claim, cancel, report })
  return {
    barrier,
    cancel,
    claim,
    report,
    source: (value: string) => {
      source = value
    },
  }
}

describe('renderer authored mutation barrier', () => {
  it('keeps setters pending until main cancellation is acknowledged', async () => {
    const f = browserFixture(),
      gate = deferred()
    f.cancel.mockImplementation(() => gate.promise)
    await f.barrier.acquire(ticket(), () => true)
    let value = 'saved'
    f.barrier.guardSetter((next: string) => {
      value = next
    })('new edit')
    expect(value).toBe('saved')
    expect(f.barrier.locked).toBe(true)
    gate.resolve()
    await vi.waitFor(() => expect(value).toBe('new edit'))
    expect(f.barrier.locked).toBe(false)
  })

  it('remembers release before a late queued prepare can acquire', async () => {
    const f = browserFixture(),
      lease = ticket()
    f.barrier.release(lease)
    expect(await f.barrier.acquire(lease, () => true)).toBeNull()
    expect(f.barrier.locked).toBe(false)
  })

  it('never lets an old release unlock a newer lease', async () => {
    const f = browserFixture()
    await f.barrier.acquire(ticket(1), () => true)
    f.barrier.release(ticket(1))
    await f.barrier.acquire(ticket(2), () => true)
    f.barrier.release(ticket(1))
    expect(f.barrier.ticket?.id).toBe(ticket(2).id)
    expect(f.barrier.locked).toBe(true)
  })

  it('locks newly registered auxiliary editors and does not locally unlock on unregister', async () => {
    const f = browserFixture(),
      restore = vi.fn()
    await f.barrier.acquire(ticket(), () => true)
    const lock = vi.fn(() => restore),
      unregister = f.barrier.registerLock(lock)
    expect(lock).toHaveBeenCalledTimes(1)
    unregister()
    expect(restore).not.toHaveBeenCalled()
    f.barrier.release(ticket())
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('does not return a ready receipt before asynchronous frame locking finishes', async () => {
    const f = browserFixture()
    f.barrier.registerLock((async () => () => {}) as unknown as () => () => void)
    await expect(f.barrier.acquire(ticket(), () => true)).rejects.toThrow('synchronously')
    expect(f.barrier.locked).toBe(false)
    expect(f.cancel).toHaveBeenCalled()
  })

  it('refuses acquisition while a complete async writer remains pending', async () => {
    const f = browserFixture(),
      entered = deferred(),
      finish = deferred()
    const operation = f.barrier.runAsyncMutation(async () => {
      entered.resolve()
      await finish.promise
    })
    await entered.promise
    expect(await f.barrier.acquire(ticket(), () => true)).toBeNull()
    expect(f.barrier.busy).toBe(true)
    finish.resolve()
    await operation
    expect(f.barrier.busy).toBe(false)
  })

  it('rechecks a source changed between beforeMutation fulfillment and reservation', async () => {
    const f = browserFixture(),
      action = vi.fn(async () => {})
    const original = f.barrier.beforeMutation.bind(f.barrier)
    vi.spyOn(f.barrier, 'beforeMutation').mockImplementation(async (source) => {
      await original(source)
      f.source('renderer-B')
    })
    await expect(f.barrier.runAsyncMutation(action, 'renderer-A')).rejects.toThrow('changed')
    expect(action).not.toHaveBeenCalled()
    expect(f.barrier.busy).toBe(false)
  })

  it('cannot begin work under a lease acquired between cancellation fulfillment and continuation', async () => {
    const f = browserFixture(),
      firstCancel = deferred(),
      secondCancel = deferred(),
      reacquired = deferred()
    f.cancel.mockImplementation((lease) =>
      lease.sequence === 1 ? firstCancel.promise : secondCancel.promise,
    )
    await f.barrier.acquire(ticket(1), () => true)
    const original = f.barrier.beforeMutation.bind(f.barrier)
    let insertLease = true
    vi.spyOn(f.barrier, 'beforeMutation').mockImplementation(async (source) => {
      await original(source)
      if (insertLease) {
        insertLease = false
        await f.barrier.acquire(ticket(2), () => true)
        reacquired.resolve()
      }
    })
    const action = vi.fn(async () => {
      expect(f.barrier.locked).toBe(false)
    })
    const work = f.barrier.runAsyncMutation(action)
    firstCancel.resolve()
    await reacquired.promise
    expect(f.barrier.locked).toBe(true)
    expect(action).not.toHaveBeenCalled()
    secondCancel.resolve()
    await work
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('counts pending DOM input and blocks synthetic input while held', async () => {
    const f = browserFixture(),
      listeners = new Map<string, (event: CloseInputEvent) => void>()
    const root = {
      addEventListener: (name: string, listener: (event: CloseInputEvent) => void) => {
        listeners.set(name, listener)
      },
      removeEventListener: (name: string) => listeners.delete(name),
    }
    const event = (type: string) => ({
      type,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopImmediatePropagation() {},
    })
    const dispose = installCloseInputFence(f.barrier, root)
    listeners.get('input')!(event('input'))
    const revision = f.barrier.snapshot().revision
    expect(revision).not.toBe('0')
    await f.barrier.acquire(ticket(), () => true)
    const input = event('beforeinput')
    listeners.get('beforeinput')!(input)
    expect(input.defaultPrevented).toBe(true)
    expect(f.barrier.snapshot().revision).toBe(revision)
    f.barrier.release(ticket())
    dispose()
  })
})

describe('queued authored commit reservation', () => {
  it('refuses cancel-to-new-lease interleaving until the previously accepted setter commits', async () => {
    const gate = deferred(),
      author = vi.fn(),
      errors: unknown[] = []
    const barrier = new CloseMutationBarrier({
      source: () => 'renderer-A',
      claim: async () => true,
      cancel: () => gate.promise,
      report: (error) => errors.push(error),
    })
    expect(await barrier.acquire(ticket(900), () => true)).not.toBeNull()
    barrier.mutate(author)
    expect(barrier.busy).toBe(true)
    const reacquire = gate.promise.then(() => barrier.acquire(ticket(901), () => true))
    gate.resolve()
    expect(await reacquire).toBeNull()
    await vi.waitFor(() => expect(author).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(barrier.busy).toBe(false))
    expect(errors).toEqual([])
    expect(await barrier.acquire(ticket(902), () => true)).not.toBeNull()
  })
  it('retires a queued stale-source setter and releases its busy reservation exactly once', async () => {
    let source = 'renderer-A'
    const gate = deferred(),
      author = vi.fn(),
      report = vi.fn()
    const barrier = new CloseMutationBarrier({
      source: () => source,
      claim: async () => true,
      cancel: () => gate.promise,
      report,
    })
    await barrier.acquire(ticket(910), () => true)
    barrier.mutate(author)
    source = 'renderer-B'
    gate.resolve()
    await vi.waitFor(() => expect(barrier.busy).toBe(false))
    expect(author).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledTimes(1)
  })
})
