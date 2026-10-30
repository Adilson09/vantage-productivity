import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloseCleanupQueue,
  type CloseCleanupTask,
  type CloseCleanupStatus,
} from '../src/close-cleanup'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const token = '12345678-1234-4234-8234-123456789abc'
function fixture() {
  const persist = vi.fn<(status: CloseCleanupStatus) => void>(),
    prepare = vi.fn(async () => true),
    purge = vi.fn(async () => {}),
    warning = vi.fn()
  const queue = new CloseCleanupQueue({ persist, prepare, purge, warning, timeoutMs: 100 })
  const task: CloseCleanupTask = {
    id: 'main-minted-1',
    module: 'docs',
    ownerKey: '7',
    source: 'renderer-A',
    generation: 3,
    token,
    documentPath: '/a.docx',
    custody: { recoveryRoot: '/private/recovery', draftId: token },
    run: vi.fn(async () => {}),
  }
  return { queue, task, persist, prepare, purge, warning }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('captured recovery custody completion', () => {
  it('indexes a captured drain before awaiting it and retirement prevents late custody creation', async () => {
    const f = fixture(),
      gate = deferred()
    f.task.ready = gate.promise
    const staged = f.queue.stage(f.task),
      rejected = expect(staged).rejects.toThrow()
    expect(f.queue.query({ module: 'docs', source: f.task.source })).toHaveLength(1)
    expect(f.prepare).not.toHaveBeenCalled()
    const retired = f.queue.retire({ module: 'docs', source: f.task.source }, 'redaction')
    gate.resolve()
    await rejected
    await retired
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.queue.status(f.task.id)?.phase).toBe('purged')
  })
  it('indexes lineage before asynchronous custody preparation and never cleans during prepare/cancel', async () => {
    const f = fixture(),
      gate = deferred()
    f.prepare.mockImplementation(async () => {
      await gate.promise
      return true
    })
    const staged = f.queue.stage(f.task)
    expect(f.queue.query({ module: 'docs', source: 'renderer-A' })).toHaveLength(1)
    gate.resolve()
    const handle = await staged
    handle.cancel()
    expect((await handle.outcome).phase).toBe('canceled')
    expect(f.task.run).not.toHaveBeenCalled()
    expect(f.purge).not.toHaveBeenCalled()
  })
  it('registers a pending quit job before actual removal and cleans only after successful return', async () => {
    const f = fixture(),
      gate = deferred()
    f.task.run = vi.fn(() => gate.promise)
    const handle = await f.queue.stage(f.task)
    expect(
      handle.commitRemoval(() => {
        expect(f.queue.hasPending()).toBe(true)
        expect(f.task.run).not.toHaveBeenCalled()
        return true
      }),
    ).toBe(true)
    await Promise.resolve()
    expect(f.task.run).toHaveBeenCalledTimes(1)
    const drained = f.queue.drain()
    gate.resolve()
    expect((await handle.outcome).phase).toBe('complete')
    expect((await drained)[0]!.phase).toBe('complete')
  })
  it.each(['false', 'throw'] as const)(
    'retains bytes when actual removal returns %s',
    async (kind) => {
      const f = fixture(),
        handle = await f.queue.stage(f.task)
      if (kind === 'throw')
        expect(() =>
          handle.commitRemoval(() => {
            throw new Error('owner replaced')
          }),
        ).toThrow('owner replaced')
      else expect(handle.commitRemoval(() => false)).toBe(false)
      expect((await handle.outcome).phase).toBe('canceled')
      expect(f.task.run).not.toHaveBeenCalled()
    },
  )
  it('refuses removal when its durable committing intent cannot be recorded', async () => {
    const f = fixture(),
      handle = await f.queue.stage(f.task),
      remove = vi.fn(() => true)
    f.persist.mockImplementation((status) => {
      if (status.phase === 'committing') throw new Error('disk full')
    })
    expect(handle.commitRemoval(remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect((await handle.outcome).phase).toBe('retained')
    expect(f.warning).toHaveBeenCalled()
  })
  it('retains protected custody and never reports late deletion as cleanup success after timeout', async () => {
    const f = fixture(),
      gate = deferred()
    f.task.run = vi.fn(() => gate.promise)
    const handle = await f.queue.stage(f.task)
    handle.commitRemoval(() => true)
    await vi.advanceTimersByTimeAsync(100)
    expect(await handle.outcome).toMatchObject({ phase: 'retained', custody: true })
    gate.resolve()
    await Promise.resolve()
    expect(handle.status().phase).toBe('retained')
    expect(f.warning).toHaveBeenCalledTimes(1)
  })
  it('bounds quit drain and records each actual retained lineage before allowing exit', async () => {
    const f = fixture(),
      gate = deferred()
    f.task.run = vi.fn(() => gate.promise)
    const handle = await f.queue.stage(f.task)
    handle.commitRemoval(() => true)
    const drain = f.queue.drain()
    await vi.advanceTimersByTimeAsync(100)
    expect((await drain)[0]).toMatchObject({ id: f.task.id, token, phase: 'retained' })
    expect(f.queue.hasPending()).toBe(false)
    gate.resolve()
  })
  it('does not dispatch cleanup when custody preparation fails or times out', async () => {
    const f = fixture(),
      gate = deferred()
    f.prepare.mockImplementation(async () => {
      await gate.promise
      return true
    })
    const staged = f.queue.stage(f.task),
      rejected = expect(staged).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    gate.resolve()
    expect(f.task.run).not.toHaveBeenCalled()
    expect(f.queue.status(f.task.id)?.phase).toBe('retained')
  })
  it('checked redaction retirement sees and drains a stage that has not finished copying', async () => {
    const f = fixture(),
      gate = deferred()
    f.prepare.mockImplementation(async () => {
      await gate.promise
      return true
    })
    const staged = f.queue.stage(f.task),
      rejected = expect(staged).rejects.toThrow()
    const retired = f.queue.retire(
      { module: 'docs', source: 'renderer-A', tokens: [token] },
      'redaction',
    )
    expect(f.purge).not.toHaveBeenCalled()
    gate.resolve()
    await rejected
    await retired
    expect(f.purge).toHaveBeenCalledTimes(1)
    expect(f.queue.status(f.task.id)?.phase).toBe('purged')
  })
  it('checked retirement refuses success while an actual old cleanup is unsettled', async () => {
    const f = fixture(),
      gate = deferred()
    f.task.run = vi.fn(() => gate.promise)
    const handle = await f.queue.stage(f.task)
    handle.commitRemoval(() => true)
    await Promise.resolve()
    const retired = f.queue.retire({ module: 'docs', source: 'renderer-A' }, 'redaction'),
      rejected = expect(retired).rejects.toThrow('still changing')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(f.purge).not.toHaveBeenCalled()
    gate.resolve()
  })
  it('purges only trusted lineage and can exclude the currently authorized cleanup job', async () => {
    const f = fixture(),
      first = await f.queue.stage(f.task)
    first.cancel()
    const second = await f.queue.stage({
      ...f.task,
      id: 'main-minted-2',
      source: 'renderer-B',
      generation: 4,
    })
    second.cancel()
    await f.queue.retire(
      { module: 'docs', source: 'renderer-A', throughGeneration: 3, excludeIds: ['main-minted-2'] },
      'privacy',
    )
    expect(f.queue.status(f.task.id)?.phase).toBe('purged')
    expect(second.status().phase).toBe('canceled')
  })
})
