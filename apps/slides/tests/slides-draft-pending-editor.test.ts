import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShapeRenderNode } from '@vantage/pptx-render'
import { TextEditOverlay } from '../src/renderer/TextEditOverlay'
import {
  captureSlidesPendingText,
  flushSlidesPendingEditor,
} from '../src/renderer/slides-pending-edit'
import type { SlidesPendingTarget } from '../src/shared/slides-draft'

const roots: Array<{ root: Root; container: HTMLElement }> = []
const node = {
  type: 'text',
  sourceId: 'e_1',
  box: { x: 0, y: 0, w: 300, h: 120 },
} as ShapeRenderNode
const target = { kind: 'text' as const, slideIndex: 0, sourceId: 'e_1' }
function mount(recoveryTarget: SlidesPendingTarget = target, onCommit = vi.fn(async () => {})) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      createElement(TextEditOverlay, {
        node,
        scale: 1,
        recoveryTarget,
        onCommit,
        onCancel: vi.fn(),
      }),
    ),
  )
  const owned = { root, container }
  roots.push(owned)
  const editor = container.querySelector('.slide-text-editor') as HTMLElement
  return { ...owned, editor, onCommit }
}
function type(editor: HTMLElement, value: string) {
  editor.textContent = value
  act(() => {
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
}
afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('noncommitting presentation editor capture', () => {
  it('captures a still-focused text editor without blur, commit or selection changes', () => {
    const f = mount()
    type(f.editor, 'uncommitted visible words')
    const range = document.createRange()
    range.selectNodeContents(f.editor)
    range.collapse(false)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const captured = captureSlidesPendingText()
    expect(captured.text).toMatchObject(target)
    expect(JSON.stringify(captured.text)).toContain('uncommitted visible words')
    expect(f.onCommit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(f.editor)
    expect(window.getSelection()!.getRangeAt(0).startContainer).toBe(range.startContainer)
  })
  it('captures rich table cell text and its row/column identity', () => {
    const f = mount({ kind: 'table', slideIndex: 2, sourceId: 'table-1', row: 1, col: 2 })
    f.editor.innerHTML = '<div><span style="font-weight:bold">pending cell</span></div>'
    const captured = captureSlidesPendingText()
    expect(captured.text).toMatchObject({
      kind: 'table',
      slideIndex: 2,
      sourceId: 'table-1',
      row: 1,
      col: 2,
    })
    expect(JSON.stringify(captured.text)).toContain('pending cell')
    expect(JSON.stringify(captured.text)).toContain('"bold":true')
    expect(f.onCommit).not.toHaveBeenCalled()
  })
  it('keeps the active master/layout editor registered when a different overlay unmounts', () => {
    const normal = mount()
    const master = mount({
      kind: 'master',
      partPath: 'ppt/slideLayouts/slideLayout1.xml',
      sourceId: 'master-text',
    })
    type(master.editor, 'pending layout heading')
    act(() => normal.root.unmount())
    normal.container.remove()
    roots.splice(
      roots.findIndex(({ root }) => root === normal.root),
      1,
    )
    const captured = captureSlidesPendingText()
    expect(captured.text).toMatchObject({
      kind: 'master',
      partPath: 'ppt/slideLayouts/slideLayout1.xml',
      sourceId: 'master-text',
    })
    expect(JSON.stringify(captured.text)).toContain('pending layout heading')
  })
  it('a real save waits for the pending asynchronous commit instead of saving the older model', async () => {
    let done!: () => void
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve
        }),
    )
    const f = mount(target, onCommit)
    type(f.editor, 'waiting for IPC')
    let settled = false
    const saving = flushSlidesPendingEditor().then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    done()
    await saving
    expect(settled).toBe(true)
  })
  it('keeps failed edits available for recovery and a later successful retry', async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValueOnce(new Error('IPC refused'))
      .mockResolvedValue(undefined)
    const f = mount(target, onCommit)
    type(f.editor, 'kept after failed commit')
    await expect(flushSlidesPendingEditor()).rejects.toThrow('IPC refused')
    expect(JSON.stringify(captureSlidesPendingText().text)).toContain('kept after failed commit')
    await flushSlidesPendingEditor()
    expect(onCommit).toHaveBeenCalledTimes(2)
  })
  it('composition and oversized text refuse capture/save without erasing the visible editor', async () => {
    const f = mount()
    type(f.editor, '正在输入')
    act(() => {
      f.editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    expect(captureSlidesPendingText().composing).toBe(true)
    await expect(flushSlidesPendingEditor()).rejects.toThrow('Finish composing')
    expect(f.onCommit).not.toHaveBeenCalled()
    act(() => {
      f.editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    type(f.editor, 'x'.repeat(512 * 1024 + 1))
    expect(() => captureSlidesPendingText()).toThrow('recovery limit')
    expect(f.editor.textContent).toHaveLength(512 * 1024 + 1)
  })
})
