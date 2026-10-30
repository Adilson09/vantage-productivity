import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface IsolatedQueryOptions {
  timeoutMs?: number
  maxRows?: number
  parameters?: (null | string | number)[]
  signal?: AbortSignal
  /** Trusted main/CLI configuration; never forward a renderer-selected executable. */
  workerPath?: string
}
export interface IsolatedQueryResult {
  columns: string[]
  rows: Record<string, null | string | number>[]
  truncated: boolean
}
export class IsolatedQueryError extends Error {
  readonly name = 'IsolatedQueryError'
  constructor(
    readonly code: string,
    message: string,
    readonly details: {
      sqliteCode?: number
      cleanupPending?: boolean
      sqliteHeapBytes?: number
      sqliteHighwaterBytes?: number
    } = {},
  ) {
    super(message)
  }
}
const MAX_INPUT = 256 * 1024
const MAX_OUTPUT = 2 * 1024 * 1024
const SQLITE_HEAP = 64 * 1024 * 1024
const owned = new Set<{ closed: boolean }>()

function moduleDir(): string {
  return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
}
function repositoryRoot(start: string): string | undefined {
  let path = start
  for (let depth = 0; depth < 8; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as {
        name?: string
      }
      if (manifest.name === 'vantage-productivity' || manifest.name === 'vantage') return path
    } catch {
      /* An app bundle does not contain a source checkout. */
    }
    const parent = dirname(path)
    if (parent === path) break
    path = parent
  }
}
/** Fixed native resource/source locations only; never search PATH or substitute Node SQLite. */
export function resolveQueryWorkerPath(explicit?: string): string {
  const override = explicit ?? process.env.VANTAGE_QUERY_WORKER_PATH
  const executable =
    process.platform === 'win32' ? 'vantage-query-worker.exe' : 'vantage-query-worker'
  const packaged = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const root = repositoryRoot(moduleDir()) ?? repositoryRoot(process.cwd())
  const nativeRoot = root && join(root, 'apps', 'sheets', 'native', 'xlsx-engine')
  const target =
    process.env.CARGO_TARGET_DIR && root
      ? resolve(root, 'apps', 'sheets', process.env.CARGO_TARGET_DIR)
      : nativeRoot && join(nativeRoot, 'target')
  const configuredTarget = process.env.CARGO_BUILD_TARGET
  const triples =
    configuredTarget && /^[a-zA-Z0-9_-]{1,80}$/.test(configuredTarget)
      ? [configuredTarget]
      : process.platform === 'win32'
        ? process.arch === 'arm64'
          ? ['aarch64-pc-windows-msvc']
          : ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu']
        : process.platform === 'darwin'
          ? [process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin']
          : [process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu']
  const sibling = process.env.XLSX_SIDECAR_PATH
  const candidates = override
    ? [override]
    : [
        ...(packaged ? [join(packaged, 'native', executable)] : []),
        join(dirname(process.execPath), 'resources', 'native', executable),
        join(dirname(process.execPath), '..', 'Resources', 'native', executable),
        join(moduleDir(), '..', 'native', executable),
        ...(sibling && isAbsolute(sibling) ? [join(dirname(sibling), executable)] : []),
        ...(target
          ? [
              ...(configuredTarget
                ? triples.map((triple) => join(target, triple, 'release', executable))
                : []),
              join(target, 'release', executable),
              ...triples.map((triple) => join(target, triple, 'release', executable)),
            ]
          : []),
      ]
  for (const path of candidates) {
    if (!isAbsolute(path)) continue
    try {
      if (existsSync(path) && statSync(path).isFile()) return realpathSync(path)
    } catch {
      /* Try the next fixed location. */
    }
  }
  throw new IsolatedQueryError(
    'QUERY_RUNTIME_UNAVAILABLE',
    'The bounded database query engine is unavailable. Rebuild the native tools or reinstall Vantage.',
  )
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: string[], required = allowed): boolean {
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  )
}
function parseResponse(
  bytes: Buffer,
  nonce: string,
  exitCode: number,
  maxRows: number,
): IsolatedQueryResult {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new IsolatedQueryError(
      'QUERY_PROTOCOL',
      'The query engine returned invalid UTF-8 or JSON.',
    )
  }
  if (
    !object(value) ||
    value.protocol !== 1 ||
    value.nonce !== nonce ||
    typeof value.ok !== 'boolean' ||
    !object(value.limits) ||
    !keys(value.limits, ['sqliteHeapBytes', 'sqliteHighwaterBytes']) ||
    value.limits.sqliteHeapBytes !== SQLITE_HEAP ||
    !Number.isSafeInteger(value.limits.sqliteHighwaterBytes) ||
    Number(value.limits.sqliteHighwaterBytes) < 0 ||
    Number(value.limits.sqliteHighwaterBytes) > SQLITE_HEAP
  )
    throw new IsolatedQueryError(
      'QUERY_PROTOCOL',
      'The query engine returned a mismatched or unbounded result.',
    )
  if (value.ok === false) {
    if (
      exitCode !== 1 ||
      !keys(value, ['protocol', 'nonce', 'ok', 'error', 'limits']) ||
      !object(value.error) ||
      !keys(value.error, ['code', 'message', 'sqliteCode'], ['code', 'message']) ||
      typeof value.error.code !== 'string' ||
      !/^QUERY_[A-Z_]+$/.test(value.error.code) ||
      typeof value.error.message !== 'string' ||
      value.error.message.length > 2048 ||
      (value.error.sqliteCode !== undefined &&
        (!Number.isInteger(value.error.sqliteCode) ||
          Number(value.error.sqliteCode) < 1 ||
          Number(value.error.sqliteCode) > 255)) ||
      (value.error.code === 'QUERY_MEMORY_LIMIT' && value.error.sqliteCode !== 7)
    )
      throw new IsolatedQueryError(
        'QUERY_PROTOCOL',
        'The query engine returned an invalid failure receipt.',
      )
    throw new IsolatedQueryError(value.error.code, value.error.message, {
      ...(typeof value.error.sqliteCode === 'number' ? { sqliteCode: value.error.sqliteCode } : {}),
      sqliteHeapBytes: SQLITE_HEAP,
      sqliteHighwaterBytes: Number(value.limits.sqliteHighwaterBytes),
    })
  }
  const result = value.result
  if (
    exitCode !== 0 ||
    !keys(value, ['protocol', 'nonce', 'ok', 'result', 'limits']) ||
    !object(result) ||
    !keys(result, ['columns', 'rows', 'truncated']) ||
    !Array.isArray(result.columns) ||
    !result.columns.every((column) => typeof column === 'string') ||
    !Array.isArray(result.rows) ||
    result.rows.length > maxRows ||
    typeof result.truncated !== 'boolean'
  )
    throw new IsolatedQueryError(
      'QUERY_PROTOCOL',
      'The query engine returned an invalid completion receipt.',
    )
  const columns = result.columns as string[]
  const columnSet = new Set(columns)
  for (const row of result.rows) {
    if (
      !object(row) ||
      Object.keys(row).length !== columnSet.size ||
      Object.keys(row).some((key) => !columnSet.has(key)) ||
      Object.values(row).some(
        (cell) =>
          cell !== null &&
          typeof cell !== 'string' &&
          !(typeof cell === 'number' && Number.isFinite(cell)),
      )
    )
      throw new IsolatedQueryError(
        'QUERY_PROTOCOL',
        'The query engine returned invalid row values.',
      )
  }
  return result as unknown as IsolatedQueryResult
}

/** Native SQLite allocation limit + bounded JSON transport + an owned process deadline.
 * The 64 MiB limit is SQLite allocator memory, not total process RSS or an OS sandbox.
 */
export async function queryDatabaseIsolated(
  path: string,
  sql: string,
  options: IsolatedQueryOptions = {},
): Promise<IsolatedQueryResult> {
  const timeoutMs = options.timeoutMs ?? 3000
  const maxRows = options.maxRows ?? 1000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
    throw new IsolatedQueryError('QUERY_INVALID_REQUEST', 'Query timeout must be 100 to 30,000 ms.')
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10000)
    throw new IsolatedQueryError('QUERY_INVALID_REQUEST', 'Result limit must be 1 to 10,000 rows.')
  if (
    typeof path !== 'string' ||
    !path ||
    path === ':memory:' ||
    Buffer.byteLength(path) > MAX_INPUT
  )
    throw new IsolatedQueryError(
      'QUERY_INVALID_REQUEST',
      'Isolated queries need a saved database file.',
    )
  if (
    typeof sql !== 'string' ||
    Buffer.byteLength(sql) > 32768 ||
    !/^\s*(SELECT|WITH)\b/i.test(sql)
  )
    throw new IsolatedQueryError(
      'QUERY_INVALID_REQUEST',
      'Enter one SELECT or WITH query, at most 32 KiB.',
    )
  const parameters = options.parameters ?? []
  if (
    !Array.isArray(parameters) ||
    parameters.length > 32766 ||
    parameters.some(
      (p) => p !== null && typeof p !== 'string' && !(typeof p === 'number' && Number.isFinite(p)),
    )
  )
    throw new IsolatedQueryError(
      'QUERY_PARAMETERS',
      'Query parameters must be finite numbers, text or null.',
    )
  let parameterBytes = 0
  for (const parameter of parameters) {
    parameterBytes += typeof parameter === 'string' ? Buffer.byteLength(parameter) : 32
    if (parameterBytes > MAX_INPUT)
      throw new IsolatedQueryError('QUERY_INPUT_LIMIT', 'Query parameters exceed 256 KiB.')
  }
  if (options.signal?.aborted) throw new IsolatedQueryError('QUERY_CANCELLED', 'Query cancelled.')
  const nonce = randomUUID()
  const request = Buffer.from(
    JSON.stringify({
      protocol: 1,
      nonce,
      path: resolve(path),
      sql,
      parameters,
      maxRows,
      deadlineMs: timeoutMs,
    }),
  )
  if (request.length + 1 > MAX_INPUT)
    throw new IsolatedQueryError('QUERY_INPUT_LIMIT', 'Query parameters exceed 256 KiB.')
  const workerPath = resolveQueryWorkerPath(options.workerPath)
  if (owned.size >= 2)
    throw new IsolatedQueryError(
      'QUERY_BUSY',
      'Two query processes are still running or finishing cleanup. Try again after they exit.',
    )
  return new Promise((resolveResult, reject) => {
    const job = { closed: false }
    owned.add(job)
    const release = (): void => {
      if (job.closed) owned.delete(job)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(workerPath, [], {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      owned.delete(job)
      reject(new IsolatedQueryError('QUERY_RUNTIME_UNAVAILABLE', String(error)))
      return
    }
    let outputBytes = 0
    const output: Buffer[] = []
    let stderrBytes = 0
    let settled = false
    let stopped: IsolatedQueryError | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    let killRequested = false
    const finish = (error?: IsolatedQueryError, code = 1): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      options.signal?.removeEventListener('abort', cancelled)
      if (error) {
        error.details.cleanupPending = !job.closed
        if (!job.closed) {
          child.unref()
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
        }
        reject(error)
      } else {
        try {
          resolveResult(parseResponse(Buffer.concat(output, outputBytes), nonce, code, maxRows))
        } catch (error) {
          reject(error)
        }
      }
    }
    const cancelPipe = (): void => {
      if (killRequested || job.closed) return
      killRequested = true
      // Closing the held-open pipe makes the trusted helper terminate itself,
      // independently of its query thread and without targeting a reusable PID.
      child.stdin!.destroy()
    }
    const stop = (error: IsolatedQueryError): void => {
      if (settled || stopped) return
      stopped = error
      cancelPipe()
      grace = setTimeout(() => finish(error), 1000)
    }
    const cancelled = (): void =>
      stop(new IsolatedQueryError('QUERY_CANCELLED', 'Query cancelled.'))
    const timer = setTimeout(
      () =>
        stop(
          new IsolatedQueryError(
            'QUERY_TIMEOUT',
            'Query exceeded its ' + timeoutMs + ' ms time limit.',
          ),
        ),
      timeoutMs,
    )
    options.signal?.addEventListener('abort', cancelled, { once: true })
    if (options.signal?.aborted) cancelled()
    child.stdout!.on('error', (error) =>
      stop(new IsolatedQueryError('QUERY_IO', 'The query result pipe failed: ' + error.message)),
    )
    child.stderr!.on('error', (error) =>
      stop(
        new IsolatedQueryError('QUERY_IO', 'The query diagnostic pipe failed: ' + error.message),
      ),
    )
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled || stopped) return
      if (outputBytes + chunk.length > MAX_OUTPUT) {
        stop(new IsolatedQueryError('QUERY_OUTPUT_LIMIT', 'Database query output exceeded 2 MiB.'))
        return
      }
      output.push(Buffer.from(chunk))
      outputBytes += chunk.length
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > 4096)
        stop(
          new IsolatedQueryError(
            'QUERY_PROTOCOL',
            'The query engine diagnostic output exceeded its limit.',
          ),
        )
    })
    child.once('error', (error) => {
      if (!child.pid) {
        job.closed = true
        release()
        finish(new IsolatedQueryError('QUERY_RUNTIME_UNAVAILABLE', error.message))
      } else stop(new IsolatedQueryError('QUERY_RUNTIME_FAILURE', error.message))
    })
    child.once('close', (code, signal) => {
      job.closed = true
      release()
      if (stopped) finish(stopped)
      else if (code === 124)
        finish(
          new IsolatedQueryError('QUERY_TIMEOUT', 'The query engine reached its own time limit.'),
        )
      else if (code === 125)
        finish(new IsolatedQueryError('QUERY_CANCELLED', 'The query process was cancelled.'))
      else if (signal || (code !== 0 && code !== 1))
        finish(
          new IsolatedQueryError(
            'QUERY_RUNTIME_FAILURE',
            'The query engine exited without a normal result.',
          ),
        )
      else finish(undefined, code)
    })
    child.stdin!.on('error', (error) =>
      stop(new IsolatedQueryError('QUERY_IO', 'The query request pipe failed: ' + error.message)),
    )
    if (!stopped) child.stdin!.write(Buffer.concat([request, Buffer.from('\n')]))
    else cancelPipe()
  })
}
