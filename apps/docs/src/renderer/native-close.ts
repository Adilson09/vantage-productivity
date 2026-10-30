import { isCloseLeaseStamp, isCloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
import type { DocNativeCloseRequest, DocNativeCloseResult } from '../shared/ipc'
import { docCloseBarrier, releaseDocCloseAfterFailure } from './doc-close-lease'
import { canDiscardCurrentDocument, canCloseSavedDocument, currentDocGeneration, currentRecoverySequence, save, type FileActionContext } from './file-actions'
import { saveUntilPersisted } from './save-until-persisted'

/** Save publication is separate from held permission for a later synchronous removal. */
export async function prepareDocRendererClose(
  getContext: () => FileActionContext,
  request: DocNativeCloseRequest,
): Promise<DocNativeCloseResult> {
  const generation = currentDocGeneration()
  const before = docCloseBarrier.snapshot()
  let published = false
  const current = () => currentDocGeneration() === generation && docCloseBarrier.snapshot().source === before.source
  const failed = (): DocNativeCloseResult => ({ throughSequence:currentRecoverySequence(),published, current: current(), clean: false, intent: request.intent })
  if (!isCloseLeaseTicket(request.ticket) || !['save', 'discard'].includes(request.intent))
    throw new Error('The native close request is invalid.')
  const ticket = request.ticket
  try {
    const ctx = getContext()
    if (!ctx.doc || !ctx.editor || (ctx.doc.filePath ?? null) !== request.sourcePath) {
      await releaseDocCloseAfterFailure(ticket)
      return failed()
    }
    if (request.intent === 'discard') {
      const approved = request.approvedStamp
      const matches = () => {
        const live = docCloseBarrier.snapshot()
        return current() && canDiscardCurrentDocument(getContext(), generation) && isCloseLeaseStamp(approved) && live.source === approved.source && live.revision === approved.revision
      }
      // Pending surfaces are intentionally discarded, not committed into a new
      // revision after the user's exact approval. Busy async authors refuse it.
      if (!matches()) { await releaseDocCloseAfterFailure(ticket); return failed() }
      const stamp = await docCloseBarrier.acquire(ticket, matches)
      if (!stamp) return failed()
      // If another prompt vetoes a whole-window close or main expires this
      // permission, the live authored state still needs crash recovery. Actual
      // removal destroys its owner before a release message can run here.
      return { throughSequence:currentRecoverySequence(),published, current: true, clean: false, intent: request.intent, closeLease: { ticket, stamp } }
    }
    if (docCloseBarrier.busy) { await releaseDocCloseAfterFailure(ticket); return failed() }
    // Commit registered table/textbox/header/footer editors before the first
    // save. Their writes use the same canonical sidecar/model barriers.
    window.dispatchEvent(new Event('ai-docs-commit-tables'))
    const canClose = () => current() && canCloseSavedDocument(getContext(), generation)
    const complete = canClose() || await saveUntilPersisted({
      save: async () => { const result = await save(getContext(), false, false, undefined, undefined, ticket); published ||= result; return result },
      wasIncomplete: () => getContext().saveIncompleteRef.current,
      hasPath: () => true,
      isCurrent: current,
      canClose,
    })
    if (!complete || !current()) { await releaseDocCloseAfterFailure(ticket); return failed() }
    const stamp = await docCloseBarrier.acquire(ticket, canClose)
    if (!stamp || !canClose()) { await releaseDocCloseAfterFailure(ticket); return failed() }
    return { throughSequence:currentRecoverySequence(),published, current: true, clean: true, intent: request.intent, closeLease: { ticket, stamp } }
  } catch (error) {
    await releaseDocCloseAfterFailure(ticket)
    throw error
  }
}

