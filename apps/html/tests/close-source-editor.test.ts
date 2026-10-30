// @vitest-environment jsdom
import { createElement, createRef, act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import { CloseMutationBarrier } from '../../../packages/electron-utils/src/renderer-close-barrier'
import { bindHtmlCloseBarrier } from '../src/renderer/close-lease'
import { SourceEditor, type SourceEditorHandle } from '../src/renderer/source/SourceEditor'
it('keeps real CodeMirror programmatic source replacement behind main cancel acknowledgment', async () => {
  let cancel!: () => void
  const cancellation = new Promise<void>((done) => {
      cancel = done
    }),
    barrier = new CloseMutationBarrier({
      source: () => 'html:1',
      claim: async () => true,
      cancel: async () => cancellation,
      report: (error) => {
        throw error
      },
    }),
    unbind = bindHtmlCloseBarrier({ barrier, publish: () => {}, alive: () => true })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host),
    ref = createRef<SourceEditorHandle>(),
    changed = vi.fn()
  try {
    await act(async () =>
      root.render(
        createElement(SourceEditor, {
          ref,
          initialText: '<p>alpha</p>',
          onChange: changed,
          onCursor: () => {},
        }),
      ),
    )
    const ticket = { id: 'lease', sequence: 1, source: 'main-session' }
    expect(await barrier.acquire(ticket, () => true)).not.toBeNull()
    ref.current!.replaceDoc('<p>beta</p>', false)
    expect(ref.current!.recoveryState()?.text).toBe('<p>alpha</p>')
    expect(barrier.locked).toBe(true)
    cancel()
    await vi.waitFor(() => expect(ref.current!.recoveryState()?.text).toBe('<p>beta</p>'))
    expect(barrier.locked).toBe(false)
    expect(changed).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    unbind()
  }
})
