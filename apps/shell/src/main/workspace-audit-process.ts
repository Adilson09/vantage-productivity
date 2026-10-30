import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { WorkspaceAuditResult } from '../shared/vantage-api'

/** Resource isolation for parsing; this is not an OS sandbox or schema certification. */
export function auditFileIsolated(
  path: string,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    executable?: string
    workerPath?: string
  } = {},
): Promise<WorkspaceAuditResult> {
  const timeout = options.timeoutMs ?? 20_000
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000)
    throw new Error('Inspection deadline must be between 100 and 60,000 ms.')
  if (options.signal?.aborted)
    return Promise.reject(new Error('Inspection cancelled. No result was established.'))
  if (typeof path !== 'string' || Buffer.byteLength(path) > 8192)
    return Promise.reject(new Error('Invalid document path.'))
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.executable ?? process.execPath,
      [
        '--max-old-space-size=128',
        options.workerPath ?? join(__dirname, 'workspace-audit-child.js'),
      ],
      {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      },
    )
    let output = '',
      diagnostics = '',
      failure: Error | undefined
    const stop = (error: Error) => {
      if (failure) return
      failure = error
      child.kill()
    }
    const cancelled = () => stop(new Error('Inspection cancelled. No result was established.'))
    const timer = setTimeout(
      () => stop(new Error('Inspection exceeded its time limit. The check is incomplete.')),
      timeout,
    )
    options.signal?.addEventListener('abort', cancelled, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (failure) return
      if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 2 * 1024 * 1024) {
        stop(new Error('Inspection output exceeded 2 MiB. The check is incomplete.'))
        return
      }
      output += chunk
      if (Buffer.byteLength(output) > 2 * 1024 * 1024)
        stop(new Error('Inspection output exceeded 2 MiB. The check is incomplete.'))
    })
    child.stderr.on('data', (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-2000)
    })
    child.on('error', (error) => {
      failure ??= error
    })
    child.stdin.on('error', () => {})
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancelled)
      if (failure) {
        reject(failure)
        return
      }
      try {
        const parsed = JSON.parse(output) as {
          ok: boolean
          result?: WorkspaceAuditResult
          error?: string
        }
        if (!parsed.ok || !parsed.result)
          throw new Error(parsed.error || 'The parser did not establish a result.')
        if (code !== 0 || signal)
          throw new Error(
            'The inspection process did not complete successfully. The check is incomplete.',
          )
        const result = parsed.result
        if (
          typeof result.fileName !== 'string' ||
          typeof result.filePath !== 'string' ||
          typeof result.scope !== 'string' ||
          typeof result.scannedAt !== 'string' ||
          !['docx', 'xlsx', 'pptx', 'pdf', 'md', 'html'].includes(result.kind) ||
          !Number.isFinite(result.bytes) ||
          result.bytes < 0 ||
          !Array.isArray(result.checks) ||
          !result.checks.every(
            (check) =>
              check &&
              typeof check.id === 'string' &&
              typeof check.title === 'string' &&
              typeof check.detail === 'string' &&
              ['pass', 'warning', 'fail', 'info'].includes(check.status),
          ) ||
          !result.summary ||
          !['passed', 'warnings', 'failed', 'informational'].every(
            (key) =>
              Number.isFinite(result.summary[key as keyof typeof result.summary]) &&
              result.summary[key as keyof typeof result.summary] >= 0,
          )
        )
          throw new Error('The inspection process returned an incomplete report.')
        resolve(parsed.result)
      } catch (error) {
        reject(
          new Error(
            error instanceof SyntaxError
              ? `The inspection process stopped without a result. ${diagnostics.includes('heap') ? 'Its memory budget was exhausted.' : ''}`
              : String(error instanceof Error ? error.message : error),
          ),
        )
      }
    })
    child.stdin.end(JSON.stringify({ path }))
  })
}
