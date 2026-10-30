import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type {
  CalendarOccurrenceOptions,
  CalendarWorkspaceApi,
  CalendarWorkspaceOptions,
} from './calendar-types'
import {
  assertCalendarJson,
  assertCalendarRequest,
  CALENDAR_DEFAULT_STARTUP_MS,
  CALENDAR_GENERATION_DIRECTORY,
  CALENDAR_MAX_INPUT,
  CALENDAR_MAX_OUTPUT,
  CALENDAR_MAX_READY,
  CALENDAR_METHODS,
  CALENDAR_READY_ENV,
  CALENDAR_WRITES,
  CALENDAR_WORKSPACE_FILENAME,
  decodeCalendarJson,
  isCalendarMethod,
  sanitizeCalendarFailure,
  validCalendarResponse,
  validCalendarReady,
} from './calendar-worker-protocol'
import type {
  CalendarInitializationResult,
  CalendarRemoteMetadata,
  CalendarRemoteResult,
  CalendarSourcePreview,
  CalendarWorkerFailure,
  CalendarWorkerMethod,
  CalendarWorkerRequest,
  CalendarWorkspaceMethod,
} from './calendar-worker-protocol'
export type {
  CalendarRemoteMetadata,
  CalendarRemoteMutation,
  CalendarRemoteScheduling,
  CalendarSourcePreview,
} from './calendar-worker-protocol'

export interface CalendarProcessOptions {
  workerPath: string
  executable?: string
  deadlineMs?: number
  /** Separate bounded runtime readiness budget; never extends the processing deadline. */
  startupDeadlineMs?: number
  maxHeapMb?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}
export interface IsolatedCalendarWorkspaceOptions extends CalendarProcessOptions {
  path: string
  workspaceOptions?: Omit<CalendarWorkspaceOptions, 'create'>
}
interface FixedOptions {
  path: string | undefined
  workerPath: string
  executable: string
  deadlineMs: number
  startupDeadlineMs: number
  maxHeapMb: number
  maxOutputBytes: number
  signal: AbortSignal | undefined
  workspaceOptions: Omit<CalendarWorkspaceOptions, 'create'> | undefined
}
export type AsyncCalendarWorkspaceApi = {
  [M in CalendarWorkspaceMethod]: (
    ...args: Parameters<CalendarWorkspaceApi[M]>
  ) => Promise<CalendarRemoteResult<M>>
}
export class CalendarWorkerError extends Error {
  readonly code: string
  readonly mutationMayHaveCommitted: boolean
  constructor(failure: CalendarWorkerFailure) {
    super(
      sanitizeCalendarFailure(failure.message) +
        (failure.mutationMayHaveCommitted
          ? ' Refresh the workspace before retrying; changes may already have been saved.'
          : ''),
    )
    this.name = 'CalendarWorkerError'
    this.code = failure.code
    this.mutationMayHaveCommitted = failure.mutationMayHaveCommitted
  }
}
function error(code: string, message: string, uncertain = false): CalendarWorkerError {
  return new CalendarWorkerError({ code, message, mutationMayHaveCommitted: uncertain })
}
function fixed(
  options: CalendarProcessOptions,
  path?: string,
  workspaceOptions?: Omit<CalendarWorkspaceOptions, 'create'>,
): FixedOptions {
  if (
    typeof options.workerPath !== 'string' ||
    !isAbsolute(options.workerPath) ||
    !/\.(?:cjs|mjs|js)$/i.test(options.workerPath) ||
    options.workerPath.includes('\0')
  )
    throw error(
      'CALENDAR_CONFIGURATION',
      'A trusted absolute calendar worker JavaScript path is required.',
    )
  const executable = options.executable ?? process.execPath
  if (!isAbsolute(executable) || /\.(?:bat|cmd)$/i.test(executable) || executable.includes('\0'))
    throw error('CALENDAR_CONFIGURATION', 'A native calendar worker executable path is required.')
  const value: FixedOptions = {
    path,
    workerPath: resolve(options.workerPath),
    executable,
    deadlineMs: options.deadlineMs ?? 5000,
    startupDeadlineMs: options.startupDeadlineMs ?? CALENDAR_DEFAULT_STARTUP_MS,
    maxHeapMb: options.maxHeapMb ?? 256,
    maxOutputBytes: options.maxOutputBytes ?? CALENDAR_MAX_OUTPUT,
    signal: options.signal,
    workspaceOptions: workspaceOptions ? { ...workspaceOptions } : undefined,
  }
  if (
    !Number.isSafeInteger(value.startupDeadlineMs) ||
    value.startupDeadlineMs < 100 ||
    value.startupDeadlineMs > 30_000
  )
    throw error(
      'CALENDAR_CONFIGURATION',
      'Calendar startup must be bounded between 100 and 30000 ms.',
    )
  const sample: CalendarWorkerRequest = {
    version: 1,
    nonce: '0'.repeat(32),
    method: path ? 'metadata' : 'expandSource',
    args: path ? [] : ['', {}],
    deadlineMs: value.deadlineMs,
    maxHeapMb: value.maxHeapMb,
    maxOutputBytes: value.maxOutputBytes,
    ...(path ? { path, ...(workspaceOptions ? { workspaceOptions } : {}) } : {}),
  }
  assertCalendarRequest(sample)
  return value
}

interface Job {
  owner: object
  controller: AbortController
  started: boolean
  settled: boolean
  deadlineAt: number
  queueTimer: ReturnType<typeof setTimeout> | undefined
  start: (signal: AbortSignal, remaining: number) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  external: AbortSignal | undefined
  cancel: () => void
}
const activeJobs = new Set<Job>()
// A killed child can outlive promise cleanup while the OS closes it. Keep its
// capacity reserved until exit/close proves that its parsing threads are gone.
const ownedProcesses = new Set<ChildProcess>()
const retiredProcesses = new Set<ChildProcess>()
const queuedJobs: Job[] = []
const sourceOwner = {}
const initializationOwner = {}
const occupiedSlots = () => activeJobs.size + retiredProcesses.size
function drain(): void {
  while (occupiedSlots() < 2 && queuedJobs.length) {
    const job = queuedJobs.shift()!
    if (job.settled) continue
    if (job.queueTimer) clearTimeout(job.queueTimer)
    const remaining = Math.floor(job.deadlineAt - performance.now())
    if (remaining < 100) {
      job.settled = true
      job.external?.removeEventListener('abort', job.cancel)
      job.reject(
        error(
          'CALENDAR_QUEUE_DEADLINE',
          'The calendar action expired while waiting; it did not start.',
        ),
      )
      continue
    }
    job.started = true
    activeJobs.add(job)
    void Promise.resolve()
      .then(() => {
        const available = Math.floor(job.deadlineAt - performance.now())
        if (available < 100)
          throw error(
            'CALENDAR_QUEUE_DEADLINE',
            'The calendar action expired while waiting; it did not start.',
          )
        return job.start(job.controller.signal, available)
      })
      .then(job.resolve, job.reject)
      .finally(() => {
        job.settled = true
        activeJobs.delete(job)
        job.external?.removeEventListener('abort', job.cancel)
        drain()
      })
  }
}
function schedule<T>(
  owner: object,
  signal: AbortSignal | undefined,
  deadlineMs: number,
  start: (signal: AbortSignal, remaining: number) => Promise<T>,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(
      error('CALENDAR_CANCELLED', 'Calendar action cancelled before it started.'),
    )
  if (occupiedSlots() >= 2 && queuedJobs.length >= 8)
    return Promise.reject(
      error(
        'CALENDAR_BUSY',
        'Too many calendar actions are waiting. Wait for an earlier action to finish.',
      ),
    )
  return new Promise<T>((resolveResult, reject) => {
    const job: Job = {
      owner,
      controller: new AbortController(),
      started: false,
      settled: false,
      deadlineAt: performance.now() + deadlineMs,
      queueTimer: undefined,
      start,
      resolve: (value) => resolveResult(value as T),
      reject,
      external: signal,
      cancel: () => {},
    }
    job.cancel = () => {
      if (job.settled) return
      if (job.started) job.controller.abort()
      else {
        job.settled = true
        const index = queuedJobs.indexOf(job)
        if (index >= 0) queuedJobs.splice(index, 1)
        if (job.queueTimer) clearTimeout(job.queueTimer)
        signal?.removeEventListener('abort', job.cancel)
        reject(error('CALENDAR_CANCELLED', 'Calendar action cancelled before it started.'))
      }
    }
    job.queueTimer = setTimeout(() => {
      if (job.started || job.settled) return
      job.settled = true
      const index = queuedJobs.indexOf(job)
      if (index >= 0) queuedJobs.splice(index, 1)
      signal?.removeEventListener('abort', job.cancel)
      reject(
        error(
          'CALENDAR_QUEUE_DEADLINE',
          'The calendar action expired while waiting; it did not start.',
        ),
      )
    }, deadlineMs)
    signal?.addEventListener('abort', job.cancel, { once: true })
    queuedJobs.push(job)
    if (signal?.aborted) job.cancel()
    drain()
  })
}
function abortOwner(owner?: object): void {
  for (const job of [...activeJobs, ...queuedJobs]) if (!owner || job.owner === owner) job.cancel()
}
/** Shutdown hook also cancels standalone source previews. */
export function abortAllCalendarWorkers(): void {
  abortOwner()
  for (const child of ownedProcesses) child.kill('SIGKILL')
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (/^(NODE_OPTIONS|NODE_PATH|NODE_V8_COVERAGE|ELECTRON_RUN_AS_NODE)$/i.test(key))
      delete env[key]
  env.ELECTRON_RUN_AS_NODE = '1'
  env.NODE_OPTIONS = ''
  return env
}
function rpc(
  options: FixedOptions,
  request: CalendarWorkerRequest,
  input: string,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((done, reject) => {
    if (signal.aborted) {
      reject(error('CALENDAR_CANCELLED', 'Calendar action cancelled before it started.'))
      return
    }
    const readyDeadlineAt = performance.now() + options.startupDeadlineMs
    const child = spawn(
      options.executable,
      ['--max-old-space-size=' + options.maxHeapMb, options.workerPath],
      {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...workerEnvironment(), [CALENDAR_READY_ENV]: request.nonce },
      },
    )
    const readyPipe = child.stdio[3] as Readable | undefined
    ownedProcesses.add(child)
    const releaseOwnership = () => {
      ownedProcesses.delete(child)
      retiredProcesses.delete(child)
      drain()
    }
    let settled = false,
      used = 0,
      diagnostics = 0,
      readyBytes = 0,
      delivered = false
    const chunks: Buffer[] = []
    const readyChunks: Buffer[] = []
    let failure: CalendarWorkerError | undefined
    let forced: ReturnType<typeof setTimeout> | undefined
    let operationTimer: ReturnType<typeof setTimeout> | undefined
    // No request bytes leave this process until the sole ready packet is verified.
    const uncertain = () => delivered && CALENDAR_WRITES.has(request.method)
    const finish = (code: number | null, exitSignal?: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      // The fallback may settle a caller before OS teardown is acknowledged.
      // Reserve that retired child's slot separately from still-active jobs.
      if (ownedProcesses.has(child)) retiredProcesses.add(child)
      clearTimeout(startupTimer)
      if (operationTimer) clearTimeout(operationTimer)
      if (forced) clearTimeout(forced)
      signal.removeEventListener('abort', cancelled)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      readyPipe?.destroy()
      if (failure) {
        reject(failure)
        return
      }
      if (!delivered) {
        reject(error('CALENDAR_STARTUP_FAILED', 'The calendar worker stopped before it was ready.'))
        return
      }
      try {
        const response = decodeCalendarJson(Buffer.concat(chunks, used))
        if (!validCalendarResponse(response, request))
          throw error(
            'CALENDAR_PROTOCOL',
            'The calendar worker returned an unverified response.',
            uncertain(),
          )
        if (exitSignal || code !== (response.ok ? 0 : 1))
          throw error(
            'CALENDAR_PROCESS_FAILED',
            'The calendar worker did not finish successfully.',
            uncertain(),
          )
        if (!response.ok)
          throw new CalendarWorkerError({
            ...response.error,
            mutationMayHaveCommitted: uncertain() || response.error.mutationMayHaveCommitted,
          })
        done(request.method === 'removeCalendar' ? undefined : response.result)
      } catch (reason) {
        reject(
          reason instanceof CalendarWorkerError
            ? reason
            : error(
                'CALENDAR_PROTOCOL',
                'The calendar worker stopped without a complete verified response.',
                uncertain(),
              ),
        )
      }
    }
    const stop = (reason: CalendarWorkerError): void => {
      if (failure || settled) return
      failure = reason
      // This owned process contains all parsing threads, so one kill ends the entire action.
      child.kill('SIGKILL')
      forced = setTimeout(() => finish(null), 1000)
    }
    const cancelled = () =>
      stop(error('CALENDAR_CANCELLED', 'Calendar action cancelled.', uncertain()))
    const startupExpired = () =>
      stop(
        error(
          'CALENDAR_STARTUP_DEADLINE',
          'The calendar worker did not become ready within its startup time limit; no action was sent.',
        ),
      )
    const startupTimer = setTimeout(
      startupExpired,
      Math.max(0, readyDeadlineAt - performance.now()),
    )
    signal.addEventListener('abort', cancelled, { once: true })
    readyPipe?.on('data', (chunk: Buffer) => {
      if (failure || settled) return
      if (chunk.length > CALENDAR_MAX_READY - readyBytes) {
        stop(
          error('CALENDAR_READY_PROTOCOL', 'The calendar worker sent an invalid readiness packet.'),
        )
        return
      }
      readyBytes += chunk.length
      readyChunks.push(Buffer.from(chunk))
    })
    readyPipe?.once('error', () =>
      stop(error('CALENDAR_READY_PROTOCOL', 'The calendar worker readiness pipe failed.')),
    )
    readyPipe?.once('end', () => {
      if (failure || settled) return
      if (performance.now() >= readyDeadlineAt) {
        startupExpired()
        return
      }
      try {
        const ready = decodeCalendarJson(Buffer.concat(readyChunks, readyBytes))
        if (!validCalendarReady(ready, request.nonce)) throw new Error('Invalid readiness packet')
      } catch {
        stop(
          error('CALENDAR_READY_PROTOCOL', 'The calendar worker sent an invalid readiness packet.'),
        )
        return
      }
      clearTimeout(startupTimer)
      operationTimer = setTimeout(
        () =>
          stop(
            error(
              'CALENDAR_DEADLINE',
              'The calendar action exceeded its hard time limit.',
              uncertain(),
            ),
          ),
        options.deadlineMs,
      )
      // From this point a write can reach SQLite even if the response or pipe is lost.
      delivered = true
      child.stdin.end(input)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure || settled) return
      if (!delivered) {
        stop(
          error(
            'CALENDAR_PROTOCOL',
            'The calendar worker returned data before an action was sent.',
          ),
        )
        return
      }
      if (chunk.length > options.maxOutputBytes - used) {
        stop(
          error(
            'CALENDAR_OUTPUT_LIMIT',
            'The calendar worker result exceeded its output limit.',
            uncertain(),
          ),
        )
        return
      }
      used += chunk.length
      chunks.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.length
      if (diagnostics > 65536)
        stop(
          error(
            'CALENDAR_DIAGNOSTIC_LIMIT',
            'The calendar worker exceeded its diagnostic limit.',
            uncertain(),
          ),
        )
    })
    child.once('error', () => {
      if (!child.pid) releaseOwnership()
      failure ??= error(
        'CALENDAR_UNAVAILABLE',
        'The calendar worker could not be started.',
        uncertain(),
      )
      finish(null)
    })
    child.once('exit', (code, exitSignal) => {
      releaseOwnership()
      if (failure) finish(code, exitSignal)
    })
    child.once('close', (code, exitSignal) => {
      releaseOwnership()
      finish(code, exitSignal)
    })
    child.stdin.on('error', () => {
      if (!settled && !failure)
        stop(
          error(
            'CALENDAR_INPUT_FAILED',
            'The calendar request could not be delivered completely.',
            uncertain(),
          ),
        )
    })
    if (signal.aborted) cancelled()
  })
}
function request<M extends CalendarWorkerMethod>(
  owner: object,
  options: FixedOptions,
  method: M,
  args: unknown[],
  signal?: AbortSignal,
): Promise<CalendarRemoteResult<M>> {
  if (!isCalendarMethod(method))
    return Promise.reject(
      error('CALENDAR_METHOD', 'This calendar operation is not available in the isolated worker.'),
    )
  const values = [...args]
  while (values.length && values.at(-1) === undefined) values.pop()
  try {
    assertCalendarJson(values)
  } catch {
    return Promise.reject(
      error(
        'CALENDAR_INPUT',
        'Calendar requests accept only bounded JSON data, without functions or accessors.',
      ),
    )
  }
  const message: CalendarWorkerRequest = {
    version: 1,
    nonce: randomBytes(16).toString('hex'),
    method,
    args: values,
    deadlineMs: options.deadlineMs,
    maxHeapMb: options.maxHeapMb,
    maxOutputBytes: options.maxOutputBytes,
    ...(method !== 'expandSource' && options.path
      ? {
          path: options.path,
          ...(options.workspaceOptions ? { workspaceOptions: options.workspaceOptions } : {}),
        }
      : {}),
  }
  try {
    assertCalendarRequest(message)
  } catch {
    return Promise.reject(
      error('CALENDAR_INPUT', 'The calendar request did not match the allowed operation.'),
    )
  }
  const input = JSON.stringify(message)
  if (Buffer.byteLength(input) > CALENDAR_MAX_INPUT)
    return Promise.reject(
      error(
        'CALENDAR_INPUT_LIMIT',
        'The calendar request exceeds 8 MiB. Choose a smaller calendar.',
      ),
    )
  // Detach from caller-owned objects before the request can wait in the queue.
  const snapshot = JSON.parse(input) as CalendarWorkerRequest
  const combined =
    options.signal && signal
      ? AbortSignal.any([options.signal, signal])
      : (signal ?? options.signal)
  return schedule(owner, combined, options.deadlineMs, (active, remaining) => {
    const timed = { ...snapshot, deadlineMs: remaining }
    return rpc({ ...options, deadlineMs: remaining }, timed, JSON.stringify(timed), active)
  }) as Promise<CalendarRemoteResult<M>>
}

/** Pure local RPC. File publication and function/provider transports are deliberately absent. */
export class AsyncCalendarWorkspace implements AsyncCalendarWorkspaceApi {
  readonly path: string
  private readonly options: FixedOptions
  private disposed = false
  constructor(options: IsolatedCalendarWorkspaceOptions) {
    if (
      typeof options.path !== 'string' ||
      !isAbsolute(options.path) ||
      options.path.includes('\0')
    )
      throw error(
        'CALENDAR_CONFIGURATION',
        'A trusted absolute calendar workspace path is required.',
      )
    this.path = options.path
    this.options = fixed(options, options.path, options.workspaceOptions)
    for (const method of CALENDAR_METHODS)
      if (method !== 'expandSource' && method !== 'metadata' && method !== 'initializeWorkspace')
        Object.defineProperty(this, method, {
          value: (...args: unknown[]) => this.call(method, args as never),
        })
  }
  call<M extends CalendarWorkspaceMethod>(
    method: M,
    args: Parameters<CalendarWorkspaceApi[M]>,
    options: { signal?: AbortSignal } = {},
  ): Promise<CalendarRemoteResult<M>> {
    if (this.disposed)
      return Promise.reject(
        error('CALENDAR_DISPOSED', 'This calendar worker client has been disposed.'),
      )
    if (
      !CALENDAR_METHODS.includes(method) ||
      method === ('expandSource' as string) ||
      method === ('initializeWorkspace' as string) ||
      method === ('metadata' as string)
    )
      return Promise.reject(
        error(
          'CALENDAR_METHOD',
          'This calendar operation is not available in the isolated worker.',
        ),
      )
    return request(this, this.options, method, args, options.signal)
  }
  metadata(options: { signal?: AbortSignal } = {}): Promise<CalendarRemoteMetadata> {
    return this.disposed
      ? Promise.reject(error('CALENDAR_DISPOSED', 'This calendar worker client has been disposed.'))
      : request(this, this.options, 'metadata', [], options.signal)
  }
  abortAll(): void {
    abortOwner(this)
  }
  dispose(): void {
    this.disposed = true
    this.abortAll()
  }
  declare listCalendars: AsyncCalendarWorkspaceApi['listCalendars']
  declare createCalendar: AsyncCalendarWorkspaceApi['createCalendar']
  declare importCalendar: AsyncCalendarWorkspaceApi['importCalendar']
  declare readCalendar: AsyncCalendarWorkspaceApi['readCalendar']
  declare eventDetails: AsyncCalendarWorkspaceApi['eventDetails']
  declare renameCalendar: AsyncCalendarWorkspaceApi['renameCalendar']
  declare removeCalendar: AsyncCalendarWorkspaceApi['removeCalendar']
  declare occurrences: AsyncCalendarWorkspaceApi['occurrences']
  declare allOccurrences: AsyncCalendarWorkspaceApi['allOccurrences']
  declare mutateCalendar: AsyncCalendarWorkspaceApi['mutateCalendar']
  declare applySchedulingMessage: AsyncCalendarWorkspaceApi['applySchedulingMessage']
  declare exportCalendar: AsyncCalendarWorkspaceApi['exportCalendar']
  declare listOutbox: AsyncCalendarWorkspaceApi['listOutbox']
  declare readOutbox: AsyncCalendarWorkspaceApi['readOutbox']
  declare exportOutboxMessage: AsyncCalendarWorkspaceApi['exportOutboxMessage']
  declare beginOutboxAttempt: AsyncCalendarWorkspaceApi['beginOutboxAttempt']
  declare acknowledgeOutbox: AsyncCalendarWorkspaceApi['acknowledgeOutbox']
  declare discardOutbox: AsyncCalendarWorkspaceApi['discardOutbox']
}
export function expandCalendarSourceIsolated(
  source: string,
  options: CalendarOccurrenceOptions,
  processOptions: CalendarProcessOptions,
): Promise<CalendarSourcePreview> {
  return request(sourceOwner, fixed(processOptions), 'expandSource', [source, options])
}

/** Trusted desktop setup only; initialization is not part of the regular workspace RPC surface. */
export async function initializeCalendarWorkspaceIsolated(
  directory: string,
  processOptions: CalendarProcessOptions,
): Promise<CalendarInitializationResult> {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0'))
    throw error('CALENDAR_CONFIGURATION', 'A trusted absolute calendar directory is required.')
  const root = resolve(directory)
  const result = await request(
    initializationOwner,
    fixed({ ...processOptions, deadlineMs: processOptions.deadlineMs ?? 30_000 }, root),
    'initializeWorkspace',
    [],
  )
  const expected =
    result.layout === 'legacy'
      ? join(root, CALENDAR_WORKSPACE_FILENAME)
      : join(root, CALENDAR_GENERATION_DIRECTORY, CALENDAR_WORKSPACE_FILENAME)
  if (resolve(result.path) !== expected)
    throw error(
      'CALENDAR_PROTOCOL',
      'The calendar initializer returned an unexpected workspace path.',
      true,
    )
  return result
}
