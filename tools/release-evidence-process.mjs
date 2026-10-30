import { spawn, spawnSync } from 'node:child_process'

export const defaultCheckTimeoutMs = 30 * 60 * 1000

/** Kill only this check's owned tree/group, and retain an explicit timeout result. */
export function runEvidenceProcess(command, args, options) {
  const { timeoutMs = defaultCheckTimeoutMs, ...spawnOptions } = options
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 * 60 * 60 * 1000)
    throw new Error('Evidence check timeout must be between 1 ms and two hours')
  const env = { ...(spawnOptions.env ?? process.env) }
  // Each gate is a standalone process, including when the runner is tested by node:test.
  delete env.NODE_TEST_CONTEXT
  return new Promise((resolve) => {
    let child
    let timer
    let grace
    let done = false
    let timedOut = false
    let terminationError
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(grace)
      resolve(result)
    }
    try {
      child = spawn(command, args, {
        ...spawnOptions,
        env,
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      finish({ status: 'unavailable', error: error.message })
      return
    }
    child.once('error', (error) => finish({ status: 'unavailable', error: error.message }))
    child.once('close', (code, signal) =>
      finish({
        status: timedOut ? 'timed-out' : code === 0 ? 'passed' : 'failed',
        exitCode: code,
        ...(signal ? { signal } : {}),
        ...(timedOut ? { timeoutMs, ...(terminationError ? { terminationError } : {}) } : {}),
      }),
    )
    timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === 'win32') {
          const stopped = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 10000,
          })
          if (stopped.error || stopped.status !== 0) {
            terminationError =
              stopped.error?.message ?? `Owned tree termination exited ${stopped.status}`
            child.kill('SIGKILL')
          }
        } else {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch (error) {
        terminationError = error.message
        child.kill('SIGKILL')
      }
      grace = setTimeout(() => {
        child.unref()
        finish({
          status: 'timed-out',
          timeoutMs,
          terminationError:
            terminationError ?? 'No process close acknowledgement after termination',
        })
      }, 2000)
    }, timeoutMs)
  })
}
