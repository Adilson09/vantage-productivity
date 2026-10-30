import { describe, expect, it, vi } from 'vitest'
import {
  prepareAndApplyHtmlReload,
  type HtmlReloadLiveState,
} from '../src/renderer/document/html-reload-controller'
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const live = (): HtmlReloadLiveState => ({
  token: 'same-document',
  activation: 4,
  revision: 12,
  text: 'current text',
  savedText: 'saved text',
  sourceText: 'current text',
  sourceComposing: false,
  composing: false,
  panelPending: true,
  visualPending: false,
  stylesPending: false,
  path: 'C:/docs/page.html',
  highestSequence: 7,
  ready: true,
  pendingSignature: 'pending CSS field before Reload',
})
describe('same-path HTML Reload final source guard', () => {
  it('retains typing added during the bounded read instead of replacing source', async () => {
    const before = live(),
      current = { ...before },
      read = deferred<string>(),
      apply = vi.fn()
    const pending = prepareAndApplyHtmlReload(
      before,
      () => read.promise,
      () => current,
      apply,
    )
    current.revision++
    current.text = 'new typing'
    current.sourceText = current.text
    read.resolve('disk source')
    expect(await pending).toBe(false)
    expect(apply).not.toHaveBeenCalled()
    expect(current.text).toBe('new typing')
  })
  it('does not apply an obsolete activation that completed while asynchronous preparation awaited', async () => {
    const before = live(),
      current = { ...before },
      read = deferred<string>(),
      apply = vi.fn(),
      pending = prepareAndApplyHtmlReload(
        before,
        () => read.promise,
        () => current,
        apply,
      )
    current.activation++
    current.token = 'replacement-document'
    read.resolve('old disk source')
    expect(await pending).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })
  it.each(['composing', 'sourceComposing'] as const)(
    'retains source when %s starts during the read',
    async (field) => {
      const before = live(),
        current = { ...before },
        read = deferred<string>(),
        apply = vi.fn(),
        pending = prepareAndApplyHtmlReload(
          before,
          () => read.promise,
          () => current,
          apply,
        )
      current[field] = true
      read.resolve('disk source')
      expect(await pending).toBe(false)
      expect(apply).not.toHaveBeenCalled()
    },
  )
  it('retains pending style changes even if a delayed change notification has not advanced revision', async () => {
    const before = live(),
      current = { ...before },
      read = deferred<string>(),
      apply = vi.fn(),
      pending = prepareAndApplyHtmlReload(
        before,
        () => read.promise,
        () => current,
        apply,
      )
    current.pendingSignature = 'new pending CSS input'
    read.resolve('disk source')
    expect(await pending).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })
  it('uses every old snapshot sequence allocated during preparation and applies without an activation await', async () => {
    const before = live(),
      current = { ...before },
      read = deferred<string>(),
      apply = vi.fn(),
      pending = prepareAndApplyHtmlReload(
        before,
        () => read.promise,
        () => current,
        apply,
      )
    current.highestSequence = 10
    read.resolve('validated disk source')
    expect(await pending).toBe(true)
    expect(apply).toHaveBeenCalledExactlyOnceWith('validated disk source', {
      token: 'same-document',
      documentPath: 'C:/docs/page.html',
      previousRevision: 12,
      revision: 13,
      throughSequence: 10,
    })
    expect(current.highestSequence).toBe(10)
  })
  it('preserves source on failed validation and defers composition/saving before starting read', async () => {
    const before = live(),
      read = vi.fn(async () => {
        throw new Error('invalid UTF-8')
      }),
      apply = vi.fn()
    await expect(prepareAndApplyHtmlReload(before, read, () => before, apply)).rejects.toThrow(
      'invalid UTF-8',
    )
    expect(apply).not.toHaveBeenCalled()
    const unavailable = { ...before, ready: false }
    read.mockClear()
    await expect(
      prepareAndApplyHtmlReload(unavailable, read, () => unavailable, apply),
    ).rejects.toThrow(/unavailable/)
    expect(read).not.toHaveBeenCalled()
  })
})
