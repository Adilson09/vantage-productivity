export interface MarkdownCloseSave {
  waitUntilIdle(): Promise<void>
  isCurrent(): boolean
  flushPending(): void
  canClose(): boolean
  /** True means bytes were published; newer edits can still remain in the editor. */
  save(): Promise<boolean>
}

/** Save the current activation until its latest edits, rather than one old revision, are safe. */
export async function saveMarkdownForClose(
  request: MarkdownCloseSave,
  maxPasses = 3,
): Promise<boolean> {
  for (let pass = 0; pass < maxPasses; pass++) {
    await request.waitUntilIdle()
    if (!request.isCurrent()) return false
    request.flushPending()
    if (request.canClose()) return true
    if (!(await request.save())) return false
    if (!request.isCurrent()) return false
    request.flushPending()
    if (request.canClose()) return true
  }
  return false
}
