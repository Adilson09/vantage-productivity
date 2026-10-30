/** Resolve the persisted part at the instant of a synchronous read or mutation. */
export function notesPartIndex(
  slides: readonly { path: string }[],
  index: number,
  partPath?: string,
): number {
  if (partPath !== undefined) {
    if (
      typeof partPath !== 'string' ||
      partPath.length < 1 ||
      partPath.length > 4096 ||
      partPath.includes('\0')
    )
      return -1
    return slides.findIndex((slide) => slide.path === partPath)
  }
  return Number.isSafeInteger(index) && index >= 0 && index < slides.length ? index : -1
}

/** The writer is synchronous; no stale index is carried across an await or queue. */
export function writeNotesPart(
  slides: readonly { path: string }[],
  target: { slideIndex: number; partPath?: string },
  write: (index: number) => boolean,
): boolean {
  const index = notesPartIndex(slides, target.slideIndex, target.partPath)
  return index < 0 ? false : write(index)
}
