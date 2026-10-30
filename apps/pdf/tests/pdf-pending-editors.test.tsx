// @vitest-environment jsdom
import React, { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkDialog } from '../src/renderer/LinkDialog'
import { NoteMarginColumn } from '../src/renderer/NoteMargin'
import {
  clearPdfPendingEditors,
  pendingPdfEditors,
  restorePdfPendingEditors,
  usePdfEditorState,
  discardPdfPendingEditors,
  hasPdfPendingEditors,
} from '../src/renderer/pdf-draft'
import {
  configurePdfAuthoredBarrier,
  installPdfAuthoredSource,
  pdfAuthoredSource,
  readPdfAuthored,
  withPdfFileRewrite,
} from '../src/renderer/pdf-authored'
import { CloseMutationBarrier } from '@vantage/electron-utils/renderer-close-barrier'

let container: HTMLDivElement, root: Root
const t = ((key: string) => key) as ComponentProps<typeof LinkDialog>['t']
beforeEach(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  })
  clearPdfPendingEditors()
  configurePdfAuthoredBarrier(
    new CloseMutationBarrier({
      source: pdfAuthoredSource,
      claim: async () => true,
      cancel: async () => {},
      report: () => {},
    }),
  )
  installPdfAuthoredSource('source-A', () => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  clearPdfPendingEditors()
  vi.restoreAllMocks()
})
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
describe('real pending editor ownership', () => {
  it('keeps virtualized child text through unmount and remount until explicit discard', async () => {
    function Field() {
      const [value, set] = usePdfEditorState('form-date:f', 'date-field', '')
      return <input value={value} onChange={(event) => set(event.target.value)} />
    }
    await act(async () => root.render(<Field />))
    await act(async () => input(container.querySelector('input')!, '2026-10-'))
    await act(async () => root.render(null))
    expect(pendingPdfEditors()).toEqual([
      ['form-date:f', { kind: 'date-field', value: '2026-10-' }],
    ])
    await act(async () => root.render(<Field />))
    expect(container.querySelector('input')!.value).toBe('2026-10-')
    discardPdfPendingEditors({ id: 'form-date:f' })
    await act(async () => root.render(null))
    expect(hasPdfPendingEditors()).toBe(false)
    await act(async () => root.render(<Field />))
    expect(container.querySelector('input')!.value).toBe('')
    await act(async () => input(container.querySelector('input')!, 'new after discard'))
    expect(pendingPdfEditors()[0]![1].value).toBe('new after discard')
  })
  it('blocks authored setters throughout a held irreversible rewrite without replaying rejected text later', async () => {
    let set!: React.Dispatch<React.SetStateAction<string>>, release!: () => void
    function Field() {
      const [value, update] = usePdfEditorState('form-export:f', 'form-field', '')
      set = update
      return <input value={value} readOnly />
    }
    await act(async () => root.render(<Field />))
    const held = withPdfFileRewrite(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      'source-A',
    )
    await act(async () => set('typed behind redaction hold'))
    expect(readPdfAuthored('editor:form-export:f', '')).toBe('')
    release()
    await held
    expect(readPdfAuthored('editor:form-export:f', '')).toBe('')
    await act(async () => set('accepted after refused rewrite'))
    expect(readPdfAuthored('editor:form-export:f', '')).toBe('accepted after refused rewrite')
  })
  it("recovers a link target and keeps another source's late setter from changing it", async () => {
    let oldSetter!: React.Dispatch<React.SetStateAction<{ url: string; page: string }>>
    function Field() {
      const [value, set] = usePdfEditorState('link-target', 'link', { url: '', page: '' })
      if (pdfAuthoredSource() === 'source-A') oldSetter = set
      return (
        <input
          value={value.url}
          onChange={(event) => set((prior) => ({ ...prior, url: event.target.value }))}
        />
      )
    }
    await act(async () => root.render(<Field />))
    await act(async () => input(container.querySelector('input')!, 'https://first.example.test/'))
    expect(pendingPdfEditors()[0]![1].value).toEqual({
      url: 'https://first.example.test/',
      page: '',
    })
    installPdfAuthoredSource('source-B', () => {
      restorePdfPendingEditors([
        [
          'link-target',
          { kind: 'link', value: { url: 'https://restored.example.test/', page: '' } },
        ],
      ])
    })
    await act(async () => root.render(<Field />))
    await act(async () => oldSetter({ url: 'https://obsolete.example.test/', page: '' }))
    expect(container.querySelector('input')!.value).toBe('https://restored.example.test/')
    expect(pendingPdfEditors()[0]![1].value).toEqual({
      url: 'https://restored.example.test/',
      page: '',
    })
  })
  it('evaluates two functional edits exactly once against canonical truth before React projects', async () => {
    let update!: React.Dispatch<React.SetStateAction<string>>
    function Field() {
      const [value, set] = usePdfEditorState('form-export:f', 'form-field', '')
      update = set
      return <input value={value} readOnly />
    }
    await act(async () => root.render(<Field />))
    let evaluated = 0
    await act(async () => {
      update((value) => {
        evaluated++
        return value + 'A'
      })
      update((value) => {
        evaluated++
        return value + 'B'
      })
      expect(readPdfAuthored('editor:form-export:f', '')).toBe('AB')
    })
    expect(evaluated).toBe(2)
    expect(pendingPdfEditors()[0]![1].value).toBe('AB')
  })
  it('preserves a rejected reply and clears only an accepted reply', async () => {
    let accepted = false
    const committed: string[] = []
    function Margin() {
      const [replies, setReplies] = useState(new Map([['Pthread', 'Reply still typing']]))
      return (
        <NoteMarginColumn
          newBody=""
          createdMs={1700000000000}
          replies={replies}
          onNewBody={() => {}}
          onReplyChange={(id, text) => setReplies((previous) => new Map(previous).set(id, text))}
          width={260}
          draft={null}
          activeKey="Pthread"
          author="Local author"
          lang="en"
          readOnly={false}
          t={t}
          threads={[
            {
              origIdx: 0,
              pinX: -10,
              pinY: 10,
              root: {
                key: 'Pthread',
                pendingId: 'thread',
                saved: null,
                author: 'Local author',
                contents: 'Original thread',
                timeMs: 1700000000000,
                color: null,
                at: [10, 20],
                replies: [],
              },
            },
          ]}
          onActivate={() => {}}
          onReply={(_thread, text) => {
            if (accepted) committed.push(text)
            return accepted
          }}
          editingKey={null}
          editingText=""
          onEditStart={() => {}}
          onEditChange={() => {}}
          onEditCancel={() => {}}
          onEditSubmit={() => {}}
          onDeleteItem={() => {}}
          onClose={() => {}}
          onDraftConfirm={() => {}}
          onDraftCancel={() => {}}
        />
      )
    }
    await act(async () => root.render(<Margin />))
    const area = container.querySelector<HTMLTextAreaElement>('.pdf-note-reply-box textarea')!
    await act(async () =>
      area.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      ),
    )
    expect(area.value).toBe('Reply still typing')
    expect(committed).toEqual([])
    accepted = true
    await act(async () =>
      area.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      ),
    )
    expect(area.value).toBe('')
    expect(committed).toEqual(['Reply still typing'])
  })
  it('restores an unsubmitted URL in the actual link dialog without submitting it', async () => {
    const apply = vi.fn()
    restorePdfPendingEditors([
      [
        'link-target',
        { kind: 'link', value: { url: 'https://example.test/private-draft', page: '' } },
      ],
    ])
    await act(async () =>
      root.render(<LinkDialog t={t} pageCount={2} onCancel={() => {}} onApply={apply} />),
    )
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe(
      'https://example.test/private-draft',
    )
    expect(apply).not.toHaveBeenCalled()
    expect(pendingPdfEditors()[0]![1].value).toEqual({
      url: 'https://example.test/private-draft',
      page: '',
    })
  })
})
