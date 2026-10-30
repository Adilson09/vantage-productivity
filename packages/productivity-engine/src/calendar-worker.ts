import { isAbsolute } from 'node:path'
import { closeSync, writeSync } from 'node:fs'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import type { CalendarWorkspace } from './calendar-workspace'
import {
  assertCalendarRequest,
  CALENDAR_MAX_READY,
  CALENDAR_READY_ENV,
  calendarFailure,
  CALENDAR_MAX_INPUT,
  CALENDAR_MAX_OUTPUT,
  decodeCalendarJson,
  sanitizeCalendarFailure,
  validCalendarResponse,
  validCalendarResult,
} from './calendar-worker-protocol'
import type {
  CalendarWorkerMethod,
  CalendarWorkerRequest,
  CalendarWorkerResponse,
} from './calendar-worker-protocol'

const THREAD_KIND = 'vantage-calendar-operation-v1'
function withoutSource(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { source: _source, ...metadata } = value as Record<string, unknown>
  return metadata
}
function project(method: CalendarWorkerMethod, value: unknown): unknown {
  if (
    [
      'createCalendar',
      'importCalendar',
      'readCalendar',
      'renameCalendar',
      'readOutbox',
      'beginOutboxAttempt',
      'acknowledgeOutbox',
      'discardOutbox',
    ].includes(method)
  )
    return withoutSource(value)
  if (
    (method === 'mutateCalendar' || method === 'applySchedulingMessage') &&
    value &&
    typeof value === 'object'
  ) {
    const result = value as Record<string, unknown>
    return { ...result, calendar: withoutSource(result.calendar) }
  }
  return method === 'removeCalendar' ? null : value
}
function responseError(
  request: Pick<CalendarWorkerRequest, 'nonce' | 'method'>,
  code: string,
  message: string,
): CalendarWorkerResponse {
  return {
    version: 1,
    nonce: request.nonce,
    method: request.method,
    ok: false,
    error: calendarFailure(request, code, message),
  }
}

async function operation(request: CalendarWorkerRequest): Promise<void> {
  let workspace: CalendarWorkspace | undefined
  let response: CalendarWorkerResponse
  try {
    assertCalendarRequest(request)
    let result: unknown
    if (request.method === 'initializeWorkspace') {
      const { initializeCalendarWorkspaceDirectory } = await import('./calendar-initialize')
      result = await initializeCalendarWorkspaceDirectory(request.path!)
    } else if (request.method === 'expandSource') {
      const { expandCalendar } = await import('./calendar')
      result = expandCalendar(...(request.args as Parameters<typeof expandCalendar>))
    } else {
      const { CalendarWorkspace: Store } = await import('./calendar-workspace')
      const path = request.path!
      const config = request.workspaceOptions ?? {}
      workspace = new Store(path, config)
      if (request.method === 'metadata')
        result = { calendars: workspace.listCalendars(), outbox: workspace.listOutbox() }
      else {
        // The method has passed a finite allowlist; functions/transports/file publication are absent.
        const method = workspace[request.method] as (...args: unknown[]) => unknown
        result = await Reflect.apply(method, workspace, request.args)
      }
    }
    result = project(request.method, result)
    if (!validCalendarResult(request.method, result))
      throw new Error('The calendar engine returned an unsupported result shape.')
    response = { version: 1, nonce: request.nonce, method: request.method, ok: true, result }
    if (Buffer.byteLength(JSON.stringify(response)) > request.maxOutputBytes)
      response = responseError(
        request,
        'CALENDAR_OUTPUT_LIMIT',
        'The calendar result exceeded its output limit.',
      )
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown }
    const code =
      typeof value?.code === 'string' && /^CALENDAR_[A-Z_]+$/.test(value.code)
        ? value.code
        : 'CALENDAR_OPERATION_FAILED'
    response = responseError(request, code, sanitizeCalendarFailure(value?.message))
  } finally {
    if (workspace) {
      try {
        workspace.close()
      } catch {
        response = responseError(
          request,
          'CALENDAR_CLOSE_FAILED',
          'The calendar worker could not verify a clean store close.',
        )
      }
    }
  }
  parentPort!.postMessage(response!)
}

/** Entrypoint for a bundled Node child; ICS work only runs on its separately bounded thread. */
export function runCalendarWorker(): void {
  if (!isMainThread) {
    const data = workerData as { kind?: unknown; request?: unknown }
    if (data?.kind !== THREAD_KIND) {
      process.exitCode = 2
      return
    }
    void operation(data.request as CalendarWorkerRequest).catch(() => process.exit(2))
    return
  }
  const readyNonce = process.env[CALENDAR_READY_ENV]
  delete process.env[CALENDAR_READY_ENV]
  if (readyNonce !== undefined && !/^[a-f0-9]{32}$/.test(readyNonce)) {
    process.exitCode = 2
    return
  }
  let request: CalendarWorkerRequest | undefined
  let worker: Worker | undefined
  let complete = false,
    used = 0,
    diagnosticBytes = 0
  const chunks: Buffer[] = []
  let deadline: ReturnType<typeof setTimeout> | undefined
  const unknownRequest = { nonce: '0'.repeat(32), method: 'metadata' as const }
  const publish = (response: CalendarWorkerResponse, code: number): void => {
    if (complete) return
    complete = true
    clearTimeout(startup)
    if (deadline) clearTimeout(deadline)
    if (worker) void worker.terminate().catch(() => {})
    let output: string
    try {
      output = JSON.stringify(response)
      if (Buffer.byteLength(output) > (request?.maxOutputBytes ?? CALENDAR_MAX_OUTPUT)) {
        output = JSON.stringify(
          responseError(
            request ?? unknownRequest,
            'CALENDAR_OUTPUT_LIMIT',
            'The calendar result exceeded its output limit.',
          ),
        )
        code = 1
      }
    } catch {
      output = JSON.stringify(
        responseError(
          request ?? unknownRequest,
          'CALENDAR_RESPONSE_FAILED',
          'The calendar result could not be serialized.',
        ),
      )
      code = 1
    }
    process.stdout.write(output, () => process.exit(code))
    // A closed/full pipe cannot keep a stuck operation alive after the desktop parent dies.
    setTimeout(() => process.exit(code), 250)
  }
  process.stdout.on('error', () => process.exit(2))
  const startup = setTimeout(
    () =>
      publish(
        responseError(
          unknownRequest,
          'CALENDAR_REQUEST_DEADLINE',
          'The calendar request was not delivered in time.',
        ),
        2,
      ),
    10000,
  )
  process.stdin.on('data', (chunk: Buffer) => {
    if (complete) return
    if (chunk.length > CALENDAR_MAX_INPUT - used) {
      publish(
        responseError(
          unknownRequest,
          'CALENDAR_INPUT_LIMIT',
          'The calendar request exceeded 8 MiB.',
        ),
        2,
      )
      return
    }
    used += chunk.length
    chunks.push(Buffer.from(chunk))
  })
  process.stdin.on('error', () =>
    publish(
      responseError(
        request ?? unknownRequest,
        'CALENDAR_INPUT_FAILED',
        'The calendar request pipe failed.',
      ),
      2,
    ),
  )
  process.stdin.on('end', () => {
    if (complete) return
    try {
      const input = decodeCalendarJson(Buffer.concat(chunks, used))
      assertCalendarRequest(input)
      request = input
      clearTimeout(startup)
      const entry = process.argv[1]
      if (!entry || !isAbsolute(entry))
        throw new Error('The bundled calendar worker entry is unavailable.')
      deadline = setTimeout(
        () =>
          publish(
            responseError(
              input,
              'CALENDAR_DEADLINE',
              'The calendar action exceeded its independent hard time limit.',
            ),
            1,
          ),
        input.deadlineMs,
      )
      worker = new Worker(entry, {
        workerData: { kind: THREAD_KIND, request: input },
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: input.maxHeapMb,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      })
      const diagnostics = (bytes: Buffer): void => {
        diagnosticBytes += bytes.length
        if (diagnosticBytes > 65536)
          publish(
            responseError(
              input,
              'CALENDAR_DIAGNOSTIC_LIMIT',
              'The calendar operation exceeded its diagnostic limit.',
            ),
            1,
          )
      }
      worker.stdout.on('data', diagnostics)
      worker.stderr.on('data', diagnostics)
      worker.once('message', (message: unknown) => {
        if (!validCalendarResponse(message, input))
          publish(
            responseError(
              input,
              'CALENDAR_PROTOCOL',
              'The calendar thread returned an unverified response.',
            ),
            1,
          )
        else publish(message, message.ok ? 0 : 1)
      })
      worker.once('error', (error: Error & { code?: string }) =>
        publish(
          responseError(
            input,
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? 'CALENDAR_MEMORY_LIMIT'
              : 'CALENDAR_THREAD_FAILED',
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? 'The calendar operation exhausted its JavaScript heap budget.'
              : 'The calendar operation thread failed.',
          ),
          1,
        ),
      )
      worker.once('exit', () => {
        if (!complete)
          publish(
            responseError(
              input,
              'CALENDAR_THREAD_FAILED',
              'The calendar operation stopped without a result.',
            ),
            1,
          )
      })
    } catch {
      publish(
        responseError(
          request ?? unknownRequest,
          'CALENDAR_REQUEST_INVALID',
          'The calendar worker rejected an invalid request.',
        ),
        2,
      )
    }
  })
  // A separate, closed pipe proves runtime readiness before the parent sends any
  // request. stdout remains exactly one bounded operation response. Direct CLI
  // invocations without the handshake environment retain the same stdin protocol.
  if (readyNonce !== undefined) {
    try {
      const ready = Buffer.from(JSON.stringify({ version: 1, nonce: readyNonce, ready: true }))
      if (ready.length > CALENDAR_MAX_READY) throw new Error('Invalid readiness size')
      let offset = 0
      while (offset < ready.length) {
        const written = writeSync(3, ready, offset, ready.length - offset)
        if (!written) throw new Error('Readiness pipe closed')
        offset += written
      }
      closeSync(3)
    } catch {
      process.exit(2)
    }
  }
}
