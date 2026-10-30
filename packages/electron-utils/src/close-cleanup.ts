import { copyCloseCustodyReceipt, type CloseCustodyJson } from './close-custody-providers'
export type CloseCleanupPhase =
  | 'preparing'
  | 'staged'
  | 'committing'
  | 'running'
  | 'complete'
  | 'retained'
  | 'canceled'
  | 'purging'
  | 'purged'
export interface CloseCleanupLineage {
  id: string
  module: string
  ownerKey: string
  source: string
  generation: number
  token: string
  documentPath: string | null
}
export interface CloseCleanupCapturedEntry {
  module: string
  documentPath: string | null
  sha256: string
}
export interface CloseCleanupRestoration {
  id: string
  destination: string
  phase: 'preparing' | 'publishing' | 'pending-handoff' | 'handed-off' | 'canceled' | 'uncertain'
  created: boolean
  publicationAttempted?: boolean
}
export interface CloseCleanupStatus extends CloseCleanupLineage {
  custodyProvider?: string
  custodyReceipt?: CloseCustodyJson
  capturedEntry?: CloseCleanupCapturedEntry
  restoration?: CloseCleanupRestoration
  phase: CloseCleanupPhase
  updatedAt: string
  custody: boolean
  error?: string
}
export interface CloseCleanupFilter {
  module: string
  ownerKey?: string
  source?: string
  throughGeneration?: number
  documentPath?: string | null
  tokens?: readonly string[]
  excludeIds?: readonly string[]
  ids?: readonly string[]
}
export interface CloseCleanupTask extends CloseCleanupLineage {
  custody: {
    provider?: string
    input?: unknown
    recoveryRoot?: string
    draftId?: string
    attest?: () => { expectedDocumentPath: string | null; expectedSha256?: string } | null
  }
  /** Captured producer drain, indexed before it can await. */
  ready?: Promise<void>
  /** Captured UUID only. Never look up the current producer in this callback. */
  run(signal: AbortSignal): Promise<void>
}
export interface CloseCleanupHandle {
  readonly id: string
  status(): CloseCleanupStatus
  readonly outcome: Promise<CloseCleanupStatus>
  /** Caller must invoke this inside its live authority's exact-owner sync callback. */
  commitRemoval(remove: () => boolean): boolean
  cancel(reason?: string): void
}
export interface CloseCleanupAdmission {
  readonly id: string
  readonly ready: Promise<CloseCleanupHandle>
  /** Actual provider/admission work and its finalizers, including after caller timeout. */
  readonly actualSettled: Promise<void>
  cancel(reason?: string): void
}
export interface CloseCleanupRetirementActivity {
  busy: boolean
  retryable: boolean
  error?: string
}
export interface CloseCleanupRetirementAdmission {
  readonly ready: Promise<void>
  readonly actualSettled: Promise<void>
}
interface RetirementJob {
  ids: readonly string[]
  actualSettled: Promise<void>
  settled: boolean
  error?: string
  reportedError?: string
}
export interface CloseCleanupRestoreBudgets {
  ioTimeoutMs?: number
  handoffTimeoutMs?: number
}
export interface CloseCleanupRestoreReservation {
  readonly signal: AbortSignal
  readonly id: string
  status(): CloseCleanupStatus
  run<Result>(action: () => Promise<Result>): Promise<Result>
  beforePublication(): void
  created(): void
  commitHandoff(action: () => boolean): boolean
  cancel(reason?: string): void
}
interface RestoreJob {
  statusId: string
  info: CloseCleanupRestoration
  abort: AbortController
  invalidated: boolean
  actual: Promise<unknown>
  actualSettled: boolean
  started: boolean
  done: Promise<void>
  resolveDone(): void
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
}
interface Job {
  task: CloseCleanupTask
  status: CloseCleanupStatus
  abort: AbortController
  outcome: Promise<CloseCleanupStatus>
  resolve(value: CloseCleanupStatus): void
  preparation: Promise<void>
  preparationSettled: boolean
  execution?: Promise<void>
  pending: boolean
  retired: boolean
  finished: boolean
}
export interface CloseCleanupOptions {
  persist(status: CloseCleanupStatus): void
  prepare(
    task: CloseCleanupTask,
    signal: AbortSignal,
  ): Promise<
    | boolean
    | CloseCleanupCapturedEntry
    | { capturedEntry: CloseCleanupCapturedEntry; provider: string; receipt: CloseCustodyJson }
  >
  maintenanceAdmission?(status: CloseCleanupStatus): Promise<void>
  preparationTimeoutMs?(task: CloseCleanupTask): number
  restoreIoTimeoutMs?: number
  restoreHandoffTimeoutMs?: number
  purge(status: CloseCleanupStatus): Promise<void>
  warning(status: CloseCleanupStatus): void
  now?: () => string
  timeoutMs?: number
  /** Persisted records from another process: unfinished work is retained, never auto-replayed. */
  recovered?: readonly CloseCleanupStatus[]
  sameDocument?: (a: string | null, b: string | null) => boolean
}
function matches(
  status: CloseCleanupStatus,
  filter: CloseCleanupFilter,
  sameDocument: (a: string | null, b: string | null) => boolean,
): boolean {
  return (
    status.module === filter.module &&
    (filter.ownerKey === undefined || status.ownerKey === filter.ownerKey) &&
    (filter.source === undefined || status.source === filter.source) &&
    (filter.throughGeneration === undefined || status.generation <= filter.throughGeneration) &&
    (filter.documentPath === undefined || sameDocument(status.documentPath, filter.documentPath)) &&
    (filter.tokens === undefined || filter.tokens.includes(status.token)) &&
    (filter.excludeIds === undefined || !filter.excludeIds.includes(status.id)) &&
    (filter.ids === undefined || filter.ids.includes(status.id))
  )
}

/** Main-owned completion and quit custody; independent of Electron and app editors. */
export class CloseCleanupQueue {
  private readonly jobs = new Map<string, Job>()
  private readonly recovered = new Map<string, CloseCleanupStatus>()
  private readonly restorations = new Map<string, RestoreJob>()
  private readonly retirements = new Map<string, RetirementJob>()
  private workRevision = 0
  activityRevision(): number {
    return this.workRevision
  }
  constructor(private readonly options: CloseCleanupOptions) {
    for (const status of options.recovered ?? [])
      this.recovered.set(status.id, structuredClone(status))
  }
  private now() {
    return this.options.now?.() ?? new Date().toISOString()
  }
  private snapshot(job: Job) {
    return structuredClone(job.status)
  }
  private publish(job: Job, phase: CloseCleanupPhase, error?: string): void {
    job.status = {
      ...job.status,
      phase,
      updatedAt: this.now(),
      ...(error ? { error: error.slice(0, 4096) } : {}),
    }
    if (!error) delete job.status.error
    this.options.persist(this.snapshot(job))
  }
  private finish(job: Job, phase: CloseCleanupPhase, error?: string): void {
    if (job.finished) return
    job.finished = true
    job.pending = false
    try {
      this.publish(job, phase, error)
    } catch (failure) {
      job.status = {
        ...job.status,
        phase: 'retained',
        error: `Cleanup status could not be recorded: ${String(failure)}`,
        updatedAt: this.now(),
      }
    }
    job.resolve(this.snapshot(job))
    if (job.status.phase === 'retained')
      try {
        this.options.warning(this.snapshot(job))
      } catch {
        /* Durable status remains available for the next launch. */
      }
  }
  private async bounded<Result>(
    work: Promise<Result>,
    message: string,
    timeoutMs = this.options.timeoutMs ?? 5_000,
  ): Promise<Result> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  async stage(task: CloseCleanupTask): Promise<CloseCleanupHandle> {
    return this.begin(task).ready
  }
  begin(input: CloseCleanupTask): CloseCleanupAdmission {
    // Main capabilities may contain functions; copy/freeze the wrapper and all
    // scalar authority now, while keeping provider input internals provider-owned.
    const custody = input.custody
    const task: CloseCleanupTask = Object.freeze({
      id: input.id,
      module: input.module,
      ownerKey: input.ownerKey,
      source: input.source,
      generation: input.generation,
      token: input.token,
      documentPath: input.documentPath,
      ready: input.ready,
      run: input.run,
      custody: Object.freeze({
        provider: custody.provider,
        input: custody.input,
        recoveryRoot: custody.recoveryRoot,
        draftId: custody.draftId,
        attest: custody.attest,
      }),
    })
    if (this.jobs.has(task.id) || this.recovered.has(task.id))
      throw new Error('This cleanup request already exists.')
    let resolve!: (value: CloseCleanupStatus) => void
    const outcome = new Promise<CloseCleanupStatus>((done) => {
      resolve = done
    })
    const lineage: CloseCleanupLineage = {
      id: task.id,
      module: task.module,
      ownerKey: task.ownerKey,
      source: task.source,
      generation: task.generation,
      token: task.token,
      documentPath: task.documentPath,
    }
    const job: Job = {
      task,
      status: {
        ...lineage,
        custodyProvider: task.custody.provider ?? 'draft-journal',
        phase: 'preparing',
        updatedAt: this.now(),
        custody: false,
      },
      abort: new AbortController(),
      outcome,
      resolve,
      preparation: Promise.resolve(),
      preparationSettled: false,
      pending: false,
      retired: false,
      finished: false,
    }
    // Index lineage BEFORE any copy can await, so checked redaction retirement
    // sees every in-flight automatic custody generation.
    this.workRevision++
    this.jobs.set(task.id, job)
    let admission: Promise<void> = Promise.resolve()
    try {
      this.publish(job, 'preparing')
    } catch (error) {
      if (!this.options.maintenanceAdmission) {
        this.jobs.delete(task.id)
        throw error
      }
      // Remain indexed while bounded maintenance frees a durable slot. No
      // custody copy/removal can start until the preparing intent is persisted.
      admission = Promise.resolve()
        .then(() => this.options.maintenanceAdmission!(this.snapshot(job)))
        .then(() => {
          job.abort.signal.throwIfAborted()
          if (job.retired) throw new Error('The source was retired during maintenance admission.')
          this.publish(job, 'preparing')
        })
    }
    job.preparation = admission
      .then(async () => {
        await task.ready
        job.abort.signal.throwIfAborted()
        const captured = await this.options.prepare(task, job.abort.signal)
        if (typeof captured === 'object') {
          if ('capturedEntry' in captured) {
            const receipt = copyCloseCustodyReceipt(captured.receipt)
            job.status = {
              ...job.status,
              capturedEntry: { ...captured.capturedEntry },
              custodyProvider: captured.provider,
              custodyReceipt: receipt,
              custody: true,
            }
          } else job.status = { ...job.status, capturedEntry: { ...captured }, custody: true }
        } else job.status.custody = captured
        if (job.retired) {
          // A late verified capture is retained metadata, never late cleanup success.
          // Keep its binding durable so the next launch can review that exact copy.
          try {
            this.publish(
              job,
              job.status.phase === 'purging' ? 'purging' : 'retained',
              job.status.error ??
                'The custody source retired during preparation; primary recovery is retained.',
            )
          } catch {
            /* Earlier preparation intent remains conservative on restart. */
          }
          throw new Error('The custody source was retired during preparation.')
        }
      })
      .finally(() => {
        job.preparationSettled = true
      })
    let rejectCanceled!: (error: unknown) => void
    const canceled = new Promise<never>((_resolve, reject) => {
      rejectCanceled = reject
    })
    const onCancel = () =>
      rejectCanceled(
        job.abort.signal.reason ?? new Error('Close custody preparation was canceled.'),
      )
    job.abort.signal.addEventListener('abort', onCancel, { once: true })
    const ready = (async (): Promise<CloseCleanupHandle> => {
      try {
        await this.bounded(
          Promise.race([job.preparation, canceled]),
          'Preparing recovery custody timed out; primary recovery authority is retained.',
          this.options.preparationTimeoutMs?.(task),
        )
        if (job.retired) throw new Error('The custody source was retired.')
        this.publish(job, 'staged')
      } catch (error) {
        job.retired = true
        job.abort.abort()
        this.finish(job, 'retained', String(error))
        throw error
      } finally {
        job.abort.signal.removeEventListener('abort', onCancel)
      }
      return {
        id: task.id,
        status: () => this.snapshot(job),
        outcome,
        commitRemoval: (remove) => this.commit(job, remove),
        cancel: (reason) => this.cancel(job, reason),
      }
    })()
    // The main owner may disappear before attaching its waiter. Keep the
    // rejection observed without changing the rejecting ready contract/status.
    void ready.catch(() => {})
    return {
      id: task.id,
      ready,
      actualSettled: job.preparation.then(
        () => {},
        () => {},
      ),
      cancel: (reason) => this.cancel(job, reason),
    }
  }

  private cancel(job: Job, reason = 'Close canceled; recovery was retained.'): void {
    if (job.pending || job.finished) return
    job.retired = true
    job.abort.abort()
    this.finish(job, 'canceled', reason)
  }
  private commit(job: Job, remove: () => boolean): boolean {
    if (job.retired || job.finished || job.status.phase !== 'staged') return false
    // A before-quit fired by remove() sees this pending job immediately.
    this.workRevision++
    job.pending = true
    try {
      this.publish(job, 'committing')
    } catch (error) {
      job.retired = true
      job.abort.abort()
      this.finish(job, 'retained', String(error))
      return false
    }
    let removed = false
    try {
      removed = remove()
      if (typeof removed !== 'boolean')
        throw new Error('Cleanup requires synchronous actual removal.')
    } catch (error) {
      job.pending = false
      this.cancel(job, String(error))
      throw error
    }
    if (!removed) {
      job.pending = false
      this.cancel(job)
      return false
    }
    try {
      this.publish(job, 'running')
    } catch (error) {
      job.retired = true
      job.abort.abort()
      this.finish(job, 'retained', String(error))
      return true
    }
    job.execution = Promise.resolve().then(async () => {
      if (job.retired) throw new Error('Cleanup was retired.')
      await job.task.run(job.abort.signal)
    })
    void this.bounded(
      job.execution,
      'Recovery cleanup timed out; available custody and owned recovery status are retained.',
    ).then(
      () => this.finish(job, 'complete'),
      (error) => {
        job.retired = true
        job.abort.abort()
        this.finish(job, 'retained', String(error))
      },
    )
    return true
  }
  hasPending(): boolean {
    return (
      [...this.jobs.values()].some((job) => job.pending || !job.preparationSettled) ||
      [...this.restorations.values()].some(
        (restore) => !restore.settled || !restore.actualSettled,
      ) ||
      [...this.retirements.values()].some((job) => !job.settled)
    )
  }
  async drain(): Promise<CloseCleanupStatus[]> {
    const pending = [...this.jobs.values()].filter((job) => job.pending || !job.preparationSettled)
    const restoring = [...this.restorations.values()].filter(
      (restore) => !restore.settled || !restore.actualSettled,
    )
    const retiring = [...new Set(this.retirements.values())].filter((job) => !job.settled)
    try {
      await this.bounded(
        Promise.allSettled([
          ...pending.map((job) => (job.pending ? job.outcome : job.preparation)),
          ...restoring.map((restore) => Promise.allSettled([restore.actual, restore.done])),
          ...retiring.map((job) => job.actualSettled),
        ]),
        'The cleanup drain did not finish; durable custody/status remains for the next launch.',
      )
      return [
        ...pending.map((job) => this.snapshot(job)),
        ...retiring.flatMap((retirement) =>
          retirement.ids
            .map((id) => this.status(id))
            .filter((status): status is CloseCleanupStatus => !!status),
        ),
      ]
    } catch (error) {
      for (const job of pending)
        if (!job.finished) {
          job.retired = true
          job.abort.abort()
          this.finish(job, 'retained', String(error))
        }
      for (const restore of restoring)
        if (!restore.settled) {
          restore.invalidated = true
          restore.abort.abort()
          if (!restore.started) restore.actualSettled = true
          this.finishRestore(restore, this.restoreMayExist(restore), String(error))
        }
      for (const retirement of retiring)
        if (!retirement.settled) this.noteRetirementBusy(retirement, String(error))
      return [
        ...pending.map((job) => this.snapshot(job)),
        ...retiring.flatMap((retirement) =>
          retirement.ids
            .map((id) => this.status(id))
            .filter((status): status is CloseCleanupStatus => !!status),
        ),
      ]
    }
  }
  status(id: string): CloseCleanupStatus | undefined {
    const job = this.jobs.get(id)
    return job
      ? this.snapshot(job)
      : this.recovered.has(id)
        ? structuredClone(this.recovered.get(id)!)
        : undefined
  }
  async outcome(id: string): Promise<CloseCleanupStatus | undefined> {
    const job = this.jobs.get(id)
    return job ? job.outcome : this.status(id)
  }
  query(filter: CloseCleanupFilter): CloseCleanupStatus[] {
    const records = [
      ...this.recovered.values(),
      ...[...this.jobs.values()].map((job) => job.status),
    ]
    return records
      .filter((status) => matches(status, filter, this.options.sameDocument ?? ((a, b) => a === b)))
      .map((status) => structuredClone(status))
  }
  /** A trusted app may record an owned failure without claiming a custody copy. */
  recordFailure(lineage: CloseCleanupLineage, error: string): CloseCleanupStatus {
    if (this.status(lineage.id)) throw new Error('This cleanup request already exists.')
    const status: CloseCleanupStatus = {
      ...lineage,
      phase: 'retained',
      updatedAt: this.now(),
      custody: false,
      error: error.slice(0, 4096),
    }
    this.recovered.set(lineage.id, status)
    try {
      this.options.persist(structuredClone(status))
    } catch (failure) {
      try {
        this.options.warning(structuredClone(status))
      } catch {}
      throw failure
    }
    try {
      this.options.warning(structuredClone(status))
    } catch {
      /* The retained status is durable. */
    }
    return structuredClone(status)
  }
  /** Bounded private maintenance may forget only successful/purged terminal work. */
  forgetCompleted(id: string): boolean {
    const status = this.status(id)
    if (
      !status ||
      !['complete', 'purged'].includes(status.phase) ||
      this.retirements.get(id)?.settled === false ||
      this.restorations.has(id) ||
      (status.restoration && !['handed-off', 'canceled'].includes(status.restoration.phase))
    )
      return false
    const job = this.jobs.get(id)
    if (job?.pending) return false
    this.jobs.delete(id)
    this.recovered.delete(id)
    this.retirements.delete(id)
    return true
  }
  private updateStatus(
    id: string,
    update: (status: CloseCleanupStatus) => CloseCleanupStatus,
  ): CloseCleanupStatus {
    const status = this.status(id)
    if (!status) throw new Error('Recovery custody is unavailable.')
    const next = update(status)
    this.options.persist(next)
    const job = this.jobs.get(id)
    if (job) job.status = next
    else this.recovered.set(id, next)
    return next
  }
  private restoreMayExist(restore: RestoreJob): boolean {
    return (
      restore.info.created ||
      restore.info.publicationAttempted === true ||
      restore.info.phase === 'publishing'
    )
  }
  private finishRestore(restore: RestoreJob, uncertain: boolean, reason: string): void {
    if (restore.settled) return
    restore.settled = true
    if (restore.timer !== undefined) clearTimeout(restore.timer)
    restore.info = { ...restore.info, phase: uncertain ? 'uncertain' : 'canceled' }
    const previous = this.status(restore.statusId)
    let status: CloseCleanupStatus | undefined
    try {
      status = this.updateStatus(restore.statusId, (prior) => ({
        ...prior,
        phase: uncertain ? 'retained' : prior.phase,
        restoration: { ...restore.info },
        updatedAt: this.now(),
        ...(uncertain
          ? {
              error:
                `A separate restoration output needs review: ${restore.info.destination}. ${reason}`.slice(
                  0,
                  4096,
                ),
            }
          : {}),
      }))
    } catch (error) {
      // Earlier durable publication intent remains conservative on restart;
      // preserve the same uncertainty in memory without masking the writer error.
      if (previous) {
        status = {
          ...previous,
          phase: 'retained',
          restoration: { ...restore.info },
          updatedAt: this.now(),
          error:
            `Restoration status could not be recorded; review ${restore.info.destination}. ${String(error)}`.slice(
              0,
              4096,
            ),
        }
        const job = this.jobs.get(restore.statusId)
        if (job) job.status = status
        else this.recovered.set(restore.statusId, status)
      }
    } finally {
      restore.resolveDone()
      if (restore.actualSettled && this.restorations.get(restore.statusId) === restore)
        this.restorations.delete(restore.statusId)
    }
    if ((uncertain || status?.phase === 'retained') && status)
      try {
        this.options.warning(structuredClone(status))
      } catch {
        /* Durable unresolved intent remains available on restart. */
      }
  }
  reserveRestore(
    id: string,
    destination: string,
    restoreId: string,
    budgets: CloseCleanupRestoreBudgets = {},
  ): CloseCleanupRestoreReservation {
    const ioTimeoutMs =
        budgets.ioTimeoutMs ?? this.options.restoreIoTimeoutMs ?? this.options.timeoutMs ?? 5_000,
      handoffTimeoutMs = budgets.handoffTimeoutMs ?? this.options.restoreHandoffTimeoutMs ?? 120_000
    for (const budget of [ioTimeoutMs, handoffTimeoutMs])
      if (!Number.isSafeInteger(budget) || budget < 1 || budget > 120_000)
        throw new Error('Invalid main-owned restoration budget.')
    const status = this.status(id)
    if (
      !status ||
      this.retirements.get(id)?.settled === false ||
      !status.custody ||
      !status.capturedEntry ||
      !['retained', 'canceled', 'complete'].includes(status.phase) ||
      this.restorations.has(id) ||
      (status.restoration && !['handed-off', 'canceled'].includes(status.restoration.phase))
    )
      throw new Error('Recovery custody has an unresolved or unavailable restoration.')
    let resolveDone!: () => void
    const restore: RestoreJob = {
      statusId: id,
      info: { id: restoreId, destination, phase: 'preparing', created: false },
      abort: new AbortController(),
      invalidated: false,
      actual: Promise.resolve(),
      actualSettled: false,
      started: false,
      done: new Promise<void>((done) => {
        resolveDone = done
      }),
      resolveDone: () => resolveDone(),
      settled: false,
    }
    this.workRevision++
    this.restorations.set(id, restore)
    try {
      this.updateStatus(id, (prior) => ({
        ...prior,
        restoration: { ...restore.info },
        updatedAt: this.now(),
      }))
    } catch (error) {
      this.restorations.delete(id)
      throw error
    }
    const invalid = () =>
      restore.invalidated ||
      restore.abort.signal.aborted ||
      !['retained', 'canceled', 'complete'].includes(this.status(id)?.phase ?? '')
    let rejectDeadline!: (error: unknown) => void
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject
    })
    // A reserved operation can expire before its consumer calls run().
    void deadline.catch(() => {})
    const cancel = (reason = 'The pending restoration was canceled.') => {
      restore.invalidated = true
      restore.abort.abort()
      if (!restore.started) restore.actualSettled = true
      this.finishRestore(restore, this.restoreMayExist(restore), reason)
      rejectDeadline(new Error(reason))
    }
    restore.timer = setTimeout(
      () =>
        cancel(
          'The bounded restoration I/O interval expired; actual work remains reserved until settlement.',
        ),
      ioTimeoutMs,
    )
    return {
      id: restoreId,
      signal: restore.abort.signal,
      status: () => this.status(id)!,
      beforePublication: () => {
        if (restore.settled || !restore.started || invalid())
          throw new Error('The restoration source was retired before publication.')
        restore.info = { ...restore.info, phase: 'publishing', publicationAttempted: true }
        this.updateStatus(id, (prior) => ({
          ...prior,
          restoration: { ...restore.info },
          updatedAt: this.now(),
        }))
      },
      created: () => {
        if (restore.settled && restore.actualSettled)
          throw new Error('This restoration writer has already settled.')
        restore.info = {
          ...restore.info,
          created: true,
          publicationAttempted: true,
          ...(restore.settled ? { phase: 'uncertain' as const } : {}),
        }
        this.updateStatus(id, (prior) => ({
          ...prior,
          ...(restore.settled
            ? {
                phase: 'retained' as const,
                error: 'A late restoration output needs explicit review.',
              }
            : {}),
          restoration: { ...restore.info },
          updatedAt: this.now(),
        }))
      },
      run: <Result>(action: () => Promise<Result>): Promise<Result> => {
        if (restore.started || restore.settled)
          return Promise.reject(new Error('This restoration writer is single-use.'))
        restore.started = true
        const actual = Promise.resolve()
          .then(() => {
            if (invalid()) throw new Error('The restoration source is retired.')
            return action()
          })
          .then((value) => {
            restore.actualSettled = true
            if (invalid()) {
              this.finishRestore(
                restore,
                this.restoreMayExist(restore),
                'Source retirement overlapped restoration.',
              )
              throw new Error(
                'The restoration source retired; the visible output was retained without a trusted handoff.',
              )
            }
            if (restore.timer !== undefined) clearTimeout(restore.timer)
            restore.timer = setTimeout(
              () => cancel('The main-owned restoration handoff interval expired.'),
              handoffTimeoutMs,
            )
            restore.info = { ...restore.info, phase: 'pending-handoff' }
            this.updateStatus(id, (prior) => ({
              ...prior,
              restoration: { ...restore.info },
              updatedAt: this.now(),
            }))
            return value
          })
          .catch((error) => {
            restore.actualSettled = true
            this.finishRestore(restore, this.restoreMayExist(restore), String(error))
            throw error
          })
        restore.actual = actual
        void actual
          .finally(() => {
            if (restore.settled && this.restorations.get(id) === restore)
              this.restorations.delete(id)
          })
          .catch(() => {})
        return Promise.race([actual, deadline])
      },
      commitHandoff: (action) => {
        if (restore.settled || !restore.actualSettled || invalid()) {
          cancel('Trusted handoff was refused after source retirement.')
          return false
        }
        let committed = false
        try {
          committed = action()
          if (typeof committed !== 'boolean')
            throw new Error('A restoration handoff must return a synchronous Boolean.')
          if (!committed) {
            cancel('The separate output was not handed to its owner.')
            return false
          }
          restore.info = { ...restore.info, phase: 'handed-off' }
          try {
            this.updateStatus(id, (prior) => ({
              ...prior,
              restoration: { ...restore.info },
              updatedAt: this.now(),
            }))
          } catch (error) {
            const previous = this.status(id)!
            const retained = {
              ...previous,
              phase: 'retained' as const,
              restoration: { ...restore.info },
              updatedAt: this.now(),
              error:
                `The output was handed off, but its status could not be recorded: ${String(error)}`.slice(
                  0,
                  4096,
                ),
            }
            const job = this.jobs.get(id)
            if (job) job.status = retained
            else this.recovered.set(id, retained)
            try {
              this.options.warning(retained)
            } catch {
              /* Durable earlier intent remains for replay. */
            }
          }
          restore.settled = true
          if (restore.timer !== undefined) clearTimeout(restore.timer)
          if (this.restorations.get(id) === restore) this.restorations.delete(id)
          restore.resolveDone()
          return true
        } catch (error) {
          cancel(String(error))
          throw error
        }
      },
      cancel,
    }
  }
  /** Main calls only after an explicit review of the selected output artifact. */
  acknowledgeRestoreArtifact(id: string, restoreId: string): void {
    const status = this.status(id),
      active = this.restorations.get(id)
    if (
      !status?.restoration ||
      status.restoration.id !== restoreId ||
      status.restoration.phase !== 'uncertain' ||
      (active && !active.actualSettled)
    )
      throw new Error('That restoration has not reached a reviewable terminal state.')
    this.updateStatus(id, (prior) => ({
      ...prior,
      phase: prior.phase === 'purging' ? 'retained' : prior.phase,
      restoration: { ...prior.restoration!, phase: 'handed-off' },
      updatedAt: this.now(),
      error:
        'The separate output was acknowledged as user-owned; retained custody may now be selected independently.',
    }))
    this.restorations.delete(id)
  }
  retirementActivity(id: string): CloseCleanupRetirementActivity {
    const job = this.retirements.get(id),
      status = this.status(id)
    if (job && !job.settled)
      return {
        busy: true,
        retryable: false,
        ...(job.reportedError ? { error: job.reportedError } : {}),
      }
    const error =
      job?.error ??
      (status?.phase === 'purging'
        ? (status.error ?? 'Earlier removal did not reach a recorded terminal state.')
        : undefined)
    return {
      busy: false,
      retryable: !!status && status.phase !== 'purged' && !!error,
      ...(error ? { error } : {}),
    }
  }
  private noteRetirementBusy(job: RetirementJob, reason: string): void {
    job.reportedError = reason.slice(0, 4096)
    for (const id of job.ids) {
      if (this.retirements.get(id) !== job) continue
      const status = this.status(id)
      if (!status || status.phase === 'purged') continue
      const next = {
        ...status,
        updatedAt: this.now(),
        error: (
          'Recovery removal is still finishing; its actual work remains owned. ' + reason
        ).slice(0, 4096),
      }
      const entry = this.jobs.get(id)
      if (entry) entry.status = next
      else this.recovered.set(id, next)
      try {
        this.options.persist(structuredClone(next))
      } catch {
        /* Earlier purging intent remains durable. */
      }
      try {
        this.options.warning(structuredClone(next))
      } catch {
        /* Review remains available from the persisted record. */
      }
    }
  }
  private retainRetirement(job: RetirementJob, error: unknown): void {
    job.error = String(error).slice(0, 4096)
    for (const id of job.ids) {
      if (this.retirements.get(id) !== job) continue
      const status = this.status(id)
      if (!status || status.phase === 'purged') continue
      let next: CloseCleanupStatus = {
        ...status,
        phase: 'retained',
        updatedAt: this.now(),
        error: ('Checked recovery removal failed. ' + String(error)).slice(0, 4096),
      }
      const entry = this.jobs.get(id)
      if (entry) entry.status = next
      else this.recovered.set(id, next)
      try {
        this.options.persist(structuredClone(next))
      } catch (failure) {
        next = {
          ...next,
          error: (next.error + ' Its status could not be updated: ' + String(failure)).slice(
            0,
            4096,
          ),
        }
        if (entry) entry.status = next
        else this.recovered.set(id, next)
      }
      try {
        this.options.warning(structuredClone(next))
      } catch {
        /* Previous intent and current retained state remain conservative. */
      }
    }
  }
  /** Index exact selected IDs before any await. Caller deadlines never settle actual purge work. */
  beginRetirement(filter: CloseCleanupFilter, reason: string): CloseCleanupRetirementAdmission {
    const records = this.query(filter)
    const busy = [
      ...new Set(
        records
          .map((status) => this.retirements.get(status.id))
          .filter((job): job is RetirementJob => !!job && !job.settled),
      ),
    ]
    if (busy.length) {
      const ready = Promise.reject<void>(
        new Error(
          'An earlier recovery removal is still finishing; refresh after its actual work settles.',
        ),
      )
      void ready.catch(() => {})
      return {
        ready,
        actualSettled: Promise.all(busy.map((job) => job.actualSettled)).then(() => {}),
      }
    }
    if (!records.length) return { ready: Promise.resolve(), actualSettled: Promise.resolve() }
    let resolveActual!: () => void
    const job: RetirementJob = {
      ids: Object.freeze(records.map((status) => status.id)),
      actualSettled: new Promise<void>((done) => {
        resolveActual = done
      }),
      settled: false,
    }
    this.workRevision++
    for (const id of job.ids) this.retirements.set(id, job)
    // Calling the async method executes retirement/flooring synchronously up
    // to its first real await, after the ownership index above already exists.
    const actual = this.retireActual(records, reason)
      .catch((error) => {
        this.retainRetirement(job, error)
        throw error
      })
      .finally(() => {
        job.settled = true
        resolveActual()
      })
    const ready = this.bounded(
      actual,
      'Automatic custody, restoration, or recovery removal is still changing; checked removal timed out and remains incomplete.',
    )
    void ready.catch((error) => {
      if (!job.settled) this.noteRetirementBusy(job, String(error))
    })
    return { ready, actualSettled: job.actualSettled }
  }
  async retire(filter: CloseCleanupFilter, reason: string): Promise<void> {
    return this.beginRetirement(filter, reason).ready
  }
  private async retireActual(
    records: readonly CloseCleanupStatus[],
    reason: string,
  ): Promise<void> {
    const actual: Promise<unknown>[] = []
    const restores: RestoreJob[] = []
    for (const status of records) {
      const restore = this.restorations.get(status.id)
      if (restore) {
        restore.invalidated = true
        restore.abort.abort()
        if (!restore.started) restore.actualSettled = true
        restores.push(restore)
        actual.push(restore.actual, restore.done)
        if (restore.actualSettled)
          this.finishRestore(
            restore,
            this.restoreMayExist(restore),
            'Source retirement overlapped a pending restoration.',
          )
      }
    }
    let persistenceFailure: unknown
    for (const status of records) {
      const latest = this.status(status.id) ?? status
      const retiring = {
        ...latest,
        phase: 'purging' as const,
        updatedAt: this.now(),
        error: reason.slice(0, 4096),
      }
      const job = this.jobs.get(status.id)
      if (job) {
        job.retired = true
        job.abort.abort()
        actual.push(job.preparation, ...(job.execution ? [job.execution] : []))
        job.status = retiring
      } else this.recovered.set(status.id, retiring)
      try {
        this.options.persist(retiring)
      } catch (error) {
        persistenceFailure ??= error
      }
      if (job && !job.finished) this.finish(job, 'purging', reason)
    }
    await Promise.allSettled(actual)
    if (persistenceFailure) throw persistenceFailure
    for (const status of records) {
      const current = this.status(status.id)
      if (
        current?.restoration?.phase === 'uncertain' ||
        restores.some((restore) => restore.statusId === status.id && this.restoreMayExist(restore))
      )
        throw new Error(
          'A separate restoration artifact needs review; privacy cleanup is incomplete.',
        )
    }
    for (const status of records) {
      await this.options.purge(this.status(status.id) ?? status)
      const purged = {
        ...(this.status(status.id) ?? status),
        phase: 'purged' as const,
        custody: false,
        updatedAt: this.now(),
        error: undefined,
      }
      this.options.persist(purged)
      const job = this.jobs.get(status.id)
      if (job) job.status = purged
      else this.recovered.set(status.id, purged)
    }
  }
}
