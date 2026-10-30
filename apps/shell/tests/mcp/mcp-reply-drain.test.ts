// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  McpReplyDrain,
  toolRequestIds,
  installMcpReplyQuitGuard,
  type McpQuitService,
} from '../../src/main/mcp/mcp-reply-drain'
function fixture(limit = 4) {
  const timers = new Map<number, () => void>(),
    listeners = new Set<() => void>()
  let next = 0
  const drain = new McpReplyDrain({
    maxPending: limit,
    maxPerSession: limit,
    timeoutMs: 100,
    setTimer: (callback) => {
      timers.set(++next, callback)
      return next
    },
    clearTimer: (id) => {
      timers.delete(id as number)
    },
    changed: () => {
      for (const listener of listeners) listener()
    },
  })
  drain.activate(1)
  const service: McpQuitService = {
    beginQuitDrain: () => drain.beginDrain(),
    cancelQuitDrain: () => drain.cancelDrain(),
    replyDrainStatus: () => drain.status(),
    onReplyStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    drain,
    timers,
    service,
    fire() {
      const [id, callback] = timers.entries().next().value!
      timers.delete(id)
      callback()
    },
  }
}
const response = (id: string | number) => ({ jsonrpc: '2.0', id, result: { content: [] } })
class App {
  listeners: Array<(event: { preventDefault: () => void }) => void> = []
  attempts = 0
  exits = 0
  on(_event: 'before-quit', listener: (event: { preventDefault: () => void }) => void) {
    this.listeners.push(listener)
  }
  quit() {
    this.attempts++
    let denied = false
    for (const listener of this.listeners)
      listener({
        preventDefault: () => {
          denied = true
        },
      })
    if (!denied) this.exits++
  }
}
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
describe('owned tool execution and local reply drain', () => {
  it('does not treat handler completion or emitted response as physical reply completion', () => {
    const f = fixture(),
      [ticket] = f.drain.admit(1, 'A', [7], vi.fn())
    const running = f.drain.begin(1, 'A', 7)
    f.drain.settle(running)
    expect(f.drain.status().owned).toBe(1)
    expect(f.drain.emission(1, 'A', response(7))).toBe(ticket)
    expect(f.drain.status().owned).toBe(1)
    f.drain.finished(ticket!)
    expect(f.drain.status().owned).toBe(0)
  })
  it('reserves a whole batch atomically and rejects duplicate/capacity without dispatch', () => {
    const f = fixture(2)
    f.drain.admit(1, 'A', [1], vi.fn())
    expect(() => f.drain.admit(1, 'A', [2, 2], vi.fn())).toThrow('Duplicate')
    expect(() => f.drain.admit(1, 'B', [2, 3], vi.fn())).toThrow('too many')
    expect(f.drain.status().owned).toBe(1)
  })
  it('rejects control/tool id collisions before either can impersonate the other response', () => {
    const f = fixture()
    expect(() =>
      toolRequestIds([
        { jsonrpc: '2.0', id: 1, method: 'tools/call' },
        { jsonrpc: '2.0', id: 1, method: 'ping' },
      ]),
    ).toThrow('Duplicate')
    f.drain.admit(1, 'A', [], vi.fn(), [1])
    expect(() => f.drain.admit(1, 'A', [1], vi.fn())).toThrow('Duplicate')
    f.drain.admit(1, 'A', [2], vi.fn())
    expect(() => f.drain.admit(1, 'A', [], vi.fn(), [2])).toThrow('Duplicate')
  })
  it('keeps a disconnected executing handler owned and refuses a replacement slot', () => {
    const f = fixture(1),
      [ticket] = f.drain.admit(1, 'A', [1], vi.fn())
    f.drain.begin(1, 'A', 1)
    f.drain.disconnected(ticket!)
    expect(f.drain.status()).toMatchObject({ owned: 1, running: 1, pendingReplies: 0 })
    expect(() => f.drain.admit(1, 'B', [2], vi.fn())).toThrow('too many')
    f.drain.settle(ticket!)
    expect(f.drain.status().owned).toBe(0)
  })
  it('returns a bounded blocked drain without disconnecting a legitimate unresolved handler', async () => {
    const f = fixture(),
      abort = vi.fn(),
      [ticket] = f.drain.admit(1, 'A', [1], abort)
    f.drain.begin(1, 'A', 1)
    const pending = f.drain.beginDrain()
    f.fire()
    expect(await pending).toMatchObject({ owned: 1, running: 1, pendingReplies: 1 })
    expect(abort).not.toHaveBeenCalled()
    expect(f.drain.status().failures).toEqual([])
    f.drain.settle(ticket!)
    f.drain.emission(1, 'A', response(1))
    f.fire()
    expect(abort).toHaveBeenCalledOnce()
    expect(f.drain.status().owned).toBe(1)
    f.drain.disconnected(ticket!)
    expect(f.drain.status().owned).toBe(0)
  })
  it('does not let one session/id release an equal id owned by another session', () => {
    const f = fixture(),
      [first] = f.drain.admit(1, 'A', [17], vi.fn()),
      [second] = f.drain.admit(1, 'B', [17], vi.fn())
    f.drain.begin(1, 'A', 17)
    f.drain.begin(1, 'B', 17)
    f.drain.settle(first!)
    f.drain.emission(1, 'A', response(17))
    f.drain.finished(first!)
    expect(f.drain.status().owned).toBe(1)
    f.drain.writeFlushed(first!)
    expect(f.drain.status().owned).toBe(1)
    f.drain.settle(second!)
    f.drain.emission(1, 'B', response(17))
    f.drain.finished(second!)
    expect(f.drain.status().owned).toBe(0)
  })
  it('does not treat SDK session closure as the Node writer terminal event', () => {
    const f = fixture(),
      abort = vi.fn(),
      [ticket] = f.drain.admit(1, 'A', [1], abort)
    f.drain.begin(1, 'A', 1)
    f.drain.settle(ticket!)
    f.drain.sessionEnded(1, 'A')
    expect(abort).toHaveBeenCalledOnce()
    expect(f.drain.status()).toMatchObject({ owned: 1, pendingReplies: 1 })
    f.drain.disconnected(ticket!)
    expect(f.drain.status().owned).toBe(0)
  })
  it('retains session request-id tombstones and rejects late dispatch after an unhandled protocol response', () => {
    const f = fixture(),
      [ticket] = f.drain.admit(1, 'A', [1], vi.fn())
    f.drain.finished(ticket!)
    expect(() => f.drain.begin(1, 'A', 1)).toThrow('not admitted')
    expect(() => f.drain.admit(1, 'A', [1], vi.fn())).toThrow('Duplicate')
  })
  it('an old generation callback cannot release a replacement generation request', () => {
    const f = fixture(),
      [old] = f.drain.admit(1, 'A', [1], vi.fn())
    f.drain.begin(1, 'A', 1)
    f.drain.stopGeneration(1)
    f.drain.activate(3)
    const [current] = f.drain.admit(3, 'A', [1], vi.fn())
    f.drain.disconnected(old!)
    f.drain.settle(old!)
    f.drain.writeFlushed(old!)
    expect(f.drain.status().owned).toBe(1)
    expect(f.drain.find(3, 'A', 1)).toBe(current)
  })
  it('notifies once after a bounded refusal, then retries only once when actual work and reply settle', async () => {
    const f = fixture(),
      app = new App(),
      blocked = vi.fn(),
      [ticket] = f.drain.admit(1, 'A', [1], vi.fn())
    f.drain.begin(1, 'A', 1)
    installMcpReplyQuitGuard(app, { services: () => [f.service], onQuitBlocked: blocked })
    app.quit()
    f.fire()
    await tick()
    expect(blocked).toHaveBeenCalledOnce()
    expect(app.exits).toBe(0)
    app.quit()
    await tick()
    expect(blocked).toHaveBeenCalledOnce()
    f.drain.settle(ticket!)
    f.drain.emission(1, 'A', response(1))
    f.drain.finished(ticket!)
    await tick()
    expect(app.exits).toBe(1)
  })
  it('user return cancels the old quit intent without freeing its unresolved handler', async () => {
    const f = fixture(),
      app = new App(),
      [ticket] = f.drain.admit(1, 'A', [1], vi.fn())
    f.drain.begin(1, 'A', 1)
    const guard = installMcpReplyQuitGuard(app, {
      services: () => [f.service],
      onQuitBlocked: vi.fn(),
    })
    app.quit()
    guard.cancel()
    await tick()
    expect(f.drain.status()).toMatchObject({ draining: false, owned: 1, running: 1 })
    f.drain.settle(ticket!)
    f.drain.emission(1, 'A', response(1))
    f.drain.finished(ticket!)
    await tick()
    expect(app.exits).toBe(0)
  })
  it('a stale configuration epoch cannot quit a replacement service', async () => {
    const old = fixture(),
      replacement = fixture(),
      app = new App()
    let epoch = 1
    const [ticket] = old.drain.admit(1, 'A', [1], vi.fn())
    old.drain.begin(1, 'A', 1)
    installMcpReplyQuitGuard(app, {
      services: () => [old.service, replacement.service],
      epoch: () => epoch,
      onQuitBlocked: vi.fn(),
    })
    app.quit()
    epoch++
    old.drain.settle(ticket!)
    old.drain.emission(1, 'A', response(1))
    old.drain.finished(ticket!)
    await tick()
    expect(app.exits).toBe(0)
    expect(replacement.drain.status().owned).toBe(0)
  })
})

describe('current service ownership during guarded quit resume', () => {
  it('adopts a same-epoch service added after quit before deciding the first resume', async () => {
    const old = fixture(),
      late = fixture(),
      app = new App(),
      blocked = vi.fn()
    let current = [old.service]
    const [first] = old.drain.admit(1, 'old', [1], vi.fn())
    old.drain.begin(1, 'old', 1)
    installMcpReplyQuitGuard(app, {
      services: () => current,
      epoch: () => 1,
      onQuitBlocked: blocked,
    })
    app.quit()
    const [second] = late.drain.admit(1, 'late', [2], vi.fn())
    late.drain.begin(1, 'late', 2)
    current = [old.service, late.service]
    old.drain.settle(first!)
    old.drain.emission(1, 'old', response(1))
    old.drain.finished(first!)
    await tick()
    expect(app.exits).toBe(0)
    expect(late.drain.status()).toMatchObject({ draining: true, owned: 1, running: 1 })
    expect(blocked).toHaveBeenCalledOnce()
    late.drain.settle(second!)
    late.drain.emission(1, 'late', response(2))
    late.drain.finished(second!)
    await tick()
    expect(app.exits).toBe(1)
  })
  it('rechecks a current writer introduced by an earlier synchronous before-quit listener during retry', async () => {
    const old = fixture(),
      late = fixture(),
      app = new App(),
      blocked = vi.fn()
    let current = [old.service],
      second: ReturnType<typeof late.drain.admit>[number] | undefined
    app.on('before-quit', () => {
      if (app.attempts === 2) {
        ;[second] = late.drain.admit(1, 'late', [2], vi.fn())
        late.drain.begin(1, 'late', 2)
        current = [late.service]
      }
    })
    const [first] = old.drain.admit(1, 'old', [1], vi.fn())
    old.drain.begin(1, 'old', 1)
    installMcpReplyQuitGuard(app, { services: () => current, onQuitBlocked: blocked })
    app.quit()
    old.drain.settle(first!)
    old.drain.emission(1, 'old', response(1))
    old.drain.finished(first!)
    await tick()
    expect(app.exits).toBe(0)
    expect(late.drain.status().owned).toBe(1)
    expect(blocked).toHaveBeenCalledOnce()
    late.drain.settle(second!)
    late.drain.emission(1, 'late', response(2))
    late.drain.finished(second!)
    await tick()
    expect(app.exits).toBe(1)
  })
  it('joins a newly published service before start can admit work', () => {
    const old = fixture(),
      late = fixture(),
      app = new App()
    let current = [old.service]
    const [ticket] = old.drain.admit(1, 'old', [1], vi.fn())
    old.drain.begin(1, 'old', 1)
    const guard = installMcpReplyQuitGuard(app, { services: () => current, onQuitBlocked: vi.fn() })
    app.quit()
    current = [old.service, late.service]
    guard.ownershipChanged()
    expect(late.drain.status().draining).toBe(true)
    expect(() => late.drain.admit(1, 'late', [2], vi.fn())).toThrow('draining')
    guard.cancel()
    old.drain.disconnected(ticket!)
    old.drain.settle(ticket!)
  })
  it('does not cancel ordinary quit when an already-quiescent retired service disappears', async () => {
    const old = fixture(),
      app = new App(),
      interrupted = vi.fn()
    let current = [old.service]
    old.service.onReplyStateChange!(() => {
      if (!old.drain.status().owned) current = []
    })
    const [ticket] = old.drain.admit(1, 'old', [1], vi.fn())
    old.drain.begin(1, 'old', 1)
    installMcpReplyQuitGuard(app, {
      services: () => current,
      onQuitBlocked: vi.fn(),
      onQuitInterrupted: interrupted,
    })
    app.quit()
    old.drain.settle(ticket!)
    old.drain.emission(1, 'old', response(1))
    old.drain.finished(ticket!)
    await tick()
    expect(app.exits).toBe(1)
    expect(interrupted).not.toHaveBeenCalled()
  })
  it('surfaces an invalidated configuration intent instead of stranding a hidden process', async () => {
    const f = fixture(),
      app = new App(),
      interrupted = vi.fn()
    let epoch = 1
    const [ticket] = f.drain.admit(1, 'A', [1], vi.fn())
    f.drain.begin(1, 'A', 1)
    installMcpReplyQuitGuard(app, {
      services: () => [f.service],
      epoch: () => epoch,
      onQuitBlocked: vi.fn(),
      onQuitInterrupted: interrupted,
    })
    app.quit()
    epoch++
    f.drain.settle(ticket!)
    await tick()
    expect(app.exits).toBe(0)
    expect(interrupted).toHaveBeenCalledTimes(1)
    expect(f.drain.status()).toMatchObject({ draining: false, owned: 1, pendingReplies: 1 })
    f.drain.emission(1, 'A', response(1))
    f.drain.finished(ticket!)
  })
})
