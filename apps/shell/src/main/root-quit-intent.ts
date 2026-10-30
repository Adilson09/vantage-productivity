/** Root owns cancellation of retry permissions; actual I/O remains owned by its service. */
export interface RootQuitIntentHooks {
  cancelMcp(reason: string): void
  cancelCleanup(): void
  resetSheets(): void
  resetShell(): void
  revealWorkspace(reason: string): void
  report(error: unknown): void
}
const empty: RootQuitIntentHooks = {
  cancelMcp: () => {},
  cancelCleanup: () => {},
  resetSheets: () => {},
  resetShell: () => {},
  revealWorkspace: () => {},
  report: () => {},
}
export class RootQuitIntent {
  private epoch = 0
  private mutations = 0
  private canceling = false
  private revealReason: string | undefined
  private listeners = new Set<(reason: string) => void>()
  constructor(private hooks: RootQuitIntentHooks = empty) {}
  configure(hooks: RootQuitIntentHooks): void {
    this.hooks = hooks
  }
  capture(): number {
    return this.epoch
  }
  mutationAllowed(): boolean {
    return this.mutations === 0
  }
  assertMutationAvailable(): void {
    if (!this.mutationAllowed())
      throw new Error(
        'A file move is still updating this document. Keep it open and try again when it finishes.',
      )
  }
  current(epoch: number): boolean {
    return this.epoch === epoch && this.mutations === 0
  }
  /** Covers physical source change and its awaited native identity/checkpoint refresh. */
  beginMutation(reason: string): () => void {
    this.assertMutationAvailable()
    ++this.mutations
    this.cancel(reason, false)
    let active = true
    return () => {
      if (active) {
        active = false
        --this.mutations
      }
    }
  }
  subscribe(listener: (reason: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  /** before-quit must never make an interactive Sheets approval look terminal. */
  beginApproval(): void {
    this.attempt(() => this.hooks.resetSheets())
  }
  cancel(reason: string, reveal = true): void {
    ++this.epoch
    if (reveal) this.revealReason = reason
    if (this.canceling) return
    this.canceling = true
    try {
      // MCP interruption can reenter cancel(); no hook is recursively dispatched.
      this.attempt(() => this.hooks.cancelMcp(reason))
      this.attempt(() => this.hooks.cancelCleanup())
      this.attempt(() => this.hooks.resetSheets())
      this.attempt(() => this.hooks.resetShell())
      for (const listener of [...this.listeners]) this.attempt(() => listener(reason))
      const show = this.revealReason
      this.revealReason = undefined
      if (show !== undefined) this.attempt(() => this.hooks.revealWorkspace(show))
    } finally {
      this.canceling = false
      this.revealReason = undefined
    }
  }
  private attempt(action: () => void): void {
    try {
      action()
    } catch (error) {
      try {
        this.hooks.report(error)
      } catch {
        /* cancellation must still attempt every hook */
      }
    }
  }
}
export const rootQuitIntent = new RootQuitIntent()
