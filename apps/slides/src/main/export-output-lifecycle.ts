import type { UserOutputSourceProof } from '@vantage/electron-utils/user-output-publication'

/** Proof is captured before the picker can yield; selection never adopts a newer source. */
export async function selectCurrentSlidesOutput<Picked, Result>(options: {
  captureProof(): UserOutputSourceProof
  pick(): Promise<Picked | null>
  pin(picked: Picked, proof: UserOutputSourceProof): Promise<Result>
}): Promise<Result | null> {
  const proof = options.captureProof()
  proof.assertCurrent?.()
  const picked = await options.pick()
  if (picked === null) return null
  proof.assertCurrent?.()
  return options.pin(picked, proof)
}

/** Actual accepted work survives caller report timeout/crash and owns its finalizer. */
export class SlidesExportAdmission {
  private open = true
  private readonly pending = new Set<Promise<unknown>>()
  private readonly failures: unknown[] = []
  close(): void {
    this.open = false
  }
  run<T>(actual: () => Promise<T>): Promise<T> {
    if (!this.open) return Promise.reject(new Error('The headless export has already ended.'))
    const work = (async () => actual())()
    this.pending.add(work)
    void work.then(
      () => this.pending.delete(work),
      (error) => {
        this.failures.push(error)
        this.pending.delete(work)
      },
    )
    return work
  }
  async drain(): Promise<void> {
    this.close()
    while (this.pending.size) await Promise.allSettled([...this.pending])
    if (this.failures.length) throw this.failures[0]
  }
}

export interface SlidesHeadlessReport {
  ok: boolean
  error?: string
}
/** Absolute permission budget includes metadata pinning. Actual cleanup is unbounded. */
export class SlidesHeadlessExportLifecycle {
  readonly admission = new SlidesExportAdmission()
  readonly report: Promise<SlidesHeadlessReport>
  private active = true
  private readonly deadline: number
  private readonly timer: ReturnType<typeof setTimeout>
  private resolveReport!: (report: SlidesHeadlessReport) => void
  private terminalReport: SlidesHeadlessReport | undefined
  constructor(
    private readonly timeoutMs: number,
    startedAt = Date.now(),
  ) {
    this.deadline = startedAt + timeoutMs
    this.report = new Promise((resolve) => {
      this.resolveReport = resolve
    })
    this.timer = setTimeout(() => this.expire(), Math.max(0, this.deadline - Date.now()))
  }
  private expire(): void {
    this.terminal({ ok: false, error: `slides export timed out after ${this.timeoutMs}ms` })
  }
  terminal(report: SlidesHeadlessReport): void {
    if (!this.active) return
    if (report.ok && Date.now() >= this.deadline)
      report = { ok: false, error: `slides export timed out after ${this.timeoutMs}ms` }
    this.active = false
    this.terminalReport = report
    this.admission.close()
    this.resolveReport(report)
  }
  assertActive(): void {
    if (this.active && Date.now() >= this.deadline) this.expire()
    if (!this.active)
      throw new Error(this.terminalReport?.error ?? 'The registered headless export ended.')
  }
  pin<T>(actual: () => Promise<T>): Promise<T> {
    this.assertActive()
    return this.admission.run(async () => {
      const result = await actual()
      this.assertActive()
      return result
    })
  }
  /** Dispose only after actual pin/export drain, never as settlement evidence. */
  dispose(): void {
    clearTimeout(this.timer)
  }
}
