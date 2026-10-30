/** Schedules typed checkpoints independently of formula calculation and badge count. */
export interface CheckpointObservation {
  readonly sessionId: string
  readonly generation: number
  readonly pending: boolean
  readonly paused: boolean
}

export class DocumentCheckpointLoop {
  private sessionId: string | null = null
  private acknowledgedGeneration = -1
  private checkpointed = false
  private active: Promise<void> | null = null
  private disposed = false
  private attemptedGeneration = -1
  private retryAt = 0
  private retryDelay = 0

  constructor(
    private readonly options: {
      observe(): CheckpointObservation | null
      checkpoint(): Promise<{ readonly ok: boolean }>
      now?: () => number
    },
  ) {}

  poll(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.active) return this.active
    const state = this.options.observe()
    if (!state || state.paused) return Promise.resolve()
    if (this.sessionId !== state.sessionId) {
      this.sessionId = state.sessionId
      this.acknowledgedGeneration = -1
      this.checkpointed = false
      this.retryAt = 0
      this.retryDelay = 0
    }
    // An undo back to a clean journal must replace an earlier checkpoint.
    // Merely viewing a clean workbook does not create a recovery base copy.
    if (
      (!state.pending && !this.checkpointed) ||
      state.generation === this.acknowledgedGeneration
    ) {
      return Promise.resolve()
    }
    const now = this.options.now ?? Date.now
    if (state.generation === this.attemptedGeneration && now() < this.retryAt)
      return Promise.resolve()
    const task = Promise.resolve()
      .then(async () => {
        const starting = this.options.observe()
        if (this.disposed || starting?.sessionId !== state.sessionId || starting.paused) return
        this.attemptedGeneration = state.generation
        const outcome = await this.options.checkpoint().catch(() => ({ ok: false }))
        const current = this.options.observe()
        if (!this.disposed && outcome.ok && current?.sessionId === state.sessionId) {
          this.acknowledgedGeneration = state.generation
          this.checkpointed = state.pending
          this.retryAt = 0
          this.retryDelay = 0
        } else if (!this.disposed && current?.sessionId === state.sessionId) {
          this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : 1_000, 30_000)
          this.retryAt = now() + this.retryDelay
        }
      })
      .finally(() => {
        if (this.active === task) this.active = null
      })
    this.active = task
    return task
  }

  dispose(): void {
    this.disposed = true
  }
}
