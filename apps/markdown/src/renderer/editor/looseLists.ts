import type { JSONContent, MarkdownParseHelpers, MarkdownToken, Node } from '@tiptap/core'
import { BulletList, OrderedList, TaskList } from '@tiptap/extension-list'
import { renderList } from './markdownStyleRenderers'

/**
 * Whether the list had blank lines between its items or blocks. HTML cannot
 * say, so the attribute is read off the markdown at parse time and only the
 * serializer looks at it (see renderList / renderItem).
 */
const FENCE = /^ *(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n *\1[`~]* *$/gm

function isLoose(token: MarkdownToken): boolean {
  if (typeof token.loose === 'boolean') return token.loose
  // the ordered / task list tokenizers do not compute it; blank lines inside a fence do not count
  return /\n[ \t]*\n[ \t]*\S/.test(
    String(token.raw ?? '')
      .replace(FENCE, 'fence')
      .trimEnd(),
  )
}

/** Upstream ordered-list parsing can emit an empty listItem or start it with
 * a nested block. The schema requires a paragraph first, even for a bare
 * `1.` placeholder. Keep all parsed blocks and supply only that required node.
 */
function withRequiredListParagraph(node: JSONContent): JSONContent {
  let content = node.content?.map(withRequiredListParagraph)
  if ((node.type === 'listItem' || node.type === 'taskItem') && content?.[0]?.type !== 'paragraph')
    content = [{ type: 'paragraph' }, ...(content ?? [])]
  return content ? { ...node, content } : node
}

function withLoose(list: Node): Node {
  const base = list.config.parseMarkdown!
  return list.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        loose: { default: false, rendered: false, parseHTML: () => false },
      }
    },
    parseMarkdown: (token: MarkdownToken, h: MarkdownParseHelpers) => {
      const out = base(token, h) as JSONContent | JSONContent[]
      if (Array.isArray(out)) return out.map(withRequiredListParagraph)
      const valid = withRequiredListParagraph(out)
      return { ...valid, attrs: { ...valid.attrs, loose: isLoose(token) } }
    },
    renderMarkdown: renderList,
  })
}

export const LooseBulletList = withLoose(BulletList)
export const LooseOrderedList = withLoose(OrderedList)
export const LooseTaskList = withLoose(TaskList)
