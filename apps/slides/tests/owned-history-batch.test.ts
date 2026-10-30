// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createBlankPptx, openPptx } from '@vantage/pptx-engine'
import { SlidesHistoryBatches } from '../src/main/slides-history-batches'
import {
  SlidesSessionOwnership,
  configureSlidesMutationGuard,
} from '../src/main/slides-session-ownership'
import {
  beginHistoryBatch,
  endCapturedHistoryBatch,
  carryHistoryForReplacement,
  registerAiSnapshot,
  settleStaleHistoryBatch,
  pushHistory,
  takeSnapshot,
  restoreSnapshot,
  type Session,
} from '../src/main/session-state'
import { SlidesAuthoredRuntime } from '../src/renderer/slides-authored'
import {
  captureSlidesHistoryBatches,
  runSlidesHistoryBatch,
} from '../src/renderer/slides-history-batch'
import type { SlidesApi } from '../src/shared/ipc'
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  webContents: { fromId: () => null },
}))
vi.mock('../src/main/fonts', () => ({
  createSystemFontMetrics: () => ({}),
  resetFontRegistry: () => {},
}))
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const releases: Array<() => void> = [],
  cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
  configureSlidesMutationGuard(() => {})
  vi.useRealTimers()
})
async function fixture() {
  const owner = { id: 1 },
    other = { id: 2 },
    frame = '11:22',
    opened = await openPptx(await createBlankPptx())
  const original: Session = { path: '', opened, fitWidthPx: 1280, undoStack: [], redoStack: [] },
    sources = new Map<number, Session>([[1, original]]),
    known = new Set<object>([original])
  const isSession = (value: object): value is Session => known.has(value)
  const ownership = new SlidesSessionOwnership<Session>({
    source: (id) => sources.get(id),
    batch: (source) => source.historyBatch,
    changed: () => {},
  })
  configureSlidesMutationGuard((source) => {
    if (!isSession(source)) throw new Error('Unexpected native source')
    ownership.assert(source)
  })
  const finish = vi.fn(
    (source: Session, batch: NonNullable<Session['historyBatch']>, carriers: readonly Session[]) =>
      ownership.finishBatch(source, () => {
        const before = endCapturedHistoryBatch(source, batch, carriers)
        return before ? registerAiSnapshot(source, before) : null
      }),
  )
  const broker = new SlidesHistoryBatches<
    typeof owner,
    Session,
    NonNullable<Session['historyBatch']>
  >({
    source: (value) => sources.get(value.id),
    begin: (source) => {
      beginHistoryBatch(source)
      const batch = source.historyBatch
      if (!batch) throw new Error('Missing batch')
      return batch
    },
    carriers: (batch, origin, value) =>
      [...new Set([sources.get(value.id), ...sources.values(), origin])].filter(
        (source): source is Session => !!source && source.historyBatch === batch,
      ),
    sameBatch: (source, batch) => source.historyBatch === batch,
    actualBatchSources: (batch) => ownership.actualBatchSources(batch),
    closed: (batch) => batch.depth <= 0,
    hold: (source) => ownership.holdBatch(source),
    pause: (source) => ownership.pauseOrdinary(source),
    waitActual: (source) => ownership.waitActual(source),
    actualIdle: (source) => ownership.actualIdle(source),
    finish,
    report: vi.fn(),
  })
  const begin = () => ownership.run(owner.id, () => broker.begin(owner, frame))
  const replacement = async (carry: boolean) => {
    const next: Session = {
      path: '',
      opened: await openPptx(await createBlankPptx()),
      fitWidthPx: 1280,
      undoStack: [],
      redoStack: [],
    }
    known.add(next)
    ownership.run(owner.id, () => {
      if (carry) carryHistoryForReplacement(sources.get(owner.id), next)
      ownership.adopt(owner.id, next)
      sources.set(owner.id, next)
    })
    return next
  }
  cleanups.push(() => broker.destroy(owner))
  return { owner, other, frame, original, sources, ownership, broker, finish, begin, replacement }
}
it('same-source callback cancellation still finishes the exact accepted native batch', async () => {
  const f = await fixture(),
    runtime = new SlidesAuthoredRuntime(
      { claimCloseLease: async () => false, cancelCloseLease: async () => {} },
      vi.fn(),
    ),
    scope = runtime.scope(),
    entered = deferred(),
    render = deferred()
  releases.push(() => render.resolve())
  const api: Pick<SlidesApi, 'beginOwnedHistoryBatch' | 'finishOwnedHistoryBatch'> = {
    beginOwnedHistoryBatch: async () => f.begin(),
    finishOwnedHistoryBatch: (ticket) => f.broker.finish(f.owner, f.frame, ticket),
  }
  const access = captureSlidesHistoryBatches(api, runtime, scope),
    action = runSlidesHistoryBatch(access, async () => {
      entered.resolve()
      await runtime.wait(scope, render.promise)
    })
  const failure = expect(action).rejects.toThrow('retired presentation')
  await entered.promise
  expect(f.ownership.busy(f.original)).toBe(true)
  runtime.cancelPending()
  render.resolve()
  await failure
  expect(f.finish).toHaveBeenCalledOnce()
  expect(f.original.historyBatch).toBeUndefined()
  expect(f.broker.pending).toBe(0)
  expect(f.ownership.busy(f.original)).toBe(false)
})
it('an old capability ends only its origin batch when the replacement has an unrelated new batch', async () => {
  const f = await fixture(),
    old = f.begin()!,
    oldBatch = f.original.historyBatch!,
    next = await f.replacement(false),
    fresh = f.begin()!,
    newBatch = next.historyBatch!
  await f.broker.finish(f.owner, f.frame, old)
  expect(oldBatch.depth).toBe(0)
  expect(f.original.historyBatch).toBeUndefined()
  expect(next.historyBatch).toBe(newBatch)
  expect(newBatch.depth).toBe(1)
  await f.broker.finish(f.owner, f.frame, fresh)
  expect(next.historyBatch).toBeUndefined()
})
it('a carried exact batch finishes on its current session and clears only matching carrier references', async () => {
  const f = await fixture(),
    ticket = f.begin()!,
    batch = f.original.historyBatch!,
    next = await f.replacement(true)
  expect(next.historyBatch).toBe(batch)
  const snapshot = await f.broker.finish(f.owner, f.frame, ticket)
  expect(batch.depth).toBe(0)
  expect(next.historyBatch).toBeUndefined()
  expect(f.original.historyBatch).toBeUndefined()
  expect(typeof snapshot).toBe('number')
  if (typeof snapshot === 'number') expect(next.aiSnapshots?.has(snapshot)).toBe(true)
})
it('forged, wrong-owner, wrong-frame and duplicate receipts never decrement another depth', async () => {
  const f = await fixture(),
    ticket = f.begin()!,
    batch = f.original.historyBatch!
  await expect(
    f.broker.finish(f.owner, f.frame, { nonce: '00000000-0000-4000-8000-000000000000' }),
  ).rejects.toThrow('stale')
  await expect(f.broker.finish(f.other, f.frame, ticket)).rejects.toThrow('another owner')
  await expect(f.broker.finish(f.owner, 'another-frame', ticket)).rejects.toThrow('another owner')
  expect(batch.depth).toBe(1)
  await f.broker.finish(f.owner, f.frame, ticket)
  await expect(f.broker.finish(f.owner, f.frame, ticket)).rejects.toThrow('stale')
  expect(batch.depth).toBe(0)
  expect(f.finish).toHaveBeenCalledOnce()
})
it('two concurrent finishers join actual work without waiting on either batch hold or finisher', async () => {
  const f = await fixture(),
    first = f.begin()!,
    second = f.begin()!,
    batch = f.original.historyBatch!,
    actual = deferred()
  releases.push(() => actual.resolve())
  const work = f.ownership.run(f.owner.id, async () => {
    await actual.promise
  })
  const one = f.broker.finish(f.owner, f.frame, first),
    two = f.broker.finish(f.owner, f.frame, second)
  expect(batch.depth).toBe(2)
  expect(f.finish).not.toHaveBeenCalled()
  expect(() => f.ownership.run(f.owner.id, () => {})).toThrow('cleanup is still finishing')
  actual.resolve()
  await work
  await Promise.all([one, two])
  expect(batch.depth).toBe(0)
  expect(f.finish).toHaveBeenCalledTimes(2)
  expect(f.ownership.busy(f.original)).toBe(false)
  expect(f.broker.pending).toBe(0)
  expect(() => f.ownership.run(f.owner.id, () => {})).not.toThrow()
})
it('owner destruction closes admission and retains actual ordinary IO beyond a caller deadline', async () => {
  const f = await fixture(),
    ticket = f.begin()!,
    batch = f.original.historyBatch!,
    actual = deferred(),
    cleanup = deferred(),
    cleaning = deferred()
  releases.push(
    () => actual.resolve(),
    () => cleanup.resolve(),
  )
  const work = f.ownership.run(f.owner.id, async () => {
    try {
      await actual.promise
    } finally {
      cleaning.resolve()
      await cleanup.promise
    }
  })
  vi.useFakeTimers()
  let finished = false
  const destroyed = f.broker.destroy(f.owner).then(() => {
    finished = true
  })
  const caller = Promise.race([
    destroyed.then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('caller timed out'), 5000)),
  ])
  await vi.advanceTimersByTimeAsync(5000)
  expect(await caller).toBe('caller timed out')
  await vi.advanceTimersByTimeAsync(295_000)
  expect(finished).toBe(false)
  expect(batch.depth).toBe(1)
  expect(f.ownership.busy(f.original)).toBe(true)
  expect(() => f.broker.begin(f.owner, f.frame)).toThrow('owner has ended')
  actual.resolve()
  await cleaning.promise
  expect(finished).toBe(false)
  cleanup.resolve()
  await work
  await destroyed
  expect(finished).toBe(true)
  expect(batch.depth).toBe(0)
  expect(f.broker.pending).toBe(0)
  await expect(f.broker.finish(f.owner, f.frame, ticket)).rejects.toThrow('stale')
})
it('a retired begin response captures its receipt and joins exact cleanup before rejecting the callback', async () => {
  const f = await fixture(),
    runtime = new SlidesAuthoredRuntime(
      { claimCloseLease: async () => false, cancelCloseLease: async () => {} },
      vi.fn(),
    ),
    scope = runtime.scope(),
    entered = deferred(),
    response = deferred()
  releases.push(() => response.resolve())
  const api: Pick<SlidesApi, 'beginOwnedHistoryBatch' | 'finishOwnedHistoryBatch'> = {
    beginOwnedHistoryBatch: async () => {
      const receipt = f.begin()
      entered.resolve()
      await response.promise
      return receipt
    },
    finishOwnedHistoryBatch: (ticket) => f.broker.finish(f.owner, f.frame, ticket),
  }
  const access = captureSlidesHistoryBatches(api, runtime, scope),
    pending = access.acquire(),
    failure = expect(pending).rejects.toThrow('retired presentation')
  await entered.promise
  runtime.cancelPending()
  expect(f.original.historyBatch?.depth).toBe(1)
  response.resolve()
  await failure
  expect(f.original.historyBatch).toBeUndefined()
  expect(f.broker.pending).toBe(0)
  expect(f.finish).toHaveBeenCalledOnce()
})
it('retiring a component while begin is outstanding ends the accepted batch instead of leaking its receipt', async () => {
  const f = await fixture(),
    entered = deferred(),
    response = deferred()
  releases.push(() => response.resolve())
  const access = captureSlidesHistoryBatches(
    {
      beginOwnedHistoryBatch: async () => {
        const receipt = f.begin()
        entered.resolve()
        await response.promise
        return receipt
      },
      finishOwnedHistoryBatch: (ticket) => f.broker.finish(f.owner, f.frame, ticket),
    },
    null,
    undefined,
  )
  const pending = access.acquire(),
    failure = expect(pending).rejects.toThrow('action was retired')
  await entered.promise
  access.retire()
  response.resolve()
  await failure
  expect(f.original.historyBatch).toBeUndefined()
  expect(f.broker.pending).toBe(0)
})
it('a single captured lease shares its actual finish promise and cannot dispatch duplicate depth releases', async () => {
  const f = await fixture(),
    access = captureSlidesHistoryBatches(
      {
        beginOwnedHistoryBatch: async () => f.begin(),
        finishOwnedHistoryBatch: (ticket) => f.broker.finish(f.owner, f.frame, ticket),
      },
      null,
      undefined,
    ),
    lease = (await access.acquire())!
  const first = lease.finish(),
    second = lease.finish()
  expect(second).toBe(first)
  await first
  expect(f.finish).toHaveBeenCalledOnce()
  expect(f.broker.pending).toBe(0)
})

it.each(['undo', 'redo'] as const)(
  'Main %s replay guard preserves an owned batch and history while actual mutation is pending',
  async (direction) => {
    const f = await fixture(),
      ticket = f.begin()!,
      batch = f.original.historyBatch!,
      actual = deferred(),
      entered = deferred()
    releases.push(() => actual.resolve())
    const work = f.ownership.run(f.owner.id, async () => {
      pushHistory(f.original)
      f.original.metaDirty = true
      entered.resolve()
      await actual.promise
    })
    await entered.promise
    const undoBefore = [...f.original.undoStack],
      redoBefore = [...f.original.redoStack],
      dirty = f.original.metaDirty
    // Same guard and ordering as both Main IPC handlers: before stale settlement or any stack mutation.
    const replay = () =>
      f.ownership.run(f.owner.id, () => {
        f.broker.assertReplayAllowed(f.original.historyBatch)
        settleStaleHistoryBatch(f.original)
        const from = direction === 'undo' ? f.original.undoStack : f.original.redoStack,
          to = direction === 'undo' ? f.original.redoStack : f.original.undoStack
        if (!from.length) return false
        to.push(takeSnapshot(f.original))
        restoreSnapshot(f.original, from.pop()!)
        return true
      })
    expect(replay).toThrow('owned history batch')
    expect(batch.depth).toBe(1)
    expect(f.original.historyBatch).toBe(batch)
    expect(f.original.undoStack).toEqual(undoBefore)
    expect(f.original.redoStack).toEqual(redoBefore)
    expect(f.original.metaDirty).toBe(dirty)
    actual.resolve()
    await work
    await f.broker.finish(f.owner, f.frame, ticket)
    expect(f.original.historyBatch).toBeUndefined()
    if (direction === 'redo')
      f.ownership.run(f.owner.id, () => {
        f.original.redoStack.push(takeSnapshot(f.original))
      })
    expect(replay()).toBe(true)
  },
)
it('replay ownership follows exact carried batches across owner aliases but leaves unrelated legacy batches usable', async () => {
  const f = await fixture(),
    ticket = f.begin()!,
    batch = f.original.historyBatch!,
    carried = await f.replacement(true)
  f.sources.set(f.other.id, carried)
  expect(() =>
    f.ownership.run(f.other.id, () => f.broker.assertReplayAllowed(carried.historyBatch)),
  ).toThrow('owned history batch')
  const unrelated = await f.replacement(false)
  f.ownership.run(f.owner.id, () => beginHistoryBatch(unrelated))
  expect(unrelated.historyBatch).not.toBe(batch)
  f.ownership.run(f.owner.id, () => {
    f.broker.assertReplayAllowed(unrelated.historyBatch)
    settleStaleHistoryBatch(unrelated)
  })
  expect(unrelated.historyBatch).toBeUndefined()
  expect(batch.depth).toBe(1)
  await f.broker.finish(f.owner, f.frame, ticket)
  expect(carried.historyBatch).toBeUndefined()
})
