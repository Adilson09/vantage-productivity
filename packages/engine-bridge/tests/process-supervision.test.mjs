import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessSupervisor } from '../src/process-supervision.mjs'

const turn = () => new Promise((resolve) => setImmediate(resolve))
function fixture(overrides = {}) {
  const children = [],
    terminations = [],
    removed = []
  const supervisor = createProcessSupervisor({
    cleanupGraceMs: 20,
    platform: 'win32',
    spawnProcess: (_exe, _args, options) => {
      const child = new EventEmitter()
      Object.assign(child, {
        pid: 40001 + children.length,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        options,
        close(code) {
          this.exitCode = code
          this.emit('close', code)
        },
      })
      children.push(child)
      return child
    },
    terminateTree: (request, acknowledge) => terminations.push({ request, acknowledge }),
    removeDirectory: async (path) => {
      removed.push(path)
    },
    ...overrides,
  })
  return { ...supervisor, children, terminations, removed }
}

test('deadline settles with explicit pending cleanup when OS cleanup and pipe close never arrive', async () => {
  const f = fixture()
  const started = Date.now()
  const result = await f.runBounded(process.execPath, [], { timeoutMs: 10 })
  assert.ok(Date.now() - started < 2000)
  assert.equal(result.stopped, 'timeout')
  assert.equal(result.code, null)
  assert.deepEqual(result.cleanup, { status: 'pending', processClosed: false })
  assert.equal(f.terminations.length, 1)
  assert.equal(f.terminations[0].request.pid, f.children[0].pid)
  const refused = await f.runBounded(process.execPath, [])
  assert.equal(refused.stopped, 'unavailable')
  assert.match(refused.stderr, /still stopping/)
  assert.equal(f.children.length, 1)
})

test('retains work files until BOTH tree termination acknowledgment and process close are confirmed', async () => {
  const f = fixture()
  const work = join(tmpdir(), 'owned-pending-engine-profile')
  const result = await f.runBounded(process.execPath, [], { cwd: work, timeoutMs: 10 })
  assert.equal(await f.releaseDirectory(work), false)
  assert.equal(result.cleanup.temporaryFilesRetained, true)
  assert.deepEqual(f.removed, [])
  f.children[0].close(0)
  await turn()
  assert.deepEqual(f.removed, [])
  assert.equal((await f.runBounded(process.execPath, [])).stopped, 'unavailable')
  f.terminations[0].acknowledge(true)
  await turn()
  assert.deepEqual(f.removed, [work])
  assert.equal(result.stopped, 'timeout')
  assert.equal(result.code, null)
  const next = f.runBounded(process.execPath, [])
  f.children[1].close(0)
  assert.equal((await next).code, 0)
})

test('tree acknowledgment without pipe closure cannot release quarantine or work files', async () => {
  const f = fixture()
  const work = join(tmpdir(), 'owned-open-engine-pipes')
  const pending = f.runBounded(process.execPath, [], { cwd: work, timeoutMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 15))
  f.terminations[0].acknowledge(true)
  const result = await pending
  assert.equal(result.cleanup.status, 'pending')
  assert.equal(await f.releaseDirectory(work), false)
  assert.deepEqual(f.removed, [])
  f.children[0].close(1)
  await turn()
  assert.deepEqual(f.removed, [work])
})

test('failed or throwing cleanup remains explicit, quarantined and bounded', async () => {
  for (const throws of [false, true]) {
    const f = fixture({
      terminateTree: (_request, report) => {
        if (throws) throw new Error('helper could not start')
        report(false)
      },
    })
    const result = await f.runBounded(process.execPath, [], { timeoutMs: 10 })
    f.children[0].close(0)
    assert.equal(result.cleanup.status, 'pending')
    assert.equal((await f.runBounded(process.execPath, [])).stopped, 'unavailable')
    assert.equal(f.children.length, 1)
  }
})

test('late zero exit after a stop request is never a successful outcome', async () => {
  const f = fixture()
  const pending = f.runBounded(process.execPath, [], { timeoutMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 15))
  f.terminations[0].acknowledge(true)
  f.children[0].close(0)
  const result = await pending
  assert.equal(result.code, 0)
  assert.equal(result.stopped, 'timeout')
  assert.equal(result.cleanup.status, 'confirmed')
})

test('combined byte budget and cancellation settle even when cleanup is stubborn', async () => {
  const f = fixture()
  const pending = f.runBounded(process.execPath, [], { maxOutputBytes: 4 })
  f.children[0].stdout.write('ab')
  f.children[0].stderr.write('cdef')
  const result = await pending
  assert.equal(result.stopped, 'output-limit')
  assert.equal(result.stdout + result.stderr, 'abcd')
  f.children[0].stdout.write('x'.repeat(100000))
  assert.equal(result.stdout + result.stderr, 'abcd')
  assert.equal(f.terminations.length, 1)
  const c = fixture()
  const controller = new AbortController()
  const cancelled = c.runBounded(process.execPath, [], { signal: controller.signal })
  controller.abort()
  assert.equal((await cancelled).stopped, 'cancelled')
  assert.equal(c.terminations.length, 1)
})

test('active and uncertain jobs share a process cap across distinct executables', async () => {
  const f = fixture({ maxProcesses: 2 })
  const first = f.runBounded(process.execPath, [], { timeoutMs: 10 })
  const second = f.runBounded(join(tmpdir(), 'other-engine.exe'), [], { timeoutMs: 10 })
  const third = await f.runBounded(join(tmpdir(), 'third-engine.exe'), [])
  assert.equal(third.stopped, 'unavailable')
  assert.match(third.stderr, /process limit/)
  await Promise.all([first, second])
  assert.equal((await f.runBounded(join(tmpdir(), 'fourth-engine.exe'), [])).stopped, 'unavailable')
  assert.equal(f.children.length, 2)
})

test('OS error diagnostics and incomplete UTF-8 decoder flush stay inside the combined byte cap', async () => {
  for (const diagnostic of ['diagnostic', 'é😀']) {
    const f = fixture()
    const pending = f.runBounded(process.execPath, [], { maxOutputBytes: 4 })
    f.children[0].stdout.write('abcd')
    f.children[0].emit('error', new Error(diagnostic))
    f.children[0].close(0)
    const result = await pending
    assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 4)
    assert.ok(result.stopped)
  }
  const f = fixture()
  const pending = f.runBounded(process.execPath, [], { maxOutputBytes: 1 })
  f.children[0].stdout.write(Buffer.from([0xc3]))
  f.children[0].close(0)
  const result = await pending
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 1)
  assert.equal(result.stdout, '')
  const fail = fixture({
    spawnProcess: () => {
      throw new Error('é😀')
    },
  })
  const failed = await fail.runBounded(process.execPath, [], { maxOutputBytes: 3 })
  assert.equal(failed.stderr, 'é')
  assert.ok(Buffer.byteLength(failed.stderr) <= 3)
})

test('spawn failure releases capacity and normal completion removes work normally', async () => {
  const f = fixture()
  const work = join(tmpdir(), 'owned-successful-engine-work')
  const pending = f.runBounded(process.execPath, [], { cwd: work })
  f.children[0].stdout.write('result')
  f.children[0].close(3)
  assert.deepEqual(await pending, { code: 3, stdout: 'result', stderr: '' })
  assert.equal(await f.releaseDirectory(work), true)
  assert.deepEqual(f.removed, [work])
  const fail = fixture({
    spawnProcess: () => {
      throw new Error('spawn rejected')
    },
    maxProcesses: 1,
  })
  for (let i = 0; i < 2; i++) {
    const result = await fail.runBounded(process.execPath, [])
    assert.equal(result.stopped, 'unavailable')
    assert.equal(result.cleanup.status, 'confirmed')
    assert.match(result.stderr, /spawn rejected/)
  }
})

test('asynchronous ENOENT with a tiny byte cap never launches cleanup for a nonexistent PID', async () => {
  const work = await mkdtemp(join(tmpdir(), 'vantage-missing-process-'))
  let terminations = 0
  const f = createProcessSupervisor({
    maxProcesses: 1,
    terminateTree: () => {
      terminations++
    },
  })
  try {
    for (let i = 0; i < 3; i++) {
      const result = await f.runBounded(join(work, 'absent.exe'), [], { maxOutputBytes: 1 })
      assert.equal(result.stopped, 'unavailable')
      assert.equal(result.cleanup.status, 'confirmed')
      assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 1)
    }
    assert.equal(terminations, 0)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test(
  'real owned child stays quarantined with its files until delayed cleanup is confirmed',
  { timeout: 120000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), 'vantage-owned-cleanup-'))
    const marker = join(work, 'profile-marker')
    await writeFile(marker, 'retain until process cleanup')
    let child,
      acknowledge,
      launchCount = 0
    let removedDirectory
    const removed = new Promise((resolve) => {
      removedDirectory = resolve
    })
    const supervisor = createProcessSupervisor({
      cleanupGraceMs: 50,
      spawnProcess: (...args) => {
        launchCount++
        child = spawn(...args)
        return child
      },
      terminateTree: (_request, report) => {
        acknowledge = report
      },
      removeDirectory: async (path) => {
        await rm(path, { recursive: true, force: true })
        removedDirectory(path)
      },
    })
    let closed
    try {
      const started = Date.now()
      const pending = supervisor.runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: work,
        timeoutMs: 100,
      })
      closed = new Promise((resolve) => child.once('close', resolve))
      const result = await pending
      assert.ok(Date.now() - started < 5000)
      assert.equal(result.stopped, 'timeout')
      assert.equal(result.cleanup.status, 'pending')
      assert.doesNotThrow(() => process.kill(child.pid, 0))
      assert.equal(await supervisor.releaseDirectory(work), false)
      assert.equal(await readFile(marker, 'utf8'), 'retain until process cleanup')
      assert.equal((await supervisor.runBounded(process.execPath, [])).stopped, 'unavailable')
      assert.equal(launchCount, 1)
      // This fixture starts no descendants. Kill only this explicitly owned child.
      child.kill('SIGKILL')
      await closed
      acknowledge(true)
      assert.equal(await removed, work)
      let absenceObserved = false
      for (let i = 0; i < 100; i++) {
        try {
          await readFile(marker)
        } catch (error) {
          if (error.code === 'ENOENT') {
            absenceObserved = true
            break
          }
          // Windows can briefly reject opens while directory deletion finishes.
          // EPERM is not accepted as evidence of deletion; require ENOENT.
          if (error.code !== 'EPERM') throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(absenceObserved, true, 'removed marker must become absent')
      assert.equal(result.stopped, 'timeout')
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (closed) await closed
      acknowledge?.(true)
      await rm(work, { recursive: true, force: true })
    }
  },
)
