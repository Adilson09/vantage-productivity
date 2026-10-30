import { randomUUID } from 'node:crypto'
import { CloseLeaseBroker, isCloseLeaseStamp, type CloseLeaseStamp, type CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
import type { CloseCleanupHandle } from '../../../../packages/electron-utils/src/close-cleanup'
import { sameSheetsCloseSource, type SheetsCloseReceipt, type SheetsCloseSource,
  type SheetsPrepareCloseRequest, type SheetsPrepareCloseResult } from '../shared/sheets-close'
import type { CapturedNativeCloseAuthority } from './workbook-document-recovery'

export interface SheetsCleanupAdmission {
  ready: Promise<CloseCleanupHandle>
  actualSettled: Promise<void>
  cancel(reason: string): void
}
export interface SheetsRendererCloseAdmission {
  result: Promise<SheetsPrepareCloseResult>
  actualSettled: Promise<void>
}
export interface SheetsClosePrepareOptions {
  deferSeal?: boolean
  /** Trusted main operation lifetime; never received from renderer JSON. */
  signal?: AbortSignal
  isCurrent?: () => boolean
}
/** Only the issuing coordinator's WeakMap grants this prompt reservation. */
export interface SheetsClosePromptHandle {
  readonly ticket: CloseLeaseTicket
  readonly source: SheetsCloseSource
}
export interface SheetsCloseCoordinatorOptions<Owner> {
  /** Owner/proof hooks below inspect main-local state. They must not delegate
   * back to a cross-family group-current or prepared-scan predicate.
   */
  alive(owner: Owner): boolean
  current(owner: Owner): SheetsCloseSource | null
  sourceBusy(owner: Owner): boolean
  coverageComplete(owner: Owner): boolean
  /** Must not throw after starting untracked renderer work. */
  prepareRenderer(owner: Owner, request: SheetsPrepareCloseRequest): SheetsRendererCloseAdmission
  releaseRenderer(owner: Owner, ticket: CloseLeaseTicket, reason: string): void
  capture(owner: Owner, sessionId: string): CapturedNativeCloseAuthority | null
  verifyCapturedRevision(owner: Owner, result: SheetsPrepareCloseResult, authority: CapturedNativeCloseAuthority): boolean
  stagePersistent(owner: Owner, lineage: string, authority: CapturedNativeCloseAuthority): SheetsCleanupAdmission
  stageMemory(owner: Owner, lineage: string, authority: CapturedNativeCloseAuthority): SheetsCleanupAdmission
  holdNativeUntilSettled(owner: Owner, actual: Promise<void>): void
  report(error: unknown): void
  prepareTimeoutMs?: number
  readyTimeoutMs?: number
}
interface PendingClose {
  ticket: CloseLeaseTicket
  initial: SheetsCloseSource
  expiresAt: number
  readyExpiresAt?: number
  options: SheetsClosePrepareOptions
  phase: 'prompting' | 'preparing' | 'prepared' | 'ready' | 'committing' | 'removed' | 'cancelled'
  rendererAdmitted: boolean
  removeAbort?: () => void
  authority?: CapturedNativeCloseAuthority
  admission?: SheetsCleanupAdmission
  cleanup?: CloseCleanupHandle
  result?: SheetsPrepareCloseResult
  receipt?: SheetsCloseReceipt
}

/** Main-owned phases. No copied receipt, late dialog, or timed-out writer grants removal. */
export class SheetsCloseCoordinator<Owner> {
  private readonly pending = new Map<Owner, PendingClose>()
  private readonly captures = new Map<Owner, Set<Promise<void>>>()
  private readonly prompts = new WeakMap<SheetsClosePromptHandle, { owner: Owner; pending: PendingClose }>()
  private readonly grants = new WeakMap<SheetsCloseReceipt, { owner: Owner; pending: PendingClose }>()
  private readonly broker: CloseLeaseBroker<Owner>
  private checkingMainScope = 0

  constructor(private readonly options: SheetsCloseCoordinatorOptions<Owner>) {
    this.broker = new CloseLeaseBroker({ alive: owner => options.alive(owner), source: owner => options.current(owner)?.lineage ?? '',
      validate: (owner, ticket, stamp) => this.valid(owner, ticket, stamp), release: (owner, ticket, reason) => this.released(owner, ticket, reason),
      ...(options.prepareTimeoutMs === undefined ? {} : { prepareTimeoutMs: options.prepareTimeoutMs }),
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }) })
  }
  claim(owner: Owner, ticket: CloseLeaseTicket): boolean {
    const p = this.pending.get(owner)
    return !!p && p.rendererAdmitted && p.phase === 'preparing' && sameTicket(p.ticket, ticket) && this.scopeCurrent(owner, p) && this.broker.claim(owner, ticket)
  }
  cancel(owner: Owner, ticket: CloseLeaseTicket, reason = 'close cancelled'): void { this.broker.cancel(owner, ticket, reason) }
  invalidateSource(owner: Owner, reason: string): void { this.broker.cancel(owner, undefined, reason) }

  /** Reserve synchronously BEFORE a native prompt/query can await. */
  beginPrompt(owner: Owner, options: SheetsClosePrepareOptions = {}): SheetsClosePromptHandle {
    if (options.signal?.aborted || options.isCurrent?.() === false || !this.options.alive(owner) ||
      !this.options.coverageComplete(owner) || this.options.sourceBusy(owner)) throw new Error('The workbook cannot establish a current close reservation.')
    if (this.captures.get(owner)?.size) throw new Error('A previous recovery capture is still actually settling.')
    const initial = this.options.current(owner)
    if (!initial) throw new Error('The active workbook is unavailable.')
    const ticket = this.broker.reserve(owner, randomUUID())
    const pending: PendingClose = { ticket, initial: { ...initial }, options: { ...options },
      expiresAt: Date.now() + (this.options.prepareTimeoutMs ?? 120_000), phase: 'prompting', rendererAdmitted: false }
    this.pending.set(owner, pending)
    const prompt = Object.freeze({ ticket: Object.freeze({ ...ticket }), source: Object.freeze({ ...initial }) })
    this.prompts.set(prompt, { owner, pending })
    if (options.signal) {
      const abort = () => this.broker.cancel(owner, ticket, 'main close operation aborted')
      options.signal.addEventListener('abort', abort, { once: true })
      pending.removeAbort = () => options.signal!.removeEventListener('abort', abort)
      if (options.signal.aborted) abort()
    }
    return prompt
  }
  isPromptCurrent(owner: Owner, prompt: SheetsClosePromptHandle): boolean {
    const issued = this.prompts.get(prompt), p = issued?.pending
    const current = this.options.current(owner)
    return !!issued && issued.owner === owner && !!p && p.phase === 'prompting' && this.scopeCurrent(owner, p) &&
      !!current && sameSheetsCloseSource(current, p.initial) && !this.options.sourceBusy(owner) && this.options.coverageComplete(owner) && this.broker.claim(owner, p.ticket)
  }
  endPrompt(owner: Owner, prompt: SheetsClosePromptHandle, success: boolean): void {
    const issued = this.prompts.get(prompt)
    if (!issued || issued.owner !== owner) return
    this.prompts.delete(prompt)
    const p = issued.pending
    if (!success || !p.rendererAdmitted) this.broker.cancel(owner, p.ticket, success ? 'unused prompt reservation ended' : 'native prompt ended without preparation')
    // Once admitted, only the actual-renderer observer can settle this writer.
    if (!p.rendererAdmitted) this.broker.settle(owner, p.ticket)
  }

  async prepare(owner: Owner, intent: 'save' | 'discard', approvedStamp?: CloseLeaseStamp,
    target?: { path?: string; overwrite?: boolean }, options: SheetsClosePrepareOptions = {}): Promise<SheetsCloseReceipt> {
    const prompt = this.beginPrompt(owner, options)
    let success = false
    try { const receipt = await this.prepareReserved(owner, prompt, intent, approvedStamp, target); success = true; return receipt }
    finally { this.endPrompt(owner, prompt, success) }
  }

  async prepareReserved(owner: Owner, prompt: SheetsClosePromptHandle, intent: 'save' | 'discard', approvedStamp?: CloseLeaseStamp,
    target?: { path?: string; overwrite?: boolean }): Promise<SheetsCloseReceipt> {
    const issued = this.prompts.get(prompt)
    if (!issued || issued.owner !== owner || !this.isPromptCurrent(owner, prompt)) throw new Error('The original native close reservation expired or changed.')
    const p = issued.pending, ticket = p.ticket
    if (intent === 'discard' && !isCloseLeaseStamp(approvedStamp)) throw new Error('Discard needs the exact approved authored revision.')
    p.phase = 'preparing'
    try {
      this.assertScope(owner, p)
      const renderer = this.options.prepareRenderer(owner, { ticket, intent, expectedSource: p.initial,
        ...(approvedStamp ? { approvedStamp: { ...approvedStamp } } : {}), ...target })
      p.rendererAdmitted = true
      void renderer.actualSettled.then(() => this.broker.settle(owner, ticket), () => this.broker.settle(owner, ticket))
      this.options.holdNativeUntilSettled(owner, renderer.actualSettled)
      void renderer.actualSettled.catch(error => this.options.report(error))
      const result = await renderer.result
      this.assertScope(owner, p)
      await renderer.actualSettled
      this.assertScope(owner, p)
      p.result = result
      const envelope = result.closeLease
      if (!result.current || !envelope || result.intent !== intent || !/^[a-f0-9]{64}$/.test(envelope.payloadSha256) ||
        !sameTicket(envelope.ticket, ticket) || intent === 'save' && !result.clean ||
        intent === 'discard' && !sameStamp(envelope.stamp, approvedStamp!) || !this.valid(owner, ticket, envelope.stamp))
        throw new Error(result.error ?? 'The workbook changed before close could be prepared.')
      this.assertScope(owner, p)
      const authority = this.options.capture(owner, envelope.source.sessionId)
      if (!authority) throw new Error('A native recovery authority could not be captured.')
      p.authority = authority
      // Index immediately after synchronous detach, before any captured drain awaits.
      const admission = authority.encrypted ? this.options.stageMemory(owner, envelope.source.lineage, authority)
        : this.options.stagePersistent(owner, envelope.source.lineage, authority)
      p.admission = admission
      this.trackActualCapture(owner, admission.actualSettled)
      const cleanup = await admission.ready
      p.cleanup = cleanup
      this.assertScope(owner, p)
      await admission.actualSettled
      this.assertScope(owner, p)
      if (!this.capturedCurrent(owner, p)) throw new Error('Native checkpoint/custody proof is uncertain or no longer current.')
      const proof = authority.attest()!, status = cleanup.status()
      const prepared: SheetsCloseReceipt = Object.freeze({ phase: 'prepared', source: envelope.source.lineage, intent,
        published: result.published, clean: result.clean, closeLease: structuredClone(envelope),
        nativeAuthorities: [{ documentId: authority.id, producer: authority.producer, generation: authority.generation,
          revision: proof.revision, sourceFingerprint: proof.sourceFingerprint, protectedMemoryOnly: authority.encrypted }],
        cleanup: { id: cleanup.id, phase: status.phase, custody: status.custody }, ...(result.savedPath ? { savedPath: result.savedPath } : {}) })
      p.phase = 'prepared'; p.receipt = prepared; this.grants.set(prepared, { owner, pending: p })
      if (p.options.deferSeal) return prepared
      const ready = this.seal(owner, prepared)
      if (!ready) throw new Error('The close approval expired before sealing.')
      return ready
    } catch (error) { this.broker.cancel(owner, ticket, 'prepare refused'); throw error }
    finally { if (!p.rendererAdmitted) this.broker.settle(owner, ticket) }
  }

  /** Local proof query only: never invokes the caller's group-current predicate
   * and never starts or refreshes either deadline. A group may scan this while
   * its own nonrecursive validation guard is active.
   */
  isPrepared(owner: Owner, receipt: SheetsCloseReceipt): boolean {
    const grant = this.grants.get(receipt), p = grant?.pending
    return !!grant && grant.owner === owner && !!p && p === this.pending.get(owner) && p.receipt === receipt &&
      receipt.phase === 'prepared' && p.phase === 'prepared' && this.capturedLocalCurrent(owner, p, receipt) && this.broker.claim(owner, p.ticket)
  }
  /** Synchronous one-shot transition. A prepared/copy/consumed token cannot remove or renew. */
  seal(owner: Owner, receipt: SheetsCloseReceipt): SheetsCloseReceipt | null {
    const grant = this.grants.get(receipt)
    if (!grant || grant.owner !== owner) return null
    const p = grant.pending
    if (receipt.phase !== 'prepared' || p.phase !== 'prepared' || p.receipt !== receipt) return null
    if (!this.isPrepared(owner, receipt) || !this.scopeCurrent(owner, p)) { this.broker.cancel(owner, p.ticket, 'prepared close no longer current'); return null }
    if (!this.broker.ready(owner, p.ticket, receipt.closeLease.stamp)) return null
    this.grants.delete(receipt)
    const ready: SheetsCloseReceipt = Object.freeze({ ...structuredClone(receipt), phase: 'ready' })
    p.phase = 'ready'; p.readyExpiresAt = Date.now() + (this.options.readyTimeoutMs ?? 5_000)
    p.receipt = ready; this.grants.set(ready, { owner, pending: p })
    return ready
  }
  complete(owner: Owner, receipt: SheetsCloseReceipt, remove: () => boolean): boolean {
    const grant = this.grants.get(receipt), p = grant?.pending
    if (!grant || grant.owner !== owner || !p || p !== this.pending.get(owner) || p.receipt !== receipt ||
      p.phase !== 'ready' || receipt.phase !== 'ready' || !p.cleanup) return false
    this.grants.delete(receipt)
    if (!this.capturedCurrent(owner, p, receipt)) { this.broker.cancel(owner, p.ticket, 'ready proof changed'); return false }
    p.phase = 'committing'
    try {
      const removed = this.broker.complete(owner, p.ticket, receipt.closeLease.stamp, () => p.cleanup!.commitRemoval(remove))
      if (removed) { p.phase = 'removed'; p.removeAbort?.(); this.pending.delete(owner) }
      else this.retained(owner, p, 'Actual removal was refused.')
      return removed
    } catch (error) { this.retained(owner, p, 'Actual removal failed.'); throw error }
  }
  destroy(owner: Owner): void { this.broker.destroy(owner) }

  private scopeLocalCurrent(owner: Owner, p: PendingClose): boolean {
    return this.pending.get(owner) === p && p.phase !== 'cancelled' && p.phase !== 'removed' &&
      this.options.alive(owner) && !p.options.signal?.aborted &&
      Date.now() < (p.readyExpiresAt ?? p.expiresAt)
  }
  /** Full operation scope; used by preparation, sealing and actual completion. */
  private scopeCurrent(owner: Owner, p: PendingClose): boolean {
    if (!this.scopeLocalCurrent(owner, p)) return false
    // Prepared queries are local, so a nested full operation is not a query
    // cycle. It must not inherit another operation's group permission.
    if (p.options.isCurrent) {
      if (this.checkingMainScope !== 0) return false
      this.checkingMainScope++
      try { if (!p.options.isCurrent()) return false } catch { return false }
      finally { this.checkingMainScope-- }
    }
    return this.scopeLocalCurrent(owner, p)
  }
  private assertScope(owner: Owner, p: PendingClose): void {
    if (!this.scopeCurrent(owner, p)) throw new Error('The original close operation expired, was canceled, or changed.')
  }
  private valid(owner: Owner, ticket: CloseLeaseTicket, stamp: CloseLeaseStamp): boolean {
    const p = this.pending.get(owner)
    return !!p && this.scopeCurrent(owner, p) && this.validLocally(owner, ticket, stamp)
  }
  private validLocally(owner: Owner, ticket: CloseLeaseTicket, stamp: CloseLeaseStamp): boolean {
    const p = this.pending.get(owner), envelope = p?.result?.closeLease
    if (!p || !this.scopeLocalCurrent(owner, p)) return false
    const current = this.options.current(owner)
    return sameTicket(p.ticket, ticket) && !!envelope && sameStamp(envelope.stamp, stamp) &&
      !p.authority?.cancelled && !!current && sameSheetsCloseSource(current, envelope.source) && !this.options.sourceBusy(owner) && this.options.coverageComplete(owner)
  }
  private capturedCurrent(owner: Owner, p: PendingClose, receipt?: SheetsCloseReceipt): boolean {
    return this.scopeCurrent(owner, p) && this.capturedLocalCurrent(owner, p, receipt)
  }
  private capturedLocalCurrent(owner: Owner, p: PendingClose, receipt?: SheetsCloseReceipt): boolean {
    const envelope = p.result?.closeLease, authority = p.authority, cleanup = p.cleanup
    if (!envelope || !authority || !cleanup || !this.validLocally(owner, p.ticket, envelope.stamp)) return false
    const status = cleanup.status(), proof = authority.attest()
    if (status.phase !== 'staged' || !authority.encrypted && !status.custody || !proof || proof.pending || proof.documentId !== authority.id ||
      proof.payloadSha256 !== envelope.payloadSha256 || !authority.encrypted && proof.sourceFingerprint !== `sha256:${envelope.source.openedSha256.toLowerCase()}` ||
      this.options.verifyCapturedRevision(owner, p.result!, authority) !== true) return false
    if (!receipt) return true
    const old = receipt.nativeAuthorities[0]
    return receipt.nativeAuthorities.length === 1 && !!old && old.documentId === authority.id && old.producer === authority.producer &&
      old.generation === authority.generation && old.revision === proof.revision && old.sourceFingerprint === proof.sourceFingerprint &&
      old.protectedMemoryOnly === authority.encrypted && receipt.cleanup.id === cleanup.id
  }
  private released(owner: Owner, ticket: CloseLeaseTicket, reason: string): void {
    const p = this.pending.get(owner)
    if (p && sameTicket(p.ticket, ticket) && p.phase !== 'committing' && p.phase !== 'removed') this.retained(owner, p, reason)
    this.options.releaseRenderer(owner, ticket, reason)
  }
  private retained(owner: Owner, p: PendingClose, reason: string): void {
    if (p.phase === 'removed' || p.phase === 'cancelled') return
    p.phase = 'cancelled'; p.removeAbort?.()
    if (p.receipt) this.grants.delete(p.receipt)
    try { p.admission?.cancel(reason) } catch (error) { this.options.report(error) }
    try { p.cleanup?.cancel(reason) } catch (error) { this.options.report(error) }
    try { if (p.authority) this.trackActualCapture(owner, p.authority.resume()) } catch (error) { this.options.report(error) }
    if (!p.rendererAdmitted) this.broker.settle(owner, p.ticket)
    if (this.pending.get(owner) === p) this.pending.delete(owner)
  }
  private trackActualCapture(owner: Owner, actual: Promise<void>): void {
    const captures = this.captures.get(owner) ?? new Set<Promise<void>>()
    this.captures.set(owner, captures); captures.add(actual)
    void actual.catch(error => this.options.report(error)).finally(() => {
      captures.delete(actual)
      if (!captures.size && this.captures.get(owner) === captures) this.captures.delete(owner)
    })
    this.options.holdNativeUntilSettled(owner, actual)
  }
}
function sameTicket(a: CloseLeaseTicket, b: CloseLeaseTicket): boolean { return a.id === b.id && a.sequence === b.sequence && a.source === b.source }
function sameStamp(a: CloseLeaseStamp, b: CloseLeaseStamp): boolean { return a.source === b.source && a.revision === b.revision }
