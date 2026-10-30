import type { CloseLeaseStamp, CloseLeaseTicket } from './close-lease'

export interface CloseMutationBarrierOptions {
  source(): string
  /** Main validates the preparing ticket. This call must not await final save completion. */
  claim(ticket: CloseLeaseTicket): Promise<boolean>
  /** Resolves only after main invalidated its close permission. */
  cancel(ticket: CloseLeaseTicket, reason: string): Promise<void>
  report(error: unknown): void
}

interface HeldLease {
  ticket: CloseLeaseTicket
  stamp: CloseLeaseStamp
  releases: Map<() => () => void, () => void>
  cancelling?: Promise<void>
  invalidating: boolean
}

/** App-independent gate; apps must register editor locks and route every authored setter through it. */
export class CloseMutationBarrier {
  private held: HeldLease | null = null
  private revision = 0
  private operations = 0
  private queuedCommits = 0
  private readonly locks = new Set<() => () => void>()
  private readonly releasedThrough = new Map<string, number>()

  constructor(private readonly options: CloseMutationBarrierOptions) {}

  snapshot(): CloseLeaseStamp {
    return { source: this.options.source(), revision: String(this.revision) }
  }

  get locked(): boolean { return this.held !== null }
  get busy(): boolean { return this.operations !== 0 || this.queuedCommits !== 0 }
  get ticket(): CloseLeaseTicket | null { return this.held ? { ...this.held.ticket } : null }

  registerLock(lock: () => () => void): () => void {
    this.locks.add(lock)
    if (this.held) {
      try {
        const release = lock()
        if (typeof release !== 'function') throw new Error('A close participant must finish locking synchronously; await frame attestation before acquire.')
        this.held.releases.set(lock, release)
      }
      catch (error) { void this.cancelHeld('participant lock failed'); this.options.report(error) }
    }
    return () => {
      this.locks.delete(lock)
      // An active participant remains locked until main release, even if its
      // registration was disposed. Its restoration callback must tolerate destruction.
    }
  }

  /** No renderer expiry timer: only a correlated main release or cancel acknowledgment unlocks. */
  release(ticket: CloseLeaseTicket): void {
    this.releasedThrough.set(ticket.source, Math.max(this.releasedThrough.get(ticket.source) ?? 0, ticket.sequence))
    const held = this.held
    if (!held || held.ticket.id !== ticket.id || held.ticket.sequence !== ticket.sequence || held.ticket.source !== ticket.source) return
    this.held = null
    for (const release of [...held.releases.values()].reverse()) {
      try { release() } catch (error) { this.options.report(error) }
    }
  }

  async acquire(ticket: CloseLeaseTicket, validate: () => boolean): Promise<CloseLeaseStamp | null> {
    const source = this.options.source()
    const claimed = await this.options.claim(ticket)
    if (!claimed || (this.releasedThrough.get(ticket.source) ?? 0) >= ticket.sequence ||
      source !== this.options.source() || this.held || this.busy) {
      await this.options.cancel(ticket, 'prepare obsolete or busy')
      this.release(ticket)
      return null
    }
    const held: HeldLease = { ticket: { ...ticket }, stamp: this.snapshot(), releases: new Map(), invalidating: false }
    this.held = held
    try {
      for (const lock of this.locks) {
        const release = lock()
        if (typeof release !== 'function') throw new Error('A close participant must finish locking synchronously; await frame attestation before acquire.')
        held.releases.set(lock, release)
      }
      if (!validate() || held.invalidating || this.busy ||
        held.stamp.source !== this.options.source() || held.stamp.revision !== String(this.revision)) {
        await this.cancelHeld('state changed while acquiring')
        return null
      }
      return { ...held.stamp }
    } catch (error) {
      await this.cancelHeld('prepare failed')
      throw error
    }
  }

  private async cancelHeld(reason: string): Promise<void> {
    const held = this.held
    if (!held) return
    held.invalidating = true
    if (!held.cancelling) held.cancelling = this.options.cancel(held.ticket, reason).then(() => this.release(held.ticket))
    await held.cancelling
  }

  async beforeMutation(source = this.options.source()): Promise<void> {
    if (source !== this.options.source()) throw new Error('The document changed before its pending edit could be applied.')
    while (this.held) await this.cancelHeld('authored mutation requested')
    if (source !== this.options.source()) throw new Error('The document changed while canceling close.')
  }

  /** Deferred setters preserve accepted work until main confirms that close can no longer occur. */
  mutate(action: () => void, source = this.options.source()): boolean {
    if (source !== this.options.source()) return false
    if (this.held) {
      this.held.invalidating = true
      this.queuedCommits++
      void this.beforeMutation(source).then(() => { this.mutate(action, source) })
        .catch((error) => this.options.report(error))
        .finally(() => { this.queuedCommits-- })
      return false
    }
    this.revision++
    action()
    return true
  }

  guardSetter<Arguments extends unknown[]>(setter: (...args: Arguments) => void, source = this.options.source()): (...args: Arguments) => void {
    return (...args) => { this.mutate(() => setter(...args), source) }
  }

  /** Reserve the complete asynchronous writer, including its post-await application. */
  async runAsyncMutation<Result>(action: () => Promise<Result>, source = this.options.source()): Promise<Result> {
    for (;;) {
      await this.beforeMutation(source)
      // A ready lease or a new source can appear between the awaited promise's
      // resolution and this continuation. Reservation itself must be atomic.
      if (source !== this.options.source()) throw new Error('The document changed before its pending work could reserve the source.')
      if (this.held) continue
      this.operations++
      break
    }
    try { return await action() }
    finally { this.operations-- }
  }

  /** Keeps synchronous APIs synchronous when no lease is held. */
  runMutationWork<Result>(action: () => Result | Promise<Result>, source = this.options.source()): Result | Promise<Result> {
    if (source !== this.options.source()) throw new Error('The document changed before its work began.')
    if (this.held) return this.beforeMutation(source).then(() => this.runMutationWork(action, source))
    this.operations++
    try {
      const result = action()
      if (result && typeof (result as Promise<Result>).then === 'function')
        return Promise.resolve(result).finally(() => { this.operations-- })
      this.operations--
      return result
    } catch (error) {
      this.operations--
      throw error
    }
  }
}

export interface CloseInputEvent {
  type: string
  preventDefault(): void
  stopImmediatePropagation(): void
}
export interface CloseInputRoot {
  addEventListener(name: string, listener: (event: CloseInputEvent) => void, capture: boolean): void
  removeEventListener(name: string, listener: (event: CloseInputEvent) => void, capture: boolean): void
}

/** Structural input adapter keeps this shared package independent of DOM/React/Electron types. */
export function installCloseInputFence(barrier: CloseMutationBarrier, root: CloseInputRoot): () => void {
  const events = ['beforeinput', 'input', 'change', 'keydown', 'paste', 'cut', 'drop', 'compositionstart', 'pointerdown']
  const prevent = (event: CloseInputEvent): void => {
    if (!barrier.locked) {
      if (event.type === 'input' || event.type === 'change') barrier.mutate(() => {})
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  for (const name of events) root.addEventListener(name, prevent, true)
  return () => { for (const name of events) root.removeEventListener(name, prevent, true) }
}
