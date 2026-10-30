/** Owns setup and terminal output admission without importing Electron. */
export class DocsHeadlessOutputAdmission {
  private closed = false
  private actualPin?: Promise<void>
  private actualSettlement?: Promise<void>

  constructor(private readonly output: {
    pin(): Promise<void>
    closeAdmission(): void
    awaitSettlement(): Promise<void>
  }) {}

  /** False means a terminal outcome arrived while setup was still pending. */
  prepare(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (!this.actualPin) {
      // Reserve the actual setup lifetime before invoking a pin implementation
      // that may perform synchronous registration before its first await.
      this.actualPin = Promise.resolve().then(async () => {
        if (!this.closed) await this.output.pin()
      })
      void this.actualPin.catch(() => {})
    }
    return this.actualPin.then(() => !this.closed)
  }

  /** Terminal notification revokes permission now; it never settles actual work. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.output.closeAdmission()
  }

  /** The caller clears handoff maps/destroys the owner only after this returns. */
  settle(): Promise<void> {
    if (this.actualSettlement) return this.actualSettlement
    this.close()
    this.actualSettlement = (async () => {
      let failed = false, failure: unknown
      try { await this.actualPin } catch (error) { failed = true; failure = error }
      // Setup can finish registering work after terminal notification. Join it
      // before asking the provider for its stable actual-output drain.
      try { await this.output.awaitSettlement() }
      catch (error) { if (!failed) { failed = true; failure = error } }
      if (failed) throw failure
    })()
    return this.actualSettlement
  }
}
