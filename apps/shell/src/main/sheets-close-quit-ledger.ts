/** Main-process custody of actual Sheets close/retirement lifetimes.
 * No Electron runtime, persistence, logging, or document/provider metadata.
 */
export interface SheetsCloseHoldOptions {
  retainFailure?: boolean
  retry?: () => Promise<void>
}

export class SheetsProtectedRetirementBlockedError extends Error {
  readonly code = 'sheets_protected_retirement_blocked'
  constructor() { super('Protected spreadsheet retirement remains incomplete.') }
}

interface ProtectedFailure {
  retry?: () => Promise<void>
  inFlight: Promise<void> | null
}

export class SheetsCloseQuitLedger {
  private readonly actual = new Set<Promise<void>>()
  private readonly holds = new Map<Promise<void>, SheetsCloseHoldOptions>()
  private readonly failures = new Set<ProtectedFailure>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  constructor(private readonly options: { report?(error: unknown): void } = {}) {}

  /** Hold the actual finalizer, never a caller's timeout/race promise. */
  holdUntilSettled(operation: Promise<void>, options: SheetsCloseHoldOptions = {}): void {
    const existing = this.holds.get(operation)
    if (existing) {
      if (options.retainFailure) {
        existing.retainFailure = true
        if (options.retry) existing.retry = options.retry
      }
      return
    }
    const hold = { ...options }
    this.holds.set(operation, hold)
    this.actual.add(operation)
    this.revision++
    this.changed()
    const settle = () => {
      if (!this.actual.delete(operation)) return
      this.holds.delete(operation)
      this.revision++
      this.changed()
    }
    void operation.then(settle, error => {
      if (hold.retainFailure) {
        this.failures.add({ ...(hold.retry ? { retry: hold.retry } : {}), inFlight: null })
        this.revision++
      }
      this.report(error)
      settle()
    })
  }

  holdProtectedRetirement(operation: Promise<void>, retry: () => Promise<void>): void {
    this.holdUntilSettled(operation, { retainFailure: true, retry })
  }

  /** The caller owns any protected-error redaction policy. No default logger. */
  report(error: unknown): void {
    try { this.options.report?.(error) } catch { /* Reporting cannot release or strand custody. */ }
  }

  hasPending(): boolean { return this.actual.size !== 0 }
  hasBlockedFailures(): boolean { return this.failures.size !== 0 }

  /** Explicit cleanup retry. It never revives a canceled quit intention. */
  async retryFailed(): Promise<void> {
    await Promise.allSettled([...this.failures].map(failure => this.retryFailure(failure)))
    await this.joinActual()
  }

  onWorkChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Re-snapshot until no hold or finalizer arrived across the settled turn. */
  async joinActual(): Promise<void> {
    for (;;) {
      const revision = this.revision
      const pending = [...this.actual]
      if (pending.length !== 0) await Promise.allSettled(pending)
      await Promise.resolve()
      if (this.actual.size === 0 && this.revision === revision) {
        if (this.failures.size !== 0) throw new SheetsProtectedRetirementBlockedError()
        return
      }
    }
  }

  private retryFailure(failure: ProtectedFailure): Promise<void> {
    if (failure.inFlight) return failure.inFlight
    if (!failure.retry) return Promise.reject(new SheetsProtectedRetirementBlockedError())
    let actual: Promise<void>
    try { actual = failure.retry() }
    catch (error) { this.report(error); return Promise.reject(new SheetsProtectedRetirementBlockedError()) }
    this.holdUntilSettled(actual)
    const outcome = actual.then(() => {
      if (this.failures.delete(failure)) {
        this.revision++
        this.changed()
      }
    }, () => { throw new SheetsProtectedRetirementBlockedError() })
    failure.inFlight = outcome
    void outcome.then(() => {
      if (failure.inFlight === outcome) failure.inFlight = null
    }, () => {
      if (failure.inFlight === outcome) failure.inFlight = null
    })
    return outcome
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { this.report(error) }
    }
  }
}

export interface SheetsBeforeQuitEvent { preventDefault(): void }
type BeforeQuitListener = (event: SheetsBeforeQuitEvent) => void

export interface SheetsQuitApp {
  on(event: 'before-quit', listener: BeforeQuitListener): unknown
  removeListener?(event: 'before-quit', listener: BeforeQuitListener): unknown
  quit(): void
}

export interface SheetsCloseQuitGuardOptions {
  epoch(): number
  isCurrent(epoch: number): boolean
  subscribeCancel(listener: () => void): () => void
  onDeferred?(): void
  onBlocked?(error: unknown): void
  report?(error: unknown): void
}

export interface SheetsCloseQuitGuard {
  /** Invalidates only this quit intention. Actual work remains in the ledger. */
  cancel(): void
  dispose(): void
}

interface QuitIntent {
  readonly epoch: number
  waiter: object | null
  announced: boolean
}
interface ObservedQuit {
  readonly event: SheetsBeforeQuitEvent
  readonly intent: QuitIntent
}
interface RetryFrame {
  readonly intent: QuitIntent
  observed: ObservedQuit | null
}

/**
 * Install for the app lifetime; do not stop this guard in a will-quit listener.
 * A later before-quit listener may synchronously add a protected close hold,
 * including on our own retry. The work subscription must still prevent that
 * already-observed event before Electron returns from its listener dispatch.
 */
export function installSheetsCloseQuitGuard(
  app: SheetsQuitApp,
  ledger: SheetsCloseQuitLedger,
  options: SheetsCloseQuitGuardOptions,
): SheetsCloseQuitGuard {
  let disposed = false
  let intent: QuitIntent | null = null
  let observed: ObservedQuit | null = null
  let retry: RetryFrame | null = null

  const report = (error: unknown): void => {
    try {
      if (options.report) options.report(error)
      else ledger.report(error)
    } catch { /* No default logging of protected operation failures. */ }
  }
  const current = (candidate: QuitIntent): boolean => {
    if (disposed || intent !== candidate) return false
    try { return options.epoch() === candidate.epoch && options.isCurrent(candidate.epoch) }
    catch (error) { report(error); return false }
  }

  const waitForActual = (candidate: QuitIntent): void => {
    if (!current(candidate) || candidate.waiter !== null) return
    const waiter = {}
    candidate.waiter = waiter
    if (!candidate.announced) {
      candidate.announced = true
      try { options.onDeferred?.() } catch (error) { report(error) }
    }
    void (async () => {
      try {
        await ledger.joinActual()
        if (candidate.waiter !== waiter || !current(candidate)) return
        // Clear only our token. A late hold during app.quit() can immediately
        // install its own waiter, which this operation's finally must retain.
        candidate.waiter = null
        if (ledger.hasPending()) { waitForActual(candidate); return }
        const frame: RetryFrame = { intent: candidate, observed: null }
        const previous = retry
        retry = frame
        try { app.quit() }
        finally {
          if (retry === frame) retry = previous
          if (frame.observed && observed === frame.observed) observed = null
        }
      } catch (error) {
        if (error instanceof SheetsProtectedRetirementBlockedError) {
          if (current(candidate)) {
            intent = null
            try { options.onBlocked?.(error) } catch (failure) { report(failure) }
          }
        } else report(error)
      } finally {
        if (candidate.waiter === waiter) candidate.waiter = null
      }
    })()
  }

  const beforeQuit: BeforeQuitListener = event => {
    if (disposed) return
    let candidate: QuitIntent
    if (retry) candidate = retry.intent
    else {
      try { candidate = { epoch: options.epoch(), waiter: null, announced: false } }
      catch (error) { event.preventDefault(); report(error); return }
      intent = candidate
    }
    const entry: ObservedQuit = { event, intent: candidate }
    observed = entry
    if (retry) retry.observed = entry
    // The identity check matters if a later listener starts a nested quit:
    // cleanup for this event must not clear that successor's event pointer.
    queueMicrotask(() => { if (observed === entry) observed = null })
    if (!current(candidate)) { event.preventDefault(); return }
    if (ledger.hasPending() || ledger.hasBlockedFailures()) {
      event.preventDefault()
      waitForActual(candidate)
    }
  }

  const stopWork = ledger.onWorkChange(() => {
    const entry = observed
    if (disposed || !entry || !(ledger.hasPending() || ledger.hasBlockedFailures())) return
    entry.event.preventDefault()
    waitForActual(entry.intent)
  })
  const cancel = (): void => {
    intent = null
    observed?.event.preventDefault()
  }
  app.on('before-quit', beforeQuit)
  let stopCancel: () => void
  try { stopCancel = options.subscribeCancel(cancel) }
  catch (error) {
    disposed = true
    stopWork()
    app.removeListener?.('before-quit', beforeQuit)
    throw error
  }
  return {
    cancel,
    dispose: () => {
      if (disposed) return
      disposed = true
      cancel()
      stopWork()
      stopCancel()
      app.removeListener?.('before-quit', beforeQuit)
    },
  }
}
