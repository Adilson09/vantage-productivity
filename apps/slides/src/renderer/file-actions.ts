import { slidesActionApi, slidesActionWait, slidesActionWork } from './slides-action-ownership'
/**
 * File actions extracted from App.tsx: save / save-as, image & PDF
 * export. Each function takes the ActionCtx built fresh per call.
 * (Printing lives in components/PrintDialog.tsx — preview + options dialog.)
 */
import type { RenderSlide } from '@vantage/pptx-render'
import type { ExportPdfLink } from '../shared/ipc'
import type { SlidesToolSaveRequest, SlidesToolSaveResult } from '../shared/slides-tool-save'
import { slidesAuthored } from './slides-authored'
import { baseName } from '../shared/base-name'
import { modelSaveAsName } from './file-naming'
import type { ActionCtx } from './action-context'
import { collectExportPdfLinks } from './export-links'
import { renderSlidesToPdfPages } from './export-pages'
import { renderSlidesToPngBase64 } from './export-render'
import { t } from './i18n/locale'
import { showToast } from './components/toast-bus'
import { flushSlidesPendingEditor, slidesEditIsComposing } from './slides-pending-edit'
import { slidesRecoveryClient } from './slides-recovery'

/**
 * If a text box/table is still being edited on ⌘S/close-save, blur first so the
 * overlay commits (blur→commitEdit), and save only after the commit lands —
 * otherwise we save pre-edit content and get a dirty-close prompt again.
 */
export async function flushActiveEdit(ctx: ActionCtx): Promise<void> {
  if (slidesEditIsComposing()) throw new Error('Finish composing the current text before saving.')
  const active = document.activeElement as HTMLElement | null
  if (active?.isContentEditable) active.blur()
  await flushSlidesPendingEditor()
  for (let i = 0; i < 40 && ctx.editingActiveRef.current; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (ctx.editingActiveRef.current)
    throw new Error('The current text edit has not finished; the presentation was not saved.')
}

function saveFailure(ctx: ActionCtx, error: unknown): void {
  const failed = t('appStatusSaveFailed', { error: String(error) })
  ctx.setStatus(failed)
  showToast(failed, 'error')
}
export async function flushForAliasClose(getCtx: () => ActionCtx): Promise<boolean> {
  try {
    await flushActiveEdit(getCtx())
    await getCtx().flushNotes()
    return true
  } catch (error) {
    saveFailure(getCtx(), error)
    return false
  }
}

/**
 * After save, the main process reopens the file with all-new element ids: swap
 * the render tree, mapping selection/edit state to new ids by per-page node ordinal.
 */
export function adoptSavedSlides(ctx: ActionCtx, next: RenderSlide[]): void {
  const page = ctx.slides[ctx.current]
  const remap = (id: string) => {
    const i = page?.nodes.findIndex((n) => n.sourceId === id) ?? -1
    return i >= 0 ? (next[ctx.current]?.nodes[i]?.sourceId ?? null) : null
  }
  ctx.setSelectedIds((ids) => ids.map(remap).filter((x): x is string => x !== null))
  ctx.setEnteredGroupId(null) // Group children ids can't be mapped by top-level ordinal; exit in-group editing after save
  // A stale edit target (page gone, deck shrunk) cannot be mapped: drop it rather than keep an id no node owns
  ctx.setEditing((e) => {
    const id = e && remap(e.sourceId)
    return id ? { sourceId: id } : null
  })
  ctx.setEditingCell((c) => {
    const id = c && remap(c.sourceId)
    return id && c ? { ...c, sourceId: id } : null
  })
  ctx.setSlides(next)
}

/**
 * Serializes save passes: a call that arrives while a save is in flight waits
 * for it instead of running concurrently. Two overlapping saves write the
 * same file with two `createWriteStream` pipes — interleaved zip streams,
 * truncated pptx, or EPERM/EBUSY on Windows. The queue is a simple promise
 * chain: each caller awaits the previous tail, then runs its own pass.
 */
let saveTail: Promise<unknown> | null = null

/**
 * Runs `pass` after the in-flight save (if any) finishes, and becomes the
 * tail subsequent saves wait on. A pass that throws still releases the
 * queue; the error propagates to its own caller only.
 */
async function runSerialized<T>(pass: () => Promise<T>): Promise<T> {
  const prior = saveTail
  const current = (async (): Promise<T> => {
    if (prior) await prior.catch(() => undefined)
    return pass()
  })()
  const tail = current.then(
    () => undefined,
    () => undefined,
  )
  saveTail = tail
  void current.then(
    () => {
      if (saveTail === tail) saveTail = null
    },
    () => {
      if (saveTail === tail) saveTail = null
    },
  )
  return current
}

/** UI-backed MCP saves share the same serialized full-flush and adoption primitives. */
export async function saveForTool(
  getCtx: () => ActionCtx,
  request: SlidesToolSaveRequest,
): Promise<SlidesToolSaveResult> {
  return runSerialized(async () => {
    const result: SlidesToolSaveResult = {
      requestId: request.requestId,
      sourceToken: request.sourceToken ?? '',
      published: false,
      current: false,
      clean: false,
      revision: '',
    }
    const recovery = slidesRecoveryClient(),
      ticket = recovery?.beginSave(),
      authored = slidesAuthored()
    try {
      if (!authored || !recovery || !ticket || authored.source() !== request.sourceIdentity)
        throw new Error('The presentation source is no longer ready.')
      const scope = authored.scope(),
        initial = authored.barrier.snapshot()
      if (
        request.approvedStamp &&
        (initial.source !== request.approvedStamp.source ||
          initial.revision !== request.approvedStamp.revision)
      )
        throw new Error('The presentation changed after the approved Save/Discard decision.')
      const activation = await ticket.activation
      authored.assert(scope)
      if (!activation?.token || !recovery.isCurrent(ticket))
        throw new Error('The presentation recovery source changed.')
      result.sourceToken = activation.token
      const identity = { requestId: request.requestId, sourceToken: activation.token }
      if (request.sourceToken !== null && request.sourceToken !== activation.token)
        throw new Error('The presentation recovery source changed.')
      if (request.intent === 'discard') {
        // Cancel callback authority, not actual promise ownership. Old decoder/dialog work cannot author again.
        authored.cancelPending()
      } else {
        const pendingReason = authored.reason()
        if (pendingReason) throw new Error(pendingReason)
        await flushActiveEdit(getCtx())
        await getCtx().flushNotes()
        if (!recovery.isCurrent(ticket) || authored.source() !== scope.source)
          throw new Error('The presentation changed while its editors flushed.')
        const flushed = await window.slidesApi.probeToolSave(identity)
        if (!flushed.current) throw new Error('The main presentation source changed.')
        if (!(request.requireClean && !flushed.dirty && !recovery.hasPending())) {
          const before = authored.barrier.snapshot(),
            saved = await window.slidesApi.saveToolToPath(identity)
          if (!saved.ok) throw new Error(saved.error ?? 'The presentation could not be saved.')
          result.published = true
          if (!recovery.isCurrent(ticket) || authored.source() !== before.source) return result
          const unchanged = authored.barrier.snapshot().revision === before.revision,
            pending = recovery.hasPending()
          const clean = saved.dirty !== true && !pending && unchanged
          if (saved.slides && clean) adoptSavedSlides(getCtx(), saved.slides)
          getCtx().setPath(saved.path)
          getCtx().setDirty(!clean)
          const projected = authored.barrier.snapshot()
          await recovery.acknowledgeSaved(ticket, saved.path, clean)
          if (
            !recovery.isCurrent(ticket) ||
            authored.barrier.snapshot().source !== projected.source
          )
            return result
          if (authored.barrier.snapshot().revision !== projected.revision || recovery.hasPending())
            getCtx().setDirty(true)
        }
      }
      const after = await window.slidesApi.probeToolSave(identity)
      result.current =
        after.current && recovery.isCurrent(ticket) && authored.source() === request.sourceIdentity
      result.revision = after.revision
      result.throughSequence = recovery.throughSequence()
      result.clean =
        result.current &&
        !after.dirty &&
        !recovery.hasPending() &&
        !getCtx().editingActiveRef.current &&
        !authored.reason()
      if (request.requireClean) {
        if (!request.closeLease || !result.current || (request.intent === 'save' && !result.clean))
          throw new Error('Newer or pending presentation edits prevented close.')
        const stamp = await authored.barrier.acquire(
          request.closeLease,
          () =>
            authored.source() === request.sourceIdentity &&
            !authored.busy &&
            (request.intent === 'discard' || (!recovery.hasPending() && !authored.reason())),
        )
        if (!stamp)
          throw new Error('The pending presentation close could not acquire its mutation barrier.')
        result.stamp = stamp
      }
      return result
    } catch (error) {
      result.error = String(error).slice(0, 2000)
      if (!ticket || !recovery || recovery.isCurrent(ticket)) saveFailure(getCtx(), error)
      if (request.closeLease && authored) {
        try {
          await window.slidesApi.cancelCloseLease(request.closeLease, result.error)
          authored.barrier.release(request.closeLease)
        } catch {
          /* Main permission remains invalid until a correlated release arrives. */
        }
      }
      return result
    }
  })
}

export async function save(getCtx: () => ActionCtx, quiet = false): Promise<boolean> {
  return runSerialized(async () => {
    // resolved only now: a queued pass must remap selection against the tree the prior save adopted
    const automaticSource = slidesAuthored()?.source()
    if (quiet && slidesAuthored()?.barrier.locked) return false
    let ctx = getCtx()
    const recovery = slidesRecoveryClient()
    const ticket = recovery?.beginSave()
    try {
      await flushActiveEdit(ctx)
      await getCtx().flushNotes()
      if (ticket && recovery && !recovery.isCurrent(ticket)) return false
      ctx = getCtx()
      // No name is proposed here: a save never waits on a model round-trip. An
      // untitled deck keeps the app's own name, the localized "Untitled
      // presentation" the main process produces in `pickDraftPath`.
      const authored = slidesAuthored(),
        before = authored?.barrier.snapshot()
      if (
        quiet &&
        (slidesAuthored()?.barrier.locked || slidesAuthored()?.source() !== automaticSource)
      )
        return false
      const r = await window.slidesApi.save(quiet)
      if (r.deferred) return false
      if (ticket && recovery && !recovery.isCurrent(ticket)) return false
      if (r.ok) {
        ctx = getCtx()
        const pending = recovery?.hasPending() ?? false
        const clean =
          r.dirty !== true &&
          !pending &&
          (!before ||
            (authored?.barrier.snapshot().source === before.source &&
              authored.barrier.snapshot().revision === before.revision))
        if (r.slides && !pending) adoptSavedSlides(ctx, r.slides)
        if (r.path) ctx.setPath(r.path)
        ctx.setDirty(!clean)
        const saved = t('appStatusSaved')
        ctx.setStatus(clean ? saved : `${saved} Newer edits are still unsaved.`)
        if (!quiet) showToast(saved)
        const acknowledged = authored?.barrier.snapshot()
        if (recovery && ticket && r.path) await recovery.acknowledgeSaved(ticket, r.path, clean)
        const stillClean =
          clean &&
          (!ticket || !recovery || recovery.isCurrent(ticket)) &&
          !recovery?.hasPending() &&
          (!acknowledged ||
            (authored?.barrier.snapshot().source === acknowledged.source &&
              authored.barrier.snapshot().revision === acknowledged.revision))
        if (!stillClean && (!ticket || !recovery || recovery.isCurrent(ticket)))
          getCtx().setDirty(true)
        return stillClean
      } else {
        const failed = t('appStatusSaveFailed', { error: r.error ?? t('appErrorCanceled') })
        ctx.setStatus(failed)
        // quiet suppresses the success toast only — a failed save (incl. the 30s
        // auto-save) must surface, or edits silently stop reaching disk
        showToast(failed, 'error')
      }
      return false
    } catch (error) {
      if (!ticket || !recovery || recovery.isCurrent(ticket)) saveFailure(getCtx(), error)
      return false
    }
  })
}

export async function saveAs(getCtx: () => ActionCtx): Promise<void> {
  await saveAsWithName(getCtx, null)
}

/**
 * Ask the model to name this deck, on request, then open Save As with its
 * answer prefilled.
 *
 * The stem goes into the dialog rather than renaming the file on disk: a deck
 * that may be open elsewhere, presented from another machine, or synced is not
 * something to move behind the reader's back. A declined or empty answer
 * leaves the dialog on the deck's current name, so this is a no-op rather than
 * a failure.
 */
export async function nameWithAi(getCtx: () => ActionCtx): Promise<void> {
  const ctx = getCtx(),
    authored = slidesAuthored(),
    scope = authored?.scope()
  // the model reads the deck, so an edit still being typed has to land first
  const editing = ctx.editingActiveRef.current
  if (authored && scope) await authored.wait(scope, flushActiveEdit(ctx))
  else await flushActiveEdit(ctx)
  // that commit can replace the deck, so read it again rather than from the
  // snapshot taken before the flush
  const deck = editing ? getCtx() : ctx
  const stem =
    authored && scope
      ? await authored.wait(scope, modelSaveAsName(deck.slides))
      : await modelSaveAsName(deck.slides)
  if (!stem) return
  await saveAsWithName(getCtx, `${stem}.pptx`)
}

/**
 * Save As with a name the reader (or the model, via `nameWithAi`) chose.
 *
 * A null name means "the deck's current name", which is read inside the queue:
 * a save that landed while this call was waiting may have changed it.
 */
export async function saveAsWithName(getCtx: () => ActionCtx, name: string | null): Promise<void> {
  // Same queue as save(): Save + Save As (or double Save As) write through
  // the same main-process pipe and would interleave without it.
  await runSerialized(async () => {
    let ctx = getCtx()
    const recovery = slidesRecoveryClient()
    const ticket = recovery?.beginSave()
    try {
      await flushActiveEdit(ctx)
      await getCtx().flushNotes()
      if (ticket && recovery && !recovery.isCurrent(ticket)) return
      ctx = getCtx()
      const target = name ?? (baseName(ctx.path ?? '') || 'presentation.pptx')
      const authored = slidesAuthored(),
        before = authored?.barrier.snapshot()
      const r = await window.slidesApi.saveAs(target)
      if (ticket && recovery && !recovery.isCurrent(ticket)) return
      if (r.ok) {
        ctx = getCtx()
        const pending = recovery?.hasPending() ?? false
        const clean =
          r.dirty !== true &&
          !pending &&
          (!before ||
            (authored?.barrier.snapshot().source === before.source &&
              authored.barrier.snapshot().revision === before.revision))
        if (r.slides && !pending) adoptSavedSlides(ctx, r.slides)
        ctx.setPath(r.path ?? ctx.path)
        ctx.setDirty(!clean)
        const saved = t('appStatusSavedAs')
        ctx.setStatus(clean ? saved : `${saved} Newer edits are still unsaved.`)
        showToast(saved)
        const acknowledged = authored?.barrier.snapshot()
        if (recovery && ticket && r.path) await recovery.acknowledgeSaved(ticket, r.path, clean)
        if (
          (!ticket || !recovery || recovery.isCurrent(ticket)) &&
          (recovery?.hasPending() ||
            (acknowledged &&
              (authored?.barrier.snapshot().source !== acknowledged.source ||
                authored.barrier.snapshot().revision !== acknowledged.revision)))
        )
          getCtx().setDirty(true)
      } else if (r.error) {
        // a canceled dialog returns ok:false without error — only real write
        // failures surface, matching the docs/sheets save-as feedback
        const failed = t('appStatusSaveFailed', { error: r.error })
        ctx.setStatus(failed)
        showToast(failed, 'error')
      }
    } catch (error) {
      if (!ticket || !recovery || recovery.isCurrent(ticket)) saveFailure(getCtx(), error)
    }
  })
}

/** Export base name: file name without the .pptx extension */
export function exportBaseName(ctx: ActionCtx): string {
  return (baseName(ctx.path ?? '') || t('appUntitledPresentation')).replace(/\.pptx$/i, '')
}

/** Export as images: each page (skipping hidden ones) rendered offscreen to 2x PNG, written to disk by the main process */
export async function exportImages(ctx: ActionCtx): Promise<void> {
  return slidesActionWork(ctx, async () => {
    const visible = ctx.slides.filter((s) => !s.hidden)
    if (visible.length === 0) {
      ctx.setStatus(t('appExportNoSlides'))
      return
    }
    const baseName = exportBaseName(ctx)
    const selection = await slidesActionWait(
      ctx,
      slidesActionApi(ctx).pickExportDir({ baseName, count: visible.length }),
    )
    if (!selection) return
    const dir = selection.path
    ctx.setStatus(t('appExportImagesProgress', { count: visible.length }))
    try {
      const pngs = await slidesActionWait(ctx, renderSlidesToPngBase64(visible, ctx.images))
      const r = await slidesActionWait(
        ctx,
        slidesActionApi(ctx).exportImages({
          dir,
          baseName,
          selectionId: selection.selectionId,
          pngsBase64: pngs,
        }),
      )
      ctx.setStatus(
        r.ok
          ? t('appExportImagesDone', { count: r.paths?.length ?? 0, dir })
          : t('appExportImagesFailed', { error: r.error ?? t('appUnknownError') }),
      )
    } catch (err) {
      ctx.setStatus(t('appExportImagesFailed', { error: String(err) }))
    }
  })
}

/**
 * Element and text-run hyperlinks of every exported page as clickable overlay
 * rects (the pages are rasterized, so links must ride along separately). Link
 * fetch failures degrade to a link-less PDF rather than failing the export.
 */
async function collectPdfLinks(ctx: ActionCtx): Promise<ExportPdfLink[][]> {
  return slidesActionWork(ctx, async () => {
    const modelIndexes = ctx.slides.flatMap((s, i) => (s.hidden ? [] : [i]))
    const pageOfModelIndex = new Map(modelIndexes.map((mi, page) => [mi, page] as const))
    try {
      const [linkLists, runLinkLists] = await slidesActionWait(
        ctx,
        Promise.all([
          Promise.all(modelIndexes.map((mi) => slidesActionApi(ctx).getSlideLinks(mi))),
          Promise.all(modelIndexes.map((mi) => slidesActionApi(ctx).getRunLinks(mi))),
        ]),
      )
      const visible = modelIndexes.map((mi) => ctx.slides[mi]!)
      return collectExportPdfLinks(visible, linkLists, runLinkLists, pageOfModelIndex)
    } catch {
      return []
    }
  })
}

/**
 * Export as PDF: each page (skipping hidden ones) rendered to vector SVG (text
 * stays text; a page the SVG backend cannot build falls back to its 2x PNG);
 * main process printToPDF in a hidden window.
 *
 * `outPath` skips the save dialog — the headless CLI entry already knows where
 * the file goes. Resolves true only when a PDF was written.
 */
export async function exportPdf(ctx: ActionCtx, outPath?: string): Promise<boolean> {
  return slidesActionWork(ctx, async () => {
    const visible = ctx.slides.filter((s) => !s.hidden)
    if (visible.length === 0) {
      ctx.setStatus(t('appExportNoSlides'))
      return false
    }
    const selection = outPath
      ? undefined
      : await slidesActionWait(
          ctx,
          slidesActionApi(ctx).pickExportPdfPath(`${exportBaseName(ctx)}.pdf`),
        )
    const target = outPath ?? selection?.path
    if (!target) return false
    ctx.setStatus(t('appExportPdfProgress'))
    try {
      const { pages, fontCss } = await slidesActionWait(
        ctx,
        renderSlidesToPdfPages(visible, ctx.images),
      )
      const links = await slidesActionWait(ctx, collectPdfLinks(ctx))
      const r = await slidesActionWait(
        ctx,
        slidesActionApi(ctx).exportPdf({
          filePath: target,
          selectionId: selection?.selectionId,
          pages,
          widthPx: visible[0].widthPx,
          heightPx: visible[0].heightPx,
          links,
          fontCss,
        }),
      )
      ctx.setStatus(
        r.ok
          ? t('appExportPdfDone', { path: r.path ?? '' })
          : t('appExportPdfFailed', { error: r.error ?? t('appUnknownError') }),
      )
      return r.ok
    } catch (err) {
      ctx.setStatus(t('appExportPdfFailed', { error: String(err) }))
      return false
    }
  })
}
