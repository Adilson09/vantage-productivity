import { randomUUID } from 'node:crypto'
import { CloseLeaseBroker, isCloseLeaseTicket, isCloseLeaseStamp, type CloseLeaseStamp, type CloseLeaseTicket } from '@vantage/electron-utils/close-lease'
import type { CloseCleanupHandle } from '@vantage/electron-utils/close-cleanup'
import { PDF_WORKSPACE_LIMITS, decodePdfWorkspaceState, pdfWorkspacePendingReasons, type PdfDraftCloseFloor, type PdfCloseIntent, type PdfClosePrepared, type PdfCloseReceipt, type PdfCloseRelease, type PdfCloseRequest, type PdfCloseState } from '../shared/pdf-workspace'

interface Preparation {
  ticket: CloseLeaseTicket; intent: PdfCloseIntent; draftToken: string | null
  resolve(receipt: PdfCloseReceipt): void; reject(error: Error): void
  rendererSettled: boolean; released: boolean; cleanupPending: boolean; processing: boolean
  floor?: PdfDraftCloseFloor; cleanup?: CloseCleanupHandle; receipt?: PdfCloseReceipt
  staging?: PdfCleanupPreparation
  options: PdfCloseOptions
  removeAbort?: () => void
  failure?: Error
}
/** Trusted main callbacks only. Never sent to the renderer or accepted from IPC. */
export interface PdfCloseOptions { deferSeal?: boolean; signal?: AbortSignal; isCurrent?: () => boolean }
export function pdfCloseOptionsCurrent(options: PdfCloseOptions): boolean {
  try {
    if (options.deferSeal !== undefined && typeof options.deferSeal !== 'boolean') return false
    if (options.signal && (typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function' || options.signal.aborted)) return false
    return options.isCurrent === undefined || options.isCurrent() === true
  } catch { return false }
}
export interface PdfCleanupPreparation { ready: Promise<CloseCleanupHandle>; actualSettled: Promise<unknown>; cancel(reason?: string): void }
export interface PdfCloseDependencies {
  alive(owner: number): boolean
  source(owner: number): string
  canReady(owner: number): boolean
  unpublished(owner: number): boolean
  draftToken(owner: number): string | null
  stage(owner: number, floor: PdfDraftCloseFloor, cleanupId: string): PdfCleanupPreparation
  resume(owner: number, floor: PdfDraftCloseFloor): boolean
  prepare(owner: number, request: PdfCloseRequest): void
  release(owner: number, response: PdfCloseRelease): void
  query(owner: number, id: string): void
}
const same = (left: CloseLeaseTicket, right: CloseLeaseTicket) => left.id === right.id && left.sequence === right.sequence && left.source === right.source
const sameStamp = (left: { source: string; revision: string }, right: { source: string; revision: string }) => left.source === right.source && left.revision === right.revision
const sameReceipt = (left: PdfCloseReceipt, right: PdfCloseReceipt) => left.phase === right.phase && same(left.ticket, right.ticket) && sameStamp(left.stamp, right.stamp) && left.intent === right.intent && left.cleanupId === right.cleanupId
/** Main alone owns readiness/expiry/removal. Prepare retains durable recovery;
 * captured-token cleanup starts only inside the exact synchronous removal. */
export class PdfCloseCoordinator {
  private readonly entries = new Map<number, Preparation>()
  private readonly completed = new Set<string>()
  private readonly queries = new Map<number, { id: string; source: string; options: PdfCloseOptions; resolve(value: PdfCloseState): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; removeAbort(): void }>()
  private readonly broker: CloseLeaseBroker<number>
  constructor(private readonly dependencies: PdfCloseDependencies) {
    this.broker = new CloseLeaseBroker({
      alive: owner => dependencies.alive(owner), source: owner => dependencies.source(owner),
      validate: (owner, ticket, stamp) => {
        const entry = this.entries.get(owner)
        return !!entry?.receipt && same(entry.ticket, ticket) && sameStamp(entry.receipt.stamp, stamp) && this.validHeld(owner, entry)
      },
      release: (owner, ticket, reason) => {
        const entry = this.entries.get(owner)
        const closed = reason === 'destroyed' || this.completed.has(ticket.id)
        let resumeRecovery = !closed && reason !== 'explicit draft discard'
        if (entry && same(entry.ticket, ticket)) {
          entry.removeAbort?.(); entry.removeAbort = undefined
          entry.released = true
          if (!closed) entry.cleanup?.cancel(reason)
          if (!closed) entry.staging?.cancel(reason)
          // Restore the same producer/floors before the renderer unlocks. Never
          // reactivate a new UUID while its retained journal still exists.
          if (resumeRecovery && entry.floor) resumeRecovery = dependencies.resume(owner, entry.floor)
          entry.reject(entry.failure ?? new Error(`PDF close was canceled or expired (${reason}). Its pending content was kept.`))
          if (entry.rendererSettled && !entry.cleanupPending) this.entries.delete(owner)
        }
        dependencies.release(owner, { ticket, closed, resumeRecovery })
      },
    })
  }
  query(owner: number, options: PdfCloseOptions = {}): Promise<PdfCloseState> {
    if (!pdfCloseOptionsCurrent(options)) return Promise.reject(new Error('The PDF close group was canceled before its pending-state query.'))
    if (!this.dependencies.alive(owner) || this.queries.has(owner) || this.entries.has(owner)) return Promise.reject(new Error('This PDF is closed or another close operation is still finishing.'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const removeAbort = () => options.signal?.removeEventListener('abort', abort)
      const finishError = (error: Error) => { if (this.queries.get(owner)?.id !== id) return; clearTimeout(timer); removeAbort(); this.queries.delete(owner); reject(error) }
      const abort = () => finishError(new Error('The PDF close group was canceled while querying pending state.'))
      const timer = setTimeout(() => finishError(new Error('The PDF editor did not finish reporting its pending state.')), 10000)
      this.queries.set(owner, { id, source: this.dependencies.source(owner), options: { signal: options.signal, isCurrent: options.isCurrent }, timer, resolve, reject, removeAbort })
      options.signal?.addEventListener('abort', abort, { once: true })
      if (!pdfCloseOptionsCurrent(options)) { abort(); return }
      try { this.dependencies.query(owner, id) } catch (error) { finishError(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  queried(owner: number, id: unknown, state: unknown): void {
    const waiting = this.queries.get(owner)
    if (!waiting || waiting.id !== id) return
    clearTimeout(waiting.timer); waiting.removeAbort(); this.queries.delete(owner)
    if (!this.dependencies.alive(owner) || this.dependencies.source(owner) !== waiting.source || !pdfCloseOptionsCurrent(waiting.options)) { waiting.reject(new Error('The PDF source or close group changed during its pending-state query.')); return }
    const result = state as PdfCloseState | null
    if (!result || !isCloseLeaseStamp(result.stamp) || typeof result.pending !== 'boolean' || typeof result.busy !== 'boolean') { waiting.reject(new Error('The PDF pending-state receipt was invalid.')); return }
    waiting.resolve({ stamp: { ...result.stamp }, pending: result.pending || this.dependencies.unpublished(owner), busy: result.busy || !this.dependencies.canReady(owner) })
  }
  prepare(owner: number, intent: PdfCloseIntent, approvedStamp?: CloseLeaseStamp, options: PdfCloseOptions = {}): Promise<PdfCloseReceipt> {
    if (!pdfCloseOptionsCurrent(options)) return Promise.reject(new Error('The PDF close group was canceled before Save or Discard was dispatched.'))
    if (!['save', 'discard', 'clean'].includes(intent) || this.entries.has(owner)) return Promise.reject(new Error('Another PDF close/save cleanup is still finishing.'))
    if (approvedStamp !== undefined && !isCloseLeaseStamp(approvedStamp)) return Promise.reject(new Error('Invalid PDF close approval receipt.'))
    const ticket = this.broker.reserve(owner, randomUUID())
    return new Promise((resolve, reject) => {
      const entry: Preparation = { ticket, intent, draftToken: this.dependencies.draftToken(owner), resolve, reject, rendererSettled: false, released: false, cleanupPending: false, processing: false,
        options: { deferSeal: options.deferSeal === true, signal: options.signal, isCurrent: options.isCurrent } }
      this.entries.set(owner, entry)
      const abort = () => this.broker.cancel(owner, ticket, 'PDF close group aborted')
      entry.removeAbort = () => options.signal?.removeEventListener('abort', abort)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (!pdfCloseOptionsCurrent(entry.options)) { entry.rendererSettled = true; this.broker.settle(owner, ticket); abort(); return }
      try { this.dependencies.prepare(owner, { ticket, intent, restoreRecoveryOnCancel: entry.draftToken !== null, ...(approvedStamp ? { approvedStamp: { ...approvedStamp } } : {}) }) }
      catch (error) { entry.failure = error instanceof Error ? error : new Error(String(error)); entry.rendererSettled = true; this.broker.settle(owner, ticket); this.broker.cancel(owner, ticket, 'prepare dispatch failed'); reject(entry.failure) }
    })
  }
  claim(owner: number, ticket: unknown): boolean {
    if (!isCloseLeaseTicket(ticket)) return false
    const entry = this.entries.get(owner)
    if (entry && same(entry.ticket, ticket) && !pdfCloseOptionsCurrent(entry.options)) { this.broker.cancel(owner, ticket, 'PDF close group changed before writer claim'); return false }
    return this.broker.claim(owner, ticket)
  }
  async prepared(owner: number, response: PdfClosePrepared): Promise<void> {
    if (!response || !isCloseLeaseTicket(response.ticket)) return
    const entry = this.entries.get(owner)
    if (!entry || !same(entry.ticket, response.ticket) || entry.processing) return
    response = { ticket: { id: response.ticket.id, sequence: response.ticket.sequence, source: response.ticket.source }, ok: response.ok === true,
      ...(isCloseLeaseStamp(response.stamp) ? { stamp: { source: response.stamp.source, revision: response.stamp.revision } } : {}),
      ...(response.state instanceof ArrayBuffer ? { state: response.state } : {}),
      ...(response.draftFloor ? { draftFloor: { token: response.draftFloor.token, readId: response.draftFloor.readId, throughSequence: response.draftFloor.throughSequence } } : { draftFloor: null }),
      ...(typeof response.error === 'string' ? { error: response.error.slice(0, 2048) } : {}),
    }
    entry.processing = true
    entry.rendererSettled = true
    this.broker.settle(owner, entry.ticket)
    if (entry.released) { if (!entry.cleanupPending) this.entries.delete(owner); return }
    try {
      if (!pdfCloseOptionsCurrent(entry.options) || !this.broker.claim(owner, entry.ticket)) throw new Error('The PDF close group expired before its renderer result was accepted.')
      if (!response.ok || !isCloseLeaseStamp(response.stamp)) throw new Error(typeof response.error === 'string' ? response.error.slice(0, 2048) : 'The PDF editor refused to close with pending content.')
      if (entry.intent !== 'discard') {
        if (this.dependencies.unpublished(owner)) throw new Error('The complete older-base workspace still needs a new verified PDF copy before closing with Save.')
        if (!(response.state instanceof ArrayBuffer) || response.state.byteLength > PDF_WORKSPACE_LIMITS.entryBytes) throw new Error('The complete PDF close state was missing or oversized.')
        const state = decodePdfWorkspaceState(response.state.slice(0))
        if (pdfWorkspacePendingReasons(state).length) throw new Error('Some PDF content remains unrepresented. The editor was kept open.')
      }
      if (!this.dependencies.canReady(owner)) throw new Error('A PDF writer is still finishing.')
      // Own Save can adopt a verified successor. Capture its actual current UUID
      // once, after the locked complete state is checked and before any await.
      // Every continuation below uses this UUID, never a later "current" lookup.
      const capturedToken = this.dependencies.draftToken(owner)
      if (capturedToken) {
        if (!pdfCloseOptionsCurrent(entry.options)) throw new Error('The PDF close group changed before recovery custody admission.')
        const floor = response.draftFloor
        if (!floor || floor.token !== capturedToken || typeof floor.readId !== 'string' || floor.readId.length > 128 || !Number.isSafeInteger(floor.throughSequence) || floor.throughSequence < 0 || floor.throughSequence > Number.MAX_SAFE_INTEGER - 2) throw new Error('The PDF recovery producer did not supply a current sequence floor.')
        entry.floor = { token: capturedToken, readId: floor.readId, throughSequence: floor.throughSequence }
        entry.cleanupPending = true
        let staging: PdfCleanupPreparation
        try { staging = this.dependencies.stage(owner, entry.floor, randomUUID()) }
        catch (error) { entry.cleanupPending = false; throw error }
        entry.staging = staging
        const actualSettled = () => {
          entry.cleanupPending = false
          if (entry.released && this.entries.get(owner) === entry) this.entries.delete(owner)
        }
        void staging.actualSettled.then(actualSettled, actualSettled)
        try {
          const cleanup = await staging.ready
          entry.cleanup = cleanup
          if (entry.released) cleanup.cancel('The PDF close decision expired during custody preparation.')
          else if (!pdfCloseOptionsCurrent(entry.options)) throw new Error('The PDF close group changed during custody admission.')
          // Successful caller readiness is not necessarily actual provider/drain
          // settlement. Neither prepared nor ready may hide that remaining work.
          await staging.actualSettled
          if (entry.released) { cleanup.cancel('The PDF close decision expired before actual custody settlement.'); return }
        } catch (error) { staging.cancel('The PDF custody stage failed or timed out.'); throw error }
      } else if (response.draftFloor !== null && response.draftFloor !== undefined) {
        throw new Error('The PDF recovery producer changed during close preparation.')
      }
      if (entry.released || this.entries.get(owner) !== entry || !pdfCloseOptionsCurrent(entry.options) || !this.broker.claim(owner, entry.ticket)) throw new Error('The PDF close decision expired before cleanup completed.')
      const receipt = this.receipt(entry, response.stamp, 'prepared')
      entry.receipt = receipt
      if (entry.options.deferSeal) entry.resolve(receipt)
      else {
        const sealed = this.seal(owner, receipt)
        if (!sealed) throw new Error('The PDF close decision could not be sealed after its actual preparation.')
        entry.resolve(sealed)
      }
    } catch (error) {
      // Synchronous release must preserve the original renderer/custody refusal.
      // Actual writer ownership still follows its real settlement.
      entry.failure = error instanceof Error ? error : new Error(String(error))
      this.broker.cancel(owner, entry.ticket, 'PDF close preparation failed')
      entry.reject(entry.failure)
    }
  }
  private receipt(entry: Preparation, stamp: PdfCloseReceipt['stamp'], phase: PdfCloseReceipt['phase']): PdfCloseReceipt {
    return Object.freeze({ phase, ticket: Object.freeze({ ...entry.ticket }), stamp: Object.freeze({ ...stamp }), intent: entry.intent, ...(entry.cleanup ? { cleanupId: entry.cleanup.id } : {}) })
  }
  private validHeld(owner: number, entry: Preparation): boolean {
    try {
      return !entry.released && entry.rendererSettled && !entry.cleanupPending && !this.broker.hasWriter(owner) && this.dependencies.canReady(owner)
        && (entry.intent === 'discard' || !this.dependencies.unpublished(owner))
        && (!entry.cleanup || entry.cleanup.status().phase === 'staged')
    } catch { return false }
  }
  /** LOCAL checks only. Group isCurrent must not recurse through its member list. */
  isPrepared(owner: number, receipt: PdfCloseReceipt): boolean {
    const entry = this.entries.get(owner)
    if (!entry?.receipt || entry.receipt.phase !== 'prepared' || receipt?.phase !== 'prepared' || !isCloseLeaseTicket(receipt.ticket) || !isCloseLeaseStamp(receipt.stamp) || !sameReceipt(entry.receipt, receipt) || !this.validHeld(owner, entry)) return false
    return this.broker.claim(owner, entry.ticket)
  }
  seal(owner: number, receipt: PdfCloseReceipt): PdfCloseReceipt | null {
    if (!this.isPrepared(owner, receipt)) return null
    const entry = this.entries.get(owner)!
    if (!pdfCloseOptionsCurrent(entry.options)) { this.broker.cancel(owner, entry.ticket, 'PDF close group changed before sealing'); return null }
    if (!this.broker.ready(owner, entry.ticket, receipt.stamp)) return null
    const sealed = this.receipt(entry, receipt.stamp, 'ready')
    entry.receipt = sealed
    return sealed
  }
  complete(owner: number, receipt: PdfCloseReceipt, remove: () => boolean): boolean {
    const entry = this.entries.get(owner)
    if (!entry?.receipt || entry.receipt.phase !== 'ready' || receipt?.phase !== 'ready' || !isCloseLeaseTicket(receipt.ticket) || !isCloseLeaseStamp(receipt.stamp) || !sameReceipt(entry.receipt, receipt)) return false
    if (!pdfCloseOptionsCurrent(entry.options)) { this.broker.cancel(owner, entry.ticket, 'PDF close group changed before actual removal'); return false }
    entry.removeAbort?.(); entry.removeAbort = undefined
    return this.broker.complete(owner, receipt.ticket, receipt.stamp, () => {
      const actualRemoval = () => {
        const removed = remove()
        if (removed) this.completed.add(receipt.ticket.id)
        return removed
      }
      const removed = entry.cleanup ? entry.cleanup.commitRemoval(actualRemoval) : actualRemoval()
      while (this.completed.size > 256) this.completed.delete(this.completed.values().next().value!)
      return removed
    })
  }
  cancel(owner: number, ticket?: CloseLeaseTicket, reason = 'PDF close canceled'): void { this.broker.cancel(owner, ticket, reason) }
  hasWriter(owner: number): boolean { return this.entries.has(owner) }
  destroy(owner: number): void {
    const query = this.queries.get(owner)
    if (query) { clearTimeout(query.timer); query.removeAbort(); query.reject(new Error('The PDF editor closed.')); this.queries.delete(owner) }
    this.entries.get(owner)?.removeAbort?.()
    this.broker.destroy(owner)
    const entry = this.entries.get(owner)
    if (entry && !entry.cleanupPending) this.entries.delete(owner)
  }
}
