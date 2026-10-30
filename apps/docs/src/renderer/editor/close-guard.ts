import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { docCloseBarrier, docMutationSource, reportDocCloseError, isDocAuthoringActive } from '../doc-close-lease'

/** Included in the main, textbox/cell and header/footer extension sets. */
export const DocCloseGuard = Extension.create({
  name: 'docCloseGuard',
  addStorage() { return { unregister: null as (() => void) | null } },
  onCreate() {
    const editor = this.editor
    this.storage.unregister = docCloseBarrier.registerLock(() => {
      const editable = editor.isEditable
      if (!editor.isDestroyed) editor.setEditable(false, false)
      return () => { if (!editor.isDestroyed) editor.setEditable(editable, false) }
    })
  },
  onDestroy() { this.storage.unregister?.() },
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({
      filterTransaction(transaction) {
        if (!isDocAuthoringActive()) return false
        if (!transaction.docChanged) return true
        if (!docCloseBarrier.locked) {
          docCloseBarrier.mutate(() => {})
          return true
        }
        const source = docMutationSource()
        docCloseBarrier.mutate(() => {
          if (editor.isDestroyed) return
          if (editor.state.doc !== transaction.before) {
            reportDocCloseError(new Error('A pending document transaction conflicted after close cancellation; it was not applied.'))
            return
          }
          editor.view.dispatch(transaction)
        }, source)
        return false
      },
    })]
  },
})
