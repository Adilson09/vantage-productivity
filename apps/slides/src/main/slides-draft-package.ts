import {
  getSlideNotes,
  parseMasterPart,
  savePptxBounded,
  type OpenedPptx,
  type Slide,
} from '@vantage/pptx-engine'
import { runTxn, type Op } from '@vantage/pptx-ops'
import type { SlidesPendingDraft } from '../shared/slides-draft'

export const SLIDES_DRAFT_MAX_BYTES = 16 * 1024 * 1024
export const SLIDES_DRAFT_MODEL_BYTES = 64 * 1024 * 1024
export const SLIDES_DRAFT_PENDING_BYTES = 1024 * 1024
const models = new WeakMap<OpenedPptx, number>()
let nextModel = 0
/** Semantic operations and a replacement parse both invalidate queued overlays. */
export function slidesDraftRevision(source: {
  opened: OpenedPptx
  opSeq?: number
  metaRev?: number
}): string {
  let model = models.get(source.opened)
  if (model === undefined) {
    model = ++nextModel
    models.set(source.opened, model)
  }
  return `${model}:${source.opSeq ?? 0}:${source.metaRev ?? 0}`
}

/** Inspect before cloning; an imported large deck remains open when recovery exceeds its budget. */
export function inspectDraftBudget(value: unknown, maximum: number, maximumNodes = 200000): number {
  const seen = new Set<object>()
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let bytes = 0
  let nodes = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > maximumNodes || item.depth > 128)
      throw new Error('The presentation draft is too complex to capture safely.')
    const current = item.value
    if (typeof current === 'string') bytes += Buffer.byteLength(current)
    else if (typeof current === 'number' || typeof current === 'boolean') bytes += 8
    else if (current && typeof current === 'object') {
      if (seen.has(current)) continue
      seen.add(current)
      if (ArrayBuffer.isView(current)) bytes += current.byteLength
      else if (current instanceof ArrayBuffer) bytes += current.byteLength
      else if (current instanceof Map || current instanceof Set) {
        for (const value of current.values()) pending.push({ value, depth: item.depth + 1 })
        if (current instanceof Map)
          for (const value of current.keys()) pending.push({ value, depth: item.depth + 1 })
      } else
        for (const [key, value] of Object.entries(current)) {
          bytes += Buffer.byteLength(key)
          pending.push({ value, depth: item.depth + 1 })
        }
    } else if (current !== undefined && current !== null)
      throw new Error('The presentation draft contains unsupported values.')
    if (bytes > maximum)
      throw new Error(`The presentation draft exceeds its ${maximum} byte capture budget.`)
  }
  return bytes
}

const indexFor = (opened: OpenedPptx, target: { slideIndex: number; partPath?: string }) => {
  const index = target.partPath
    ? opened.deck.slides.findIndex((slide) => slide.path === target.partPath)
    : target.slideIndex
  if (!Number.isSafeInteger(index) || index < 0 || index >= opened.deck.slides.length)
    throw new Error(
      'The slide being edited changed before its recovery snapshot; retry after the view refreshes.',
    )
  return index
}

export function freezeSlidesDraft(
  source: { opened: OpenedPptx; masterEdit?: { partPath: string; slide: Slide } | null },
  pending: SlidesPendingDraft,
): OpenedPptx {
  inspectDraftBudget(pending, SLIDES_DRAFT_PENDING_BYTES, 50000)
  inspectDraftBudget(
    { opened: source.opened, master: source.masterEdit ?? null },
    SLIDES_DRAFT_MODEL_BYTES,
  )
  pending = structuredClone(pending)
  if (source.opened.archive.entries.size > 10000)
    throw new Error('The presentation contains too many parts for recovery.')
  const opened: OpenedPptx = {
    deck: structuredClone(source.opened.deck),
    archive: source.opened.archive.clone(),
  }
  const ops: Op[] = []
  const parts = new Map<string, Slide>()
  const text = pending.text
  if (text) {
    if (text.kind === 'master') {
      const part =
        source.masterEdit?.partPath === text.partPath
          ? structuredClone(source.masterEdit.slide)
          : parseMasterPart(opened.archive, text.partPath)
      if (!part) throw new Error('The master or layout being edited no longer exists.')
      parts.set(text.partPath, part)
      ops.push({
        op: 'setText',
        target: { part: text.partPath, el: text.sourceId },
        paragraphs: text.paragraphs,
      })
    } else {
      const target = { slide: indexFor(opened, text), el: text.sourceId }
      ops.push(
        text.kind === 'table'
          ? {
              op: 'setTableCell',
              target,
              row: text.row,
              col: text.col,
              paragraphs: text.paragraphs,
            }
          : {
              op: 'setText',
              target,
              paragraphs: text.paragraphs,
              ...(text.groupId ? { group: text.groupId } : {}),
            },
      )
    }
  }
  if (pending.notes) {
    const index = indexFor(opened, pending.notes)
    if (getSlideNotes(opened.archive, opened.deck.slides[index]!.path) !== pending.notes.baseline)
      throw new Error(
        'Speaker notes changed in another view; their pending text was not overwritten.',
      )
    ops.push({ op: 'setNotes', target: { slide: index }, text: pending.notes.text })
  }
  if (ops.length) {
    const result = runTxn(opened, { isolation: 'atomic', ops, parts })
    if (!result.applied)
      throw new Error(
        result.failures?.[0]?.error ?? 'Pending presentation edits could not be captured.',
      )
  }
  inspectDraftBudget(opened, SLIDES_DRAFT_MODEL_BYTES)
  return opened
}

export async function serializeSlidesDraft(opened: OpenedPptx): Promise<Buffer> {
  // savePptx mutates its saveSnapshot WeakMap and font resources. Only the clone is supplied.
  return Buffer.from(await savePptxBounded(opened, SLIDES_DRAFT_MAX_BYTES))
}
