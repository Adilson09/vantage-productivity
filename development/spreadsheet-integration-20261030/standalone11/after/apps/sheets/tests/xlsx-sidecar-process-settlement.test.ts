/** Real Node subprocess fixture + real streams/OS exit; never a Rust-binary acceptance claim. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { joinNativeActualWork, XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'

const launch = vi.hoisted(() => ({
  fixture: '',
  children: [] as ChildProcessWithoutNullStreams[],
  observe: undefined as ((child: ChildProcessWithoutNullStreams) => void) | undefined,
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (_binary: string, _args: readonly string[], options: object) => {
      // Only launcher selection is replaced. The returned process, pipes,
      // failures, replies, kill request and exit/close events are real Node I/O.
      const child = actual.spawn(
        process.execPath,
        [launch.fixture],
        options,
      ) as ChildProcessWithoutNullStreams
      launch.children.push(child)
      launch.observe?.(child)
      return child
    },
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
interface ChildState {
  accepted: Set<string>
  waiting: Map<string, () => void>
  closed: boolean
}
const states = new WeakMap<ChildProcessWithoutNullStreams, ChildState>()
const clients: XlsxSidecarClient[] = []
let directory: string

function client() {
  const value = new XlsxSidecarClient('/test-only/launcher-is-replaced')
  clients.push(value)
  return value
}
function accepted(child: ChildProcessWithoutNullStreams, tag: string): Promise<void> {
  const state = states.get(child)!
  if (state.accepted.has(tag)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    state.waiting.set(tag, resolve)
  })
}
function request(value: XlsxSidecarClient, tag: string, timeout = 100) {
  const gatePath = join(directory, `${tag}.gate`)
  return {
    gatePath,
    operation: value.requestAttested(
      { command: 'fixture_wait_file', fixtureTag: tag, gatePath },
      timeout,
    ),
  }
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'vantage-node-native-lifecycle-')))
  launch.fixture = fileURLToPath(new URL('./fixtures/native-lifecycle-child.cjs', import.meta.url))
  launch.observe = (child) => {
    const state: ChildState = { accepted: new Set(), waiting: new Map(), closed: false }
    states.set(child, state)
    let buffered = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) break
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        let value: { fixtureAccepted?: unknown }
        try {
          value = JSON.parse(line) as typeof value
        } catch {
          continue
        }
        if (typeof value.fixtureAccepted !== 'string') continue
        state.accepted.add(value.fixtureAccepted)
        state.waiting.get(value.fixtureAccepted)?.()
        state.waiting.delete(value.fixtureAccepted)
      }
    })
    child.once('close', () => {
      state.closed = true
    })
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  const stopped = clients.splice(0).map((value) => value.stopSettled())
  // Every process below came from the exact fixture launcher in this test.
  for (const child of launch.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    child.stdout.resume()
    child.stderr.resume()
  }
  await Promise.all(stopped)
  await joinNativeActualWork()
  await Promise.all(
    launch.children.map((child) =>
      states.get(child)?.closed ? Promise.resolve() : once(child, 'close').then(() => undefined),
    ),
  )
  launch.children.length = 0
  launch.observe = undefined
  await rm(directory, { recursive: true, force: true })
})

describe('standalone native terminal shutdown with an actual Node child fixture', () => {
  it('joins a definitive late response after its bounded caller timed out', async () => {
    const value = client(),
      { operation, gatePath } = request(value, 'late-reply')
    const bounded = expect(operation.result).rejects.toThrow('timed out')
    await accepted(launch.children[0]!, 'late-reply')
    await bounded
    let joined = false
    const drain = joinNativeActualWork().then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)
    await writeFile(gatePath, 'allow definitive fixture ACK')
    await expect(operation.completion).resolves.toEqual({
      fixtureTag: 'late-reply',
      acknowledged: true,
    })
    await drain
    expect(joined).toBe(true)
    await value.stopSettled()
  }, 15_000)

  it('a kill request is insufficient until the owned real child confirms exit, and terminal stop cannot restart', async () => {
    const value = client(),
      { operation } = request(value, 'held-kill', 10_000)
    const caller = expect(operation.result).rejects.toThrow('stopped')
    const child = launch.children[0]!
    await accepted(child, 'held-kill')
    const realKill = child.kill.bind(child)
    let exited = false
    child.once('exit', () => {
      exited = true
    })
    // Deliberately postpone sending the OS signal. The real accepted child
    // stays alive, proving a successful kill request alone cannot release it.
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => true)
    const stopping = value.stopSettled()
    expect(value.stopSettled()).toBe(stopping)
    let closeSettled = false
    const closing = value.closeSettled('fixture-session').then(
      () => {
        closeSettled = true
      },
      (error: unknown) => {
        closeSettled = true
        throw error
      },
    )
    const closed = expect(closing).rejects.toThrow('terminally stopped')
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    await caller
    await Promise.resolve()
    expect(kill).toHaveBeenCalledOnce()
    expect(exited).toBe(false)
    expect(settled).toBe(false)
    expect(closeSettled).toBe(false)
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
    await expect(value.requestAttested({ command: 'fixture_wait_file' }).result).rejects.toThrow(
      'terminally stopped',
    )
    expect(launch.children).toHaveLength(1)
    realKill()
    await stopping
    await closed
    await operation.actualSettled
    expect(exited).toBe(true)
    expect(settled).toBe(true)
    expect(closeSettled).toBe(true)
    await expect(operation.completion).rejects.toThrow(/exited|closed/)
    await expect(value.requestAttested({ command: 'fixture_wait_file' }).result).rejects.toThrow(
      'terminally stopped',
    )
    expect(launch.children).toHaveLength(1)
  }, 15_000)

  it('a parent stdin failure leaves a real child and its accepted work alive until the actual reply and exit', async () => {
    const value = client(),
      { operation, gatePath } = request(value, 'broken-stdin', 10_000)
    const child = launch.children[0]!
    const caller = expect(operation.result).rejects.toThrow(/stdin/)
    await accepted(child, 'broken-stdin')
    let actual = false
    void operation.actualSettled.then(() => {
      actual = true
    })
    const broken = once(child.stdin, 'error')
    child.stdin.destroy(new Error('fixture stdin failure while process remains alive'))
    await broken
    await caller
    expect(actual).toBe(false)
    expect(child.exitCode).toBeNull()
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
    await writeFile(gatePath, 'accepted child work may now finish')
    await expect(operation.completion).resolves.toEqual({
      fixtureTag: 'broken-stdin',
      acknowledged: true,
    })
    await joinNativeActualWork()
    expect(actual).toBe(true)
    let exited = false
    child.once('exit', () => {
      exited = true
    })
    await value.stopSettled()
    expect(exited).toBe(true)
  }, 15_000)

  it('stable native joining includes a second admitted request started by the first completion', async () => {
    const value = client(),
      first = request(value, 'chain-first')
    void first.operation.result.catch(() => undefined)
    const secondStarted = deferred<void>()
    let second!: ReturnType<typeof request>
    const complete = first.operation.completion.then(() => {
      second = request(value, 'chain-second')
      void second.operation.result.catch(() => undefined)
      secondStarted.resolve(undefined)
      return second.operation.completion
    })
    let joined = false
    const drain = joinNativeActualWork().then(() => {
      joined = true
    })
    await accepted(launch.children[0]!, 'chain-first')
    await writeFile(first.gatePath, 'first ACK')
    await secondStarted.promise
    await accepted(launch.children[0]!, 'chain-second')
    await Promise.resolve()
    expect(joined).toBe(false)
    await writeFile(second.gatePath, 'second ACK')
    await complete
    await drain
    expect(joined).toBe(true)
    await value.stopSettled()
  }, 15_000)
})
