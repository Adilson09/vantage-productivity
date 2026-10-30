export interface HtmlSavedTicket {
  token: string
  activation: number
  revision: number
  representedClean: boolean
}
export interface HtmlSaveLiveState {
  token: string | null
  activation: number
  revision: number
  text: string
  savedText: string
  sourceText: string | null
  sourceComposing: boolean
  composing: boolean
  panelPending: boolean
  visualPending: boolean
  stylesPending: boolean
}
export function htmlSaveStateIsDirty(current: HtmlSaveLiveState): boolean {
  return (
    current.text !== current.savedText ||
    (current.sourceText !== null && current.sourceText !== current.text) ||
    current.sourceComposing ||
    current.composing ||
    current.panelPending ||
    current.visualPending ||
    current.stylesPending
  )
}
/** Read and publish synchronously after the storage await. Never reuse a pre-await clean decision. */
export async function completeHtmlSaveAcknowledgment(
  acknowledgment: Promise<unknown>,
  ticket: HtmlSavedTicket,
  readCurrent: () => HtmlSaveLiveState,
  publishCurrent: (state: { clean: boolean; dirty: boolean; revision: number }) => void,
): Promise<boolean> {
  await acknowledgment
  const current = readCurrent()
  if (current.token !== ticket.token || current.activation !== ticket.activation) return false
  const dirty = htmlSaveStateIsDirty(current)
  const clean = ticket.representedClean && current.revision === ticket.revision && !dirty
  publishCurrent({ clean, dirty, revision: current.revision })
  return clean
}
