import {
  absentPublicationTarget,
  type DocumentPublication,
  type PublicationSelection,
} from '../../../../packages/electron-utils/src/document-publication'
/** The real Save/SaveAs/MCP path serializes only this captured package into the publisher's temporary file. */
export async function publishSlidesDocument<Snapshot>(
  publication: DocumentPublication,
  path: string,
  selection: PublicationSelection,
  capture: () => Snapshot,
  write: (snapshot: Snapshot, temporary: string) => Promise<void>,
): Promise<Snapshot> {
  const target =
      selection.target ??
      (selection.source.path === path ? undefined : absentPublicationTarget(path)),
    ticket = publication.pin(path, target, selection.source),
    snapshot = capture()
  await publication.publishVia(ticket, (temporary) => write(snapshot, temporary))
  return snapshot
}
