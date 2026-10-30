import { describe, expect, it, vi } from 'vitest'
import {
  installSheetsCloseQuitGuard,
  SheetsCloseQuitLedger,
  SheetsProtectedRetirementBlockedError,
  type SheetsBeforeQuitEvent,
} from '../src/main/sheets-close-quit-ledger'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

class QuitEvent implements SheetsBeforeQuitEvent {
  prevented = false
  preventDefault(): void {
    this.prevented = true
  }
}

class TestApp {
  readonly listeners: ((event: SheetsBeforeQuitEvent) => void)[] = []
  readonly events: QuitEvent[] = []
  accepted = 0
  on(_event: 'before-quit', listener: (event: SheetsBeforeQuitEvent) => void): this {
    this.listeners.push(listener)
    return this
  }
  removeListener(_event: 'before-quit', listener: (event: SheetsBeforeQuitEvent) => void): this {
    const index = this.listeners.indexOf(listener)
    if (index !== -1) this.listeners.splice(index, 1)
    return this
  }
  quit(): void {
    const event = new QuitEvent()
    this.events.push(event)
    for (const listener of [...this.listeners]) listener(event)
    if (!event.prevented) this.accepted++
  }
}

function fixture(ledger = new SheetsCloseQuitLedger()) {
  const app = new TestApp()
  let epoch = 1
  const cancellations = new Set<() => void>()
  const blocked = vi.fn()
  const guard = installSheetsCloseQuitGuard(app, ledger, {
    epoch: () => epoch,
    isCurrent: (captured) => captured === epoch,
    subscribeCancel: (listener) => {
      cancellations.add(listener)
      return () => {
        cancellations.delete(listener)
      }
    },
    onBlocked: blocked,
  })
  return {
    app,
    ledger,
    guard,
    blocked,
    revise: () => {
      epoch++
    },
    cancel: () => {
      epoch++
      for (const listener of [...cancellations]) listener()
    },
  }
}

describe('Sheets actual close custody at before-quit', () => {
  it('joins the unresolved protected actual promise before retrying quit', async () => {
    const f = fixture(),
      actual = deferred()
    const retry = vi.fn(async () => {})
    f.ledger.holdProtectedRetirement(actual.promise, retry)
    f.app.quit()
    expect(f.app.events[0]?.prevented).toBe(true)
    expect(f.app.accepted).toBe(0)
    expect(f.ledger.hasPending()).toBe(true)
    actual.resolve()
    await f.ledger.joinActual()
    await Promise.resolve()
    expect(f.app.events).toHaveLength(2)
    expect(f.app.accepted).toBe(1)
    expect(retry).not.toHaveBeenCalled()
    f.guard.dispose()
  })

  it('cancels the intention without releasing its actual work or resuming afterward', async () => {
    const f = fixture(),
      actual = deferred()
    f.ledger.holdUntilSettled(actual.promise)
    f.app.quit()
    f.cancel()
    expect(f.ledger.hasPending()).toBe(true)
    actual.resolve()
    await f.ledger.joinActual()
    await Promise.resolve()
    expect(f.app.events).toHaveLength(1)
    expect(f.app.accepted).toBe(0)
    // A fresh explicit quit is independent of the canceled intention.
    f.app.quit()
    expect(f.app.accepted).toBe(1)
    f.guard.dispose()
  })

  it('rechecks the caller epoch after the actual operation settles', async () => {
    const f = fixture(),
      actual = deferred()
    f.ledger.holdUntilSettled(actual.promise)
    f.app.quit()
    f.revise()
    actual.resolve()
    await f.ledger.joinActual()
    await Promise.resolve()
    expect(f.app.events).toHaveLength(1)
    expect(f.app.accepted).toBe(0)
    f.guard.dispose()
  })

  it('does not mistake a caller timeout for actual settlement; an ordinary rejection can settle', async () => {
    const reported = vi.fn(),
      ledger = new SheetsCloseQuitLedger({ report: reported })
    const actual = deferred(),
      callerDeadline = deferred()
    const caller = Promise.race([actual.promise, callerDeadline.promise])
    ledger.holdUntilSettled(actual.promise)
    ledger.holdUntilSettled(actual.promise) // identical actual ownership is joined once
    callerDeadline.resolve()
    await caller
    expect(ledger.hasPending()).toBe(true)
    let joined = false
    const join = ledger.joinActual().then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)
    const error = new Error('ordinary preparation failed')
    actual.reject(error)
    await join
    expect(ledger.hasPending()).toBe(false)
    expect(ledger.hasBlockedFailures()).toBe(false)
    expect(reported).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('prevents the current event when a later before-quit listener adds its first hold', async () => {
    const f = fixture(),
      actual = deferred()
    f.app.on('before-quit', () => {
      if (f.app.events.length === 1) f.ledger.holdUntilSettled(actual.promise)
    })
    f.app.quit()
    expect(f.app.events[0]?.prevented).toBe(true)
    expect(f.app.accepted).toBe(0)
    actual.resolve()
    await f.ledger.joinActual()
    await Promise.resolve()
    expect(f.app.events).toHaveLength(2)
    expect(f.app.accepted).toBe(1)
    f.guard.dispose()
  })

  it('also blocks a synchronous late hold on the retry and retains its successor waiter', async () => {
    const f = fixture(),
      first = deferred(),
      second = deferred(),
      retryObserved = deferred()
    f.ledger.holdUntilSettled(first.promise)
    f.app.on('before-quit', () => {
      if (f.app.events.length === 2) {
        f.ledger.holdUntilSettled(second.promise)
        retryObserved.resolve()
      }
    })
    f.app.quit()
    first.resolve()
    await retryObserved.promise
    expect(f.app.events).toHaveLength(2)
    expect(f.app.events[1]?.prevented).toBe(true)
    expect(f.app.accepted).toBe(0)
    expect(f.ledger.hasPending()).toBe(true)
    second.resolve()
    await f.ledger.joinActual()
    await Promise.resolve()
    expect(f.app.events).toHaveLength(3)
    expect(f.app.accepted).toBe(1)
    f.guard.dispose()
  })

  it('keeps failed protected retirement blocked until its exact cleanup retry actually succeeds', async () => {
    const f = fixture(),
      retired = deferred(),
      retryOne = deferred(),
      retryTwo = deferred()
    const retry = vi
      .fn()
      .mockImplementationOnce(() => retryOne.promise)
      .mockImplementationOnce(() => retryTwo.promise)
    f.ledger.holdUntilSettled(retired.promise, { retainFailure: true, retry })
    f.app.quit()
    retired.reject(new Error('protected retirement failed'))
    await expect(f.ledger.joinActual()).rejects.toBeInstanceOf(
      SheetsProtectedRetirementBlockedError,
    )
    await Promise.resolve()
    expect(f.blocked).toHaveBeenCalledTimes(1)
    expect(f.app.accepted).toBe(0)
    expect(f.ledger.hasPending()).toBe(false)
    expect(f.ledger.hasBlockedFailures()).toBe(true)

    const firstRetry = f.ledger.retryFailed()
    const concurrentRetry = f.ledger.retryFailed()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(f.ledger.hasPending()).toBe(true)
    expect(f.ledger.hasBlockedFailures()).toBe(true)
    const rejectedFirst = expect(firstRetry).rejects.toBeInstanceOf(
      SheetsProtectedRetirementBlockedError,
    )
    const rejectedConcurrent = expect(concurrentRetry).rejects.toBeInstanceOf(
      SheetsProtectedRetirementBlockedError,
    )
    retryOne.reject(new Error('cleanup retry failed'))
    await Promise.all([rejectedFirst, rejectedConcurrent])
    expect(f.ledger.hasBlockedFailures()).toBe(true)
    const secondRetry = f.ledger.retryFailed()
    expect(retry).toHaveBeenCalledTimes(2)
    expect(f.ledger.hasPending()).toBe(true)
    retryTwo.resolve()
    await secondRetry
    expect(f.ledger.hasPending()).toBe(false)
    expect(f.ledger.hasBlockedFailures()).toBe(false)
    // Successful cleanup retires custody; it cannot revive the failed quit.
    expect(f.app.events).toHaveLength(1)
    expect(f.app.accepted).toBe(0)
    f.app.quit()
    expect(f.app.accepted).toBe(1)
    f.guard.dispose()
  })

  it('joins a new actual hold registered by a settlement listener in the same drain', async () => {
    const ledger = new SheetsCloseQuitLedger(),
      first = deferred(),
      second = deferred()
    ledger.holdUntilSettled(first.promise)
    let added = false
    const stop = ledger.onWorkChange(() => {
      if (!added && !ledger.hasPending()) {
        added = true
        ledger.holdUntilSettled(second.promise)
      }
    })
    let settled = false
    const join = ledger.joinActual().then(() => {
      settled = true
    })
    first.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(ledger.hasPending()).toBe(true)
    expect(settled).toBe(false)
    second.resolve()
    await join
    expect(settled).toBe(true)
    stop()
  })
})
