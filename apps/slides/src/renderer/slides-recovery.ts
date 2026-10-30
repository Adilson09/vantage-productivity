import type {
  SlidesDraftActivation,
  SlidesDraftDiscarded,
  SlidesDraftResult,
  SlidesDraftSaveAcknowledgment,
  SlidesDraftState,
  SlidesDraftWriteRequest,
  SlidesPendingDraft,
} from '../shared/slides-draft'
import {
  onSlidesEditCommitError,
  onSlidesPendingChanged,
  retireSlidesPendingEditor,
} from './slides-pending-edit'

export interface SlidesRecoveryApi {
  activateDraft: (path: string | null, sourceIdentity?: string) => Promise<SlidesDraftActivation>
  writeDraft: (request: SlidesDraftWriteRequest) => Promise<SlidesDraftResult>
  acknowledgeDraftSave: (request: SlidesDraftSaveAcknowledgment) => Promise<SlidesDraftResult>
  draftState: () => Promise<SlidesDraftState | null>
  setPendingEditState: (token: string, dirty: boolean) => void
  onDraftDiscarded: (handler: (notice: SlidesDraftDiscarded) => void) => () => void
  onDraftWarning: (handler: (message: string) => void) => () => void
}
export interface SlidesRecoverySaveTicket {
  generation: number
  throughSequence: number
  activation: Promise<SlidesDraftActivation | null>
}
interface Dependencies {
  api: SlidesRecoveryApi
  capturePending: () => { pending: SlidesPendingDraft; composing: boolean }
  reportError: (error: unknown) => void
  markPendingDirty?: () => void
  sourceIdentity?: () => string
  maySnapshot?: () => boolean
}
const meaningful = (pending: SlidesPendingDraft) => !!pending.text || !!pending.notes

/** One client per view; snapshots do not blur or commit the active editor. */
export class SlidesRecoveryClient {
  private activation: Promise<SlidesDraftActivation | null> = Promise.resolve(null)
  private token: string | null = null
  private documentPath: string | null = null
  private generation = 0
  private sequence = 0
  private running: { generation: number } | null = null
  private stopped = true
  private suppressedFingerprint: string | null = null
  private lastWrittenFingerprint: string | null = null
  private needsActivation = false
  private lastError = ''
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: Array<() => void> = []
  constructor(private readonly dependencies: Dependencies) {}
  activate(path: string | null): void {
    retireSlidesPendingEditor()
    this.generation++
    this.sequence = 0
    this.documentPath = path || null
    this.token = null
    this.suppressedFingerprint = null
    this.lastWrittenFingerprint = null
    this.needsActivation = false
    this.lastError = ''
    this.startActivation()
  }
  throughSequence(): number {
    return this.sequence
  }
  rename(path: string): void {
    this.documentPath = path || null
  }
  start(): void {
    this.stop()
    this.stopped = false
    this.unsubscribe = [
      this.dependencies.api.onDraftWarning((message) => this.warn(message)),
      this.dependencies.api.onDraftDiscarded((notice) => this.discarded(notice)),
      onSlidesPendingChanged(() => this.pendingChanged()),
      onSlidesEditCommitError((error) => this.warn(error)),
    ]
    this.timer = setInterval(() => {
      void this.snapshot()
    }, 30000)
    this.pendingChanged()
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe()
  }
  beginSave(): SlidesRecoverySaveTicket {
    return {
      generation: this.generation,
      throughSequence: this.sequence,
      activation: this.activation,
    }
  }
  isCurrent(ticket: SlidesRecoverySaveTicket): boolean {
    return ticket.generation === this.generation
  }
  reportFailure(error: unknown): void {
    this.warn(error)
  }
  async acknowledgeSaved(
    ticket: SlidesRecoverySaveTicket,
    path: string,
    clean: boolean,
  ): Promise<void> {
    if (ticket.generation !== this.generation) return
    this.documentPath = path
    try {
      const activation = await ticket.activation
      if (ticket.generation !== this.generation || !activation?.token) return
      const result = await this.dependencies.api.acknowledgeDraftSave({
        token: activation.token,
        throughSequence: ticket.throughSequence,
        documentPath: path,
        clean,
      })
      if (!result.ok) throw new Error(result.error ?? 'Recovery cleanup did not finish.')
    } catch (error) {
      if (ticket.generation === this.generation) this.warn(error)
    }
  }
  hasPending(): boolean {
    const captured = this.dependencies.capturePending()
    return captured.composing || meaningful(captured.pending)
  }
  async snapshot(): Promise<boolean> {
    if (
      this.stopped ||
      this.running?.generation === this.generation ||
      this.dependencies.maySnapshot?.() === false
    )
      return false
    const running = { generation: this.generation }
    this.running = running
    // Reserve before activation/status IPC, so a real save can fence unfinished captures.
    const sequence = ++this.sequence
    let generation = this.generation
    const path = this.documentPath
    try {
      const state = await this.dependencies.api.draftState()
      if (this.stopped || generation !== this.generation || !state) return false
      const captured = this.dependencies.capturePending()
      if (captured.composing) return false
      const pending = structuredClone(captured.pending)
      if (new TextEncoder().encode(JSON.stringify(pending)).length > 1024 * 1024)
        throw new Error(
          'Pending presentation edits exceed the recovery limit. Save a copy to protect your changes.',
        )
      const fingerprint = JSON.stringify([state.revision, pending])
      if (
        this.suppressedFingerprint === fingerprint ||
        this.lastWrittenFingerprint === fingerprint ||
        (!state.dirty && !meaningful(pending))
      )
        return false
      if (this.needsActivation) {
        this.generation++
        generation = this.generation
        running.generation = generation
        this.needsActivation = false
        this.suppressedFingerprint = null
        this.lastWrittenFingerprint = null
        this.startActivation()
      }
      const activation = await this.activation
      if (this.stopped || generation !== this.generation) return false
      if (!activation?.ok || !activation.token)
        throw new Error(activation?.error ?? 'Recovery is not active for this presentation.')
      const result = await this.dependencies.api.writeDraft({
        token: activation.token,
        sequence,
        expectedRevision: state.revision,
        documentPath: path,
        pending,
      })
      if (!this.stopped && generation === this.generation && !result.ok)
        throw new Error(result.error ?? 'The recovery copy was not recorded.')
      if (generation === this.generation && result.ok && !result.skipped) {
        this.lastWrittenFingerprint = fingerprint
        this.lastError = ''
      }
      return result.ok && !result.skipped
    } catch (error) {
      if (!this.stopped && generation === this.generation) this.warn(error)
      return false
    } finally {
      if (this.running === running) this.running = null
    }
  }
  private startActivation(): void {
    const generation = this.generation
    this.activation = this.dependencies.api
      .activateDraft(this.documentPath, this.dependencies.sourceIdentity?.())
      .then(
        (value) => {
          if (
            !value ||
            typeof value.ok !== 'boolean' ||
            (value.ok && typeof value.token !== 'string')
          ) {
            const error = 'The presentation recovery service returned an invalid activation.'
            if (generation === this.generation) this.warn(new Error(error))
            return { ok: false, error }
          }
          if (generation === this.generation && value.ok && value.token) {
            this.token = value.token
            this.pendingChanged()
          }
          return value
        },
        (error) => {
          if (generation === this.generation) this.warn(error)
          return null
        },
      )
  }
  private pendingChanged(): void {
    if (this.stopped || !this.token) return
    try {
      const dirty = this.hasPending()
      this.dependencies.api.setPendingEditState(this.token, dirty)
      if (dirty) this.dependencies.markPendingDirty?.()
    } catch (error) {
      this.dependencies.api.setPendingEditState(this.token, true)
      this.dependencies.markPendingDirty?.()
      this.warn(error)
    }
  }
  private discarded(notice: SlidesDraftDiscarded): void {
    if (notice.token !== this.token) return
    this.generation++
    this.needsActivation = true
    try {
      this.suppressedFingerprint = JSON.stringify([
        notice.revision,
        this.dependencies.capturePending().pending,
      ])
    } catch (error) {
      this.suppressedFingerprint = null
      this.warn(error)
    }
  }
  private warn(error: unknown): void {
    const message = String(error)
    if (message === this.lastError) return
    this.lastError = message
    this.dependencies.reportError(error)
  }
}

let current: SlidesRecoveryClient | null = null
export function configureSlidesRecovery(client: SlidesRecoveryClient | null): void {
  current = client
}
export function slidesRecoveryClient(): SlidesRecoveryClient | null {
  return current
}
