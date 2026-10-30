import type { PdfWorkspaceStateV1 } from '../shared/pdf-workspace'
import { pdfAuthoredFingerprint } from './pdf-draft'

/** A saved file is an independent publication. It is safe to replace the canvas
 * base and subtract its operations only when all current authoring still equals
 * the captured model, including same-ID changes, removals and Undo. */
export class PdfSaveAuthoringChanged extends Error {
  constructor() {
    super('The PDF was saved, but newer authoring needs its complete old-base workspace.')
    this.name = 'PdfSaveAuthoringChanged'
  }
}
export function assertPdfSaveUnchanged(expected: string, capture: () => PdfWorkspaceStateV1): void {
  if (pdfAuthoredFingerprint(capture()) !== expected) throw new PdfSaveAuthoringChanged()
}

/** Stage every asynchronous read before adoption. No setter or old-base disposal
 * may occur between this final check and the synchronous installation. */
export async function preparePdfSaveAdoption<Value>(options: {
  expected: string
  capture(): PdfWorkspaceStateV1
  current(): boolean
  prepare(): Promise<Value>
  dispose(value: Value): void
}): Promise<Value> {
  if (!options.current()) throw new Error('A newer PDF source replaced this save.')
  assertPdfSaveUnchanged(options.expected, options.capture)
  const value = await options.prepare()
  try {
    if (!options.current()) throw new Error('A newer PDF source replaced this save.')
    assertPdfSaveUnchanged(options.expected, options.capture)
    return value
  } catch (error) {
    options.dispose(value)
    throw error
  }
}
