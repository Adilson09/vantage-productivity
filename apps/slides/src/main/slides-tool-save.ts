import type { PublicationSelection } from '../../../../packages/electron-utils/src/document-publication'
import type { NativeClosePromptHold } from '../../../../packages/electron-utils/src/native-close-admission'
import { randomUUID } from 'node:crypto'
import {
  CloseLeaseBroker,
  type CloseLeaseTicket,
  type CloseLeaseStamp,
} from '../../../../packages/electron-utils/src/close-lease'
import type {
  CloseCleanupAdmission,
  CloseCleanupHandle,
} from '../../../../packages/electron-utils/src/close-cleanup'
import type {
  SlidesCloseIntent,
  SlidesCloseQuery,
  SlidesToolSaveCompletion,
  SlidesNativeCloseReceipt,
  SlidesToolSaveIdentity,
  SlidesToolSaveProbe,
  SlidesToolSaveRequest,
  SlidesToolSaveWriteResult,
} from '../shared/slides-tool-save'
export interface SlidesClosePrepareOptions {
  deferSeal?: boolean
  signal?: AbortSignal
  isCurrent?: () => boolean
}
export function slidesClosePermit(options: SlidesClosePrepareOptions = {}): boolean {
  try {
    return !options.signal?.aborted && options.isCurrent?.() !== false
  } catch {
    return false
  }
}
interface SourceState {
  source: object
  identity: string
  token: string | null
  revision: string
  dirty: boolean
  busy?: boolean
}
interface Producer {
  token: string
  documentPath: string | null
  ready: Promise<void>
  attest(): { expectedDocumentPath: string | null; expectedSha256: string } | null
  cancel(): void
  removed(): void
  cleanup(signal: AbortSignal): Promise<void>
}
interface Host {
  state(wcId: number): SourceState | null
  send(wcId: number, channel: string, value: unknown): void
  write(
    wcId: number,
    source: object,
    path: string,
    overwrite: boolean,
    publicationSelection?: PublicationSelection,
  ): Promise<SlidesToolSaveWriteResult>
  stage(wcId: number, through: number): { producer: Producer; admission: CloseCleanupAdmission }
}
interface Pending {
  publicationSelection?: PublicationSelection
  phase: 'preparing' | 'prepared' | 'ready' | 'cancelled'
  permit: SlidesClosePrepareOptions
  approval?: SlidesToolSaveCompletion
  detachAbort?: () => void
  finishing: boolean
  lease: CloseLeaseTicket
  wcId: number
  request: SlidesToolSaveRequest
  source: object
  token: string | null
  overwrite: boolean
  published: boolean
  writing: boolean
  writeRevision: string | null
  revision: string
  stamp?: CloseLeaseStamp
  producer?: Producer
  cleanup?: CloseCleanupHandle
  admission?: CloseCleanupAdmission
  committing: boolean
  removed: boolean
  done: boolean
  timer: ReturnType<typeof setTimeout>
  resolve(value: SlidesToolSaveCompletion): void
  reject(error: Error): void
}
/** One broker is shared by native/tab/detached/MCP Save and Discard. */
export class SlidesToolSaveBroker {
  private readonly pending = new Map<number, Pending>()
  private readonly busyWrites = new Set<object>()
  private readonly leases: CloseLeaseBroker<number>
  constructor(
    private readonly host: Host,
    private readonly timeoutMs = 120_000,
  ) {
    this.leases = new CloseLeaseBroker({
      alive: (owner) => !!host.state(owner),
      source: (owner) => host.state(owner)?.identity ?? '',
      validate: (owner, _ticket, stamp) => {
        const entry = this.pending.get(owner),
          state = host.state(owner)
        return (
          !!entry &&
          !!state &&
          state.source === entry.source &&
          stamp.source === entry.request.sourceIdentity &&
          state.identity === entry.request.sourceIdentity &&
          stamp.revision === entry.stamp?.revision &&
          state.revision === entry.revision &&
          !state.busy &&
          (entry.request.intent === 'discard' || !state.dirty)
        )
      },
      release: (owner, ticket, reason) => {
        const entry = this.pending.get(owner)
        if (entry?.request.requestId === ticket.id) {
          entry.phase = 'cancelled'
          if (!entry.committing && !entry.removed) {
            entry.producer?.cancel()
            entry.cleanup?.cancel(reason)
            entry.admission?.cancel(reason)
          }
          if (!entry.done) {
            entry.done = true
            entry.reject(new Error(reason))
          }
          if (!entry.writing && !this.leases.hasWriter(owner)) {
            entry.detachAbort?.()
            this.pending.delete(owner)
          }
        }
        host.send(owner, 'slides:close-release', ticket)
      },
    })
  }
  retaining(owner: number): boolean {
    return this.pending.get(owner)?.request.requireClean === true
  }
  request(
    wcId: number,
    path: string,
    overwrite: boolean,
    requireClean: boolean,
    intent: SlidesCloseIntent = 'save',
    approvedStamp?: CloseLeaseStamp,
    options: SlidesClosePrepareOptions = {},
    publicationSelection?: PublicationSelection,
  ): Promise<SlidesToolSaveCompletion> {
    if (this.pending.has(wcId))
      return Promise.reject(new Error('A presentation writer or close is still finishing.'))
    const state = this.host.state(wcId)
    if (!state || !state.identity)
      return Promise.reject(new Error('The presentation renderer is not ready.'))
    if (this.busyWrites.has(state.source) || state.busy)
      return Promise.reject(new Error('Finish the pending presentation operation before closing.'))
    const permit = Object.freeze({
      deferSeal: options.deferSeal === true,
      signal: options.signal,
      isCurrent: options.isCurrent,
    })
    if (!slidesClosePermit(permit))
      return Promise.reject(new Error('The close operation ended before request delivery.'))
    const id = randomUUID(),
      lease = this.leases.reserve(wcId, id)
    return new Promise((resolve, reject) => {
      const request: SlidesToolSaveRequest = {
        requestId: id,
        path,
        requireClean,
        sourceToken: state.token,
        intent,
        sourceIdentity: state.identity,
        ...(requireClean ? { closeLease: lease } : {}),
        ...(approvedStamp ? { approvedStamp } : {}),
      }
      const entry: Pending = {
        publicationSelection,
        phase: 'preparing',
        permit,
        finishing: false,
        lease,
        wcId,
        request,
        source: state.source,
        token: state.token,
        overwrite,
        published: false,
        writing: false,
        writeRevision: null,
        revision: '',
        committing: false,
        removed: false,
        done: false,
        timer: setTimeout(
          () =>
            this.cancel(
              wcId,
              'The save/close response timed out; any publication and actual writer remain owned.',
            ),
          this.timeoutMs,
        ),
        resolve,
        reject,
      }
      this.pending.set(wcId, entry)
      if (permit.signal) {
        const abort = () => this.cancelRequest(wcId, id)
        permit.signal.addEventListener('abort', abort, { once: true })
        entry.detachAbort = () => permit.signal?.removeEventListener('abort', abort)
      }
      try {
        if (!slidesClosePermit(permit))
          throw new Error('The close operation ended before delivery.')
        this.host.send(wcId, 'slides:tool-save-request', request)
      } catch (error) {
        this.cancel(wcId, String(error))
        this.leases.settle(wcId, lease)
        if (this.pending.get(wcId) === entry) {
          entry.detachAbort?.()
          this.pending.delete(wcId)
        }
      }
    })
  }
  private ticket(entry: Pending): CloseLeaseTicket {
    return entry.lease
  }
  private entry(wcId: number, identity: SlidesToolSaveIdentity): Pending {
    const e = this.pending.get(wcId)
    if (
      !e ||
      e.request.requestId !== identity?.requestId ||
      typeof identity.sourceToken !== 'string'
    )
      throw new Error('Obsolete presentation save request.')
    return e
  }
  private current(e: Pending, token: string) {
    const s = this.host.state(e.wcId)
    return s &&
      s.source === e.source &&
      s.identity === e.request.sourceIdentity &&
      s.token === token &&
      (e.token === null || e.token === token)
      ? s
      : null
  }
  probe(wcId: number, identity: SlidesToolSaveIdentity): SlidesToolSaveProbe {
    const e = this.entry(wcId, identity),
      s =
        e.phase === 'preparing' && slidesClosePermit(e.permit)
          ? this.current(e, identity.sourceToken)
          : null
    if (s) e.token = identity.sourceToken
    return { current: !!s, revision: s?.revision ?? '', dirty: s?.dirty ?? true }
  }
  claim(owner: number, ticket: CloseLeaseTicket): boolean {
    return this.leases.claim(owner, ticket)
  }
  async publish(
    wcId: number,
    identity: SlidesToolSaveIdentity,
  ): Promise<SlidesToolSaveWriteResult> {
    const e = this.entry(wcId, identity),
      s = this.current(e, identity.sourceToken)
    if (
      !s ||
      e.done ||
      e.writing ||
      e.published ||
      e.request.intent !== 'save' ||
      !slidesClosePermit(e.permit)
    )
      throw new Error('The presentation save is no longer current.')
    e.token = identity.sourceToken
    e.writeRevision = s.revision
    e.writing = true
    this.busyWrites.add(e.source)
    try {
      const r = await this.host.write(
        wcId,
        e.source,
        e.request.path,
        e.overwrite,
        e.publicationSelection,
      )
      if (r.ok) {
        e.published = true
        e.request.path = r.path
      }
      return r
    } finally {
      e.writing = false
      this.busyWrites.delete(e.source)
      if (e.done && !this.host.state(wcId) && this.pending.get(wcId) === e)
        this.pending.delete(wcId)
    }
  }
  async finish(wcId: number, value: unknown): Promise<boolean> {
    const result = value as SlidesToolSaveCompletion | null,
      e = this.pending.get(wcId)
    if (
      !e ||
      !result ||
      result.requestId !== e.request.requestId ||
      typeof result.sourceToken !== 'string' ||
      typeof result.current !== 'boolean' ||
      typeof result.clean !== 'boolean' ||
      typeof result.published !== 'boolean' ||
      typeof result.revision !== 'string' ||
      result.revision.length > 1024
    )
      return false
    if (e.finishing || (e.done && e.cleanup)) return false
    e.finishing = true
    const lease = e.request.closeLease
    try {
      if (!slidesClosePermit(e.permit))
        throw new Error('The close group ended before custody preparation.')
      if (e.writing || result.published !== e.published)
        throw new Error('The presentation publication receipt is inconsistent.')
      const state = this.current(e, result.sourceToken),
        current =
          !!state &&
          result.current &&
          state.revision === result.revision &&
          (!e.published || state.revision === e.writeRevision),
        clean = current && result.clean && !state!.dirty
      if (
        (e.request.requireClean && !current) ||
        (!e.request.requireClean && !e.published) ||
        (e.request.requireClean && e.request.intent === 'save' && !clean)
      )
        throw new Error(
          result.error ?? 'The presentation has newer or unrepresented edits; it stayed open.',
        )
      e.revision = state?.revision ?? result.revision
      e.stamp = result.stamp
      if (e.request.requireClean) {
        if (
          !lease ||
          !e.stamp ||
          e.stamp.source !== e.request.sourceIdentity ||
          !Number.isSafeInteger(result.throughSequence) ||
          result.throughSequence! < 0 ||
          state!.busy
        )
          throw new Error(
            'The presentation did not provide a settled source/revision close barrier.',
          )
        const staged = this.host.stage(wcId, result.throughSequence!)
        e.producer = staged.producer
        e.admission = staged.admission
        e.cleanup = await staged.admission.ready
        await staged.admission.actualSettled
        this.leases.settle(wcId, lease)
        if (e.done || !slidesClosePermit(e.permit))
          throw new Error('The presentation group changed during recovery custody preparation.')
      } else {
        e.done = true
        this.leases.settle(wcId, e.lease)
        this.leases.cancel(wcId, e.lease, 'ordinary publication completed')
      }
      clearTimeout(e.timer)
      const completion: SlidesToolSaveCompletion = {
        ...result,
        path: e.request.path,
        published: e.published,
        current,
        clean,
        ...(lease
          ? {
              closeLease: lease,
              intent: e.request.intent,
              cleanupId: e.cleanup?.id,
              phase: 'prepared' as const,
            }
          : {}),
      }
      e.approval = completion
      if (e.request.requireClean) {
        e.phase = 'prepared'
        if (!this.isPrepared(wcId, completion))
          throw new Error('The presentation is no longer locally prepared.')
        if (e.permit.deferSeal) {
          e.done = true
          e.resolve(completion)
        } else {
          const ready = this.seal(wcId, completion)
          if (!ready) throw new Error('The presentation seal was refused.')
          e.done = true
          e.resolve(ready)
        }
      } else {
        e.done = true
        e.detachAbort?.()
        e.resolve(completion)
        this.pending.delete(wcId)
      }
      return true
    } catch (error) {
      this.cancel(wcId, String(error))
      return false
    } finally {
      if (!e.request.requireClean || !e.cleanup) {
        if (e.admission)
          void e.admission.actualSettled.then(() => {
            this.leases.settle(wcId, this.ticket(e))
            if (e.done && this.pending.get(wcId) === e) {
              e.detachAbort?.()
              this.pending.delete(wcId)
            }
          })
        else this.leases.settle(wcId, this.ticket(e))
        if (e.done && !this.leases.hasWriter(wcId) && this.pending.get(wcId) === e)
          this.pending.delete(wcId)
      }
    }
  }
  /** LOCAL check: group isCurrent may call this predicate for every held receipt. */
  isPrepared(wcId: number, receipt: SlidesToolSaveCompletion): boolean {
    const e = this.pending.get(wcId),
      s = this.host.state(wcId)
    return (
      !!e &&
      e.phase === 'prepared' &&
      receipt.phase === 'prepared' &&
      e.approval === receipt &&
      receipt.requestId === e.request.requestId &&
      !!receipt.closeLease &&
      !!e.request.closeLease &&
      receipt.closeLease.id === e.request.closeLease.id &&
      receipt.closeLease.sequence === e.request.closeLease.sequence &&
      receipt.closeLease.source === e.request.closeLease.source &&
      !!receipt.stamp &&
      !!e.stamp &&
      receipt.stamp.source === e.stamp.source &&
      receipt.stamp.revision === e.stamp.revision &&
      !!e.cleanup &&
      !e.permit.signal?.aborted &&
      !!s &&
      s.source === e.source &&
      s.identity === e.request.sourceIdentity &&
      s.revision === e.revision &&
      !s.busy &&
      (e.request.intent === 'discard' || !s.dirty) &&
      this.leases.claim(wcId, e.request.closeLease)
    )
  }
  seal(wcId: number, receipt: SlidesToolSaveCompletion): SlidesNativeCloseReceipt | null {
    const e = this.pending.get(wcId)
    if (!e || !slidesClosePermit(e.permit) || !this.isPrepared(wcId, receipt)) {
      this.cancelRequest(wcId, receipt.requestId)
      return null
    }
    if (!this.leases.ready(wcId, e.request.closeLease!, e.stamp!)) return null
    const ready = { ...receipt, phase: 'ready' as const }
    e.phase = 'ready'
    e.approval = ready
    return ready
  }
  completeReceipt(wcId: number, receipt: SlidesToolSaveCompletion, remove: () => boolean): boolean {
    const e = this.pending.get(wcId)
    if (!e || receipt.phase !== 'ready' || e.approval !== receipt || !slidesClosePermit(e.permit))
      return false
    return this.completeClose(wcId, receipt.requestId, remove)
  }
  completeClose(wcId: number, requestId: string, close: () => boolean): boolean {
    const e = this.pending.get(wcId)
    if (
      !e?.request.closeLease ||
      !e.stamp ||
      !e.cleanup ||
      e.phase !== 'ready' ||
      !slidesClosePermit(e.permit)
    )
      return false
    if (e.request.requestId !== requestId) return false
    try {
      return this.leases.complete(wcId, e.request.closeLease, e.stamp, () => {
        e.committing = true
        try {
          return e.cleanup!.commitRemoval(() => {
            const removed = close()
            if (removed) {
              e.removed = true
              e.producer!.removed()
            }
            return removed
          })
        } finally {
          e.committing = false
          if (!e.removed) e.producer?.cancel()
        }
      })
    } finally {
      e.detachAbort?.()
      this.pending.delete(wcId)
    }
  }
  cancelRequest(wcId: number, id: unknown): void {
    if (this.pending.get(wcId)?.request.requestId === id) this.cancel(wcId)
  }
  invalidateReady(wcId: number): void {
    const e = this.pending.get(wcId)
    if (e?.stamp && !e.committing)
      this.cancel(wcId, 'Another authored operation canceled presentation close.')
  }
  cancel(wcId: number, reason = 'The presentation close was canceled.'): void {
    const e = this.pending.get(wcId)
    if (!e) return
    clearTimeout(e.timer)
    e.producer?.cancel()
    e.cleanup?.cancel(reason)
    e.admission?.cancel(reason)
    this.leases.cancel(wcId, undefined, reason)
    if (!e.done) {
      e.done = true
      e.reject(new Error(reason))
    }
    if (!e.writing && !this.leases.hasWriter(wcId)) {
      e.detachAbort?.()
      this.pending.delete(wcId)
    }
  }
  destroy(wcId: number): void {
    const e = this.pending.get(wcId)
    if (e?.committing) return
    this.cancel(wcId, 'The renderer was destroyed; recovery remains retained.')
    this.leases.destroy(wcId)
    if (e && !e.writing) {
      e.detachAbort?.()
      this.pending.delete(wcId)
    }
  }
}

export interface SlidesNativeCloseHost<Source extends object> {
  holdAutomaticSaves(): NativeClosePromptHold | null
  alive(): boolean
  source(): Source | undefined
  revision(source: Source): string
  dirty(): boolean
  autoSave(source: Source): boolean
  query(): Promise<SlidesCloseQuery>
  prompt(): Promise<number>
  prepare(
    source: Source,
    intent: SlidesCloseIntent,
    stamp: CloseLeaseStamp,
    options: SlidesClosePrepareOptions,
  ): Promise<SlidesNativeCloseReceipt>
  cancel(receipt: SlidesToolSaveCompletion): void | Promise<void>
  warning(error: unknown): void
}
export async function runSlidesNativeClose<Source extends object>(
  host: SlidesNativeCloseHost<Source>,
  options: SlidesClosePrepareOptions = {},
): Promise<SlidesNativeCloseReceipt | null> {
  const external = Object.freeze({
    deferSeal: options.deferSeal === true,
    signal: options.signal,
    isCurrent: options.isCurrent,
  })
  if (!host.alive() || !slidesClosePermit(external)) return null
  const hold = host.holdAutomaticSaves()
  if (!hold) return null
  let transferred = false
  const permit = {
      ...external,
      isCurrent: () => slidesClosePermit(external) && (transferred || hold.current()),
    },
    allowed = () => host.alive() && slidesClosePermit(permit)
  try {
    const source = host.source(),
      query = await host.query()
    if (!allowed() || !source || host.source() !== source) return null
    const approvedRevision = host.revision(source)
    let intent: SlidesCloseIntent = 'save'
    if ((query.dirty || query.pending || host.dirty()) && !host.autoSave(source)) {
      const response = await host.prompt()
      if (
        !allowed() ||
        host.source() !== source ||
        host.revision(source) !== approvedRevision ||
        response === 2
      )
        return null
      intent = response === 1 ? 'discard' : 'save'
    }
    if (!allowed() || host.source() !== source || host.revision(source) !== approvedRevision)
      return null
    try {
      const receipt = await host.prepare(source, intent, query.stamp, permit)
      if (!allowed()) {
        await host.cancel(receipt)
        return null
      }
      transferred = true
      return receipt
    } catch (error) {
      host.warning(error)
      return null
    }
  } finally {
    hold.release()
  }
}
