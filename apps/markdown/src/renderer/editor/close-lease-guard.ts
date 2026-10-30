import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { markdownCloseLocked, markdownCloseStamp, mutateMarkdown, noteMarkdownAuthoredMutation } from '../close-lease'
/** Covers direct tools, node views, undo/redo and synthetic/programmatic document transactions. */
export const MarkdownCloseTransactionGuard = Extension.create({
  name:'markdownCloseTransactionGuard', priority:10000,
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({ key:new PluginKey('markdownCloseTransactionGuard'), filterTransaction(transaction) {
      if (!transaction.docChanged) return true
      if (!markdownCloseLocked()) return noteMarkdownAuthoredMutation()
      const source = markdownCloseStamp().source, before = transaction.before
      mutateMarkdown(() => {
        if (editor.isDestroyed) throw new Error('The editor closed before its pending transaction could be applied.')
        if (!editor.state.doc.eq(before)) throw new Error('A pending programmatic edit could not be rebased after close cancellation; retry that edit.')
        editor.view.dispatch(transaction)
      }, source)
      return false
    } })]
  },
})
