import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Schema } from '@tiptap/pm/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommentsPanel } from '../src/renderer/components/CommentsPanel'
import {
  adoptCommentDraftRecovery,
  commentDraftSnapshot,
  noteCommentDraftRecorded,
  putCommentDraft,
} from '../src/renderer/comment-draft-recovery'
import { setDocCloseSourceReader } from '../src/renderer/doc-close-lease'
import { editComment, type ReviewContext } from '../src/renderer/review-actions'
import type { CommentInfo } from '@vantage/docx-engine'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
  marks: { comment: { attrs: { ids: { default: '' } }, toDOM: () => ['span', 0] } },
})
const doc = schema.node('doc', null, [
  schema.node('paragraph', null, [
    schema.text('Selected text', [schema.mark('comment', { ids: '7' })]),
  ]),
])
let root: Root,
  host: HTMLDivElement,
  source = 0
beforeEach(() => {
  setDocCloseSourceReader(() => String(source))
  source++
  adoptCommentDraftRecovery()
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
function restored(kind: 'new' | 'reply' | 'edit', id = 'draft') {
  adoptCommentDraftRecovery({
    version: 1,
    drafts: [
      {
        id,
        kind,
        text: 'Unsent private text',
        target: {
          id: 'missing',
          parentId: null,
          author: 'Old',
          date: 'old',
          text: 'Old published text',
          anchor: 'Old anchor',
        },
      },
    ],
  })
}
function props() {
  return {
    comments: [{ id: '7', text: 'Current thread', author: 'Author', date: '2026-10-30' }],
    docNode: doc,
    composing: false,
    onSubmitNew: vi.fn(() => true),
    onReply: vi.fn(() => false),
    onEdit: vi.fn(() => false),
    onResolve: vi.fn(),
    onCancelNew: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    selectionAnchor: () => undefined,
  }
}
async function mount(p: ReturnType<typeof props>) {
  await act(async () => root.render(createElement(CommentsPanel, p)))
}
describe('actual unsent comment recovery pane', () => {
  it('restores inert text visibly without calling any published-comment action', async () => {
    restored('reply')
    const p = props()
    await mount(p)
    expect(host.textContent).toContain('Recovered unsent draft')
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Unsent private text',
    )
    expect(p.onReply).not.toHaveBeenCalled()
    expect(p.onEdit).not.toHaveBeenCalled()
    expect(p.onSubmitNew).not.toHaveBeenCalled()
  })
  it('requires an explicit current target and retains text when the chosen action fails', async () => {
    restored('reply')
    const p = props()
    await mount(p)
    const select = host.querySelector('select')!,
      button = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Post reply to chosen thread',
      )!
    expect(button.disabled).toBe(true)
    await act(async () => {
      select.value = '7'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => button.click())
    expect(p.onReply).toHaveBeenCalledTimes(1)
    expect(commentDraftSnapshot().drafts[0].text).toBe('Unsent private text')
  })
  it('keeps a missing new-comment anchor visible and never substitutes another range', async () => {
    restored('new')
    const p = props()
    await mount(p)
    const button = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Post to selected text',
    )!
    await act(async () => button.click())
    expect(p.onSubmitNew).not.toHaveBeenCalled()
    expect(commentDraftSnapshot().drafts).toHaveLength(1)
    expect(host.textContent).toContain('Select the text')
  })
  it('makes an old source button harmless after model adoption switches to B', async () => {
    restored('new')
    const p = props()
    await mount(p)
    const button = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Discard draft',
    )!
    await act(async () => {
      source++
      adoptCommentDraftRecovery({ version: 1, drafts: [{ id: 'B', kind: 'new', text: 'B text' }] })
      button.click()
    })
    expect(commentDraftSnapshot().drafts[0].text).toBe('B text')
    expect(p.onSubmitNew).not.toHaveBeenCalled()
  })
  it('never lets a source-A recording acknowledgment clear source-B unsent changes', () => {
    restored('new')
    const old = commentDraftSnapshot()
    source++
    adoptCommentDraftRecovery()
    const next = commentDraftSnapshot()
    putCommentDraft(next.source, { id: 'new', kind: 'new', text: 'B remains pending' })
    noteCommentDraftRecorded(old.source, old.revision)
    expect(commentDraftSnapshot().recordedRevision).toBe(0)
    expect(commentDraftSnapshot().drafts[0].text).toBe('B remains pending')
  })
  it('edits an imported reply using its existing parent anchor without inventing a reply range', () => {
    let comments: CommentInfo[] = [
      { id: '7', author: 'A', text: 'Parent' },
      { id: '8', author: 'B', parentId: '7', text: 'Original reply' },
    ]
    const context = {
      editor: { state: { doc } },
      get comments() {
        return comments
      },
      dirtyRef: { current: false },
      setComments: (update: Parameters<ReviewContext['setComments']>[0]) => {
        comments = typeof update === 'function' ? update(comments) : update
      },
      setCommentsDirty: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as ReviewContext
    expect(editComment(context, '8', 'Explicit replacement')).toBe(true)
    expect(comments.find((comment) => comment.id === '8')?.text).toBe('Explicit replacement')
    expect(editComment(context, 'missing', 'Wrong fallback')).toBe(false)
  })
})
