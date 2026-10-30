import type { HtmlSaveLiveState } from './html-save-acknowledgment'
export interface HtmlReloadLiveState extends HtmlSaveLiveState {
  path: string | null
  highestSequence: number
  ready: boolean
  pendingSignature: string
}
/** Every await precedes the final guard. apply must replace the model synchronously. */
export async function prepareAndApplyHtmlReload<T>(
  captured: HtmlReloadLiveState,
  prepare: () => Promise<T>,
  readCurrent: () => HtmlReloadLiveState,
  apply: (
    prepared: T,
    receipt: {
      token: string
      documentPath: string
      previousRevision: number
      revision: number
      throughSequence: number
    },
  ) => void,
): Promise<boolean> {
  if (
    !captured.ready ||
    !captured.token ||
    !captured.path ||
    captured.composing ||
    captured.sourceComposing
  )
    throw new Error(
      'Reload is unavailable during loading, saving or text composition; the current document is retained.',
    )
  const prepared = await prepare()
  const current = readCurrent()
  if (
    !current.ready ||
    current.token !== captured.token ||
    current.activation !== captured.activation ||
    current.path !== captured.path ||
    current.revision !== captured.revision ||
    current.text !== captured.text ||
    current.savedText !== captured.savedText ||
    current.sourceText !== captured.sourceText ||
    current.pendingSignature !== captured.pendingSignature ||
    current.composing ||
    current.sourceComposing
  )
    return false
  if (
    !Number.isSafeInteger(current.revision + 1) ||
    !Number.isSafeInteger(current.highestSequence) ||
    current.highestSequence < 0
  )
    throw new Error('The Reload revision or sequence exceeds its safe range.')
  // Include snapshots allocated while the bounded read/validation was awaiting.
  apply(prepared, {
    token: captured.token,
    documentPath: captured.path,
    previousRevision: current.revision,
    revision: current.revision + 1,
    throughSequence: current.highestSequence,
  })
  return true
}
