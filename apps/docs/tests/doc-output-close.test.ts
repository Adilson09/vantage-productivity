// @vitest-environment node
import { realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseLeaseBroker } from '../../../packages/electron-utils/src/close-lease'
import { DocNativeCloseCoordinator, type DocsNativeCloseState } from '../src/main/doc-native-close'
import { DocsOutputGrants } from '../src/main/export-output-grants'
import type { DocNativeCloseRequest } from '../src/shared/ipc'
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const prefix = join(realpathSync(tmpdir()), 'vantage-docs-real-output-close-')
let dir: string
const releases: Array<() => void> = [],
  jobs: Promise<unknown>[] = [],
  shutdown: Array<() => void> = []
beforeEach(async () => {
  dir = mkdtempSync(prefix)
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementation(actual.rename)
})
afterEach(async () => {
  for (const release of releases) release()
  for (const close of shutdown) close()
  vi.useRealTimers()
  await Promise.allSettled(jobs)
  releases.length = 0
  jobs.length = 0
  shutdown.length = 0
  if (!dir.startsWith(prefix)) throw new Error('Unexpected test root')
  rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const owner = { id: 1, alive: true, source: 'A' },
    outputs = new DocsOutputGrants<typeof owner>(),
    sent: DocNativeCloseRequest[] = []
  const state: DocsNativeCloseState = {
    dirty: true,
    autoSave: false,
    filePath: join(dir, 'source.docx'),
    stamp: { source: 'renderer-A', revision: '1' },
  }
  writeFileSync(state.filePath!, 'source bytes')
  let service!: DocNativeCloseCoordinator<typeof owner>,
    sequence = 0
  const leases = new CloseLeaseBroker<typeof owner>({
    alive: (value) => value.alive,
    source: (value) => value.source,
    validate: (_owner, _ticket, stamp) =>
      stamp.source === state.stamp!.source && stamp.revision === state.stamp!.revision,
    release: (value, ticket, reason) => service.released(value, ticket, reason),
  })
  const query = vi.fn(async () => state),
    choose = vi.fn(async () => 'save' as 'save' | 'discard' | 'force' | 'cancel'),
    preserve = vi.fn(() => () => {})
  service = new DocNativeCloseCoordinator({
    leases,
    id: () => `close-${++sequence}`,
    ownerKey: (value) => String(value.id),
    alive: (value) => value.alive,
    source: (value) => value.source,
    pauseOutputs: (value, source) =>
      outputs.pause(value, source, () => value.alive && value.source === source),
    query,
    choose,
    send: (_owner, request) => sent.push(request),
    // This fixture has no draft producer. The output registry and filesystem
    // publisher are genuine and are the work whose lifetime is under test.
    stage: () => ({
      ready: Promise.resolve(null),
      actualSettled: Promise.resolve(),
      cancel: () => {},
    }),
    preserveRecovery: preserve,
    report: vi.fn(),
  })
  const respond = () => {
    const request = sent.at(-1)!
    service.receive(owner, request.ticket.id, {
      intent: request.intent,
      published: false,
      clean: true,
      current: true,
      throughSequence: 0,
      closeLease: { ticket: request.ticket, stamp: state.stamp! },
    })
  }
  shutdown.push(() => service.destroy(owner))
  return { owner, outputs, state, sent, leases, service, query, choose, preserve, respond }
}
async function dispatch(f: ReturnType<typeof fixture>) {
  for (let count = 0; count < 20 && !f.sent.length; count++) await Promise.resolve()
  expect(f.sent).toHaveLength(1)
}
async function actualPending(f: ReturnType<typeof fixture>) {
  const path = join(dir, 'selected.pdf')
  writeFileSync(path, 'original selected bytes')
  const selection = await f.outputs.captureFile(f.owner, path, {
    sourcePaths: [f.state.filePath!],
    assertCurrent: () => {
      if (!f.owner.alive || f.owner.source !== 'A') throw new Error('source changed')
    },
  })
  const entered = deferred(),
    publication = deferred(),
    published = deferred(),
    cleanup = deferred(),
    actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  releases.push(publication.resolve, cleanup.resolve)
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to) === path) {
      entered.resolve()
      await publication.promise
    }
    return actual.rename(from, to)
  })
  const work = f.outputs.runFile(f.owner, path, selection, async (lease) => {
    await lease.publish(Buffer.from('actual exported bytes'))
    published.resolve()
    await cleanup.promise
  })
  jobs.push(work)
  void work.catch(() => {})
  await entered.promise
  return { path, work, publication, published, cleanup }
}
it('source adoption fences actual A work before cancellation can resume its old close pause', async () => {
  const f = fixture(),
    output = await actualPending(f),
    controller = new AbortController()
  const close = f.service.prepare(f.owner, undefined, false, {
    deferSeal: true,
    signal: controller.signal,
  })
  f.outputs.transitionSource(f.owner, () => {
    // Exact production order: invalidate A while A is still current, then install B.
    controller.abort()
    expect(f.owner.source).toBe('A')
    expect(() => f.outputs.fileSelection(f.owner, output.path)).toThrow('paused')
    f.owner.source = 'B'
    return f.owner.source
  })
  expect(await close).toBeNull()
  const next = join(dir, 'B-output.pdf')
  await expect(f.outputs.captureFile(f.owner, next, {})).rejects.toThrow('paused')
  output.publication.resolve()
  await output.published.promise
  // A's physical rename is insufficient: its accepted finalizer is still pending.
  await expect(f.outputs.captureFile(f.owner, next, {})).rejects.toThrow('paused')
  f.outputs.transitionSource(f.owner, () => {
    f.owner.source = 'C'
    return f.owner.source
  })
  await expect(f.outputs.captureFile(f.owner, next, {})).rejects.toThrow('paused')
  output.cleanup.resolve()
  await output.work
  const selection = await f.outputs.captureFile(f.owner, next, {
    assertCurrent: () => {
      if (f.owner.source !== 'C') throw new Error('source changed')
    },
  })
  await f.outputs.runFile(f.owner, next, selection, (lease) =>
    lease.publish(Buffer.from('current C bytes')),
  )
  expect(readFileSync(next, 'utf8')).toBe('current C bytes')
  expect(f.query).not.toHaveBeenCalled()
  expect(f.sent).toHaveLength(0)
})

describe.each(['dirty native', 'clean native', 'explicit discard'] as const)('%s close', (mode) => {
  it('pauses late admission, waits actual final rename and cleanup, then permits exact removal', async () => {
    const f = fixture(),
      output = await actualPending(f)
    if (mode === 'clean native') f.state.dirty = false
    const close =
      mode === 'explicit discard'
        ? f.service.prepareDiscard(f.owner, f.state.filePath)
        : f.service.prepare(f.owner)
    expect(f.query).not.toHaveBeenCalled()
    await expect(f.outputs.captureFile(f.owner, join(dir, 'late.pdf'), {})).rejects.toThrow(
      'paused',
    )
    output.publication.resolve()
    await output.published.promise
    expect(f.query).not.toHaveBeenCalled()
    output.cleanup.resolve()
    await output.work
    await dispatch(f)
    f.respond()
    const receipt = (await close)!
    const remove = vi.fn(() => {
      f.owner.alive = false
      return true
    })
    expect(f.service.complete(f.owner, receipt, remove)).toBe(true)
    expect(remove).toHaveBeenCalledOnce()
    expect(readFileSync(output.path, 'utf8')).toBe('actual exported bytes')
    expect(() => f.outputs.fileSelection(f.owner, output.path)).toThrow('ended')
  })
})
it('abort refuses close and resumes the same live source while actual accepted IO remains owned', async () => {
  const f = fixture(),
    output = await actualPending(f),
    controller = new AbortController()
  const close = f.service.prepare(f.owner, undefined, false, {
    deferSeal: true,
    signal: controller.signal,
  })
  controller.abort()
  expect(await close).toBeNull()
  expect(f.query).not.toHaveBeenCalled()
  expect(readFileSync(output.path, 'utf8')).toBe('original selected bytes')
  const path = join(dir, 'new-live-export.pdf'),
    selection = await f.outputs.captureFile(f.owner, path, {})
  await f.outputs.runFile(f.owner, path, selection, async (lease) =>
    lease.publish(Buffer.from('new allowed output')),
  )
  expect(readFileSync(path, 'utf8')).toBe('new allowed output')
  output.publication.resolve()
  output.cleanup.resolve()
  await output.work
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(f.query).not.toHaveBeenCalled()
  expect(f.sent).toHaveLength(0)
})
it('the original120s budget refuses permission during upfront drain without settling actual IO or reviving a latent close', async () => {
  const f = fixture(),
    output = await actualPending(f)
  vi.useFakeTimers()
  const close = f.service.prepare(f.owner)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await close).toBeNull()
  expect(f.query).not.toHaveBeenCalled()
  expect(readFileSync(output.path, 'utf8')).toBe('original selected bytes')
  const next = f.service.prepare(f.owner)
  expect(f.query).not.toHaveBeenCalled()
  output.publication.resolve()
  output.cleanup.resolve()
  await output.work
  await dispatch(f)
  expect(f.query).toHaveBeenCalledOnce()
  f.respond()
  const receipt = (await next)!
  expect(f.service.complete(f.owner, receipt, () => true)).toBe(true)
})
it('upfront drain consumes the preparing lifetime instead of starting a fresh120s after renderer dispatch', async () => {
  const f = fixture(),
    output = await actualPending(f)
  vi.useFakeTimers()
  const close = f.service.prepare(f.owner, undefined, false, { deferSeal: true })
  await vi.advanceTimersByTimeAsync(90_000)
  output.publication.resolve()
  output.cleanup.resolve()
  await output.work
  await dispatch(f)
  f.respond()
  const receipt = (await close)!
  await vi.advanceTimersByTimeAsync(29_999)
  expect(f.service.isPrepared(f.owner, receipt)).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.service.isPrepared(f.owner, receipt)).toBe(false)
  expect(f.service.seal(f.owner, receipt)).toBeNull()
})
it('ready retains its separate original5s only after a seal inside the remaining preparation budget', async () => {
  const f = fixture(),
    output = await actualPending(f)
  vi.useFakeTimers()
  const close = f.service.prepare(f.owner, undefined, false, { deferSeal: true })
  await vi.advanceTimersByTimeAsync(90_000)
  output.publication.resolve()
  output.cleanup.resolve()
  await output.work
  await dispatch(f)
  f.respond()
  const prepared = (await close)!
  await vi.advanceTimersByTimeAsync(29_999)
  const ready = f.service.seal(f.owner, prepared)!
  await vi.advanceTimersByTimeAsync(4_999)
  expect(f.service.complete(f.owner, ready, () => true)).toBe(true)
})
it('MCP saved-envelope staging cannot seal or remove before the actual output finalizer', async () => {
  const f = fixture(),
    output = await actualPending(f),
    ticket = f.leases.reserve(f.owner, 'mcp')
  f.leases.claim(f.owner, ticket)
  f.leases.settle(f.owner, ticket)
  let approved = false
  const close = f.service
    .stageSaved(f.owner, { ticket, stamp: f.state.stamp! }, true, 0)
    .then((value) => {
      approved = true
      return value
    })
  const remove = vi.fn(() => {
    f.owner.alive = false
    return true
  })
  expect(f.service.completeEnvelope(f.owner, { ticket, stamp: f.state.stamp! }, remove)).toBe(false)
  expect(remove).not.toHaveBeenCalled()
  expect(approved).toBe(false)
  output.publication.resolve()
  await output.published.promise
  expect(approved).toBe(false)
  output.cleanup.resolve()
  await output.work
  const receipt = (await close)!
  expect(receipt.kind).toBe('lease')
  expect(
    f.service.completeEnvelope(
      f.owner,
      receipt.kind === 'lease' ? receipt.closeLease : null,
      remove,
    ),
  ).toBe(true)
  expect(remove).toHaveBeenCalledOnce()
})
it('individual force also waits actual exporters before its separate explicit removal authority', async () => {
  const f = fixture(),
    output = await actualPending(f)
  f.state.unresponsive = true
  f.choose.mockResolvedValue('force')
  const close = f.service.prepare(f.owner)
  expect(f.choose).not.toHaveBeenCalled()
  output.publication.resolve()
  output.cleanup.resolve()
  await output.work
  const receipt = (await close)!
  expect(receipt.kind).toBe('force')
  expect(f.service.complete(f.owner, receipt, () => true)).toBe(true)
  expect(f.preserve).toHaveBeenCalledOnce()
})
