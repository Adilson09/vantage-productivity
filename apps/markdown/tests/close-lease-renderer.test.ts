// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, Node } from '@tiptap/core'
import { CloseLeaseBroker } from '../../../packages/electron-utils/src/close-lease'
import { CloseMutationBarrier } from '../../../packages/electron-utils/src/renderer-close-barrier'
import { MarkdownCloseTransactionGuard } from '../src/renderer/editor/close-lease-guard'
import {
  bindMarkdownCloseBarrier,
  beforeMarkdownMutation,
  flushMarkdownPendingSurfaces,
  registerMarkdownPendingSurface,
  runMarkdownAsyncMutation,
} from '../src/renderer/close-lease'
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  let source = 'renderer:1'
  const cancellation = deferred(),
    releases: Array<() => void> = []
  let barrier: CloseMutationBarrier
  const broker = new CloseLeaseBroker<number>({
    alive: () => true,
    source: () => source,
    release: (_owner, ticket) => {
      releases.push(() => barrier.release(ticket))
    },
  })
  barrier = new CloseMutationBarrier({
    source: () => source,
    claim: async (ticket) => broker.claim(1, ticket),
    cancel: async (ticket) => {
      broker.cancel(1, ticket)
      await cancellation.promise
    },
    report: (error) => {
      throw error
    },
  })
  const unbind = bindMarkdownCloseBarrier({ barrier, publish: () => {}, alive: () => true })
  disposers.push(unbind)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Node.create({ name: 'doc', topNode: true, content: 'paragraph+' }),
      Node.create({
        name: 'paragraph',
        group: 'block',
        content: 'text*',
        parseHTML: () => [{ tag: 'p' }],
        renderHTML: () => ['p', 0],
      }),
      Node.create({ name: 'text', group: 'inline' }),
      MarkdownCloseTransactionGuard,
    ],
    content: '<p>alpha</p>',
  })
  disposers.push(() => editor.destroy())
  const lock = barrier.registerLock(() => {
    const editable = editor.isEditable
    editor.setEditable(false, false)
    return () => {
      if (!editor.isDestroyed) editor.setEditable(editable, false)
    }
  })
  disposers.push(lock)
  disposers.push(() => broker.destroy(1))
  return {
    barrier,
    broker,
    editor,
    cancellation,
    releases,
    replace() {
      source = 'renderer:2'
    },
    async acquire() {
      const ticket = broker.reserve(1, crypto.randomUUID()),
        stamp = await barrier.acquire(ticket, () => true)
      broker.settle(1, ticket)
      expect(stamp).not.toBeNull()
      expect(broker.ready(1, ticket, stamp!)).toBe(true)
      return { ticket, stamp: stamp! }
    },
  }
}
describe('Markdown actual transaction and pending-work close barriers', () => {
  it('defers a real programmatic document transaction until main invalidation and browser release', async () => {
    const f = fixture(),
      lease = await f.acquire()
    expect(f.editor.isEditable).toBe(false)
    f.editor.commands.insertContent('beta')
    expect(f.editor.getText()).toBe('alpha')
    expect(
      f.broker.complete(1, lease.ticket, lease.stamp, () => {
        throw Error('must not remove')
      }),
    ).toBe(false)
    expect(f.editor.isEditable).toBe(false)
    f.cancellation.resolve()
    await vi.waitFor(() => expect(f.editor.getText()).toContain('beta'))
    expect(f.editor.isEditable).toBe(true)
  })
  it('does not let an old release unlock a newer editor lease', async () => {
    const f = fixture(),
      old = await f.acquire()
    f.broker.cancel(1, old.ticket)
    f.releases.splice(0).forEach((release) => release())
    const current = await f.acquire()
    f.barrier.release(old.ticket)
    expect(f.barrier.locked).toBe(true)
    expect(f.editor.isEditable).toBe(false)
    f.broker.cancel(1, current.ticket)
    f.releases.splice(0).forEach((release) => release())
  })
  it('tracks the complete asynchronous asset lifetime and refuses close while it is pending', async () => {
    const f = fixture(),
      asset = deferred(),
      writing = runMarkdownAsyncMutation(async (source) => {
        await asset.promise
        await beforeMarkdownMutation(source)
        f.editor.commands.insertContent('asset')
      })
    await Promise.resolve()
    expect(f.barrier.busy).toBe(true)
    const ticket = f.broker.reserve(1, crypto.randomUUID())
    const acquiring = f.barrier.acquire(ticket, () => true)
    f.cancellation.resolve()
    expect(await acquiring).toBeNull()
    asset.resolve()
    await writing
    expect(f.editor.getText()).toContain('asset')
  })
  it('rejects a late asynchronous writer after source replacement', async () => {
    const f = fixture(),
      asset = deferred(),
      writing = runMarkdownAsyncMutation(async (source) => {
        await asset.promise
        await beforeMarkdownMutation(source)
        f.editor.commands.insertContent('wrong source')
      })
    await Promise.resolve()
    f.replace()
    asset.resolve()
    await expect(writing).rejects.toThrow('document changed')
    expect(f.editor.getText()).toBe('alpha')
  })
  it('retains an unfinished IME/math field without a blur or a destructive flush', () => {
    fixture()
    let draft = '\\frac{unfinished',
      composing = true
    const flush = vi.fn(() => {
        draft = ''
        return true
      }),
      dispose = registerMarkdownPendingSurface({
        pending: () => draft !== '',
        composing: () => composing,
        flush,
      })
    disposers.push(dispose)
    expect(flushMarkdownPendingSurfaces()).toBe(false)
    expect(flush).not.toHaveBeenCalled()
    expect(draft).toContain('unfinished')
    composing = false
    expect(flushMarkdownPendingSurfaces()).toBe(true)
  })
})
