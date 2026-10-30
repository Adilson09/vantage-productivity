import type { WorkbookCloseCheckpointBinding } from '../shared/desktop-api'
import type { DocumentCheckpointReceipt } from '../shared/document-checkpoint'
import { hashWorkbookDocumentPayload } from '../shared/document-payload-canonical'
import { collectWorkbookDocumentPayload, type SaveContext } from './save-actions'
import { stageEditsForSave, abortStagedEditsTransfer } from './save-edits-staging'

/** Force a complete checkpoint directly; never schedules or relies on the ordinary timer. */
export async function checkpointWorkbookForClose(
  context: SaveContext,
  binding?: WorkbookCloseCheckpointBinding,
): Promise<{ payloadSha256: string; receipt: DocumentCheckpointReceipt }> {
  const snapshot = collectWorkbookDocumentPayload(context)
  const fingerprint = await hashWorkbookDocumentPayload(snapshot.payload)
  if (context.lazyWorkbookRef.current !== snapshot.state)
    throw new Error('The spreadsheet changed before its full checkpoint was staged.')
  if (binding && binding.payloadSha256 !== fingerprint.sha256)
    throw new Error('The locked full spreadsheet payload changed before its checkpoint.')
  const staged = await stageEditsForSave(
    window.desktopApi,
    snapshot.state.file.sessionId,
    snapshot.payload.edits,
  )
  try {
    if (context.lazyWorkbookRef.current !== snapshot.state)
      throw new Error('The spreadsheet changed while its full checkpoint was staged.')
    const receipt = await window.desktopApi.checkpointWorkbookDocument(
      {
        ...snapshot.payload,
        edits: staged.edits,
        ...(staged.editsTransferId ? { editsTransferId: staged.editsTransferId } : {}),
      },
      snapshot.dirtyAtSnapshot,
      binding,
      context.writeContext ?? { origin: binding ? 'close' : 'manual' },
    )
    if (context.lazyWorkbookRef.current !== snapshot.state)
      throw new Error('The spreadsheet changed while its full checkpoint was acknowledged.')
    return { payloadSha256: fingerprint.sha256, receipt }
  } catch (error) {
    await abortStagedEditsTransfer(
      window.desktopApi,
      snapshot.state.file.sessionId,
      staged.editsTransferId,
    )
    throw error
  }
}
