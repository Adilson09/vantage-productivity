/** Exact main-owned source offer decision; never serialized into a renderer receipt. */
export interface WorkbookPublicationDecision {
  finishAfter(actual: Promise<unknown>): void
}

/**
 * Owns real main I/O and its source-offer finalizers independently of the IPC
 * result. Only a genuine body task, exact adoption/rejection or owner teardown
 * can release a hold. Caller cancellation/deadline is deliberately absent.
 */
export class WorkbookPublicationLifecycle {
  readonly actualSettled: Promise<void>
  private resolveActual!: () => void
  private started = false
  private bodyPending = true
  private decisions = 0
  private settled = false
  private readonly work = new Set<Promise<unknown>>()

  constructor() { this.actualSettled = new Promise<void>(resolve => { this.resolveActual = resolve }) }

  isSettled(): boolean { return this.settled }

  run<T>(actual: () => Promise<T>): Promise<T> {
    if (this.started || !this.bodyPending) throw new Error('The main publication body has already been admitted.')
    this.started = true
    // Dispatch after the outer W2 and quit holds have been indexed.
    const body = Promise.resolve().then(actual)
    const finish = () => { this.bodyPending = false; this.finishIfSettled() }
    void body.then(finish, finish)
    return body
  }

  /** W2 rejected before start; no body/native dispatch was admitted. */
  abandonBeforeStart(): void {
    if (this.started) return
    this.bodyPending = false
    this.finishIfSettled()
  }

  hold(actual: Promise<unknown>): void {
    if (this.settled) throw new Error('A settled main publication cannot acquire later work.')
    if (this.work.has(actual)) return
    this.work.add(actual)
    const finish = () => { this.work.delete(actual); this.finishIfSettled() }
    void actual.then(finish, finish)
  }

  retainOffer(): WorkbookPublicationDecision {
    if (this.settled || !this.bodyPending) throw new Error('A source offer must be retained before its main body returns.')
    this.decisions++
    let decided = false
    return Object.freeze({ finishAfter: (actual: Promise<unknown>) => {
      if (decided) return
      this.hold(actual)
      decided = true
      this.decisions--
      this.finishIfSettled()
    } })
  }

  private finishIfSettled(): void {
    if (this.settled || this.bodyPending || this.decisions || this.work.size) return
    this.settled = true
    this.resolveActual()
  }
}
