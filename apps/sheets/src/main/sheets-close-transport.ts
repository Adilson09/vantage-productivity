import {
  isCloseLeaseStamp,
  isCloseLeaseTicket,
  type CloseLeaseTicket,
} from '../../../../packages/electron-utils/src/close-lease'
import type {
  SheetsPrepareCloseRequest,
  SheetsPrepareCloseResult,
  SheetsCloseSource,
} from '../shared/sheets-close'
import type { SheetsRendererCloseAdmission } from './sheets-close-coordinator'

export interface SheetsCloseTransportOptions<Owner> {
  send(owner: Owner, request: SheetsPrepareCloseRequest & { requestId: string }): void
  /** Snapshot all already-admitted owner publication tails synchronously. */
  publicationTail(owner: Owner): Promise<void>
  alive(owner: Owner): boolean
  report(error: unknown): void
  timeoutMs?: number
}
interface Pending {
  request: SheetsPrepareCloseRequest
  claimed: boolean
  released: boolean
  finalized: boolean
  actuallySettled: boolean
  resultSettled: boolean
  timer?: ReturnType<typeof setTimeout>
  resolveResult(result: SheetsPrepareCloseResult): void
  rejectResult(error: unknown): void
  resolveActual(): void
  rejectActual(error: unknown): void
  actual: Promise<void>
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const sameTicket = (a: CloseLeaseTicket, b: CloseLeaseTicket): boolean =>
  a.id === b.id && a.sequence === b.sequence && a.source === b.source
export function isSheetsCloseSource(v: unknown): v is SheetsCloseSource {
  return (
    object(v) &&
    typeof v.lineage === 'string' &&
    v.lineage.length > 0 &&
    v.lineage.length <= 1024 &&
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0 &&
    v.sessionId.length <= 512 &&
    typeof v.openedSha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(v.openedSha256) &&
    (v.documentPath === null || typeof v.documentPath === 'string')
  )
}
export function isSheetsPrepareCloseResult(v: unknown): v is SheetsPrepareCloseResult {
  if (
    !object(v) ||
    typeof v.current !== 'boolean' ||
    typeof v.published !== 'boolean' ||
    typeof v.clean !== 'boolean' ||
    (v.intent !== 'save' && v.intent !== 'discard') ||
    (v.savedPath !== undefined && typeof v.savedPath !== 'string') ||
    (v.error !== undefined && typeof v.error !== 'string')
  )
    return false
  if (v.closeLease === undefined)
    return !v.current || (typeof v.error === 'string' && v.error.length > 0)
  const e = v.closeLease
  return (
    object(e) &&
    isCloseLeaseTicket(e.ticket) &&
    isCloseLeaseStamp(e.stamp) &&
    isSheetsCloseSource(e.source) &&
    typeof e.payloadSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(e.payloadSha256)
  )
}

/** A caller deadline never substitutes for a distinct renderer-finalizer message. */
export class SheetsCloseTransport<Owner> {
  private readonly pending = new Map<Owner, Pending>()
  constructor(private readonly options: SheetsCloseTransportOptions<Owner>) {}

  prepare(owner: Owner, request: SheetsPrepareCloseRequest): SheetsRendererCloseAdmission {
    if (this.pending.has(owner))
      throw new Error('A previous renderer close writer is still reserved.')
    let resolveResult!: Pending['resolveResult'], rejectResult!: Pending['rejectResult']
    let resolveActual!: Pending['resolveActual'], rejectActual!: Pending['rejectActual']
    const result = new Promise<SheetsPrepareCloseResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const actualSettled = new Promise<void>((resolve, reject) => {
      resolveActual = resolve
      rejectActual = reject
    })
    // Observers do not replace either caller-visible promise.
    void result.catch(() => undefined)
    void actualSettled.catch((error) => this.options.report(error))
    const pending: Pending = {
      request: structuredClone(request),
      claimed: false,
      released: false,
      finalized: false,
      actuallySettled: false,
      resultSettled: false,
      resolveResult,
      rejectResult,
      resolveActual,
      rejectActual,
      actual: actualSettled,
    }
    this.pending.set(owner, pending)
    pending.timer = setTimeout(() => {
      if (pending.resultSettled) return
      pending.resultSettled = true
      pending.rejectResult(
        new Error('Preparing workbook close timed out; its actual writer remains reserved.'),
      )
    }, this.options.timeoutMs ?? 120_000)
    try {
      this.options.send(owner, { ...request, requestId: request.ticket.id })
    } catch (error) {
      pending.resultSettled = true
      if (pending.timer) clearTimeout(pending.timer)
      pending.rejectResult(error)
      // Delivery is uncertain. Only a finalizer or verified owner destruction
      // plus native publication settlement can release actual ownership.
    }
    return { result, actualSettled }
  }

  claim(owner: Owner, ticket: CloseLeaseTicket): boolean {
    const p = this.pending.get(owner)
    if (!p || p.released || p.finalized || !sameTicket(p.request.ticket, ticket)) return false
    p.claimed = true
    return true
  }
  current(owner: Owner): SheetsPrepareCloseRequest | null {
    const p = this.pending.get(owner)
    return p ? structuredClone(p.request) : null
  }
  accepts(owner: Owner, ticket: CloseLeaseTicket): boolean {
    const p = this.pending.get(owner)
    return !!p && p.claimed && !p.released && !p.finalized && sameTicket(p.request.ticket, ticket)
  }
  assertWriter(owner: Owner, ticket?: CloseLeaseTicket): void {
    const p = this.pending.get(owner)
    if (!p) return
    if (!ticket || !this.accepts(owner, ticket))
      throw new Error('This workbook writer is not admitted by the active close request.')
  }
  receiveResult(owner: Owner, requestId: unknown, result: unknown): boolean {
    const p = this.pending.get(owner)
    if (
      !p ||
      requestId !== p.request.ticket.id ||
      p.released ||
      p.resultSettled ||
      !isSheetsPrepareCloseResult(result) ||
      (result.current && !p.claimed)
    )
      return false
    if (
      result.intent !== p.request.intent ||
      (result.closeLease && !sameTicket(result.closeLease.ticket, p.request.ticket))
    )
      return false
    p.resultSettled = true
    if (p.timer) clearTimeout(p.timer)
    p.resolveResult(structuredClone(result))
    return true
  }
  receiveActualSettled(owner: Owner, requestId: unknown): boolean {
    const p = this.pending.get(owner)
    if (!p || requestId !== p.request.ticket.id || p.finalized) return false
    p.finalized = true
    this.waitNative(owner, p)
    return true
  }
  release(owner: Owner, ticket: CloseLeaseTicket, reason: string): void {
    const p = this.pending.get(owner)
    if (!p || !sameTicket(p.request.ticket, ticket)) return
    p.released = true
    if (!p.resultSettled) {
      p.resultSettled = true
      if (p.timer) clearTimeout(p.timer)
      p.rejectResult(new Error(reason))
    }
    this.prune(owner, p)
  }
  /** Only call after the actual sender is destroyed; native work still drains. */
  destroy(owner: Owner): Promise<void> {
    const p = this.pending.get(owner)
    if (!p) return this.options.publicationTail(owner)
    if (this.options.alive(owner))
      throw new Error('A live renderer cannot be assumed actually settled.')
    p.released = true
    if (!p.resultSettled) {
      p.resultSettled = true
      if (p.timer) clearTimeout(p.timer)
      p.rejectResult(new Error('Workbook renderer was destroyed.'))
    }
    if (!p.finalized) {
      p.finalized = true
      this.waitNative(owner, p)
    }
    return p.actual
  }
  private waitNative(owner: Owner, p: Pending): void {
    let tail: Promise<void>
    try {
      tail = this.options.publicationTail(owner)
    } catch (error) {
      p.rejectActual(error)
      this.options.report(error)
      return
    }
    void tail.then(
      () => {
        p.actuallySettled = true
        p.resolveActual()
        this.prune(owner, p)
      },
      (error) => {
        // A failed drain is reported, never silently converted into a successful finalizer.
        p.rejectActual(error)
        this.options.report(error)
      },
    )
  }
  private prune(owner: Owner, p: Pending): void {
    if (p.released && p.actuallySettled && this.pending.get(owner) === p) this.pending.delete(owner)
  }
}
