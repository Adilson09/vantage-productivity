export interface CloseLeaseTicket {
  id: string
  sequence: number
  /** Opaque main-owned document-session identity; unchanged by an owned Save As. */
  source: string
}

export interface CloseLeaseStamp {
  /** Renderer document generation, separate from the main session identity. */
  source: string
  revision: string
}

export function isCloseLeaseTicket(value: unknown): value is CloseLeaseTicket {
  const ticket = value as CloseLeaseTicket | null
  return (
    !!ticket &&
    typeof ticket.id === 'string' &&
    ticket.id.length > 0 &&
    ticket.id.length <= 512 &&
    Number.isSafeInteger(ticket.sequence) &&
    ticket.sequence > 0 &&
    typeof ticket.source === 'string' &&
    ticket.source.length > 0 &&
    ticket.source.length <= 1024
  )
}

export function isCloseLeaseStamp(value: unknown): value is CloseLeaseStamp {
  const stamp = value as CloseLeaseStamp | null
  return (
    !!stamp &&
    typeof stamp.source === 'string' &&
    stamp.source.length > 0 &&
    stamp.source.length <= 1024 &&
    typeof stamp.revision === 'string' &&
    stamp.revision.length > 0 &&
    stamp.revision.length <= 1024
  )
}

export interface CloseLeaseBrokerOptions<Owner> {
  alive(owner: Owner): boolean
  source(owner: Owner): string
  validate?(owner: Owner, ticket: CloseLeaseTicket, stamp: CloseLeaseStamp): boolean
  release(owner: Owner, ticket: CloseLeaseTicket, reason: string): void
  prepareTimeoutMs?: number
  readyTimeoutMs?: number
  setTimer?(callback: () => void, milliseconds: number): unknown
  clearTimer?(timer: unknown): void
}

interface Entry {
  ticket: CloseLeaseTicket
  phase: 'preparing' | 'ready' | 'cancelled'
  settled: boolean
  stamp?: CloseLeaseStamp
  timer?: unknown
}

const sameTicket = (left: CloseLeaseTicket, right: CloseLeaseTicket): boolean =>
  left.id === right.id && left.sequence === right.sequence && left.source === right.source
const sameStamp = (left: CloseLeaseStamp, right: CloseLeaseStamp): boolean =>
  left.source === right.source && left.revision === right.revision

/** Permission to close lives in main, independently of promise settlement and writer lifetime. */
export class CloseLeaseBroker<Owner> {
  private readonly entries = new Map<Owner, Entry>()
  private readonly issued = new Map<Owner, CloseLeaseTicket[]>()
  private sequence = 0
  private readonly timer: (callback: () => void, milliseconds: number) => unknown
  private readonly clear: (timer: unknown) => void

  constructor(private readonly options: CloseLeaseBrokerOptions<Owner>) {
    this.timer =
      options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds))
    this.clear =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  reserve(owner: Owner, id: string): CloseLeaseTicket {
    if (!this.options.alive(owner)) throw new Error('The document is no longer open.')
    if (this.entries.has(owner)) throw new Error('Another close/save writer is still finishing.')
    const source = this.options.source(owner)
    if (!id || typeof source !== 'string' || !source)
      throw new Error('A close lease requires its request and source identity.')
    const ticket = { id, sequence: ++this.sequence, source }
    const entry: Entry = { ticket, phase: 'preparing', settled: false }
    this.issued.set(owner, [...(this.issued.get(owner) ?? []).slice(-63), { ...ticket }])
    this.entries.set(owner, entry)
    entry.timer = this.timer(
      () => this.invalidate(owner, entry, 'prepare expired'),
      this.options.prepareTimeoutMs ?? 120_000,
    )
    return { ...ticket }
  }

  private current(owner: Owner, ticket: CloseLeaseTicket): Entry | undefined {
    const entry = this.entries.get(owner)
    if (!entry || !sameTicket(entry.ticket, ticket) || entry.phase === 'cancelled') return
    try {
      if (!this.options.alive(owner) || this.options.source(owner) !== ticket.source) return
    } catch {
      return
    }
    return entry
  }

  claim(owner: Owner, ticket: CloseLeaseTicket): boolean {
    const entry = this.current(owner, ticket)
    if (entry?.phase === 'preparing') return true
    this.cancel(owner, ticket, 'obsolete prepare')
    return false
  }

  hasWriter(owner: Owner): boolean {
    return this.entries.get(owner)?.settled === false
  }

  /** Call only when the actual renderer operation finished, even if its caller timed out. */
  settle(owner: Owner, ticket: CloseLeaseTicket): void {
    const entry = this.entries.get(owner)
    if (!entry || !sameTicket(entry.ticket, ticket)) return
    entry.settled = true
    if (entry.phase === 'cancelled') this.entries.delete(owner)
  }

  ready(owner: Owner, ticket: CloseLeaseTicket, stamp: CloseLeaseStamp): boolean {
    const entry = this.current(owner, ticket)
    if (
      !entry ||
      entry.phase !== 'preparing' ||
      !entry.settled ||
      !isCloseLeaseStamp(stamp) ||
      this.options.validate?.(owner, ticket, stamp) === false
    ) {
      this.cancel(owner, ticket, 'not ready')
      return false
    }
    if (entry.timer !== undefined) this.clear(entry.timer)
    entry.phase = 'ready'
    entry.stamp = { ...stamp }
    entry.timer = this.timer(
      () => this.invalidate(owner, entry, 'ready expired'),
      this.options.readyTimeoutMs ?? 5_000,
    )
    return true
  }

  /** The supplied removal is synchronous. Permission disappears before removal or renderer unlock. */
  complete(
    owner: Owner,
    ticket: CloseLeaseTicket,
    stamp: CloseLeaseStamp,
    close: () => boolean,
  ): boolean {
    const entry = this.current(owner, ticket)
    if (
      !entry ||
      entry.phase !== 'ready' ||
      !entry.stamp ||
      !sameStamp(entry.stamp, stamp) ||
      this.options.validate?.(owner, ticket, stamp) === false
    ) {
      this.cancel(owner, ticket, 'commit refused')
      return false
    }
    if (entry.timer !== undefined) this.clear(entry.timer)
    this.entries.delete(owner)
    try {
      const removed = close()
      if (typeof removed !== 'boolean')
        throw new Error('A close lease requires a synchronous Boolean removal callback.')
      return removed
    } finally {
      this.sendRelease(owner, ticket, 'commit finished')
    }
  }

  /** Idempotent for old tokens; canceling an old token never cancels a newer lease. */
  cancel(owner: Owner, ticket?: CloseLeaseTicket, reason = 'cancelled'): boolean {
    const entry = this.entries.get(owner)
    if (entry && (!ticket || sameTicket(entry.ticket, ticket)))
      this.invalidate(owner, entry, reason)
    else if (ticket && this.issued.get(owner)?.some((issued) => sameTicket(issued, ticket)))
      this.sendRelease(owner, ticket, reason)
    return true
  }

  private invalidate(owner: Owner, entry: Entry, reason: string): void {
    if (this.entries.get(owner) !== entry) return
    if (entry.timer !== undefined) this.clear(entry.timer)
    entry.timer = undefined
    // Keep the writer reservation until actual completion. It grants no close permission.
    entry.phase = 'cancelled'
    if (entry.settled) this.entries.delete(owner)
    this.sendRelease(owner, entry.ticket, reason)
  }

  private sendRelease(owner: Owner, ticket: CloseLeaseTicket, reason: string): void {
    try {
      this.options.release(owner, { ...ticket }, reason)
    } catch {
      /* Permission was already invalidated. */
    }
  }

  destroy(owner: Owner): void {
    this.issued.delete(owner)
    const entry = this.entries.get(owner)
    if (!entry) return
    if (entry.timer !== undefined) this.clear(entry.timer)
    this.entries.delete(owner)
    this.sendRelease(owner, entry.ticket, 'destroyed')
  }
}
