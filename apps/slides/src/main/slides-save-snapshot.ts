import { commitSaved, type OpenedPptx } from '@vantage/pptx-engine'
/** Ordinary publication has no recovery16MiB limit. Clone before any serializer await. */
export function captureSlidesSave(opened: OpenedPptx): OpenedPptx {
  return { deck: structuredClone(opened.deck), archive: opened.archive.clone() }
}
/** Only the exact represented live revision may adopt saved XML/fonts and clean flags; IDs survive. */
export function adoptSlidesSave(
  opened: OpenedPptx,
  frozen: OpenedPptx,
  representedRevision: string,
  currentRevision: string,
): boolean {
  if (representedRevision !== currentRevision) return false
  commitSaved(frozen)
  opened.archive.entries.clear()
  for (const [key, value] of frozen.archive.entries) opened.archive.entries.set(key, value)
  commitSaved(opened)
  return true
}
