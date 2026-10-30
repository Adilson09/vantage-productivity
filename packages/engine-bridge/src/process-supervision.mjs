import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Worker } from 'node:worker_threads'

// Native process creation can itself be slow on Windows. Keep taskkill and its
// fallback off the caller's event loop, including when CreateProcess stalls.
const terminationWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
let reported = false;
function report(acknowledged) {
  if (reported) return;
  reported = true;
  parentPort.postMessage({ acknowledged });
}
if (workerData.platform === 'win32') {
  const fallback = () => {
    try { process.kill(workerData.pid, 'SIGKILL'); } catch {}
    // Stopping only the launcher does not establish descendant cleanup.
    report(false);
  };
  if (!workerData.systemRoot) fallback();
  else {
    try {
      const killer = spawn(workerData.systemRoot + '/System32/taskkill.exe',
        ['/PID', String(workerData.pid), '/T', '/F'],
        { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', fallback);
      killer.once('close', code => code === 0 ? report(true) : fallback());
    } catch { fallback(); }
  }
} else {
  try {
    // Each POSIX child starts in its own process group; never signal our group.
    process.kill(-workerData.pid, 'SIGKILL');
    report(true);
  } catch (error) { report(error.code === 'ESRCH'); }
}
`

function startTermination({ pid, platform, systemRoot }, report) {
  let received = false
  const workerEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE'].includes(name.toUpperCase()),
    ),
  )
  const worker = new Worker(terminationWorkerSource, {
    eval: true,
    workerData: { pid, platform, systemRoot },
    execArgv: [],
    env: workerEnv,
    // Requested helper limit only: parent startup heap flags can override it.
    // The helper runs fixed termination code and never parses a document.
    resourceLimits: { maxOldGenerationSizeMb: 16, stackSizeMb: 2 },
  })
  worker.once('message', (message) => {
    received = true
    report(message?.acknowledged === true)
  })
  worker.once('error', () => {
    received = true
    report(false)
  })
  worker.once('exit', () => {
    if (!received) report(false)
  })
}

/** Internal dependency boundary also permits deterministic delayed-OS tests. */
export function createProcessSupervisor({
  spawnProcess = spawn,
  terminateTree = startTermination,
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  cleanupGraceMs = 1000,
  maxProcesses = 8,
  removeDirectory = (path) => rm(path, { recursive: true, force: true }),
} = {}) {
  const jobs = new Set()
  const utf8Prefix = (value, bytes) => {
    const decoder = new StringDecoder('utf8')
    return decoder.write(Buffer.from(value).subarray(0, Math.max(0, bytes)))
  }
  const key = (path) => {
    const absolute = resolve(path)
    return platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  const cleanupSnapshot = (job) => ({
    status: job.processClosed && job.terminationAcknowledged ? 'confirmed' : 'pending',
    processClosed: job.processClosed,
    ...(job.filesRetained ? { temporaryFilesRetained: true } : {}),
  })

  function runBounded(
    executable,
    args,
    { timeoutMs = 30000, maxOutputBytes = 1024 * 1024, signal, cwd, processEnv } = {},
  ) {
    if (!isAbsolute(executable)) throw new Error('An absolute engine executable path is required')
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
      throw new Error('Engine arguments must be strings')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new Error('Deadline must be 1–120000 ms')
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4194304)
      throw new Error('Output budget must be 1–4194304 bytes')
    if (signal?.aborted)
      return Promise.resolve({ code: null, stdout: '', stderr: '', stopped: 'cancelled' })
    const executableKey = key(executable)
    const pending = [...jobs].find((job) => job.executableKey === executableKey && job.stopped)
    if (pending)
      return Promise.resolve({
        code: null,
        stdout: '',
        stderr:
          'A previous operation is still stopping. Wait for confirmed cleanup before trying this engine again.',
        stopped: 'unavailable',
        cleanup: cleanupSnapshot(pending),
      })
    if (jobs.size >= maxProcesses)
      return Promise.resolve({
        code: null,
        stdout: '',
        stderr: 'The local engine process limit has been reached.',
        stopped: 'unavailable',
      })

    return new Promise((done) => {
      let resolveCleanup
      const job = {
        executableKey,
        directoryKey: cwd ? key(cwd) : null,
        processClosed: false,
        terminationAcknowledged: false,
        stopped: undefined,
        filesRetained: false,
        cleanupPromise: new Promise((resolveDone) => {
          resolveCleanup = resolveDone
        }),
        result: null,
      }
      jobs.add(job)
      let child, deadlineTimer, settleTimer
      let used = 0,
        stdout = '',
        stderr = '',
        settled = false
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const cleanupIfConfirmed = () => {
        if (job.processClosed && (!job.stopped || job.terminationAcknowledged)) {
          jobs.delete(job)
          resolveCleanup()
        }
      }
      const finish = (code) => {
        if (settled) return
        settled = true
        clearTimeout(deadlineTimer)
        clearTimeout(settleTimer)
        signal?.removeEventListener('abort', abort)
        if (job.stopped !== 'output-limit') {
          stdout += decoders.stdout.end()
          stderr += decoders.stderr.end()
        }
        // Decoder replacement characters and OS error diagnostics also consume
        // the output allowance. Never return a clipped partial UTF-8 character.
        stdout = utf8Prefix(stdout, maxOutputBytes)
        stderr = utf8Prefix(stderr, maxOutputBytes - Buffer.byteLength(stdout))
        job.result = {
          code,
          stdout,
          stderr,
          ...(job.stopped ? { stopped: job.stopped, cleanup: cleanupSnapshot(job) } : {}),
        }
        done(job.result)
      }
      const stop = (reason) => {
        if (job.stopped || settled) return
        job.stopped = reason
        clearTimeout(deadlineTimer)
        if (!Number.isSafeInteger(child?.pid) || child.pid < 1) {
          // A failed spawn has no owned process or descendants to terminate.
          job.processClosed = true
          job.terminationAcknowledged = true
          cleanupIfConfirmed()
          finish(null)
          return
        }
        // Arm the bounded caller outcome before requesting any native cleanup.
        // Late exit zero can never turn an interrupted operation into success.
        settleTimer = setTimeout(() => finish(null), cleanupGraceMs)
        try {
          terminateTree({ pid: child.pid, platform, systemRoot }, (acknowledged) => {
            job.terminationAcknowledged = acknowledged === true
            cleanupIfConfirmed()
            if (job.processClosed && job.terminationAcknowledged) finish(child.exitCode ?? null)
          })
        } catch {
          // Preserve quarantine and files when even starting cleanup fails.
        }
      }
      const abort = () => stop('cancelled')
      try {
        child = spawnProcess(executable, args, {
          shell: false,
          windowsHide: true,
          ...(platform !== 'win32' ? { detached: true } : {}),
          cwd,
          ...(processEnv ? { env: { ...process.env, ...processEnv } } : {}),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        job.processClosed = true
        job.terminationAcknowledged = true
        job.stopped = 'unavailable'
        stderr = utf8Prefix(error.message, maxOutputBytes)
        cleanupIfConfirmed()
        finish(null)
        return
      }
      const output = (chunk, target) => {
        // Continue draining pipes after settlement without retaining more data.
        if (settled) return
        const remaining = Math.max(0, maxOutputBytes - used)
        const text = decoders[target].write(chunk.subarray(0, remaining))
        used += chunk.length
        if (target === 'stdout') stdout += text
        else stderr += text
        if (used > maxOutputBytes) stop('output-limit')
      }
      child.stdout.on('data', (chunk) => output(chunk, 'stdout'))
      child.stderr.on('data', (chunk) => output(chunk, 'stderr'))
      child.once('error', (error) => {
        if (!child.pid) {
          if (!settled) stderr += utf8Prefix(error.message, Math.max(0, maxOutputBytes - used))
          job.processClosed = true
          job.terminationAcknowledged = true
          job.stopped = 'unavailable'
          cleanupIfConfirmed()
          finish(null)
        } else {
          output(Buffer.from(error.message), 'stderr')
          stop('unavailable')
        }
      })
      child.once('close', (code) => {
        job.processClosed = true
        cleanupIfConfirmed()
        if (!job.stopped || job.terminationAcknowledged) finish(code)
      })
      deadlineTimer = setTimeout(() => stop('timeout'), timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  async function releaseDirectory(path) {
    const directoryKey = key(path)
    const usingDirectory = [...jobs].filter((job) => job.directoryKey === directoryKey)
    if (!usingDirectory.length) {
      await removeDirectory(path)
      return true
    }
    for (const job of usingDirectory) {
      job.filesRetained = true
      if (job.result?.cleanup) job.result.cleanup.temporaryFilesRetained = true
    }
    // Never remove profiles, copied input or output under an unconfirmed child.
    // There is no automatic replacement/retry. Cleanup is deferred, not asserted.
    void Promise.all(usingDirectory.map((job) => job.cleanupPromise))
      .then(() => removeDirectory(path))
      .catch(() => {})
    return false
  }
  function waitForExecutableCleanup(executable, { timeoutMs = 120000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new Error('Cleanup wait must be 1–120000 ms')
    const matching = [...jobs].filter((job) => job.executableKey === key(executable))
    if (!matching.length) return Promise.resolve(true)
    return new Promise((done) => {
      const timer = setTimeout(() => done(false), timeoutMs)
      void Promise.all(matching.map((job) => job.cleanupPromise)).then(() => {
        clearTimeout(timer)
        done(true)
      })
    })
  }
  return { runBounded, releaseDirectory, waitForExecutableCleanup }
}

const supervisor = createProcessSupervisor()
export const runBounded = supervisor.runBounded
export const releaseEngineDirectory = supervisor.releaseDirectory
export const waitForExecutableCleanup = supervisor.waitForExecutableCleanup
