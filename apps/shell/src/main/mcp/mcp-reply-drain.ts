export type McpRequestId = string | number
export type McpReplyOutcome =
  'flushed' | 'disconnected' | 'write-error' | 'timeout' | 'stopped' | 'protocol-rejected'
export interface McpReplyTicket {
  readonly sequence: number
  readonly generation: number
  readonly session: string
  readonly requestId: McpRequestId
}
export interface McpReplyFailure {
  session: string
  requestId: McpRequestId
  outcome: McpReplyOutcome
  reason?: string
}
export interface McpReplyDrainStatus {
  draining: boolean
  owned: number
  running: number
  awaitingDispatch: number
  pendingReplies: number
  failures: McpReplyFailure[]
}
interface Entry {
  ticket: McpReplyTicket
  started: boolean
  settled: boolean
  emitted: boolean
  networkDone: boolean
  outcome?: McpReplyOutcome
  reason?: string
  abort: () => void
  flushTimer?: unknown
}
interface Options {
  maxPending?: number
  maxPerSession?: number
  maxSessionIds?: number
  maxSeenIds?: number
  timeoutMs?: number
  changed?: () => void
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}
const idKey = (id: McpRequestId) => typeof id + ':' + JSON.stringify(id)
export function isMcpRequestId(value: unknown): value is McpRequestId {
  return (
    (typeof value === 'string' && value.length <= 512) ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}
/** Only tools/call requests can cause tool work; reserve the complete batch before SDK dispatch. */
export function toolRequestIds(body: unknown): McpRequestId[] {
  const messages = Array.isArray(body) ? body : [body],
    ids: McpRequestId[] = []
  if (messages.length > 128) throw new Error('The MCP request batch exceeds its admission limit.')
  const batchIds = new Set<string>()
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const request = message as { method?: unknown; id?: unknown }
    if (typeof request.method === 'string' && isMcpRequestId(request.id)) {
      const key = idKey(request.id)
      if (batchIds.has(key)) throw new Error('Duplicate MCP request id inside one batch.')
      batchIds.add(key)
    }
  }
  for (const message of messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { method?: unknown }).method !== 'tools/call'
    )
      continue
    const id = (message as { id?: unknown }).id
    if (!isMcpRequestId(id))
      throw new Error('A tool call requires a bounded string or finite numeric request id.')
    ids.push(id)
  }
  return ids
}
export function requestMessageIds(body: unknown): McpRequestId[] {
  return (Array.isArray(body) ? body : [body])
    .filter(
      (value): value is { method: string; id: McpRequestId } =>
        !!value &&
        typeof value === 'object' &&
        typeof (value as { method?: unknown }).method === 'string' &&
        isMcpRequestId((value as { id?: unknown }).id),
    )
    .map((value) => value.id)
}
/** Reply completion and actual tool completion are separate owned lifetimes. No timer frees a running handler. */
export class McpReplyDrain {
  private readonly entries = new Map<number, Entry>()
  private readonly activeKeys = new Map<string, number>()
  private readonly seen = new Map<string, Set<string>>()
  private readonly closedSessions = new Set<string>()
  private readonly history: McpReplyFailure[] = []
  private generation = 0
  private next = 0
  private draining = false
  private wait?: {
    promise: Promise<McpReplyDrainStatus>
    resolve: (status: McpReplyDrainStatus) => void
    timer?: unknown
  }
  private deadlineReached = false
  constructor(private readonly options: Options = {}) {}
  private sessionKey(generation: number, session: string) {
    return generation + '\0' + session
  }
  private requestKey(generation: number, session: string, id: McpRequestId) {
    return this.sessionKey(generation, session) + '\0' + idKey(id)
  }
  activate(generation: number): void {
    this.generation = generation
    this.cancelDrain()
  }
  status(): McpReplyDrainStatus {
    return {
      draining: this.draining,
      owned: this.entries.size,
      running: [...this.entries.values()].filter((e) => e.started && !e.settled).length,
      awaitingDispatch: [...this.entries.values()].filter((e) => !e.started && !e.settled).length,
      pendingReplies: [...this.entries.values()].filter((e) => !e.networkDone).length,
      failures: this.history.map((value) => ({ ...value })),
    }
  }
  admit(
    generation: number,
    session: string,
    ids: readonly McpRequestId[],
    abort: () => void,
    requestIds: readonly McpRequestId[] = ids,
  ): McpReplyTicket[] {
    if (!requestIds.length) return []
    if ((ids.length && this.draining) || generation !== this.generation)
      throw new Error('MCP is draining for quit; no new tool work was accepted.')
    const sk = this.sessionKey(generation, session),
      seen = this.seen.get(sk) ?? new Set<string>(),
      incoming = new Set<string>()
    if (this.closedSessions.has(sk)) throw new Error('The MCP session is closed.')
    for (const id of requestIds) {
      const key = idKey(id)
      if (incoming.has(key) || seen.has(key))
        throw new Error('Duplicate MCP request id; use a fresh id or a new client session.')
      incoming.add(key)
    }
    if (
      this.entries.size + ids.length > (this.options.maxPending ?? 128) ||
      [...this.entries.values()].filter(
        (e) => e.ticket.generation === generation && e.ticket.session === session,
      ).length +
        ids.length >
        (this.options.maxPerSession ?? 32)
    )
      throw new Error('MCP has too many outstanding tool replies; no new work was accepted.')
    if (seen.size + requestIds.length > (this.options.maxSessionIds ?? 4096))
      throw new Error('This MCP session reached its request-id limit; initialize a new session.')
    if (
      [...this.seen.values()].reduce((count, values) => count + values.size, 0) +
        requestIds.length >
      (this.options.maxSeenIds ?? 16384)
    )
      throw new Error(
        'MCP request history is full; close an earlier client session before accepting more work.',
      )
    for (const id of requestIds) seen.add(idKey(id))
    const tickets = ids.map((requestId) => {
      const ticket = Object.freeze({ sequence: ++this.next, generation, session, requestId })
      this.entries.set(ticket.sequence, {
        ticket,
        started: false,
        settled: false,
        emitted: false,
        networkDone: false,
        abort,
      })
      this.activeKeys.set(this.requestKey(generation, session, requestId), ticket.sequence)
      return ticket
    })
    this.seen.set(sk, seen)
    this.changed()
    return tickets
  }
  private current(ticket: McpReplyTicket): Entry | undefined {
    const entry = this.entries.get(ticket.sequence)
    return entry && entry.ticket === ticket ? entry : undefined
  }
  find(generation: number, session: string, id: McpRequestId): McpReplyTicket | undefined {
    const sequence = this.activeKeys.get(this.requestKey(generation, session, id))
    return sequence === undefined ? undefined : this.entries.get(sequence)?.ticket
  }
  begin(generation: number, session: string, id: unknown): McpReplyTicket {
    if (!isMcpRequestId(id)) throw new Error('MCP tool dispatch has no owned request identity.')
    const ticket = this.find(generation, session, id),
      entry = ticket && this.current(ticket)
    if (
      !entry ||
      generation !== this.generation ||
      entry.started ||
      entry.networkDone ||
      entry.outcome
    )
      throw new Error('The MCP request expired or was not admitted; no tool work was started.')
    entry.started = true
    this.changed()
    return entry.ticket
  }
  settle(ticket: McpReplyTicket): void {
    const entry = this.current(ticket)
    if (!entry) return
    entry.settled = true
    this.release(entry)
    this.changed()
  }
  emission(generation: number, session: string, message: unknown): McpReplyTicket | undefined {
    if (!message || typeof message !== 'object') return
    const value = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
    if (
      value.method !== undefined ||
      !isMcpRequestId(value.id) ||
      !('result' in value || 'error' in value)
    )
      return
    const ticket = this.find(generation, session, value.id),
      entry = ticket && this.current(ticket)
    if (!entry) return
    if (entry.emitted || entry.networkDone || entry.outcome) {
      this.fail(ticket, 'write-error', 'Duplicate or obsolete terminal response.')
      throw new Error('MCP terminal response no longer owns its reply slot.')
    }
    entry.emitted = true
    if (this.draining) this.startFlushDeadline(entry)
    return ticket
  }
  finished(ticket: McpReplyTicket): void {
    const entry = this.current(ticket)
    if (!entry) return
    this.network(entry, entry.emitted ? 'flushed' : 'protocol-rejected')
  }
  writeFlushed(ticket: McpReplyTicket): void {
    const entry = this.current(ticket)
    if (entry) this.network(entry, 'flushed')
  }
  disconnected(
    ticket: McpReplyTicket,
    reason = 'The client connection closed before its reply flushed.',
  ): void {
    const entry = this.current(ticket)
    if (entry) this.network(entry, 'disconnected', reason)
  }
  writeError(ticket: McpReplyTicket, error: unknown): void {
    const entry = this.current(ticket)
    if (entry) this.network(entry, 'write-error', String(error))
  }
  fail(ticket: McpReplyTicket, outcome: McpReplyOutcome, reason?: string): void {
    const entry = this.current(ticket)
    if (!entry) return
    this.note(entry, outcome, reason)
    try {
      entry.abort()
    } catch {}
    this.changed()
  }
  private note(entry: Entry, outcome: McpReplyOutcome, reason?: string): void {
    if (entry.outcome) return
    entry.outcome = outcome
    entry.reason = reason?.slice(0, 1024)
    if (outcome !== 'flushed') {
      this.history.push({
        session: entry.ticket.session,
        requestId: entry.ticket.requestId,
        outcome,
        reason: entry.reason,
      })
      if (this.history.length > 128) this.history.shift()
    }
  }
  private network(entry: Entry, outcome: McpReplyOutcome, reason?: string): void {
    this.note(entry, outcome, reason)
    entry.networkDone = true
    if (!entry.started) entry.settled = true
    this.release(entry)
    this.changed()
  }
  private release(entry: Entry): void {
    if (entry.networkDone && entry.flushTimer !== undefined) {
      this.clearTimer(entry.flushTimer)
      entry.flushTimer = undefined
    }
    if (!entry.networkDone || !entry.settled) return
    this.entries.delete(entry.ticket.sequence)
    this.activeKeys.delete(
      this.requestKey(entry.ticket.generation, entry.ticket.session, entry.ticket.requestId),
    )
    const sk = this.sessionKey(entry.ticket.generation, entry.ticket.session)
    if (
      this.closedSessions.has(sk) &&
      ![...this.entries.values()].some(
        (other) => this.sessionKey(other.ticket.generation, other.ticket.session) === sk,
      )
    ) {
      this.seen.delete(sk)
      this.closedSessions.delete(sk)
    }
  }
  sessionClosed(generation: number, session: string, reason?: string): void {
    const sk = this.sessionKey(generation, session)
    this.closedSessions.add(sk)
    for (const entry of [...this.entries.values()])
      if (entry.ticket.generation === generation && entry.ticket.session === session)
        this.disconnected(entry.ticket, reason)
    if (
      ![...this.entries.values()].some(
        (entry) => this.sessionKey(entry.ticket.generation, entry.ticket.session) === sk,
      )
    ) {
      this.seen.delete(sk)
      this.closedSessions.delete(sk)
    }
  }
  /** SDK transport close is not proof that Node/Hono finished writing. Abort owned IO, then await actual events. */
  sessionEnded(
    generation: number,
    session: string,
    reason = 'The SDK session ended before its local reply completed.',
  ): void {
    const sk = this.sessionKey(generation, session)
    this.closedSessions.add(sk)
    for (const entry of [...this.entries.values()])
      if (entry.ticket.generation === generation && entry.ticket.session === session)
        this.fail(entry.ticket, 'disconnected', reason)
    if (
      ![...this.entries.values()].some(
        (entry) => this.sessionKey(entry.ticket.generation, entry.ticket.session) === sk,
      )
    ) {
      this.seen.delete(sk)
      this.closedSessions.delete(sk)
    }
  }
  stopGeneration(generation: number): void {
    if (this.generation === generation) this.draining = true
    for (const entry of [...this.entries.values()])
      if (entry.ticket.generation === generation)
        this.fail(
          entry.ticket,
          'stopped',
          'MCP transport stopped; this does not settle executing tool work.',
        )
  }
  beginDrain(): Promise<McpReplyDrainStatus> {
    this.draining = true
    for (const entry of this.entries.values()) if (entry.emitted) this.startFlushDeadline(entry)
    if (!this.entries.size) return Promise.resolve(this.status())
    if (this.wait) return this.wait.promise
    if (this.deadlineReached) return Promise.resolve(this.status())
    let resolve!: (status: McpReplyDrainStatus) => void
    const promise = new Promise<McpReplyDrainStatus>((done) => {
      resolve = done
    })
    this.wait = { promise, resolve }
    const set =
      this.options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
    this.wait.timer = set(() => {
      this.deadlineReached = true
      this.finishWait()
    }, this.options.timeoutMs ?? 5000)
    this.changed()
    return promise
  }
  private clearTimer(id: unknown): void {
    ;(this.options.clearTimer ?? ((value) => clearTimeout(value as ReturnType<typeof setTimeout>)))(
      id,
    )
  }
  private startFlushDeadline(entry: Entry): void {
    if (entry.networkDone || entry.flushTimer !== undefined) return
    const set =
      this.options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
    entry.flushTimer = set(() => {
      entry.flushTimer = undefined
      if (this.current(entry.ticket) && !entry.networkDone)
        this.fail(
          entry.ticket,
          'timeout',
          'The emitted local reply did not flush before its bounded deadline.',
        )
    }, this.options.timeoutMs ?? 5000)
  }
  cancelDrain(): void {
    this.draining = false
    this.deadlineReached = false
    for (const entry of this.entries.values())
      if (entry.flushTimer !== undefined) {
        this.clearTimer(entry.flushTimer)
        entry.flushTimer = undefined
      }
    this.finishWait()
    this.changed()
  }
  private finishWait(): void {
    const wait = this.wait
    if (!wait) return
    this.wait = undefined
    if (wait.timer !== undefined)
      (this.options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)))(
        wait.timer,
      )
    wait.resolve(this.status())
  }
  private changed(): void {
    if (!this.entries.size) this.finishWait()
    this.options.changed?.()
  }
}

export interface McpQuitService {
  beginQuitDrain(): Promise<McpReplyDrainStatus>
  cancelQuitDrain(): void
  replyDrainStatus(): McpReplyDrainStatus
  onReplyStateChange?: (listener: () => void) => () => void
}
export interface McpQuitReport {
  services: McpReplyDrainStatus[]
  owned: number
  running: number
  pendingReplies: number
}
export interface McpQuitApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}
export interface McpReplyQuitGuard {
  cancel(reason?: string): void
  /** Main calls synchronously after publishing an owned service, before start. */
  ownershipChanged(): void
}
/** A quit intent adopts current ownership before each resume and before a late start. */
export function installMcpReplyQuitGuard(
  app: McpQuitApp,
  options: {
    services: () => readonly McpQuitService[]
    epoch?: () => number
    onQuitDeferred?: (report: McpQuitReport) => void
    onQuitBlocked: (report: McpQuitReport) => void
    onQuitInterrupted?: (report: McpQuitReport, reason: string) => void
  },
): McpReplyQuitGuard {
  interface Intent {
    cycle: number
    epoch: number | undefined
    services: Set<McpQuitService>
    drains: Map<McpQuitService, Promise<McpReplyDrainStatus>>
    blocked: boolean
    retried: boolean
  }
  let cycle = 0,
    waiting = false,
    resuming = false,
    notified = false,
    refreshing = false
  let intent: Intent | undefined
  const subscriptions = new Map<McpQuitService, () => void>()
  const summarize = (services: Iterable<McpQuitService>): McpQuitReport => {
    const states = [...services].map((service) => service.replyDrainStatus())
    return {
      services: states,
      owned: states.reduce((n, s) => n + s.owned, 0),
      running: states.reduce((n, s) => n + s.running, 0),
      pendingReplies: states.reduce((n, s) => n + s.pendingReplies, 0),
    }
  }
  const valid = (value: Intent) =>
    intent === value && value.cycle === cycle && value.epoch === options.epoch?.()
  const notifyBlocked = (report: McpQuitReport) => {
    if (notified) return
    notified = true
    try {
      options.onQuitBlocked(report)
    } catch (error) {
      console.warn('[mcp] pending-work notice failed:', error)
    }
  }
  const deferred = (report: McpQuitReport) => {
    try {
      options.onQuitDeferred?.(report)
    } catch (error) {
      console.warn('[mcp] deferred-quit notice failed:', error)
    }
  }
  const cancel = (reason = 'The quit intent was canceled.') => {
    const previous = intent,
      services = new Set([...options.services(), ...(previous?.services ?? [])])
    cycle++
    waiting = false
    notified = false
    intent = undefined
    for (const off of subscriptions.values()) off()
    subscriptions.clear()
    for (const service of services) service.cancelQuitDrain()
    if (previous) {
      const report = summarize(services)
      try {
        if (options.onQuitInterrupted) options.onQuitInterrupted(report, reason)
        else options.onQuitBlocked(report)
      } catch (error) {
        console.warn('[mcp] interrupted-quit notice failed:', error)
      }
    }
  }
  const ensureValid = (value: Intent) => {
    if (valid(value)) return true
    if (intent === value) cancel('The MCP configuration changed while quit was waiting.')
    return false
  }
  const refresh = (value: Intent) => {
    if (refreshing || !ensureValid(value)) return
    refreshing = true
    try {
      const current = new Set(options.services())
      for (const service of current)
        if (!value.services.has(service)) {
          // Publish membership before callbacks: beginQuitDrain can synchronously
          // report state. A new service must be blocked before its start is awaited.
          value.services.add(service)
          if (service.onReplyStateChange && !subscriptions.has(service))
            subscriptions.set(service, service.onReplyStateChange(retry))
          const drain = service.beginQuitDrain()
          value.drains.set(service, drain)
          void drain.catch(() => {})
        }
      // Removing a quiescent retired instance is normal completion, not a new
      // configuration/quit intent. Still-owned retired work remains adopted.
      for (const service of [...value.services])
        if (!current.has(service) && !service.replyDrainStatus().owned) {
          value.services.delete(service)
          value.drains.delete(service)
          subscriptions.get(service)?.()
          subscriptions.delete(service)
        }
    } finally {
      refreshing = false
    }
  }
  const resume = (value: Intent) => {
    if (!ensureValid(value) || value.retried) return
    refresh(value)
    if (!ensureValid(value)) return
    const report = summarize(value.services)
    if (report.owned) {
      value.blocked = true
      deferred(report)
      notifyBlocked(report)
      return
    }
    value.retried = true
    resuming = true
    try {
      app.quit()
    } finally {
      resuming = false
    }
  }
  function retry(): void {
    const value = intent
    if (!value || refreshing || !ensureValid(value)) return
    refresh(value)
    if (!waiting && value.blocked && !value.retried && !summarize(value.services).owned)
      resume(value)
  }
  const wait = (value: Intent) => {
    if (waiting || !ensureValid(value)) return
    waiting = true
    const attempt = cycle
    void Promise.all([...value.drains.values()])
      .then(() => {
        if (!ensureValid(value)) return
        refresh(value)
        if (!ensureValid(value)) return
        const report = summarize(value.services)
        if (report.owned) {
          value.blocked = true
          notifyBlocked(report)
          return
        }
        resume(value)
      })
      .catch(() => {
        if (ensureValid(value)) {
          value.blocked = true
          notifyBlocked(summarize(value.services))
        }
      })
      .finally(() => {
        if (attempt === cycle) {
          waiting = false
          retry()
        }
      })
  }
  app.on('before-quit', (event) => {
    if (intent && !valid(intent)) cancel('The MCP configuration changed before this quit attempt.')
    if (!intent)
      intent = {
        cycle,
        epoch: options.epoch?.(),
        services: new Set(),
        drains: new Map(),
        blocked: false,
        retried: false,
      }
    const value = intent
    refresh(value)
    if (!ensureValid(value)) {
      event.preventDefault()
      return
    }
    const report = summarize(value.services)
    if (!report.owned) return
    // Even a guarded retry rechecks the real current set. A synchronous earlier
    // listener cannot add a writer which then escapes a resuming shortcut.
    event.preventDefault()
    deferred(report)
    if (resuming) {
      value.retried = false
      value.blocked = true
      notifyBlocked(report)
    }
    wait(value)
  })
  return {
    cancel,
    ownershipChanged: () => {
      const value = intent
      if (!value || !ensureValid(value)) return
      refresh(value)
      if (!ensureValid(value)) return
      const report = summarize(value.services)
      if (report.owned) {
        deferred(report)
        wait(value)
      } else retry()
    },
  }
}
