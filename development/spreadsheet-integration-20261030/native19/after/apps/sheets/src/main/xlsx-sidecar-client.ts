import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { rm } from 'node:fs/promises'
import {
  XlsxSidecarError,
  type EditInput,
  type EditRecalcRead,
  type EditRecalcResult,
  type EditSessionOpen,
  type EditTransaction,
} from './xlsx-edit-contract'
import { XlsxEditSessions } from './xlsx-edit-session'

export { XlsxSidecarError } from './xlsx-edit-contract'

const PROTOCOL_VERSION = 1
const REQUEST_TIMEOUT_MS = 30_000
// Archive commands stream whole workbooks; large files need more headroom.
const ARCHIVE_TIMEOUT_MS = 180_000
const MAX_STDERR_LENGTH = 8_192

export interface NativeRequestAdmission {
  /** Existing bounded caller result; rejecting this does not release native ownership. */
  readonly result: Promise<unknown>
  /** Matching reply, or definitive failure after confirmed process termination. */
  readonly completion: Promise<unknown>
  /** Always resolves, only when the request can no longer perform native work. */
  readonly actualSettled: Promise<void>
}

export interface NativeRequestLimits {
  readonly maxPendingRequests: number
  readonly maxPendingBytes: number
  readonly maxRequestBytes: number
}
export const NATIVE_REQUEST_LIMITS: Readonly<NativeRequestLimits> = Object.freeze({
  maxPendingRequests: 128,
  maxPendingBytes: 512 * 1024 * 1024,
  maxRequestBytes: 257 * 1024 * 1024,
})
const MAX_ACTIVE_GENERATIONS = 8
const MAX_NATIVE_ACTUAL_WORK = 4096
const MAX_NATIVE_ACTUAL_SUBSCRIBERS = 32
const MAX_NATIVE_PENDING_BYTES = 1024 * 1024 * 1024
let nativePendingBytes = 0
const nativeActualWork = new Set<Promise<void>>()
const nativeActualSubscribers = new Set<(actualSettled: Promise<void>) => void>()

function notifyNativeActualOwner(
  listener: (actualSettled: Promise<void>) => void,
  actual: Promise<void>,
): void {
  const returned: unknown = listener(actual)
  if (
    returned !== null &&
    (typeof returned === 'object' || typeof returned === 'function') &&
    typeof (returned as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(returned).catch(() => undefined)
    throw new Error(
      'Native actual-work ownership must be registered synchronously before dispatch.',
    )
  }
}

/** Main-only ownership notifications contain no document, command, path or payload metadata. */
export function subscribeNativeActualWork(
  listener: (actualSettled: Promise<void>) => void,
): () => void {
  if (nativeActualSubscribers.has(listener))
    throw new Error('The native actual-work subscriber is already installed.')
  if (nativeActualSubscribers.size >= MAX_NATIVE_ACTUAL_SUBSCRIBERS)
    throw new Error('The native actual-work subscriber quota is full.')
  // Register first so a reentrant admission cannot escape the replay boundary.
  nativeActualSubscribers.add(listener)
  try {
    for (const actual of [...nativeActualWork]) notifyNativeActualOwner(listener, actual)
  } catch (error) {
    nativeActualSubscribers.delete(listener)
    throw error
  }
  return () => {
    nativeActualSubscribers.delete(listener)
  }
}

interface ProcessGeneration {
  readonly id: number
  readonly child: ChildProcessWithoutNullStreams
  readonly lines: Interface
  readonly requests: Set<string>
  accepting: boolean
  intentionalStop: boolean
  finished: boolean
  stderr: string
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly complete: (value: unknown) => void
  readonly failCompletion: (error: Error) => void
  readonly resolveActual: () => void
  readonly actualSettled: Promise<void>
  readonly generation: ProcessGeneration
  readonly bytes: number
  timeout?: NodeJS.Timeout
  callerSettled: boolean
  dispatched: boolean
  cancelSent: boolean
  readonly command: string
  /** Session-scoped commands record it so close() can sweep their queue slots. */
  readonly sessionId?: string
}

/** Pure reads a departing consumer can abandon; skipping a queued close (or
 * save) instead would leave its side effects permanently undone. */
const CANCELLABLE_READS = new Set([
  'read_range',
  'read_formula_cells',
  'read_row_outline',
  'read_media',
  'find_cells',
])

// Persistence and retirement must not disappear from the native queue merely
// because their bounded caller stopped waiting. Completion remains observable.
const KEEP_NATIVE_MUTATIONS_AFTER_TIMEOUT = new Set([
  'close',
  'apply_transaction',
  'close_edit_session',
  'checkpoint_document',
  'close_document',
])

interface SidecarResponse {
  readonly version: number
  readonly requestId: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly currentRevision?: number
  }
}

export class XlsxSidecarClient {
  private currentGeneration: ProcessGeneration | null = null
  private readonly generations = new Set<ProcessGeneration>()
  private generationSequence = 0
  private readonly pending = new Map<string, PendingRequest>()
  private pendingBytes = 0
  private readonly requestLimits: NativeRequestLimits
  /// Notified when the sidecar process dies and the NEXT request will spawn a
  /// replacement that has never heard of the session ids we are holding. This
  /// is a positive crash signal, and deliberately NOT the same thing as a
  /// session guard rejecting an id: closing a workbook (or the Save swap that
  /// replaces its session) only sends a `close` command down the live pipe, so
  /// it never reaches here. A renderer that keyed recovery off a guard's error
  /// text could not tell those two apart, and would re-open the file on every
  /// ordinary save.
  private readonly exitListeners = new Set<() => void>()
  private readonly editSessions = new XlsxEditSessions(this)
  private readonly editBindings = new Map<string, { workbookId: string; storePath?: string }>()
  private readonly editOwners = new Map<string, string>()

  constructor(
    private readonly binaryPath: string,
    limits: Partial<NativeRequestLimits> = {},
  ) {
    this.requestLimits = { ...NATIVE_REQUEST_LIMITS, ...limits }
    for (const key of ['maxPendingRequests', 'maxPendingBytes', 'maxRequestBytes'] as const) {
      const value = this.requestLimits[key]
      if (!Number.isSafeInteger(value) || value < 1 || value > NATIVE_REQUEST_LIMITS[key])
        throw new Error('Invalid native request ownership quota.')
    }
    if (this.requestLimits.maxRequestBytes > this.requestLimits.maxPendingBytes)
      throw new Error('A native request cannot exceed the total pending-byte quota.')
  }

  /** Subscribe to unexpected sidecar process death; returns an unsubscribe. */
  onProcessExit(listener: () => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  private notifyExit(): void {
    for (const listener of this.exitListeners) {
      try {
        listener()
      } catch {
        /* An observer cannot undo confirmed termination. */
      }
    }
  }

  async open(path: string, locale = 'zh', shortDateFormat?: string): Promise<unknown> {
    return this.request({
      command: 'open',
      path,
      locale,
      ...(shortDateFormat === undefined ? {} : { shortDateFormat }),
    })
  }

  async readRange(input: {
    readonly sessionId: string
    readonly sheetId: string
    readonly range: {
      readonly startRow: number
      readonly endRow: number
      readonly startColumn: number
      readonly endColumn: number
    }
  }): Promise<unknown> {
    return this.request({ command: 'read_range', ...input })
  }

  async readFormulaCells(input: {
    readonly sessionId: string
    readonly sheetId: string
  }): Promise<unknown> {
    return this.request({ command: 'read_formula_cells', ...input })
  }

  async findCells(
    input: Readonly<Record<string, unknown>> & { readonly sessionId: string },
  ): Promise<unknown> {
    return this.request({ command: 'find_cells', ...input })
  }

  async readRowOutline(input: {
    readonly sessionId: string
    readonly sheetId: string
  }): Promise<unknown> {
    return this.request({ command: 'read_row_outline', ...input })
  }

  async close(sessionId: string): Promise<void> {
    return this.closeSession(sessionId, false)
  }

  /** Lifecycle teardown includes the definitive legacy and edit-session ACKs. */
  async closeSettled(sessionId: string): Promise<void> {
    return this.closeSession(sessionId, true)
  }

  private async closeSession(sessionId: string, definitive: boolean): Promise<void> {
    const edit = this.editBindings.get(sessionId)
    if (edit && this.editOwners.get(edit.workbookId) === sessionId) {
      // Retire queued work immediately, before waiting for native cleanup.
      this.editSessions.forget(edit.workbookId)
    }
    // Skip the session's queued reads so close does not wait behind them;
    // each settles with the sidecar's authoritative "cancelled" failure.
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId === sessionId && CANCELLABLE_READS.has(pending.command)) {
        this.sendCancel(requestId)
      }
    }
    try {
      if (definitive) await this.completedRequest({ command: 'close', sessionId })
      else await this.request({ command: 'close', sessionId })
    } finally {
      await this.releaseEditBinding(sessionId, definitive)
    }
  }

  /** Associate a legacy viewport session with the same tab's edit authority. */
  async bindEditSession(sessionId: string, open: EditSessionOpen): Promise<void> {
    const prior = this.editBindings.get(sessionId)
    if (prior && prior.workbookId !== open.workbookId) await this.releaseEditBinding(sessionId)
    const priorOwner = this.editOwners.get(open.workbookId)
    if (priorOwner && priorOwner !== sessionId) this.editBindings.delete(priorOwner)
    this.editOwners.set(open.workbookId, sessionId)
    this.editBindings.set(sessionId, {
      workbookId: open.workbookId,
      ...(open.storePath === undefined ? {} : { storePath: open.storePath }),
    })
  }

  private async releaseEditBinding(sessionId: string, definitive = false): Promise<void> {
    const edit = this.editBindings.get(sessionId)
    this.editBindings.delete(sessionId)
    if (!edit || this.editOwners.get(edit.workbookId) !== sessionId) return
    this.editOwners.delete(edit.workbookId)
    this.editSessions.forget(edit.workbookId)
    // Only a successful acknowledgement proves the SQLite connection is gone.
    // A timeout or broken pipe can leave it live, so retain its database/WAL.
    if (definitive)
      await this.completedRequest({
        command: 'close_edit_session',
        apiVersion: 1,
        workbookId: edit.workbookId,
      })
    else await this.closeEditSession({ apiVersion: 1, workbookId: edit.workbookId })
    if (edit.storePath) {
      // These paths belong to this document authority, never to its workbook.
      await Promise.all(
        [edit.storePath, `${edit.storePath}-wal`, `${edit.storePath}-shm`].map((path) =>
          rm(path, { force: true }).catch(() => undefined),
        ),
      )
    }
  }

  async openEditSession(input: EditSessionOpen): Promise<unknown> {
    return this.request({ command: 'open_edit_session', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async applyTransaction(input: EditTransaction): Promise<unknown> {
    return this.request({ command: 'apply_transaction', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async snapshot(input: { readonly apiVersion: 1; readonly workbookId: string }): Promise<unknown> {
    return this.request({ command: 'snapshot', ...input })
  }

  async commandResult(input: {
    readonly apiVersion: 1
    readonly workbookId: string
    readonly commandId: string
  }): Promise<unknown> {
    return this.request({ command: 'command_result', ...input })
  }

  async recalcSnapshot(input: {
    readonly apiVersion: 1
    readonly workbookId: string
    readonly revision: number
    readonly reads: readonly EditRecalcRead[]
  }): Promise<unknown> {
    return this.request({ command: 'recalc_snapshot', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async closeEditSession(input: {
    readonly apiVersion: 1
    readonly workbookId: string
  }): Promise<void> {
    await this.request({ command: 'close_edit_session', ...input })
  }

  recalculateEditSession(
    open: EditSessionOpen,
    edits: readonly EditInput[],
    reads: readonly EditRecalcRead[],
  ): Promise<EditRecalcResult> {
    return this.editSessions.recalculate(open, edits, reads)
  }

  async auditPreservation(input: {
    readonly sourcePath: string
    readonly targetPath: string
    readonly allowedChangedEntries: readonly string[]
  }): Promise<unknown> {
    return this.request({ command: 'audit_preservation', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async recalcDocument(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly revision: number
    readonly reads: readonly EditRecalcRead[]
    readonly materializedPath?: string
  }): Promise<unknown> {
    return this.request({ command: 'recalc_document', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async openDocument(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly sourcePath: string
    readonly sheets: readonly { readonly id: string; readonly name: string }[]
    readonly storePath?: string
  }): Promise<unknown> {
    return this.request({ command: 'open_document', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async checkpointDocument(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly commandId: string
    readonly expectedRevision: number
    readonly actor: string
    readonly payload: Record<string, unknown>
  }): Promise<unknown> {
    return this.request({ command: 'checkpoint_document', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async documentSnapshot(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly revision?: number
  }): Promise<unknown> {
    return this.request({ command: 'document_snapshot', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async documentCommandResult(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly commandId: string
  }): Promise<unknown> {
    return this.request({ command: 'document_command_result', ...input })
  }

  async closeDocument(input: {
    readonly apiVersion: 1
    readonly documentId: string
  }): Promise<unknown> {
    return this.request({ command: 'close_document', ...input })
  }

  async readMedia(input: {
    readonly sessionId: string
    readonly visualId: string
  }): Promise<unknown> {
    return this.request({ command: 'read_media', ...input })
  }

  async convertWorkbook(input: { path: string; targetPath: string }): Promise<unknown> {
    return this.request({ command: 'convert_workbook', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async archiveManifest(path: string): Promise<unknown> {
    return this.request({ command: 'archive_manifest', path }, ARCHIVE_TIMEOUT_MS)
  }

  async readEntries(input: {
    readonly path: string
    readonly entries: readonly string[]
    readonly outputDir: string
  }): Promise<unknown> {
    return this.request({ command: 'read_entries', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async scanEntries(input: {
    readonly path: string
    readonly entries: readonly string[]
    readonly needle: string
  }): Promise<unknown> {
    return this.request({ command: 'scan_entries', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  async saveArchive(input: {
    readonly sourcePath: string
    readonly targetPath: string
    readonly replacements: readonly { name: string; contentPath: string }[]
    readonly removals: readonly string[]
    readonly additions: readonly { name: string; contentPath: string }[]
  }): Promise<unknown> {
    return this.request({ command: 'save_archive', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  /** IronCalc-backed recalculation: load the file, apply the pending edits,
   * evaluate, and return the requested cells' computed values. Fail-soft —
   * callers keep cached values when this errors. */
  async recalcCells(input: {
    readonly path: string
    readonly edits: readonly {
      readonly sheet: string
      readonly row: number
      readonly column: number
      readonly input: string
    }[]
    readonly reads: readonly {
      readonly sheet: string
      readonly range: {
        readonly startRow: number
        readonly endRow: number
        readonly startColumn: number
        readonly endColumn: number
      }
    }[]
  }): Promise<unknown> {
    return this.request({ command: 'recalc_cells', ...input }, ARCHIVE_TIMEOUT_MS)
  }

  /**
   * Spawn the sidecar ahead of the first request to hide process cold-start.
   * The prewarm is best-effort: on Windows an unrunnable binary (corrupt,
   * AV-blocked — CreateProcess errors outside Node's delayed-error set, e.g.
   * UNKNOWN) makes spawn() throw synchronously, and letting that propagate
   * crashed tab/window creation with an uncaught main-process exception. The
   * first real request retries the spawn and surfaces the descriptive error
   * through its own handled rejection path instead.
   */
  start(): void {
    try {
      this.ensureStarted()
    } catch (error) {
      console.warn('[sheets] XLSX sidecar prewarm failed:', error)
    }
  }

  getProcessId(): number | null {
    return this.currentGeneration?.child.pid ?? null
  }

  stop(): void {
    this.currentGeneration = null
    for (const generation of this.generations) {
      generation.intentionalStop = true
      generation.accepting = false
      this.rejectCallers(generation, new Error('XLSX sidecar stopped.'))
      // A kill request is not proof of termination. Keep replies and ownership
      // live until this exact process confirms exit/close (or replies first).
      try {
        if (!generation.child.killed) generation.child.kill()
      } catch (error) {
        this.markBroken(generation, asError(error))
      }
    }
  }

  /**
   * Fire-and-forget: handled out of band by the sidecar's reader thread, so
   * it takes effect while earlier requests still wait in the queue. The
   * reply matches no pending entry and is dropped.
   */
  private sendCancel(targetRequestId: string): void {
    const pending = this.pending.get(targetRequestId),
      generation = pending?.generation
    if (
      !pending ||
      pending.cancelSent ||
      !generation ||
      generation.finished ||
      generation.child.killed ||
      !generation.accepting
    )
      return
    pending.cancelSent = true
    // The target's actual hold covers cancellation too. A cancel ACK does not
    // stand in for the target's matching response or process termination.
    try {
      generation.child.stdin.write(
        `${JSON.stringify({
          version: PROTOCOL_VERSION,
          requestId: crypto.randomUUID(),
          command: 'cancel',
          targetRequestId,
        })}\n`,
        (error) => {
          if (error) this.markBroken(generation, error)
        },
      )
    } catch (error) {
      this.markBroken(generation, asError(error))
    }
  }

  private request(
    command: Readonly<Record<string, unknown>>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.requestAttested(command, timeoutMs).result
  }

  private completedRequest(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    const request = this.requestAttested(command)
    void request.result.catch(() => undefined)
    return request.completion
  }

  /** Trusted main-process command entry. Caller timeout never releases actual native work. */
  requestAttested(
    command: Readonly<Record<string, unknown>>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): NativeRequestAdmission {
    const requestId = crypto.randomUUID()
    let payload: string, bytes: number, generation: ProcessGeneration
    try {
      if (
        typeof command.command !== 'string' ||
        !command.command ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > ARCHIVE_TIMEOUT_MS
      )
        throw new Error('Invalid native request command or bounded caller timeout.')
      // Transport identity is main-owned even for the trusted generic entry.
      payload = JSON.stringify({ ...command, version: PROTOCOL_VERSION, requestId })
      bytes = Buffer.byteLength(payload, 'utf8') + 1
      if (
        bytes > this.requestLimits.maxRequestBytes ||
        this.pending.size >= this.requestLimits.maxPendingRequests ||
        this.pendingBytes + bytes > this.requestLimits.maxPendingBytes ||
        nativePendingBytes + bytes > MAX_NATIVE_PENDING_BYTES ||
        nativeActualWork.size >= MAX_NATIVE_ACTUAL_WORK
      )
        throw new Error(
          'Native request ownership quota exceeded; earlier actual work must settle before dispatch.',
        )
      generation = this.ensureStarted()
    } catch (error) {
      return rejectedNativeAdmission(asError(error))
    }

    let resolve!: (value: unknown) => void, reject!: (error: Error) => void
    let complete!: (value: unknown) => void, failCompletion!: (error: Error) => void
    let resolveActual!: () => void
    const result = new Promise<unknown>((yes, no) => {
      resolve = yes
      reject = no
    })
    const completion = new Promise<unknown>((yes, no) => {
      complete = yes
      failCompletion = no
    })
    const actualSettled = new Promise<void>((yes) => {
      resolveActual = yes
    })
    // Existing callers consume only result; preserve the separate rejecting
    // completion for attested consumers without creating unhandled rejections.
    void completion.catch(() => undefined)
    const admission: NativeRequestAdmission = { result, completion, actualSettled }
    const pending: PendingRequest = {
      resolve,
      reject,
      complete,
      failCompletion,
      resolveActual,
      actualSettled,
      generation,
      bytes,
      callerSettled: false,
      dispatched: false,
      cancelSent: false,
      command: String(command.command),
      ...(typeof command.sessionId === 'string' ? { sessionId: command.sessionId } : {}),
    }
    this.pending.set(requestId, pending)
    generation.requests.add(requestId)
    this.pendingBytes += bytes
    nativePendingBytes += bytes
    nativeActualWork.add(actualSettled)
    try {
      // Every owner sees the real promise BEFORE stdin can accept any bytes.
      for (const listener of [...nativeActualSubscribers])
        notifyNativeActualOwner(listener, actualSettled)
    } catch (error) {
      this.finishRequest(requestId, pending, { error: asError(error) })
      return admission
    }
    if (this.pending.get(requestId) !== pending) return admission
    if (generation.finished || !generation.accepting || generation.child.killed) {
      this.finishRequest(requestId, pending, {
        error: new Error('The native process stopped before this request was dispatched.'),
      })
      return admission
    }
    pending.timeout = setTimeout(() => {
      this.rejectCaller(pending, new Error('XLSX sidecar request timed out.'))
      if (!KEEP_NATIVE_MUTATIONS_AFTER_TIMEOUT.has(pending.command)) this.sendCancel(requestId)
    }, timeoutMs)
    pending.dispatched = true
    try {
      generation.child.stdin.write(`${payload}\n`, (error) => {
        // A failed write can follow partial dispatch. It is never exit proof.
        if (error) this.markBroken(generation, error)
      })
    } catch (error) {
      this.markBroken(generation, asError(error))
    }
    return admission
  }

  private ensureStarted(): ProcessGeneration {
    const existing = this.currentGeneration
    if (existing && !existing.finished && !existing.child.killed) {
      if (!existing.accepting)
        throw new Error(
          'The XLSX sidecar pipe failed; actual process exit or an explicit stop is required before replacement.',
        )
      return existing
    }
    if (this.generations.size >= MAX_ACTIVE_GENERATIONS)
      throw new Error(
        'The native process-generation quota is full; previous actual processes must exit.',
      )
    if (this.generationSequence >= Number.MAX_SAFE_INTEGER)
      throw new Error('The native process-generation identity was exhausted.')
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      // Synchronous spawn failures ("spawn UNKNOWN") carry no path in the
      // message — rethrow with enough context to diagnose from a screenshot.
      throw new Error(
        `XLSX sidecar failed to start (${this.binaryPath}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const lines = createInterface({ input: child.stdout })
    const generation: ProcessGeneration = {
      id: ++this.generationSequence,
      child,
      lines,
      requests: new Set(),
      accepting: true,
      intentionalStop: false,
      finished: false,
      stderr: '',
    }
    this.generations.add(generation)
    this.currentGeneration = generation
    lines.on('line', (line) => this.handleLine(generation, line))
    lines.on('error', (error) => this.markBroken(generation, asError(error)))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      generation.stderr = `${generation.stderr}${chunk}`.slice(-MAX_STDERR_LENGTH)
    })
    child.stderr.on('error', (error) => this.markBroken(generation, asError(error)))
    child.stdout.on('error', (error) => this.markBroken(generation, asError(error)))
    child.once('error', (error) => {
      // Node documents an undefined pid when spawn itself failed: no native
      // process ever existed. Errors from an existing pid are not exit proof.
      if (child.pid === undefined) this.finishGeneration(generation, error)
      else this.markBroken(generation, error)
    })
    child.stdin.on('error', () => {
      this.markBroken(
        generation,
        new Error(
          `XLSX sidecar stdin failed (${generation.stderr.trim() || 'broken pipe'}).`.slice(0, 200),
        ),
      )
    })
    child.once('exit', (code, signal) => {
      const detail = generation.stderr.trim()
      const reason = detail
        ? `XLSX sidecar exited: ${detail}`
        : `XLSX sidecar exited with code ${String(code)} and signal ${String(signal)}.`
      this.finishGeneration(generation, new Error(reason))
    })
    // close is also definitive, including a spawn failure with no exit event.
    child.once('close', (code, signal) =>
      this.finishGeneration(
        generation,
        new Error(`XLSX sidecar closed with code ${String(code)} and signal ${String(signal)}.`),
      ),
    )
    return generation
  }

  private handleLine(generation: ProcessGeneration, line: string): void {
    if (generation.finished) return
    let response: SidecarResponse
    try {
      response = JSON.parse(line) as SidecarResponse
    } catch {
      // Library code inside the sidecar can print diagnostics to stdout
      // (IronCalc's importer does, e.g. "Unexpected type (empty) in ...").
      // Treat such lines as noise: rejecting every pending request here
      // nuked all in-flight chunk loads whenever a recalc hit one of those
      // workbooks. A genuinely garbled response surfaces as that one
      // request's timeout instead.
      generation.stderr = `${generation.stderr}[stdout] ${line}\n`.slice(-MAX_STDERR_LENGTH)
      return
    }
    if (
      response.version !== PROTOCOL_VERSION ||
      typeof response.requestId !== 'string' ||
      typeof response.ok !== 'boolean'
    ) {
      generation.stderr = `${generation.stderr}[stdout] ${line}\n`.slice(-MAX_STDERR_LENGTH)
      return
    }
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.generation !== generation) return
    if (response.ok) {
      this.finishRequest(response.requestId, pending, { value: response.result })
      return
    }
    this.finishRequest(response.requestId, pending, {
      error: new XlsxSidecarError(
        response.error?.code ?? 'unknown_error',
        response.error?.message ?? 'XLSX sidecar request failed.',
        response.error?.currentRevision,
      ),
    })
  }

  private rejectCaller(pending: PendingRequest, error: Error): void {
    if (pending.callerSettled) return
    pending.callerSettled = true
    if (pending.timeout !== undefined) clearTimeout(pending.timeout)
    pending.timeout = undefined
    pending.reject(error)
  }

  private rejectCallers(generation: ProcessGeneration, error: Error): void {
    for (const requestId of generation.requests) {
      const pending = this.pending.get(requestId)
      if (pending) this.rejectCaller(pending, error)
    }
  }

  private markBroken(generation: ProcessGeneration, error: Error): void {
    if (generation.finished) return
    generation.accepting = false
    this.rejectCallers(generation, error)
  }

  private finishRequest(
    requestId: string,
    pending: PendingRequest,
    outcome: { value?: unknown; error?: Error },
  ): void {
    if (this.pending.get(requestId) !== pending) return
    if (pending.timeout !== undefined) clearTimeout(pending.timeout)
    if (outcome.error) {
      this.rejectCaller(pending, outcome.error)
      pending.failCompletion(outcome.error)
    } else {
      if (!pending.callerSettled) {
        pending.callerSettled = true
        pending.resolve(outcome.value)
      }
      pending.complete(outcome.value)
    }
    this.pending.delete(requestId)
    pending.generation.requests.delete(requestId)
    this.pendingBytes -= pending.bytes
    nativePendingBytes -= pending.bytes
    nativeActualWork.delete(pending.actualSettled)
    pending.resolveActual()
  }

  private finishGeneration(generation: ProcessGeneration, error: Error): void {
    if (generation.finished) return
    generation.finished = true
    generation.accepting = false
    if (this.currentGeneration === generation) this.currentGeneration = null
    for (const requestId of [...generation.requests]) {
      const pending = this.pending.get(requestId)
      if (pending?.generation === generation) this.finishRequest(requestId, pending, { error })
    }
    generation.lines.close()
    this.generations.delete(generation)
    if (!generation.intentionalStop) this.notifyExit()
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function rejectedNativeAdmission(error: Error): NativeRequestAdmission {
  const failure = Promise.reject(error)
  void failure.catch(() => undefined)
  return { result: failure, completion: failure, actualSettled: Promise.resolve() }
}
