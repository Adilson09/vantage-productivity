import {slidesActionApi,slidesActionWait,slidesActionWork} from './slides-action-ownership'
/**
 * Table editing actions extracted from App.tsx: row/column
 * structure, merge/split, resize, cell text commit and Tab navigation.
 * Functions read the latest App state through ActionCtx.
 */
import type { EditParagraph } from '../shared/ipc'
import type { ActionCtx } from './action-context'
import { FIT_WIDTH } from './app-constants'
import { t } from './i18n/locale'
import { slidesRecoveryClient } from './slides-recovery'

export async function tableStructureOp(
  ctx: ActionCtx,
  sourceId: string,
  kind: 'insert-row' | 'delete-row' | 'insert-col' | 'delete-col',
  index: number,
  before?: boolean,
): Promise<void> {
  return slidesActionWork(ctx, async()=>{

  const r = await slidesActionWait(ctx, slidesActionApi(ctx).tableStructure({
    slideIndex: ctx.current,
    sourceId,
    kind,
    index,
    ...(before ? { before: true } : {}),
  }))
  if (r) {
    ctx.applySlide(ctx.current, r.slide)
    ctx.setSelectedIds([r.sourceId])
    ctx.setEditingCell(null)
  } else {
    ctx.setStatus(
      kind.startsWith('delete')
        ? t('appStatusTableDeleteLimit')
        : t('appStatusTableMergedUnsupported'),
    )
  }

  })
}

export async function tableMergeOp(
  ctx: ActionCtx,
  sourceId: string,
  kind: 'merge-right' | 'merge-down' | 'split',
  row: number,
  col: number,
): Promise<void> {
  return slidesActionWork(ctx, async()=>{

  const r = await slidesActionWait(ctx, slidesActionApi(ctx).tableMerge({
    slideIndex: ctx.current,
    sourceId,
    kind,
    row,
    col,
  }))
  if (r) {
    ctx.applySlide(ctx.current, r.slide)
    ctx.setSelectedIds([r.sourceId])
    ctx.setEditingCell(null)
  } else {
    ctx.setStatus(t('appStatusMergeFailed'))
  }

  })
}

export async function onTableColResize(
  ctx: ActionCtx,
  sourceId: string,
  col: number,
  wPx: number,
): Promise<void> {
  return slidesActionWork(ctx, async()=>{

  const updated = await slidesActionWait(ctx, slidesActionApi(ctx).setTableColWidth({
    slideIndex: ctx.current,
    sourceId,
    col,
    wPx,
    fitWidthPx: FIT_WIDTH,
  }))
  if (updated) ctx.applySlide(ctx.current, updated)

  })
}

export async function onTableRowResize(
  ctx: ActionCtx,
  sourceId: string,
  row: number,
  hPx: number,
): Promise<void> {
  return slidesActionWork(ctx, async()=>{

  const updated = await slidesActionWait(ctx, slidesActionApi(ctx).setTableRowHeight({
    slideIndex: ctx.current,
    sourceId,
    row,
    hPx,
    fitWidthPx: FIT_WIDTH,
  }))
  if (updated) ctx.applySlide(ctx.current, updated)

  })
}

export async function commitCellEdit(ctx: ActionCtx, paragraphs: EditParagraph[]): Promise<void> {
  return slidesActionWork(ctx, async()=>{

  if (!ctx.editingCell) return
  const recovery = slidesRecoveryClient()
  const ticket = recovery?.beginSave()
  const updated = await slidesActionWait(ctx, slidesActionApi(ctx).editTableCell({
    slideIndex: ctx.current,
    sourceId: ctx.editingCell.sourceId,
    row: ctx.editingCell.row,
    col: ctx.editingCell.col,
    paragraphs,
  }))
  if (ticket && recovery && !recovery.isCurrent(ticket)) return
  if (updated) ctx.applySlide(ctx.current, updated)
  else throw new Error('Table text changes could not be applied; the cell editor was kept open.')
  ctx.setEditingCell(null)

  })
}

/** Cell Tab/Shift+Tab: commit the current cell (if content changed) and jump to the next/previous cell;
 * Tab on the last cell auto-adds a row and enters its first cell. */
export async function navigateCell(
  ctx: ActionCtx,
  paragraphs: EditParagraph[] | null,
  dir: 1 | -1,
): Promise<void> {
  return slidesActionWork(ctx, async()=>{

  const { editingCell, slide, current } = ctx
  if (!editingCell || !slide) return
  const tbl = slide.nodes.find((n) => n.sourceId === editingCell.sourceId)
  if (!tbl || tbl.type !== 'table') return
  if (paragraphs) {
    const updated = await slidesActionWait(ctx, slidesActionApi(ctx).editTableCell({
      slideIndex: current,
      sourceId: editingCell.sourceId,
      row: editingCell.row,
      col: editingCell.col,
      paragraphs,
    }))
    if (updated) ctx.applySlide(current, updated)
  }
  const cells = [...tbl.cells].sort((a, b) => a.row - b.row || a.col - b.col)
  const idx = cells.findIndex((c) => c.row === editingCell.row && c.col === editingCell.col)
  const next = cells[idx + dir]
  if (next) {
    ctx.setEditingCell({ sourceId: editingCell.sourceId, row: next.row, col: next.col })
    return
  }
  if (dir > 0) {
    // Tab on the last cell: add a row and enter its first cell
    const lastRow = Math.max(...cells.map((c) => c.row))
    const r = await slidesActionWait(ctx, slidesActionApi(ctx).tableStructure({
      slideIndex: current,
      sourceId: editingCell.sourceId,
      kind: 'insert-row',
      index: lastRow,
    }))
    if (r) {
      ctx.applySlide(current, r.slide)
      ctx.setSelectedIds([r.sourceId])
      const firstCol = Math.min(...cells.filter((c) => c.row === lastRow).map((c) => c.col))
      ctx.setEditingCell({ sourceId: r.sourceId, row: lastRow + 1, col: firstCol })
    }
  }
  // Shift+Tab on the first cell: stay in place

  })
}
