import type { Node } from '@tiptap/pm/model'
import { serializeDocText, type DocEnvelope } from './docText'

/** Experimental no-op round trips; edited documents still use the legacy serializer. */
export function roundTripMarkdownEnabled(): boolean {
  try {
    return localStorage.getItem('mdapp.experimentalRoundTrip') === '1'
  } catch {
    return false
  }
}

export interface MarkdownSourceSnapshot {
  readonly source: string
  readonly envelope: Readonly<DocEnvelope>
  readonly doc: Node
}

export function captureMarkdownSource(
  source: string,
  envelope: DocEnvelope,
  doc: Node,
): MarkdownSourceSnapshot {
  return { source, envelope: { ...envelope }, doc }
}

export function sameMarkdownEnvelope(a: Readonly<DocEnvelope>, b: Readonly<DocEnvelope>): boolean {
  return a.frontmatter === b.frontmatter && a.eol === b.eol &&
    a.trailingNewline === b.trailingNewline && a.bom === b.bom
}

/** Clean documents retain the exact loaded UTF-8 source only when their model
 * and envelope still match. Edited documents keep the established serializer
 * unless the user enabled experimental round trips. The flag's default stays off.
 */
export function serializeMarkdownForSave(
  envelope: DocEnvelope,
  doc: Node,
  serializeBody: () => string,
  options: { original: MarkdownSourceSnapshot | undefined; clean: boolean; experimental: boolean },
): string {
  return serializeMarkdown(envelope, doc, serializeBody,
    options.clean || options.experimental ? options.original : undefined)
}

/** Compare only at serialization time, never on the typing path. */
export function serializeMarkdown(
  envelope: DocEnvelope,
  doc: Node,
  serializeBody: () => string,
  original?: MarkdownSourceSnapshot,
): string {
  if (
    original &&
    sameMarkdownEnvelope(envelope, original.envelope) &&
    doc.eq(original.doc)
  ) {
    return original.source
  }
  return serializeDocText(envelope, serializeBody())
}
