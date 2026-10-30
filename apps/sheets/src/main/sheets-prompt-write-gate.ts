import type { CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
import type { WorkbookWriteContext } from '../shared/desktop-api'

export class SheetsPromptWriteError extends Error {
  readonly code = 'workbook_close_write_blocked'
}

/** Main-owned admission; a context supplied over IPC is never this capability. */
export interface SheetsWorkbookWriteAdmission {
  readonly ready: Promise<void>
}

interface Admission<Owner> {
  owner: Owner
  epoch: number
  origin: WorkbookWriteContext['origin'] | undefined
  ticket?: CloseLeaseTicket
}

export interface SheetsPromptWriteGateOptions<Owner> {
  alive(owner: Owner): boolean
  currentClose(owner: Owner): CloseLeaseTicket | undefined
  acceptsClose(owner: Owner, ticket: CloseLeaseTicket): boolean
  assertTransportWriter(owner: Owner, ticket?: CloseLeaseTicket): void
  cancelExactClose(owner: Owner, ticket: CloseLeaseTicket, reason: string): void
  /** Capture existing native/renderer publication tails BEFORE the caller queues its own work. */
  actualSettled(owner: Owner): Promise<void>
}

const sameTicket = (a: CloseLeaseTicket, b: CloseLeaseTicket) =>
  a.id === b.id && a.sequence === b.sequence && a.source === b.source

export function parseWorkbookWriteContext(value: unknown): WorkbookWriteContext | undefined {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, 'origin')
  )
    throw new SheetsPromptWriteError('Invalid workbook write context.')
  const origin = (value as Record<string, unknown>).origin
  if (origin !== 'automatic' && origin !== 'manual' && origin !== 'close')
    throw new SheetsPromptWriteError('Invalid workbook write origin.')
  return { origin }
}

/** Covers the native-dialog interval before the renderer close transport exists. */
export class SheetsPromptWriteGate<Owner extends object> {
  private readonly prompts = new WeakMap<Owner, CloseLeaseTicket>()
  private readonly epochs = new WeakMap<Owner, number>()
  private readonly admissions = new WeakMap<SheetsWorkbookWriteAdmission, Admission<Owner>>()

  constructor(private readonly options: SheetsPromptWriteGateOptions<Owner>) {}

  beginPrompt(owner: Owner, ticket: CloseLeaseTicket): void {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1)
    this.prompts.set(owner, Object.freeze({ ...ticket }))
  }

  /** Release is synchronous and exact: an old dialog's finally cannot unlock a successor. */
  releasePrompt(owner: Owner, ticket: CloseLeaseTicket): void {
    const current = this.prompts.get(owner)
    if (current && sameTicket(current, ticket)) this.prompts.delete(owner)
  }

  admit(
    owner: Owner,
    context: WorkbookWriteContext | undefined,
    ticket?: CloseLeaseTicket,
  ): SheetsWorkbookWriteAdmission {
    if (!this.options.alive(owner))
      throw new SheetsPromptWriteError('The workbook owner is no longer available.')
    const origin = parseWorkbookWriteContext(context)?.origin
    const prompt = this.prompts.get(owner)
    if (origin === 'close') {
      // Matching a visible prompt alone cannot authorize a close writer. The
      // real sender-bound renderer request must already have claimed its ticket.
      if (
        !ticket ||
        (prompt && !sameTicket(prompt, ticket)) ||
        !this.options.acceptsClose(owner, ticket)
      )
        throw new SheetsPromptWriteError('This writer does not own the current close request.')
      this.options.assertTransportWriter(owner, ticket)
    } else {
      if (ticket) throw new SheetsPromptWriteError('Only a close writer may carry a close ticket.')
      if (prompt && origin !== 'manual')
        throw new SheetsPromptWriteError(
          'Automatic workbook writes are paused while the close question is open.',
        )
      if (origin === 'manual') {
        const current = prompt ?? this.options.currentClose(owner)
        if (current) {
          this.options.cancelExactClose(
            owner,
            current,
            'an explicit workbook write superseded this close request',
          )
          // A failed cancellation must not be treated as a released prompt.
          const remaining = this.prompts.get(owner)
          if (remaining && sameTicket(remaining, current))
            throw new SheetsPromptWriteError(
              'The close question has not released its writer reservation.',
            )
        }
      } else this.options.assertTransportWriter(owner)
    }
    const state: Admission<Owner> = {
      owner,
      epoch: this.epochs.get(owner) ?? 0,
      origin,
      ...(ticket ? { ticket: Object.freeze({ ...ticket }) } : {}),
    }
    // Evaluate the snapshot synchronously. The caller MUST await ready before
    // runDocumentPublication; waiting inside its own tail would deadlock.
    const tail = origin === 'manual' ? this.options.actualSettled(owner) : Promise.resolve()
    const admission: SheetsWorkbookWriteAdmission = Object.freeze({
      ready: tail.then(() => this.assert(owner, admission)),
    })
    this.admissions.set(admission, state)
    return admission
  }

  /** Recheck after every queue/dialog wait and immediately before publication. */
  assert(owner: Owner, admission: SheetsWorkbookWriteAdmission): void {
    const state = this.admissions.get(admission)
    if (
      !state ||
      state.owner !== owner ||
      !this.options.alive(owner) ||
      state.epoch !== (this.epochs.get(owner) ?? 0)
    )
      throw new SheetsPromptWriteError(
        'A newer close question superseded this queued workbook write.',
      )
    const prompt = this.prompts.get(owner)
    if (state.origin === 'close') {
      if (
        !state.ticket ||
        (prompt && !sameTicket(prompt, state.ticket)) ||
        !this.options.acceptsClose(owner, state.ticket)
      )
        throw new SheetsPromptWriteError('The close writer no longer owns its exact request.')
    } else if (prompt)
      throw new SheetsPromptWriteError('A close question is reserving this workbook.')
    this.options.assertTransportWriter(owner, state.ticket)
  }
}
