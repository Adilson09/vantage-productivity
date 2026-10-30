import { pdfCloseOptionsCurrent, type PdfCloseOptions } from './pdf-close'
import type { PdfCloseIntent, PdfCloseReceipt, PdfCloseState } from '../shared/pdf-workspace'
import type { CloseLeaseStamp } from '@vantage/electron-utils/close-lease'
import type { NativeClosePromptHold } from '@vantage/electron-utils/native-close-admission'

/** Real native-flow orchestration, injected only to keep OS dialogs out of unit
 * tests. Query/dialog completion is NOT authority to start a late Save. */
export async function preparePdfNativeCloseFlow(
  dependencies: {
    alive(): boolean
    source(): string
    hold(): NativeClosePromptHold | null
    query(options: PdfCloseOptions): Promise<PdfCloseState>
    prompt(): Promise<number>
    prepare(
      intent: PdfCloseIntent,
      approved: CloseLeaseStamp,
      options: PdfCloseOptions,
    ): Promise<PdfCloseReceipt>
    cancel(receipt: PdfCloseReceipt, reason: string): void
  },
  options: PdfCloseOptions = {},
): Promise<PdfCloseReceipt | null> {
  const source = dependencies.source()
  const hold = dependencies.hold()
  if (!hold)
    throw new Error(
      'Another PDF writer or close prompt is still finishing. Retry after it settles.',
    )
  let transferred = false
  const current = () =>
    dependencies.alive() &&
    !!source &&
    dependencies.source() === source &&
    pdfCloseOptionsCurrent(options) &&
    (transferred || hold.current())
  const assertCurrent = () => {
    if (!current())
      throw new Error('The PDF close group or source changed. No late Save or Discard was started.')
  }
  try {
    assertCurrent()
    const scoped: PdfCloseOptions = {
      deferSeal: options.deferSeal === true,
      signal: options.signal,
      isCurrent: current,
    }
    const state = await dependencies.query(scoped)
    assertCurrent()
    if (state.busy)
      throw new Error('PDF work is still finishing. Retry closing after it completes.')
    let intent: PdfCloseIntent = 'clean'
    if (state.pending) {
      const answer = await dependencies.prompt()
      assertCurrent() // BEFORE any Save/discard/custody side effect
      if (answer === 2) return null
      if (answer !== 0 && answer !== 1)
        throw new Error('The PDF close choice was invalid; the document was kept open.')
      intent = answer === 1 ? 'discard' : 'save'
    }
    assertCurrent()
    const receipt = await dependencies.prepare(intent, state.stamp, scoped)
    if (!current()) {
      dependencies.cancel(receipt, 'The PDF group changed before its preparation was returned.')
      throw new Error('The PDF close preparation is no longer current.')
    }
    if (receipt.phase !== (options.deferSeal ? 'prepared' : 'ready')) {
      dependencies.cancel(receipt, 'The PDF close phase did not match its requested authority.')
      throw new Error('The PDF close phase was invalid; removal was refused.')
    }
    // This main-correlated preparation owns the browser barrier and broker now.
    // Future seal checks must not depend on the completed OS prompt's hold.
    transferred = true
    return receipt
  } finally {
    hold.release()
  }
}
