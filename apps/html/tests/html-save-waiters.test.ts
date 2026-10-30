// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { HtmlSaveWaiters } from '../src/main/html-save-waiters'
function deferred() {
  let resolve!: (clean: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe('HTML final renderer Save request waiters', () => {
  it('returns physical write success without settling close until the deferred clean renderer acknowledgment', async () => {
    const waiters = new HtmlSaveWaiters(),
      finish = vi.fn(),
      id = waiters.start(1, 'activation', finish),
      ack = deferred()
    waiters.writeResult(1, id, 'activation', true)
    expect(finish).not.toHaveBeenCalled()
    expect(waiters.matches(1, id, 'activation')).toBe(true)
    const final = ack.promise.then((clean) => waiters.finish(1, id, 'activation', clean))
    ack.resolve(true)
    await final
    expect(finish).toHaveBeenCalledExactlyOnceWith(true)
    expect(waiters.matches(1, id, 'activation')).toBe(false)
  })
  it('refuses close if typing or pending style state makes the final renderer acknowledgment dirty', async () => {
    const waiters = new HtmlSaveWaiters(),
      finish = vi.fn(),
      id = waiters.start(1, 'activation', finish),
      ack = deferred()
    waiters.writeResult(1, id, 'activation', true)
    const final = ack.promise.then((clean) => waiters.finish(1, id, 'activation', clean))
    ack.resolve(false)
    await final
    expect(finish).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('rejects obsolete source acknowledgments and never publishes success for a replacement activation', () => {
    const waiters = new HtmlSaveWaiters(),
      finish = vi.fn(),
      id = waiters.start(1, 'before', finish)
    expect(waiters.finish(1, id, 'replacement', true)).toBe(true)
    expect(finish).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('ignores late and cross-sender acknowledgments for replacement requests', () => {
    const waiters = new HtmlSaveWaiters(),
      old = vi.fn(),
      current = vi.fn(),
      oldId = waiters.start(1, 'activation', old),
      currentId = waiters.start(1, 'activation', current)
    expect(old).toHaveBeenCalledExactlyOnceWith(false)
    expect(waiters.finish(1, oldId, 'activation', true)).toBe(false)
    expect(waiters.finish(2, currentId, 'activation', true)).toBe(false)
    expect(current).not.toHaveBeenCalled()
    expect(waiters.finish(1, currentId, 'activation', true)).toBe(true)
    expect(current).toHaveBeenCalledExactlyOnceWith(true)
  })
  it('owns unattended destinations per request instead of rebinding the document before publication', () => {
    const waiters = new HtmlSaveWaiters(),
      finish = vi.fn(),
      id = waiters.start(1, 'activation', finish, 'requested-copy.html')
    expect(waiters.targetFor(1, id, 'activation')).toBe('requested-copy.html')
    expect(waiters.targetFor(1, undefined, 'activation')).toBeUndefined()
    expect(waiters.targetFor(2, id, 'activation')).toBeUndefined()
    expect(waiters.targetFor(1, id, 'different')).toBeUndefined()
    waiters.cancelOwner(1)
    expect(finish).toHaveBeenCalledExactlyOnceWith(false)
    expect(waiters.targetFor(1, id, 'activation')).toBeUndefined()
  })
  it('settles write error/cancel immediately and ignores late success after destruction', () => {
    const waiters = new HtmlSaveWaiters(),
      error = vi.fn(),
      id = waiters.start(1, 'activation', error)
    waiters.writeResult(1, id, 'activation', false)
    expect(error).toHaveBeenCalledExactlyOnceWith(false)
    expect(waiters.finish(1, id, 'activation', true)).toBe(false)
    const closed = vi.fn(),
      closedId = waiters.start(1, 'activation', closed)
    waiters.cancelOwner(1)
    expect(closed).toHaveBeenCalledExactlyOnceWith(false)
    expect(waiters.finish(1, closedId, 'activation', true)).toBe(false)
  })
  it('expires the owned request and rejects a late acknowledgment without affecting the next request', async () => {
    const waiters = new HtmlSaveWaiters(20),
      expired = deferred(),
      id = waiters.start(1, 'activation', expired.resolve)
    expect(await expired.promise).toBe(false)
    const next = vi.fn(),
      nextId = waiters.start(1, 'activation', next)
    expect(waiters.finish(1, id, 'activation', true)).toBe(false)
    expect(next).not.toHaveBeenCalled()
    waiters.finish(1, nextId, 'activation', true)
    expect(next).toHaveBeenCalledExactlyOnceWith(true)
  })
})
