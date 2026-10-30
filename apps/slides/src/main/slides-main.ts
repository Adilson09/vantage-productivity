import { selectCurrentSlidesOutput, SlidesExportAdmission, SlidesHeadlessExportLifecycle } from './export-output-lifecycle'
import { publishSelectedUserOutputs, publishSelectedUserOutput, UserOutputSelections, type UserOutputSourceProof } from '@vantage/electron-utils/user-output-publication'
import {publishSlidesDocument} from './slides-publication'
import {DocumentPublication,readPublicationFile,observePublicationTarget,absentPublicationTarget,type PublicationSelection} from '../../../../packages/electron-utils/src/document-publication'
import {NativeCloseAdmission} from '../../../../packages/electron-utils/src/native-close-admission'
import { configureRecoveryProfile, initializeStandaloneRecovery, requireRecoveryRuntime, queueRecoveryWarning } from '../../../../packages/electron-utils/src/recovery-bootstrap'
import {captureSlidesSave,adoptSlidesSave} from './slides-save-snapshot'
import {slidesOwnedHandle,configureSlidesOwnedInvokes} from './slides-owned-ipc'
import {SlidesSessionOwnership,configureSlidesMutationGuard} from './slides-session-ownership'
import {SlidesHistoryBatches} from './slides-history-batches'
import {beginCloseCleanup} from '../../../../packages/electron-utils/src/close-cleanup-runtime'
import type {SlidesCloseQuery,SlidesToolSaveCompletion,SlidesNativeCloseReceipt,SlidesCloseIntent} from '../shared/slides-tool-save'
import {isCloseLeaseStamp,type CloseLeaseTicket,type CloseLeaseStamp} from '../../../../packages/electron-utils/src/close-lease'
import { SlidesToolSaveBroker,runSlidesNativeClose,slidesClosePermit,type SlidesClosePrepareOptions } from './slides-tool-save'
import type { SlidesToolSaveIdentity } from '../shared/slides-tool-save'
/**
 * Vantage Slides main process — pptx parsing/render-tree building/edit application/saving all live
 * here (Node side). The renderer only gets plain-data RenderSlide; edit intents are sent back
 * here to apply. Structure mirrors apps/docs: exports embeddable configure/register/start for
 * future shell reuse.
 */
import {
  clipboard,
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session as electronSession,
  shell,
  systemPreferences,
  webContents,
  WebContentsView,
} from 'electron'
import type { WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, writeFile, rm, stat, mkdir, open } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { cleanupExpiredGeneratedPages } from './generated-page-temp'
import { exportSlidesPdf } from './pdf-export'
import { printSlidesHtml } from './print-window'
import { setGskProxyUrl } from '@vantage/ai-search'
import {
  appMenuLabels,
  appMenuTemplate,
  configuredDefaultSaveDir,
  contextMenuLabels,
  fetchRemoteImage,
  installContextMenu,
  installNavigationGuard,
  isHeadlessMode,
  safeExternalUrl,
  saveAsSuggestion,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  helpMenuTemplate,
  toggleDevToolsItem,
  settingsMenuItem,
  installRendererProtocol,
  registerRendererScheme,
  rendererUrl,
  MAX_REMOTE_IMAGE_BYTES,
  readBodyCapped,
  recoveryCopyDiskNewer,
  configuredAuthorName,
} from '@vantage/electron-utils'
import { createMainProcessProxyDispatcher } from '@vantage/electron-utils/main-proxy'
import {
  resolveGroupChildId,
  runTxn,
  type Op,
  type OpRecord,
  type TxnRequest,
  type TxnResult,
  mapScriptOps,
} from '@vantage/pptx-ops'
import { matchesElementRef } from '@vantage/pptx-engine/identity'
import { buildPagePptx, parsePageSpec } from '@vantage/pipelines/slides'
import { convertOdpToPptx } from '../../../../packages/odf2ooxml/src'
import { sniffImageMime } from './media-mime'
import {
  newPasteCascade,
  pageKey,
  pasteShiftPx,
  recordPaste,
  type PasteCascade,
} from './paste-cascade'
import {
  ELEMENT_CLIPBOARD_FORMAT,
  canWriteElementClipboardImage,
  elementClipboardMarkerMatches,
  isElementClipboardToken,
  writeElementClipboardImage,
} from './element-clipboard'
import { getUiLang, normalizeLang, setUiLang } from '@vantage/i18n'
import { ProjectStore } from '@vantage/project-store'
import {
  copyElementData,
  findGroupChild,
  patchBodyPrAutofit,
  getElementLink,
  getSlideLinks,
  getRunLinks,
  readHeaderFooter,
  createBlankPptx,
  setSlideSize,
  copySlide,
  type SlideBundle,
  listSlideLayouts,
  editChartElement,
  getChartElementData,
  materializeSlide,
  listMasterParts,
  parseMasterPart,
  EMU_PER_PT,
  slideDurableId,
  getSlideComments,
  getSlideNotes,
  getSlideTransition,
  elementSpid,
  narrationSpids,
  getSlideAdvanceTime,
  getSlideAnimations,
  listEmbeddedFonts,
  openPptx,
  mergeSlideFromPptx,
  extractMergeSlideSource,
  type MergeSlideSource,
  promoteSlideBackground,
  autofitGeneratedTextBoxes,
  parseTheme,
  reparseDeck,
  savePptx,
  savePptxToFile,
  commitSaved,
  builtinLayoutInfos,
  ensureBuiltinLayout,
  shouldOfferBuiltinLayouts,
  BUILTIN_LAYOUT_PREFIX,
  getSections,
  normalizeSections,
  type SectionInfo,
  type ElementClipboardItem,
  type OpenedPptx,
  type Paragraph,
  type Slide,
  type TextElement,
} from '@vantage/pptx-engine'
import {
  buildRenderSlide,
  layoutText,
  makeViewport,
  EMU_PER_PX_96,
  imageDpiFromBytes,
  type RenderSlide,
  type RenderTextLayout,
} from '@vantage/pptx-render'
// From its own electron-utils subpath rather than the package barrel: the
// barrel drags Electron-only modules into headless bundles.
import { atomicWriteFile } from '@vantage/electron-utils/atomic-write'
import { SlidesDraftController } from './slides-draft-controller'
import {
  freezeSlidesDraft,
  serializeSlidesDraft,
  slidesDraftRevision,
} from './slides-draft-package'
import { notesPartIndex, writeNotesPart } from '../shared/notes-target'
import { DEFAULT_PICTURE_DPI, pictureFrame } from './picture-frame'
import { refineComplexWidths, shapedMetricsReady } from './shaped-metrics'
import { cfbKind, isCfbHeader } from './cfb-sniff'
import { unplayableAudioCodec } from './mp4-audio-sniff'
import { audioFrame, videoFrame, videoSize, type Point, type Size } from './video-size'
import { AUDIO_EXTS, VIDEO_EXTS } from '../shared/media-kinds'
import { baseName } from '../shared/base-name'
import { OPENABLE_DECK_EXTENSIONS, deckExtension } from '../shared/deck-open-formats'
import type {
  AddChartOp,
  AddCommentOp,
  AddElementOp,
  AddImageBytesOp,
  AddInkOp,
  ReplacePictureBytesOp,
  AddModel3dOp,
  SetModel3dViewOp,
  AddMediaBytesOp,
  AddMediaResult,
  AddBlankSlideOp,
  AddSlideOp,
  PasteSlideOp,
  PasteSlideResult,
  CopySlidesOp,
  DeleteSlidesOp,
  DuplicateSlidesOp,
  MoveSlidesOp,
  SetSlidesHiddenOp,
  RepasteSlideOp,
  AddSlideWithLayoutOp,
  AddSmartArtOp,
  AddTableOp,
  ApplyThemeOp,
  HeaderFooterOp,
  SetLinkOp,
  CopyElementsOp,
  DeleteCommentOp,
  DeleteElementOp,
  DeleteElementsOp,
  EditBackgroundOp,
  EditFillOp,
  GradientFillSpec,
  EditFillImageOp,
  EditStrokeOp,
  FlipElementOp,
  EditPictureSrcRectOp,
  GroupElementsOp,
  UngroupElementOp,
  BatchEditTransformOp,
  EditTextOp,
  EditTransformOp,
  EditTransformMultiOp,
  EditConnectorEndpointsOp,
  SetShapeGeometryOp,
  SetElementFontOp,
  SetElementParagraphFormatOp,
  FindReplaceOp,
  TableMergeIpcOp,
  SetSlideLayoutOp,
  SetSlideSizeOp,
  MasterEditTextOp,
  MasterEditTransformOp,
  MasterEditFillOp,
  MasterEditStrokeOp,
  MasterDeleteElementOp,
  MasterAddElementOp,
  MasterEnterResult,
  PrintSlidesOp,
  EditPictureOpacityOp,
  ExportImagesOp,
  ExportImagesResult,
  SavePictureOp,
  SavePictureResult,
  ExportPdfOp,
  ExportPdfResult,
  OpenResult,
  PasteElementsOp,
  DuplicateElementsOp,
  EditTableCellOp,
  EditTableStyleOp,
  EditChartOp,
  SetTableColWidthOp,
  SetTableRowHeightOp,
  SetTableCellAnchorOp,
  TableStructureIpcOp,
  ReorderElementOp,
  SaveRecordingOp,
  SetAdvanceTimesOp,
  ShowTiming,
  SetAnimationsOp,
  SetNotesOp,
  SetSlideHiddenOp,
  SetTransitionOp,
  AddSectionOp,
  RenameSectionOp,
  RemoveSectionOp,
  RemoveSectionSlidesOp,
  MoveSectionOp,
  MoveSlideOp,
  ApplyEditScriptOp,
  ApplyTxnOp,
  ApplyTxnResult,
  AnimationItem,
  ShapeKey,
  SetEffectsPatch,
} from '../shared/ipc'
import { DECK_LINK_PROTOCOLS } from '../shared/run-link'
import { planSlideDuplicates, planSlideMoves } from '../shared/slide-selection'
import { buildPrintDocumentHtml } from '../shared/print-html'

import { tm } from './i18n-main'
import { tiffToPng } from './tiff-decode'
import {
  attachedIds,
  editorAttachedIds,
  beginHistoryBatch,
  buildAllRenderSlides,
  buildSlideUpdate,
  carryHistoryForReplacement,
  dialogParent,
  endCapturedHistoryBatch,
  getFontMetrics,
  hostWindowFor,
  resetFontMetrics,
  journalOps,
  makeMediaResolver,
  markMetaDirty,
  pushHistory,
  rebuildSlide,
  readSlideMedia,
  rebuildSlideWithReparse,
  registerAiSnapshot,
  restoreAiSnapshot,
  restoreSnapshot,
  settleStaleHistoryBatch,
  runtime,
  scheduleDeckBroadcast,
  scheduleHistoryNotify,
  setActiveSlidesWebContents,
  sessions,
  viewerWcIds,
  showChrome,
  takeSnapshot,
  windowRefs,
  type OpLogEntry,
  type Session,
} from './session-state'
import { registerAiIpc, registerSlidesOnlyAiIpc } from './ai-ipc'
import { listPrivateFontFaces, getPrivateFontData, registerEmbeddedFonts } from './fonts'
import { listMetafileFonts } from './metafile-fonts'
import {
  downloadFontFamily,
  initFontStore,
  installLocalFontFiles,
  listFontCatalog,
  missingCatalogFonts,
} from './font-store'

/** One slide, copied from any deck open in this process, waiting to be pasted into another. */
let slideClipboard: { bundles: SlideBundle[]; pngs?: string[] } | null = null

/** The immediately preceding slide paste per webContents, so the paste-options floater can redo it with another mode. */
const lastSlidePaste = new Map<number, { afterIndex: number; undoLen: number; changed: number[] }>()

// Generated single-page pptx: marker strings travel in pageMarkers slots; only paths issued
// by slides:local-page-generate are readable (the renderer can't point the reader at arbitrary files)
const GENERATED_PAGE_PREFIX = 'genpptx:'
const issuedGeneratedPages = new Set<string>()
import { registerPresenterIpc } from './presenter-show'
import { registerAttachmentIpc } from './attachments-ipc'

export {
  configureSlidesRuntime,
  setActiveSlidesWebContents,
  setSlidesShellWindow,
  setSlidesHostWindowHook,
  setSlidesShowBleed,
} from './session-state'

/** IPC gradient → engine stop list (full stop list wins over the two-color from/to form). */
const gradientStops = (g: GradientFillSpec['gradient']): Array<{ pos: number; color: string }> =>
  g.stops?.length
    ? g.stops
    : [
        { pos: 0, color: g.from },
        { pos: 1, color: g.to },
      ]

/** IPC gradient → path kind (radial is a legacy alias for circle; undefined = linear). */
const gradientPathKind = (
  g: GradientFillSpec['gradient'],
): 'circle' | 'rect' | 'shape' | undefined => g.path ?? (g.radial ? 'circle' : undefined)

/** IPC gradient focus point → <a:fillToRect> insets (undefined when unspecified). */
const gradientFillTo = (
  g: GradientFillSpec['gradient'],
): { l: number; t: number; r: number; b: number } | undefined =>
  g.center ? { l: g.center.x, t: g.center.y, r: 1 - g.center.x, b: 1 - g.center.y } : undefined
export { registerAiIpc } from './ai-ipc'

/** standalone: path queued before window creation (argv/open-file) */
let pendingOpenPath: string | null = null
/** tab mode: each view queues its own path; the renderer consumes it after mounting */
const pendingByWc = new Map<number, string>()
/**
 * Renderer freeze watchdog: the freeze is sporadic and has never
 * reproduced under instrumentation, so when it does happen, capture the
 * discriminating evidence (per-process CPU/RSS, GPU feature state, and on
 * macOS native thread stacks of the renderer/GPU processes) and give
 * the user a way out. Reload restores from the main-side session, and the
 * 30s recovery draft bounds the loss for a force-quit instead.
 */
const freezeDialogOpen = new Set<number>()

async function handleRendererFreeze(wc: WebContents): Promise<void> {
  const ts = Date.now()
  try {
    const appMetrics = app.getAppMetrics()
    const diagnostics = {
      at: new Date().toISOString(),
      webContentsId: wc.id,
      sessionPath: sessions.get(wc.id)?.path ?? null,
      dirty: slidesIsDirty(wc.id),
      appMetrics,
      gpuFeatureStatus: app.getGPUFeatureStatus(),
    }
    await writeFile(
      join(app.getPath('userData'), `freeze-diagnostics-${ts}.json`),
      JSON.stringify(diagnostics, null, 2),
    )
    // macOS: native thread stacks of the renderer + GPU processes, taken from
    // outside the frozen event loop (task_for_pid based, so it works even when
    // a CDP attach suppresses the hang monitor and Runtime.evaluate is stuck).
    // This is the discriminating evidence for the freeze: a renderer main thread
    // parked in gpu::CommandBufferProxyImpl::WaitFor* confirms the GPU
    // command-buffer-wait hypothesis. Best effort — `sample` is denied for
    // hardened-runtime builds without the get-task-allow entitlement.
    if (process.platform === 'darwin') {
      const gpuPid = appMetrics.find((m) => m.type === 'GPU')?.pid
      const targets: Array<[string, number | undefined]> = [
        ['renderer', wc.getOSProcessId()],
        ['gpu', gpuPid],
      ]
      for (const [label, pid] of targets) {
        if (!pid) continue
        const out = join(app.getPath('userData'), `freeze-stacks-${ts}-${label}-${pid}.txt`)
        // Fire and forget: sampling runs for ~3s and must not delay the dialog
        execFile('/usr/bin/sample', [String(pid), '3', '-file', out], () => {})
      }
    }
  } catch {
    /* diagnostics must never make the freeze worse */
  }
  if (freezeDialogOpen.has(wc.id)) return
  freezeDialogOpen.add(wc.id)
  try {
    const parent = hostWindowFor(wc)
    const options = {
      type: 'warning' as const,
      message: tm('freezeTitle'),
      detail: tm('freezeBody'),
      buttons: [tm('freezeWait'), tm('freezeReload')],
      defaultId: 0,
      cancelId: 0,
    }
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    if (response === 1 && !wc.isDestroyed()) {
      wc.forcefullyCrashRenderer()
      wc.reload()
    }
  } finally {
    freezeDialogOpen.delete(wc.id)
  }
}

function trackSlidesWebContents(wc: WebContents): void {
  windowRefs.activeWebContents = wc
  slidesDraftOwners.add(wc.id)
  wc.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(!isMainFrame)return;void historyBatches.retireFrames(wc).catch(reportHistoryBatchFailure);toolSaves.cancel(wc.id,'Renderer navigation retired the prior source.');rendererSources.delete(wc.id);slidesDrafts.retire(wc.id);slidesPendingEdits.delete(wc.id)})
  wc.on('render-process-gone', () => {
    void historyBatches.retireFrames(wc).catch(reportHistoryBatchFailure)
    toolSaves.destroy(wc.id)
    slidesCrashedViews.add(wc.id)
    slidesDrafts.retire(wc.id)
    slidesPendingEdits.delete(wc.id)
  })
  wc.on('unresponsive', () => void handleRendererFreeze(wc))
  // The AI panel opens links via window.open; route them to the system
  // browser instead of spawning an in-app window with remote content.
  wc.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url)
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  wc.once('destroyed', () => {
    void historyBatches.destroy(wc).catch(reportHistoryBatchFailure)
    slidesOutputSelections.forget(wc)
    headlessOutputSelectionIds.delete(wc.id)
    toolSaves.destroy(wc.id)
    slidesDrafts.retire(wc.id)
    slidesDraftOwners.delete(wc.id)
    slidesCrashedViews.delete(wc.id)
    slidesPendingEdits.delete(wc.id)
    rendererSources.delete(wc.id)
    const candidate=sourceCandidates.get(wc.id);if(candidate){clearTimeout(candidate.timer);sourceCandidates.delete(wc.id)}
    const query=nativeQueries.get(wc.id);if(query){clearTimeout(query.timer);nativeQueries.delete(wc.id);query.reject(new Error('The presentation renderer was destroyed.'))}
    sessions.delete(wc.id)
    pendingByWc.delete(wc.id)
    lastSlidePaste.delete(wc.id)
    closeSaveWaiters.get(wc.id)?.(false)
    closeSaveWaiters.delete(wc.id)
    closeFlushWaiters.get(wc.id)?.(false)
    closeFlushWaiters.delete(wc.id)
    autoSavePrefByWc.delete(wc.id)
    if (windowRefs.activeWebContents === wc) windowRefs.activeWebContents = null
  })
}

// ── In-app element clipboard (app-wide, so elements copied in one deck paste into any other open deck; the cascade decides the paste offset) ─
let elementClipboard: {
  items: ElementClipboardItem[]
  cascade: PasteCascade
  token: string
  senderId: number
} | null = null

/** Shell hook: a view opened a file (including ⌘O inside a tab) — used to update tab titles and de-duplicate paths */
let slidesOpenedHook: ((wc: WebContents, path: string) => void) | null = null
export function setSlidesOpenedHook(fn: ((wc: WebContents, path: string) => void) | null): void {
  slidesOpenedHook = fn
}

/** Detached editor windows (createSlidesWindow), keyed by webContents id — their titles are owned here */
const standaloneWindows = new Map<number, BrowserWindow>()

/**
 * A shared session's path changed (Save As): sync every attached surface — the
 * shell tab title/path of tab-hosted windows (via the opened hook; a no-op for
 * non-tab webContents) and the window title of detached editors. Without this a
 * Save As from a detached window left the shell tab on the old path, breaking
 * open-by-path dedupe.
 */
function syncAttachedPaths(session: Session, path: string): void {
  for (const id of attachedIds(session)) {
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) continue
    slidesOpenedHook?.(wc, path)
    // Peer renderers keep the path in React state (Save As defaults, path-keyed
    // guides); the saver also gets it from its own IPC result — idempotent
    wc.send('slides:renamed', path)
    const win = standaloneWindows.get(id)
    if (win && !win.isDestroyed()) win.setTitle(basename(path))
  }
}

/**
 * savePptxToFile streams into whatever path it is given and truncates it
 * first, so the deck goes out through a sibling temp that is renamed over
 * `filePath` only once the stream has finished: a save that dies mid-way —
 * the app killed, power lost — leaves the previous deck on disk, not a
 * cut-off one. The password path already gets this from atomicWriteFile.
 */

/**
 * MCP save: write a visible session's deck to an explicit path with no dialogs
 * — the slides:save-as pipeline minus the dialog. Overwrite policy is the
 * caller's (the MCP tool layer guards clobbering); this commits the save side
 * effects: session path, recents, attached-surface titles, dirty-flag reset.
 */
const publicationBySession=new WeakMap<Session,DocumentPublication>()
function publicationForSession(session:Session):DocumentPublication{let publication=publicationBySession.get(session);if(!publication){if(session.path)throw new Error('The presentation has no verified loaded file version. Reload or Save As a separate copy; unsaved work is retained.');publication=new DocumentPublication();publicationBySession.set(session,publication)}return publication}
const sessionSaveTails=new WeakMap<Session,Promise<unknown>>()
export async function saveSessionDeckTo(session:Session,filePath:string,selection?:PublicationSelection):Promise<void>{
 const publication=publicationForSession(session),callSource=selection?.source??publication.snapshot()
 const prior=sessionSaveTails.get(session)
 const write=(async()=>{
  if(prior)await prior.catch(()=>{})
  const loaded=callSource
  const target=selection?.target??(loaded.path===filePath?undefined:absentPublicationTarget(filePath))
  await mkdir(dirname(filePath),{recursive:true})
  const revision=mainCloseRevision(session)
  // Capture before the first serializer await; fonts/XML/saveSnapshot mutate only this inert package.
  const frozen=await publishSlidesDocument(publication,filePath,{source:loaded,target},()=>captureSlidesSave(session.opened),(snapshot,temporary)=>savePptxToFile(snapshot,temporary))
  // Publication remains valid even if the editor was replaced while writing.
  if(!attachedIds(session).length)return
  const previousPath=session.path||null
  session.path=filePath;slidesDrafts.rename(session,previousPath,filePath)
  if(adoptSlidesSave(session.opened,frozen,revision,mainCloseRevision(session)))session.metaDirty=false
  await pushRecent(filePath)
  if(session.path===filePath)syncAttachedPaths(session,filePath)
 })()
 sessionSaveTails.set(session,write)
 try{await write}finally{if(sessionSaveTails.get(session)===write)sessionSaveTails.delete(session)}
}

const rendererSources=new Map<number,string>()
const nativeCloseAdmission=new NativeCloseAdmission<Session>()
const ownership=new SlidesSessionOwnership<Session>({source:owner=>sessions.get(owner),identity:owner=>currentSourceIdentity(owner),batch:source=>source.historyBatch,changed:session=>invalidateToolCloseForSession(session)})
function reportHistoryBatchFailure(_error:unknown):void{queueRecoveryWarning('slides-history-batch','Presentation history cleanup is still pending. Keep this presentation open and retry after its operation finishes.')}
type OwnedHistoryBatch=NonNullable<Session['historyBatch']>
const historyBatches=new SlidesHistoryBatches<WebContents,Session,OwnedHistoryBatch>({
 source:owner=>sessions.get(owner.id),
 begin:source=>{beginHistoryBatch(source);const batch=source.historyBatch;if(!batch)throw new Error('History batch creation did not complete.');return batch},
 carriers:(batch,origin,owner)=>[...new Set([sessions.get(owner.id),...sessions.values(),origin])].filter((source):source is Session=>!!source&&source.historyBatch===batch),
 sameBatch:(source,batch)=>source.historyBatch===batch,
 actualBatchSources:batch=>ownership.actualBatchSources(batch),closed:batch=>batch.depth<=0,
 hold:source=>ownership.holdBatch(source),pause:source=>ownership.pauseOrdinary(source),waitActual:source=>ownership.waitActual(source),actualIdle:source=>ownership.actualIdle(source),
 finish:(source,batch,carriers)=>ownership.finishBatch(source,()=>{const before=endCapturedHistoryBatch(source,batch,carriers);return before?registerAiSnapshot(source,before):null}),
 report:reportHistoryBatchFailure,
})
const historyBatchFrames=new WeakMap<object,string>()
function historyBatchFrame(event:Electron.IpcMainInvokeEvent):string{
 const frame=event.senderFrame,current=event.sender.mainFrame
 if(event.sender.isDestroyed()||!frame||frame!==current)throw new Error('History batches require the exact main renderer frame.')
 let identity=historyBatchFrames.get(frame)
 if(!identity){identity=randomUUID();historyBatchFrames.set(frame,identity)}
 return identity
}
configureSlidesMutationGuard(source=>ownership.assert(source as Session))
configureSlidesOwnedInvokes((channel,event,args,handler)=>{
 const envelope=args.at(-1) as {__slidesAuthoredSource?:unknown}|undefined
 const expected=rendererSources.get(event.sender.id)
 if(envelope&&typeof envelope==='object'&&'__slidesAuthoredSource'in envelope){args=args.slice(0,-1);if(channel!=='slides:draft-activate'&&envelope.__slidesAuthoredSource!==expected&&!(expected===undefined&&envelope.__slidesAuthoredSource===''))throw new Error('This operation belongs to a retired presentation renderer source.')}
 else if(expected&&channel!=='slides:draft-activate')throw new Error('A presentation operation is missing its source identity.')
 const pure=channel==='slides:draft-activate'||channel==='slides:source-confirm'||channel.startsWith('slides:tool-save-')||channel.startsWith('slides:close-')||channel.startsWith('slides:draft-')||channel.startsWith('slides:get-')||channel.startsWith('slides:font-')||channel==='slides:is-dirty'||channel==='slides:recent'||channel==='slides:media-data'||channel==='slides:model3d-data'||['ai:get-settings','ai:gsk-status','ai:gsk-login','ai:stream','ai:stream-cancel','ai:web-search','ai:image-search','ai:generate-image','ai:analyze-media','ai:list-style-templates','ai:load-style-template'].includes(channel)
 if(channel==='slides:save'){
  const source=sessions.get(event.sender.id),release=source?nativeCloseAdmission.write(source,args[0]===true):undefined
  if(release===null)return {ok:true,deferred:true}
  try{return Promise.resolve(ownership.run(event.sender.id,()=>handler(event,...args),pure)).finally(()=>release?.())}catch(error){release?.();throw error}
 }
 return ownership.run(event.sender.id,()=>handler(event,...args),pure)
})

function currentSourceIdentity(owner:number):string{return rendererSources.get(owner)??''}
function mainCloseRevision(session:Session):string{return draftRevision(session)+':'+ownership.revision(session)}
const toolSaves:SlidesToolSaveBroker=new SlidesToolSaveBroker({
 state:owner=>{const source=sessions.get(owner),contents=webContents.fromId(owner);return source?{source,identity:currentSourceIdentity(owner),token:slidesDrafts.tokenFor(owner),revision:mainCloseRevision(source),dirty:slidesIsDirty(owner),busy:ownership.busy(source)||!!source.historyBatch||!!contents&&historyBatches.busy(contents)}:null},
 send:(owner,channel,value)=>{const contents=webContents.fromId(owner);if(contents&&!contents.isDestroyed())contents.send(channel,value)},
 write:async(owner,source,path,overwrite,publicationSelection)=>{
  const session=source as Session
  if(sessions.get(owner)!==session)throw new Error('The presentation source changed before saving.')
  const target=path||session.path||pickDraftPath(getDraftsDir(),tm('untitledDeck'))
  if(!overwrite&&existsSync(target))return{ok:false,path:target,error:'The destination already exists.'}
  await saveSessionDeckTo(session,target,publicationSelection)
  return{ok:true,path:target,dirty:sessionDirty(session),slides:buildAllRenderSlides(session.opened,session.fitWidthPx)}
 },
 stage:(owner,through)=>{
  const producer:ReturnType<SlidesDraftController['stageClose']>=slidesDrafts.stageClose(owner,through)
  const source=sessions.get(owner),id=randomUUID()
  let admission:ReturnType<typeof beginCloseCleanup>
  try{admission=beginCloseCleanup({id,module:'slides',ownerKey:String(owner),source:currentSourceIdentity(owner),generation:through,token:producer.token,documentPath:source?.path||null,ready:producer.ready,custody:{recoveryRoot:join(app.getPath('userData'),'recovery'),draftId:producer.token,attest:producer.attest},run:signal=>producer.cleanup(signal)})}catch(error){producer.cancel();throw error}
  return{producer,admission}
 },
})
export async function requestSlidesToolSave(wcId:number,path:string,overwrite:boolean,options?:{requireClean?:boolean}){
 const session=sessions.get(wcId);if(!session)throw new Error('The presentation is not open.')
 const publication=publicationForSession(session),source=publication.snapshot(),target=path&&(overwrite||path!==source.path)?await observePublicationTarget(path):undefined
 if(path===source.path&&target&&!target.version)throw new Error('The original presentation was moved or deleted. Use Save As a separate copy; current work is retained.')
 if(sessions.get(wcId)!==session||publication.snapshot()!==source)throw new Error('The presentation source changed while its explicit destination was being checked.')
 return toolSaves.request(wcId,path,overwrite,options?.requireClean===true,'save',undefined,{}, {source,target})
}
export function cancelSlidesToolSave(wcId:number,requestId:string):void{toolSaves.cancelRequest(wcId,requestId)}
export function completeSlidesToolClose(wcId:number,requestId:string,close:()=>boolean):boolean{return toolSaves.completeClose(wcId,requestId,close)}
function invalidateToolCloseForSession(session:Session):void{for(const id of attachedIds(session))toolSaves.invalidateReady(id)}
export async function prepareSlidesClose(contents:WebContents,filePath?:string,intent:SlidesCloseIntent='save',approvedStamp?:CloseLeaseStamp,options:SlidesClosePrepareOptions={}):Promise<SlidesNativeCloseReceipt>{
 if(!slidesClosePermit(options))throw new Error('The close operation is no longer current.')
 const session=sessions.get(contents.id);if(!session)throw new Error('The presentation is no longer open.')
 const publication=publicationForSession(session),source=publication.snapshot(),target=intent==='save'&&filePath&&filePath!==source.path?await observePublicationTarget(filePath):undefined
 if(sessions.get(contents.id)!==session||publication.snapshot()!==source||!slidesClosePermit(options))throw new Error('The presentation source or close operation changed while its destination was being checked.')
 const receipt=await toolSaves.request(contents.id,filePath??session.path??'',true,true,intent,approvedStamp,options,{source,target})
 if(!slidesClosePermit(options)||receipt.phase!=='prepared'&&receipt.phase!=='ready'){toolSaves.cancelRequest(contents.id,receipt.requestId);throw new Error('The document could not be confirmed ready to close.')}
 return receipt as SlidesNativeCloseReceipt
}
export function isSlidesClosePrepared(contents:WebContents,receipt:SlidesToolSaveCompletion):boolean{return!contents.isDestroyed()&&toolSaves.isPrepared(contents.id,receipt)}
export function sealSlidesClose(contents:WebContents,receipt:SlidesToolSaveCompletion):SlidesNativeCloseReceipt|null{return contents.isDestroyed()?null:toolSaves.seal(contents.id,receipt)}
export function completeSlidesClose(contents:WebContents,receipt:SlidesToolSaveCompletion,removeSync:()=>boolean):boolean{return toolSaves.completeReceipt(contents.id,receipt,removeSync)}
export async function cancelSlidesClose(contents:WebContents,receipt:SlidesToolSaveCompletion,reason?:string):Promise<void>{toolSaves.cancelRequest(contents.id,receipt.requestId)}
const nativeQueries=new Map<number,{id:string;resolve(value:SlidesCloseQuery):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>()
function querySlidesClose(contents:WebContents):Promise<SlidesCloseQuery>{if(nativeQueries.has(contents.id))return Promise.reject(new Error('A presentation close query is still pending.'));return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{nativeQueries.delete(contents.id);reject(new Error('The renderer did not certify its current pending editors; recovery is retained.'))},5_000);nativeQueries.set(contents.id,{id,resolve,reject,timer});contents.send('slides:close-query',id)})}
export async function prepareSlidesNativeClose(contents:WebContents,parent?:BrowserWindow|null,options:SlidesClosePrepareOptions={}):Promise<SlidesNativeCloseReceipt|null>{
 if(contents.isDestroyed()||slidesCrashedViews.has(contents.id))throw new Error('An unresponsive presentation cannot certify Save/Discard close. Recovery is retained.')
 return runSlidesNativeClose({holdAutomaticSaves:()=>{const source=sessions.get(contents.id);return source&&!ownership.busy(source)?nativeCloseAdmission.hold(contents.id,source):null},alive:()=>!contents.isDestroyed(),source:()=>sessions.get(contents.id),revision:source=>mainCloseRevision(source),dirty:()=>slidesIsDirty(contents.id),autoSave:source=>!!autoSavePrefByWc.get(contents.id)&&!!source.path,query:()=>querySlidesClose(contents),prompt:async()=>{const promptOptions={type:'warning' as const,message:tm('closeUnsavedMsg'),detail:tm('closeUnsavedDetail'),buttons:[tm('menuSave'),tm('btnDontSave'),tm('btnCancel')],defaultId:0,cancelId:2,noLink:true};const {response}=parent&&!parent.isDestroyed()?await dialog.showMessageBox(parent,promptOptions):await dialog.showMessageBox(promptOptions);return response},prepare:(source,intent,approved,permit)=>prepareSlidesClose(contents,source.path||undefined,intent,approved,permit),cancel:receipt=>cancelSlidesClose(contents,receipt,'The native close group ended after preparation.'),warning:error=>warnSlidesDraft(contents.id,error)},options)
}

const RECENT_PATH = () => join(app.getPath('userData'), 'slides-recent.json')

/** Settings → General author name, falling back to the OS account */
function commentAuthorName(): string {
  return configuredAuthorName(app)
}

async function readRecent(): Promise<string[]> {
  try {
    const raw = await readFile(RECENT_PATH(), 'utf8')
    return (JSON.parse(raw) as string[]).filter((p) => existsSync(p))
  } catch {
    return []
  }
}

/** the raw recent list, for the shell's folder bookkeeping (no existence filter) */
export function readSlidesRecentFiles(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(RECENT_PATH(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

async function pushRecent(path: string): Promise<void> {
  // A headless export is not a document the user opened.
  if (isHeadlessMode()) return
  const cur = await readRecent()
  const next = [path, ...cur.filter((p) => p !== path)].slice(0, 10)
  try {
    await writeFile(RECENT_PATH(), JSON.stringify(next), 'utf8')
  } catch {
    /* best-effort */
  }
}

/** File renamed externally (shell Home list rename): swap the old path in the recent list for the new one (keeping its position). */
export async function replaceSlidesRecentFile(oldPath: string, newPath: string): Promise<void> {
  try {
    // Do not use readRecent(): it filters out old paths that no longer exist, so the map would miss
    const raw = await readFile(RECENT_PATH(), 'utf8')
    const cur = JSON.parse(raw) as string[]
    await writeFile(
      RECENT_PATH(),
      JSON.stringify(cur.map((p) => (p === oldPath ? newPath : p))),
      'utf8',
    )
  } catch {
    /* best-effort */
  }
}

/** Shell notification: an open view's file was renamed — sync the session path (subsequent
 *  saves write the new file) and push to the renderer to update the editor title bar. */
const publicationRenameTails=new WeakMap<Session,Promise<void>>()
export async function slidesFileRenamed(wc:WebContents,oldPath:string,newPath:string):Promise<void>{
 const session=sessions.get(wc.id);if(!session)return
 const prior=publicationRenameTails.get(session);if(prior)await prior
 if(session.path===newPath){if(!wc.isDestroyed())wc.send('slides:renamed',newPath);return}
 if(session.path!==oldPath)return
 ownership.assert(session)
 invalidateToolCloseForSession(session)
 const refresh=(async()=>{await publicationForSession(session).rebindMoved(oldPath,newPath,()=>sessions.get(wc.id)===session&&session.path===oldPath);session.path=newPath;slidesDrafts.rename(session,oldPath,newPath)})()
 publicationRenameTails.set(session,refresh)
 try{await refresh;if(!wc.isDestroyed())wc.send('slides:renamed',newPath)}finally{if(publicationRenameTails.get(session)===refresh)publicationRenameTails.delete(session)}
}

// ── Autosave (crash recovery): dirty sessions write a recovery copy every 30s; a normal save cleans it up ──
const autosaveDir = () => join(app.getPath('userData'), 'slides-autosave')
const autosavePathFor = (filePath: string) =>
  join(autosaveDir(), `${createHash('sha1').update(filePath).digest('hex').slice(0, 16)}.pptx`)

function sessionDirty(session: Session): boolean {
  return (
    !!session.metaDirty ||
    session.opened.deck.slides.some(
      (s) =>
        s.structureDirty ||
        s.elements.some(
          (el) =>
            el.dirty ||
            el.dirtyTransform ||
            el.dirtyFill ||
            el.dirtyStroke ||
            el.dirtySrcRect ||
            el.dirtyPPr,
        ),
    )
  )
}

const slidesDraftOwners = new Set<number>()
const slidesCrashedViews = new Set<number>()
const slidesPendingEdits = new Map<number, boolean>()
const slidesDrafts:SlidesDraftController = new SlidesDraftController({
  revisionFor: (owner) => {
    const session = sessions.get(owner)
    return session ? draftRevision(session) : null
  },
  recoveryRoot: () => join(app.getPath('userData'), 'recovery'),
  sourceFor: (owner) => sessions.get(owner),
  isLive: (owner) =>
    slidesDraftOwners.has(owner) &&
    !viewerWcIds.has(owner) &&
    webContents.fromId(owner)?.isDestroyed() === false,
  retaining:(owner):boolean=>toolSaves.retaining(owner),
  capture: (owner, pending) => {
    const session = sessions.get(owner)
    if (!session) throw new Error('This presentation is no longer open.')
    const frozen = freezeSlidesDraft(session, pending)
    return () => serializeSlidesDraft(frozen)
  },
})
const draftRevision = slidesDraftRevision
function warnSlidesDraft(owner: number, error: unknown): void {
  const contents = webContents.fromId(owner)
  if (contents && !contents.isDestroyed()) contents.send('slides:draft-warning', String(error))
}
export async function discardActiveSlidesDraft(id: string): Promise<boolean> {
  for (const owner of slidesDraftOwners) {
    if(!slidesDrafts.ownsToken(owner,id))continue
    toolSaves.cancel(owner,'An explicit recovery deletion canceled the pending close; its retained custody remains separately reviewable.')
    const session = sessions.get(owner)
    const discarded = slidesDrafts.discardCurrent(owner)
    const contents = webContents.fromId(owner)
    if (contents && !contents.isDestroyed())
      contents.send('slides:draft-discarded', {
        token: id,
        revision: session ? draftRevision(session) : '',
      })
    await discarded
    return true
  }
  return false
}

// ── Close guard (aligned with sheets/pdf): dirty sessions prompt Save/Don't Save/Cancel before closing a tab/window ──
const closeSaveWaiters = new Map<number, (ok: boolean) => void>()
const closeFlushWaiters = new Map<number, (ok: boolean) => void>()
/** Autosave toggle mirrored from the renderer: files with it on save silently on close and proceed, no dialog */
const autoSavePrefByWc = new Map<number, boolean>()

ipcMain.on('slides:autosave-pref', (event, on: unknown) => {
  autoSavePrefByWc.set(event.sender.id, on === true)
})

ipcMain.on('slides:close-save-result', (event, ok: unknown) => {
  const waiter = closeSaveWaiters.get(event.sender.id)
  if (!waiter) return
  closeSaveWaiters.delete(event.sender.id)
  waiter(ok === true)
})
ipcMain.on('slides:close-flush-result', (event, ok: unknown) => {
  const waiter = closeFlushWaiters.get(event.sender.id)
  if (!waiter) return
  closeFlushWaiters.delete(event.sender.id)
  waiter(ok === true)
})
function requestRendererFlush(contents: WebContents): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      closeFlushWaiters.delete(contents.id)
      resolve(false)
    }, 120000)
    closeFlushWaiters.set(contents.id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    contents.send('slides:close-flush-request')
  })
}

/** Ask the renderer to run the full save flow and await the result (failure/timeout = false). */
function requestRendererSave(contents: WebContents): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      closeSaveWaiters.delete(contents.id)
      resolve(false)
    }, 120_000)
    closeSaveWaiters.set(contents.id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    contents.send('slides:close-save-request')
  })
}

export function slidesIsDirty(webContentsId: number): boolean {
  const session = sessions.get(webContentsId)
  return !!session && (sessionDirty(session) || slidesPendingEdits.get(webContentsId) === true)
}

/**
 * Close guard for the slides renderer: true means proceed with closing.
 * Clean -> true; with changes -> Save/Don't Save/Cancel. Choosing Save asks the renderer to run
 * the existing save flow (flushNotes + adoptSavedSlides + Save As dialog for untitled) and
 * awaits the result; on failure/timeout stay open.
 */
export async function requestSlidesClose(_contents:WebContents,_parent?:BrowserWindow|null):Promise<boolean>{throw new Error('Use prepareSlidesNativeClose + completeSlidesClose around the actual synchronous removal; a boolean cannot retain close authority.')}

/**
 * Drop a session's crash-recovery copies without saving — the dialog-free
 * counterpart of answering "Don't Save" in `requestSlidesClose`, for the MCP
 * `open_documents` discard path (which must not raise a prompt the user did not
 * start). Without this the autosave copy survives, and the next open offers to
 * restore edits the caller explicitly discarded.
 */
export async function discardSlidesRecovery(contents: WebContents): Promise<void> {
  const session = sessions.get(contents.id)
  const token = slidesDrafts.tokenFor(contents.id)
  const discarded = slidesDrafts.discardCurrent(contents.id)
  if (token && !contents.isDestroyed())
    contents.send('slides:draft-discarded', {
      token,
      revision: session ? draftRevision(session) : '',
    })
  await discarded
  if (session?.path) void rm(autosavePathFor(session.path), { force: true }).catch(() => {})
}

/** On open, if a recovery copy exists, ask whether to restore (still points at the original path; only save persists it).
 * A newer original does not discard the copy — it may hold the only pre-crash edits — the prompt just says the disk file is newer. */
async function maybeRecoverBytes(
  path: string,
  original: Uint8Array,
): Promise<{ bytes: Uint8Array; recovered: boolean }> {
  const asPath = autosavePathFor(path)
  let diskNewer: boolean
  try {
    const [asStat, origStat] = await Promise.all([stat(asPath), stat(path)])
    diskNewer = recoveryCopyDiskNewer(asStat.mtimeMs, origStat.mtimeMs)
  } catch {
    return { bytes: original, recovered: false }
  }
  const parent = dialogParent()
  const options = {
    type: 'question' as const,
    buttons: [tm('autosaveRestore'), tm('autosaveDiscard')],
    defaultId: 0,
    cancelId: 1,
    message: tm('autosaveFoundTitle'),
    detail: diskNewer
      ? `${tm('autosaveFoundBody')}\n\n${tm('autosaveDiskNewer')}`
      : tm('autosaveFoundBody'),
  }
  const r = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (r.response === 0) {
    const bytes = await readFile(asPath)
    return { bytes: new Uint8Array(bytes), recovered: true }
  }
  await rm(asPath, { force: true })
  return { bytes: original, recovered: false }
}

/**
 * An .odp opens only as a converted .pptx deck: confirm the lossy import,
 * pick the destination (the sibling .pptx by default), convert, write the
 * file and open it — the explicit-destination flow the PDF "Export as
 * PowerPoint" path already uses, so every later Save lands in the copy the
 * user chose. Anything that is not an .odp passes through unchanged; null
 * cancels the open.
 */
async function preparePresentationForOpen(filePath: string): Promise<string | null> {
  const extension = deckExtension(filePath)
  if (extension !== 'odp' && extension !== 'otp') return filePath
  const parent = dialogParent()
  const options = {
    type: 'warning' as const,
    message: tm('odpImportMsg', { ext: extension }),
    detail: tm('odpImportDetail'),
    buttons: [tm('odpImportConvertBtn'), tm('btnCancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (response !== 0) return null
  const r = await showSaveDialogWithMemory(
    dialog,
    parent,
    {
      defaultPath: join(dirname(filePath), basename(filePath).replace(/\.(odp|otp)$/i, '.pptx')),
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
    },
    getDraftsDir(),
  )
  if (r.canceled || !r.filePath) return null
  try {
    await publishSelectedUserOutput(r.filePath,async()=>{
      const result=await convertOdpToPptx(new Uint8Array(await readFile(filePath)))
      return Buffer.from(result.pptx)
    },{sourcePaths:[filePath]})
  } catch {
    const errorOptions = {
      type: 'error' as const,
      message: tm('odpImportFailedTitle'),
      detail: tm('odpImportFailedBody'),
    }
    if (parent) await dialog.showMessageBox(parent, errorOptions)
    else await dialog.showMessageBox(errorOptions)
    return null
  }
  return r.filePath
}

/**
 * .ppt (97-2003 binary compound document) and encrypted OOXML are unsupported: show an actionable message instead of a parse error.
 * Detection uses the magic number rather than the extension -- a binary ppt with a renamed suffix is caught too. A CFB containing an
 * EncryptedPackage stream is a password-protected pptx and gets dedicated copy (instead of being mislabeled as the legacy format).
 */
async function rejectLegacyPpt(path: string): Promise<boolean> {
  let head: Buffer
  try {
    const fh = await open(path, 'r')
    try {
      head = Buffer.alloc(8)
      await fh.read(head, 0, 8, 0)
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
  if (!isCfbHeader(head)) return false
  let kind: 'legacy' | 'encrypted' = 'legacy'
  try {
    kind = cfbKind(await readFile(path)) ?? 'legacy'
  } catch {
    // on read failure, fall back to the legacy-format message
  }
  const parent = dialogParent()
  const options = {
    type: 'warning' as const,
    buttons: [tm('legacyPptOk')],
    message: tm(kind === 'encrypted' ? 'encryptedPptxTitle' : 'legacyPptTitle'),
    detail: tm(kind === 'encrypted' ? 'encryptedPptxBody' : 'legacyPptBody'),
  }
  if (parent) await dialog.showMessageBox(parent, options)
  else await dialog.showMessageBox(options)
  return true
}

/** Register the deck's usable embedded fonts before layout; new faces invalidate cached metrics. */
function adoptEmbeddedFonts(opened: OpenedPptx): void {
  try {
    if (registerEmbeddedFonts(listEmbeddedFonts(opened.archive))) resetFontMetrics()
  } catch {
    // Embedded fonts are best-effort: a malformed fntdata must never block opening
  }
  // Metafile pictures draw text through canvas fonts: resolving their facenames here puts the
  // Office-private faces (Yu Gothic UI, MS PGothic…) on the renderer's private-font list before
  // the EMF/WMF previews rasterize.
  try {
    const metrics = getFontMetrics()
    for (const f of listMetafileFonts(opened.archive))
      metrics.displayFamily?.({
        fontFamily: f.family,
        fontSizePx: 100,
        bold: f.bold,
        italic: f.italic,
      })
  } catch {
    // best-effort as well
  }
}

interface SourceCandidate {carryHistory:boolean;id:string;previous:Session|undefined;candidate:Session;result:OpenResult;timer:ReturnType<typeof setTimeout>}
const sourceCandidates=new Map<number,SourceCandidate>()
function prepareSourceCandidate(contents:WebContents,candidate:Session,result:OpenResult,carryHistory=false):OpenResult{
 const prior=sourceCandidates.get(contents.id);if(prior)clearTimeout(prior.timer)
 if(!prior&&sourceCandidates.size>=16)throw new Error('Too many presentation sources are being prepared.')
 const id=randomUUID(),entry:SourceCandidate={carryHistory,id,previous:sessions.get(contents.id),candidate,result,timer:setTimeout(()=>{if(sourceCandidates.get(contents.id)?.id===id)sourceCandidates.delete(contents.id)},120_000)}
 sourceCandidates.set(contents.id,entry)
 return{...result,sourceCandidateId:id}
}
async function confirmSourceCandidate(contents:WebContents,id:string):Promise<boolean>{
 const entry=sourceCandidates.get(contents.id)
 if(!entry||entry.id!==id||sessions.get(contents.id)!==entry.previous)throw new Error('The prepared presentation was superseded; the current editor was retained.')
 const receipt=entry.previous?await prepareSlidesNativeClose(contents,hostWindowFor(contents)):null
 if(entry.previous&&!receipt)return false
 try{
  const adopt=()=>ownership.run(contents.id,()=>{
   if(sourceCandidates.get(contents.id)!==entry||sessions.get(contents.id)!==entry.previous)return false
   if(entry.carryHistory)carryHistoryForReplacement(entry.previous,entry.candidate)
   ownership.adopt(contents.id,entry.candidate)
   slidesDrafts.retire(contents.id)
   sessions.set(contents.id,entry.candidate);rendererSources.delete(contents.id);slidesPendingEdits.delete(contents.id)
   sourceCandidates.delete(contents.id);clearTimeout(entry.timer);scheduleHistoryNotify(entry.candidate)
   return true
  },true)
  const adopted=receipt?completeSlidesClose(contents,receipt,adopt):adopt()
  if(adopted){contents.send('slides:source-adopted',entry.result);if(entry.candidate.path){slidesOpenedHook?.(contents,entry.candidate.path);void pushRecent(entry.candidate.path)}}
  return adopted
 }finally{if(receipt)await cancelSlidesClose(contents,receipt)}
}
async function openAndBuild(wc:WebContents,path:string,fitWidthPx:number):Promise<OpenResult>{
 const wanted=resolve(path)
 for(const[id,existing]of sessions){if(id===wc.id||!existing.path||resolve(existing.path)!==wanted)continue
  return prepareSourceCandidate(wc,existing,{path:existing.path,slides:buildAllRenderSlides(existing.opened,fitWidthPx),size:{cx:existing.opened.deck.size.cx,cy:existing.opened.deck.size.cy},defaultFont:deckDefaultFont(existing.opened)})
 }
 const loaded=await readPublicationFile(path,()=>readFile(path)),raw=Buffer.from(loaded.bytes)
 const{bytes,recovered}=await maybeRecoverBytes(path,raw.length===0?await createBlankPptx():new Uint8Array(raw))
 await shapedMetricsReady()
 const opened=await openPptx(bytes);adoptEmbeddedFonts(opened)
 const candidate:Session={path,opened,fitWidthPx,undoStack:[],redoStack:[],...(recovered?{metaDirty:true}:{})}
 publicationBySession.set(candidate,new DocumentPublication(loaded.binding))
 let slides=buildAllRenderSlides(opened,fitWidthPx)
 if(await refineComplexWidths(wc))slides=buildAllRenderSlides(opened,fitWidthPx)
 return prepareSourceCandidate(wc,candidate,{path,slides,size:{cx:opened.deck.size.cx,cy:opened.deck.size.cy},defaultFont:deckDefaultFont(opened)})
}

/** Directory where AI-generated drafts are saved: the configurable default save folder (falls back to <Documents>/Vantage) */
function getDraftsDir(): string {
  return configuredDefaultSaveDir(app)
}

/** Fallback draft filename: <untitled label>-YYYYMMDD-HHmmss.pptx */
function newDraftFilename(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${tm('untitledDraft')}-${date}-${time}.pptx`
}

/** Sanitize an AI-provided topic/title into a safe filename base: strip illegal path chars, collapse whitespace, cap length; null if invalid. */
function sanitizeDraftBaseName(raw: string | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Strip leading/trailing dots (Windows disallows a trailing dot; a hidden-file prefix is meaningless here)
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!cleaned) return null
  return cleaned.length > 40 ? cleaned.slice(0, 40).trim() : cleaned
}

/** Pick a draft path from deckName: append -2/-3… if a same-named file exists; fall back to timestamp naming without a valid deckName. */
function pickDraftPath(draftsDir: string, deckName?: string): string {
  const base = sanitizeDraftBaseName(deckName)
  if (base) {
    let candidate = join(draftsDir, `${base}.pptx`)
    for (let i = 2; existsSync(candidate) && i < 100; i++) {
      candidate = join(draftsDir, `${base}-${i}.pptx`)
    }
    if (!existsSync(candidate)) return candidate
  }
  return join(draftsDir, newDraftFilename())
}

/**
 * Auto-save the draft to <Documents>/Vantage/<name>.pptx after AI generation completes.
 * Append mode reuses the session's existing draft path (overwrite); replace mode generates a
 * new filename. On successful write, update session.path, pushRecent, slidesOpenedHook.
 * On write failure, degrade silently (console.warn) without blocking the in-memory session.
 */
async function saveDraftAfterGenerate(
  wc: WebContents,
  session: Session,
  bytes: Uint8Array,
  mode: 'replace' | 'append',
  deckName?: string,
): Promise<void> {
  try {
    const draftsDir = getDraftsDir()
    // Ensure the directory exists
    if (!existsSync(draftsDir)) mkdirSync(draftsDir, { recursive: true })

    // Append mode: overwrite if the session already has a draft path; otherwise create a new file too
    let draftPath: string
    if (mode === 'append' && session.path && session.path.startsWith(draftsDir)) {
      draftPath = session.path
    } else {
      draftPath = pickDraftPath(draftsDir, deckName)
    }

    const publication=publicationForSession(session),loaded=publication.snapshot(),ticket=publication.pin(draftPath,loaded.path===draftPath?undefined:absentPublicationTarget(draftPath),loaded)
    await publication.publishBytes(ticket,()=>bytes)
    if(sessions.get(wc.id)!==session&&attachedIds(session).length)throw new Error('The source changed during generated publication; its bytes were retained without adopting an obsolete path.')
    const previousPath = session.path || null
    session.path = draftPath
    slidesDrafts.rename(session, previousPath, draftPath)
    syncAttachedPaths(session, draftPath)
    await pushRecent(draftPath)
    slidesOpenedHook?.(wc, draftPath)
  } catch (err) {
    console.warn(
      '[slides] Failed to persist AI-generated draft to disk; the in-memory session still works:',
      err,
    )
  }
}

/** Theme body (minor) Latin font: fallback shown in the ribbon font box when the selection has no text element. */
function deckDefaultFont(opened: OpenedPptx): string | undefined {
  try {
    const slidePath = opened.archive.readPresentation().slidePaths[0]
    if (!slidePath) return undefined
    const themePath = opened.archive.resolveSlideChain(slidePath).themePath
    const xml = themePath ? opened.archive.readText(themePath) : undefined
    return xml ? parseTheme(xml).minorFont : undefined
  } catch {
    return undefined
  }
}

function findEl(slide: Slide, sourceId: string): TextElement | undefined {
  const el = slide.elements.find((e) => matchesElementRef(e, sourceId))
  if (el && (el.type === 'text' || el.type === 'shape')) return el as TextElement
  return undefined
}

// The single funnel for non-dry transactions in this module: every applied
// batch lands in the session's op journal (collab groundwork).
function journaledTxn(
  session: Session,
  source: Exclude<OpLogEntry['source'], 'reset'>,
  req: TxnRequest,
): TxnResult {
  invalidateToolCloseForSession(session)
  const r = runTxn(session.opened, req)
  if (r.applied) {
    journalOps(session, source, r.records ?? [])
    scheduleDeckBroadcast(session)
  }
  return r
}

/**
 * AI batch surface core, shared by the `slides:apply-txn` IPC handler and the
 * shell's MCP slides bridge (one implementation so both stay behaviorally
 * identical): raw ops arrive as one transaction. The registry validates (guided
 * errors), the executor owns atomicity/rollback/journal; dry-run rehearses the
 * plan without touching the deck or its history.
 */
export function applySessionTxn(session: Session, req: ApplyTxnOp): ApplyTxnResult | null {
  const ops = Array.isArray(req?.ops) ? (req.ops as Parameters<typeof runTxn>[1]['ops']) : []
  if (ops.length === 0 || ops.length > 50) {
    return {
      applied: false,
      failures: [
        { index: 0, error: 'ops must be a non-empty array (at most 50 per transaction).' },
      ],
    }
  }
  const isolation = req.isolation === 'per_op' ? ('per_op' as const) : ('atomic' as const)
  const compact = (fails?: Array<{ index: number; error: string }>) =>
    fails?.map((f) => ({ index: f.index, error: f.error }))
  if (req.dryRun) {
    const r = runTxn(session.opened, { ops, isolation, dryRun: true })
    return {
      applied: false,
      dryRun: true,
      plan: r.plan ?? [],
      ...(r.failures?.length ? { failures: compact(r.failures) } : {}),
    }
  }
  // Plan before pushing history (a no-op request must not clear the redo stack)
  const plan = runTxn(session.opened, { ops, isolation, dryRun: true })
  const invalid = plan.failures?.length ?? 0
  if (isolation === 'atomic' ? invalid > 0 : invalid >= ops.length) {
    return { applied: false, failures: compact(plan.failures) }
  }
  pushHistory(session)
  const r = journaledTxn(session, 'batch', { ops, isolation })
  if (!r.applied) {
    session.undoStack.pop()
    return { applied: false, failures: compact(r.failures) }
  }
  // Some ops change only package state (setNotes, a theme commit) and leave no
  // element dirty, so without this the session would still look clean and a
  // close could discard the edit. Element-level ops set their own flags; this
  // covers the archive-only ones.
  markMetaDirty(session)
  // Post-pass mirroring the dedicated shims (autofit/reparse are render concerns and live
  // outside the executor): text ops get autofit resize + fontScale write-back, level changes
  // materialize, and XML-patching ops reparse the page so the final render reflects them.
  // Slides are re-found by the executor-stamped durable id: a numeric target.slide drifts
  // when a later structural op (deleteSlide/moveSlide/duplicateSlide) shifts pages.
  const slideIdxOf = (rec: OpRecord): number => {
    if (rec.slideId)
      return session.opened.deck.slides.findIndex((s) => slideDurableId(s) === rec.slideId)
    return -1
  }
  const renderedByIdx = new Map<number, ReturnType<typeof rebuildSlide>>()
  for (const rec of r.records ?? []) {
    const o = rec.op
    const idx = slideIdxOf(rec)
    if (idx < 0) continue
    if (o.op === 'setTableStyle' || o.op === 'setChart') {
      rebuildSlideWithReparse(session, idx)
      renderedByIdx.delete(idx)
      continue
    }
    const id = o.target?.el
    if (!id || o.group) continue
    if (o.op !== 'setText' && o.op !== 'setFont' && o.op !== 'setParagraphFormat') continue
    if (o.op === 'setText' && (rec.after as { levelDirty?: boolean } | undefined)?.levelDirty)
      continue
    if (
      o.op === 'setParagraphFormat' &&
      (o.format as { indentDelta?: number } | undefined)?.indentDelta
    ) {
      materializeSlide(session.opened, idx)
      renderedByIdx.delete(idx)
      continue
    }
    let rendered = renderedByIdx.has(idx) ? renderedByIdx.get(idx)! : rebuildSlide(session, idx)
    rendered = applyAutofitResize(session, idx, id, rendered)
    rendered = syncAutofitScale(session, idx, id, rendered)
    renderedByIdx.set(idx, rendered)
  }
  return {
    applied: true,
    records: (r.records ?? []).map((rec) => ({
      op: rec.op.op,
      ...(rec.op.target
        ? { target: `${rec.op.target.slide}${rec.op.target.el ? `/${rec.op.target.el}` : ''}` }
        : {}),
      ...(rec.created ? { created: rec.created } : {}),
      ...(opNote(rec) ? { note: opNote(rec) } : {}),
    })),
    ...(r.failures?.length ? { failures: compact(r.failures) } : {}),
    slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
  }
}

/**
 * spAutoFit (autofit='resize', "resize shape to fit text"): after a text change, the box height
 * grows/shrinks with the content and is written back to cy; a wrap="none" body (PowerPoint's
 * click-to-type text box) also follows its widest line in cx. rendered = the rebuilt result
 * after this change; when the size changed, update the transform and rebuild once more.
 * Top-level elements only (group children use a different coordinate system, skip).
 */
function applyAutofitResize(
  session: Session,
  slideIndex: number,
  sourceId: string,
  rendered: RenderSlide | null,
): RenderSlide | null {
  if (!rendered) return rendered
  const slide = session.opened.deck.slides[slideIndex]
  const el = slide ? findEl(slide, sourceId) : undefined
  if (!el?.text || el.text.autofit !== 'resize') return rendered
  const node = rendered.nodes.find((n) => n.sourceId === el.id)
  if (!node || (node.type !== 'shape' && node.type !== 'text') || !node.text) return rendered
  const text = node.text
  const needH = text.contentHeight + text.insets.t + text.insets.b
  const needW = !text.wrap && !text.vert ? nowrapContentWidth(text) : node.box.w
  if (Math.abs(needH - node.box.h) < 1 && Math.abs(needW - node.box.w) < 1) return rendered
  const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
  const scale = session.fitWidthPx / baseWidthPx
  const toEmu = (px: number) => Math.max(Math.round((px / scale) * EMU_PER_PX_96), 1)
  // A nowrap box grows around its alignment: right-aligned text keeps the right edge, centered keeps the center
  const align = text.lines[0]?.align
  const shiftX =
    align === 'right' ? node.box.w - needW : align === 'center' ? (node.box.w - needW) / 2 : 0
  el.transform = {
    ...el.transform,
    offset: {
      ...el.transform.offset,
      x: el.transform.offset.x + Math.round((shiftX / scale) * EMU_PER_PX_96),
      cx: toEmu(needW),
      cy: toEmu(needH),
    },
  }
  el.dirtyTransform = true
  return rebuildSlide(session, slideIndex)
}

/** Box width a nowrap body needs: widest laid-out line plus the insets (an empty body keeps the insets alone). */
function nowrapContentWidth(text: RenderTextLayout): number {
  let left = Infinity
  let right = -Infinity
  for (const line of text.lines)
    for (const run of line.runs) {
      left = Math.min(left, run.x)
      right = Math.max(right, run.x + run.widthPx)
    }
  const content = right > left ? right - left : 0
  return content + text.insets.l + text.insets.r
}

/**
 * normAutofit fontScale write-back: when the shrink ratio the layout actually used after a text
 * edit (≤ the stored cap, shrink-only) differs from the stored model value, sync the model and
 * patch the bodyPr attribute — only then does PowerPoint show the same size on open.
 * Triggered only by text edits (resize gestures do not write: the layout cap locks the stored
 * value, and writing back during a gesture would ratchet one way); top-level elements only.
 */
const opNote = (rec: { after?: unknown }) => (rec.after as { note?: string } | undefined)?.note

function syncAutofitScale(
  session: Session,
  slideIndex: number,
  sourceId: string,
  rendered: RenderSlide | null,
): RenderSlide | null {
  if (!rendered) return rendered
  const slide = session.opened.deck.slides[slideIndex]
  const el = slide ? findEl(slide, sourceId) : undefined
  if (!el?.text || el.text.autofit !== 'shrink') return rendered
  const node = rendered.nodes.find((n) => n.sourceId === el.id)
  if (!node || (node.type !== 'shape' && node.type !== 'text') || !node.text) return rendered
  // The plain render honors the stored fontScale as-is (PowerPoint-on-open semantics);
  // after a text edit, re-run the layout with the autofit ladder enabled to find the
  // ratio PowerPoint would now use (still capped at the stored value).
  const refit = layoutText({
    body: el.text,
    boxWidthPx: node.box.w,
    boxHeightPx: node.box.h,
    metrics: getFontMetrics(),
    vp: makeViewport(session.opened.deck.size, session.fitWidthPx),
    refitAutofit: true,
  })
  const effective = refit.fontScale
  const effectiveRed = refit.lnSpcReduction ?? 0
  if (
    Math.abs(effective - (el.text.fontScale ?? 1)) < 0.005 &&
    Math.abs(effectiveRed - (el.text.lnSpcReduction ?? 0)) < 0.005
  )
    return rendered
  el.text.fontScale = effective
  if (effectiveRed) el.text.lnSpcReduction = effectiveRed
  else delete el.text.lnSpcReduction
  el.anchor.originalXml = patchBodyPrAutofit(el.anchor.originalXml, effective, effectiveRed)
  slide!.structureDirty = true
  // The render above used the pre-edit stored scale; redo it at the written-back value
  return rebuildSlide(session, slideIndex) ?? rendered
}

/** Legacy fixed color schemes (AI tools/old files still pass these keys; kept as fallback). */
const CHART_COLOR_SCHEMES: Record<string, string[]> = {
  default: [],
  blue: ['#2E75B6', '#4472C4', '#5B9BD5', '#70AD47', '#ED7D31'],
  warm: ['#ED7D31', '#FFC000', '#FF0000', '#C55A11', '#833C00'],
  cool: ['#0070C0', '#00B0F0', '#00B0A0', '#7030A0', '#2E75B6'],
  mono: ['#404040', '#666666', '#888888', '#AAAAAA', '#CCCCCC'],
}

/** PowerPoint default theme accent sequence (fallback when the deck has no theme colors). */
const FALLBACK_ACCENTS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']

/** Mix a hex color with black/white by ratio (for mono-gradient steps). */
function mixHex(hex: string, target: number, ratio: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hex
  const v = parseInt(m[1]!, 16)
  const ch = (x: number) => Math.round(x + (target - x) * ratio)
  const r = ch((v >> 16) & 255)
  const g = ch((v >> 8) & 255)
  const b = ch(v & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase()}`
}

/** Current deck's theme accent1..6 (read from the theme part of the first slide's inheritance chain). */
function deckAccents(opened: OpenedPptx): string[] {
  const slide = opened.deck.slides[0]
  if (!slide) return FALLBACK_ACCENTS
  try {
    const chain = opened.archive.resolveSlideChain(slide.path)
    const xml = chain.themePath ? opened.archive.readText(chain.themePath) : null
    const colors = xml ? parseTheme(xml).colors : undefined
    const acc = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
      .map((k) => colors?.[k])
      .filter((c): c is string => !!c)
    return acc.length >= 3 ? acc : FALLBACK_ACCENTS
  } catch {
    return FALLBACK_ACCENTS
  }
}

/** Theme-derived color schemes for the chart "Change Colors" gallery: two colorful sets + one mono gradient per accent. */
function chartColorSchemes(
  opened: OpenedPptx,
): Array<{ key: string; label: string; colors: string[] }> {
  const acc = deckAccents(opened)
  const rot = [...acc.slice(3), ...acc.slice(0, 3)]
  const mono = (c: string) => [
    mixHex(c, 0, 0.25),
    c,
    mixHex(c, 255, 0.25),
    mixHex(c, 255, 0.45),
    mixHex(c, 255, 0.65),
  ]
  return [
    { key: 'default', label: tm('schemeThemeDefault'), colors: [] },
    { key: 'colorful', label: tm('schemeColorful'), colors: acc },
    { key: 'colorful2', label: tm('schemeColorful2'), colors: rot },
    ...acc.map((c, i) => ({
      key: `mono-accent${i + 1}`,
      label: tm('schemeMono', { n: i + 1 }),
      colors: mono(c),
    })),
  ]
}

/** After a successful Slides → PDF export: open the file in a PDF tab (shell)
 * or reveal it in the folder (standalone). Tab-opening failure must not
 * report the export itself as failed — the file is already persisted. */
function openExportedPdf(path: string): void {
  // Headless export must stay silent: no tab, no Finder window.
  if (isHeadlessMode()) return
  try {
    if (runtime.openGeneratedPath?.(path)) return
  } catch (err) {
    console.warn('[slides] Failed to open exported PDF:', err)
  }
  shell.showItemInFolder(path)
}

let ipcRegistered = false

export function registerSlidesIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  slidesOwnedHandle('slides:source-confirm',(event,id:string)=>confirmSourceCandidate(event.sender,id))
  slidesOwnedHandle('slides:close-claim',(event,ticket:CloseLeaseTicket)=>toolSaves.claim(event.sender.id,ticket))
  slidesOwnedHandle('slides:close-cancel',(event,ticket:CloseLeaseTicket,reason:string)=>{toolSaves.cancelRequest(event.sender.id,ticket?.id)})
  ipcMain.on('slides:close-query-result',(event,value:SlidesCloseQuery)=>{const pending=nativeQueries.get(event.sender.id);if(!pending||value?.id!==pending.id||typeof value.dirty!=='boolean'||typeof value.pending!=='boolean'||!isCloseLeaseStamp(value.stamp)||value.stamp.source!==currentSourceIdentity(event.sender.id)||(value.unsupported!==undefined&&(typeof value.unsupported!=='string'||value.unsupported.length>2000)))return;nativeQueries.delete(event.sender.id);clearTimeout(pending.timer);pending.resolve(value)})
  slidesOwnedHandle('slides:tool-save-probe', (event, identity: SlidesToolSaveIdentity) => toolSaves.probe(event.sender.id, identity))
  slidesOwnedHandle('slides:tool-save-write', (event, identity: SlidesToolSaveIdentity) => toolSaves.publish(event.sender.id, identity))
  ipcMain.on('slides:tool-save-result', (event, value: unknown) => { void toolSaves.finish(event.sender.id, value) })
  slidesOwnedHandle('slides:tool-save-cancel', (event, requestId: unknown) => toolSaves.cancelRequest(event.sender.id, requestId))
  slidesOwnedHandle('slides:draft-activate', (event, path: unknown,identity:unknown) => {
    try {
      if(typeof identity!=='string'||identity.length>1024||!/^[-a-f0-9]{36}:\d+$/.test(identity))throw new Error('Presentation activation needs its renderer document generation.')
      const prior=rendererSources.get(event.sender.id)
      if(prior&&prior!==identity)toolSaves.cancel(event.sender.id,'A new presentation source retired the pending close.')
      // Ordinary source authority remains usable even if optional recovery activation refuses.
      rendererSources.set(event.sender.id,identity)
      slidesPendingEdits.delete(event.sender.id)
      slidesCrashedViews.delete(event.sender.id)
      requireRecoveryRuntime('Presentation automatic recovery activation')
      const token=slidesDrafts.activate(event.sender.id,path)
      return{ok:true,token}
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
  slidesOwnedHandle('slides:draft-write', async (event, request: unknown) => {
    try {
      requireRecoveryRuntime('Presentation automatic recovery capture')
      return { ok: true, skipped: !(await slidesDrafts.snapshot(event.sender.id, request)) }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
  slidesOwnedHandle('slides:draft-saved', async (event, request: unknown) => {
    try {
      const value = request as { clean?: unknown } | null
      const source = sessions.get(event.sender.id)
      const guarded =
        value && typeof value.clean === 'boolean'
          ? {
              ...value,
              clean:
                value.clean &&
                !!source &&
                !sessionDirty(source) &&
                !slidesPendingEdits.get(event.sender.id),
            }
          : request
      await slidesDrafts.acknowledgeSaved(event.sender.id, guarded)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
  slidesOwnedHandle('slides:draft-state', (event) => {
    const session = sessions.get(event.sender.id)
    return session ? { revision: draftRevision(session), dirty: sessionDirty(session) } : null
  })
  ipcMain.on('slides:draft-pending', (event, value: unknown) => {
    const request = value as { token?: unknown; dirty?: unknown } | null
    if (
      request &&
      typeof request.token === 'string' &&
      typeof request.dirty === 'boolean' &&
      slidesDrafts.tokenFor(event.sender.id) === request.token
    )
      {slidesPendingEdits.set(event.sender.id,request.dirty);const session=sessions.get(event.sender.id);if(request.dirty&&session)ownership.assert(session)}
  })
  // AI-generated slide pages land in app-owned temp directories; sweep
  // expired ones at startup (never at land time — markers can be redeemed
  // more than once), mirroring the sheets pasted-file cleanup.
  void cleanupExpiredGeneratedPages(app.getPath('temp'))

  // shared with the other editor modules — last (identical) registration wins
  ipcMain.removeHandler('app:get-language')
  slidesOwnedHandle('app:get-language', () => getUiLang())

  // Screen recording: source dispatch for the renderer's navigator.mediaDevices.getDisplayMedia.
  // macOS prefers the system picker (with its permission flow), falling back to the first screen.
  void app.whenReady().then(() => {
    electronSession.defaultSession.protocol.handle('vantage-slide-media', (request) => {
      const media = readSlideMedia(request.url)
      if (!media) return new Response(null, { status: 404 })
      return new Response(media.body as BodyInit, {
        headers: {
          'Content-Type': media.mime,
          'Content-Length': String(media.body.byteLength),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      })
    })
    try {
      electronSession.defaultSession.setDisplayMediaRequestHandler(
        (_request, callback) => {
          desktopCapturer
            .getSources({ types: ['screen', 'window'] })
            .then((sources) => {
              if (sources[0]) callback({ video: sources[0] })
              else callback({})
            })
            .catch(() => callback({}))
        },
        { useSystemPicker: true },
      )
    } catch {
      /* Older Electron lacks this API: the screen-record button will get no stream and report failure */
    }
  })

  slidesOwnedHandle('slides:private-font-faces', () => listPrivateFontFaces())
  slidesOwnedHandle('slides:private-font-data', (_e, id: string) => getPrivateFontData(id))

  initFontStore()
  // Fonts changed (download or local install): rebuild every open session with a fresh
  // registry and push the relaid-out slides + a re-sync ping to all attached windows.
  const afterFontsChanged = (): void => {
    resetFontMetrics()
    const seen = new Set<Session>()
    for (const [wcId, session] of sessions) {
      if (seen.has(session)) continue
      seen.add(session)
      const payload = {
        slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
        size: { cx: session.opened.deck.size.cx, cy: session.opened.deck.size.cy },
      }
      for (const id of attachedIds(session))
        webContents.fromId(id)?.send('slides:deck-changed', payload)
      void wcId
    }
    for (const wc of webContents.getAllWebContents()) wc.send('slides:fonts-changed')
  }
  slidesOwnedHandle('slides:font-catalog', () => listFontCatalog())
  slidesOwnedHandle('slides:font-download', async (_e, family: string) => {
    try {
      await downloadFontFamily(family)
      afterFontsChanged()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  slidesOwnedHandle('slides:font-install-local', async () => {
    const r = await showOpenDialogWithMemory(dialog, dialogParent(), {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'ttc', 'otc'] }],
    })
    if (r.canceled || !r.filePaths.length) return { families: [] }
    const families = installLocalFontFiles(r.filePaths)
    if (families.length) afterFontsChanged()
    return { families }
  })
  slidesOwnedHandle('slides:font-missing', (e) => {
    const session = sessions.get(e.sender.id)
    return session ? missingCatalogFonts(session.opened) : []
  })

  // Shared shim core: one undo step wrapping a transaction; on failure the step is
  // erased (the executor already restored the model, so history stays consistent).
  // Handlers keep only surface translation and result shaping around this.
  // Plan first: pushHistory clears the redo stack (and can evict the oldest undo
  // entry at the cap), so an invalid request must not touch history at all —
  // legacy handlers validated existence before their history push.

  const sessionTxn = (
    session: Session,
    req: TxnRequest,
    source: Exclude<OpLogEntry['source'], 'reset'> = 'edit',
  ): TxnResult | null => {
    const plan = runTxn(session.opened, { ...req, dryRun: true })
    const invalid = plan.failures?.length ?? 0
    if ((req.isolation ?? 'atomic') === 'atomic' ? invalid > 0 : invalid >= req.ops.length)
      return null
    pushHistory(session)
    const r = journaledTxn(session, source, req)
    if (!r.applied) {
      session.undoStack.pop()
      return null
    }
    return r
  }

  slidesOwnedHandle('slides:open', async (e, fitWidthPx: number) => {
    const parent = dialogParent()
    const options = {
      properties: ['openFile' as const],
      filters: [{ name: 'PowerPoint', extensions: [...OPENABLE_DECK_EXTENSIONS] }],
    }
    const r = await showOpenDialogWithMemory(dialog, parent, options)
    if (r.canceled || !r.filePaths[0]) return null
    const prepared = await preparePresentationForOpen(r.filePaths[0])
    if (!prepared) return null
    if (await rejectLegacyPpt(prepared)) return null
    return openAndBuild(e.sender, prepared, fitWidthPx)
  })

  slidesOwnedHandle('slides:open-path', async (e, path: string, fitWidthPx: number) => {
    if (!path || !existsSync(path)) return null
    const prepared = await preparePresentationForOpen(path)
    if (!prepared) return null
    if (await rejectLegacyPpt(prepared)) return null
    return openAndBuild(e.sender, prepared, fitWidthPx)
  })

  slidesOwnedHandle('slides:consume-pending-open', async (e, fitWidthPx: number) => {
    // renderer app just mounted: safe to reveal the vibrancy material behind
    // the (now painted) page without flashing raw desktop during load
    vibFlip.get(e.sender.id)?.('#00000000')
    const queued = pendingByWc.get(e.sender.id) ?? pendingOpenPath
    if (queued && existsSync(queued)) {
      const dropQueued = () => {
        if (pendingByWc.get(e.sender.id) === queued) pendingByWc.delete(e.sender.id)
        if (pendingOpenPath === queued) pendingOpenPath = null
      }
      // A CFB file (legacy .ppt / encrypted, possibly misnamed .pptx) can never
      // parse: tell the user and drop it, or every relaunch restores a blank tab
      const prepared = await preparePresentationForOpen(queued)
      if (!prepared || (await rejectLegacyPpt(prepared))) {
        dropQueued()
        return null
      }
      // Clear the queue only after a successful open: keep it on parse failure or a mid-flight renderer reload, so a remount can retry
      const result = await openAndBuild(e.sender, prepared, fitWidthPx)
      dropQueued()
      return result
    }
    // No queued path but the main process already has a session (remount after an HMR full
    // reload/crash recovery) -> restore from the session; otherwise the document is lost leaving
    // only the start screen, and reopening the same file just activates this empty tab with no
    // way to self-heal
    const session = sessions.get(e.sender.id)
    if (session) {
      session.fitWidthPx = fitWidthPx
      return {
        path: session.path,
        slides: buildAllRenderSlides(session.opened, fitWidthPx),
        size: { cx: session.opened.deck.size.cx, cy: session.opened.deck.size.cy },
        defaultFont: deckDefaultFont(session.opened),
      } satisfies OpenResult
    }
    return null
  })

  // Shim over the canonical setText op (rich-text rebuild, link rels, resource cleanup,
  // level rematerialization live in the op); autofit is a render concern and stays here.
  slidesOwnedHandle('slides:edit-text', (e, op: EditTextOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    pushHistory(session)
    const r = journaledTxn(session, 'edit', {
      ops: [
        {
          op: 'setText',
          target: { slide: op.slideIndex, el: op.sourceId },
          paragraphs: op.paragraphs,
          ...(op.groupId ? { group: op.groupId } : {}),
        },
      ],
    })
    if (!r.applied) {
      session.undoStack.pop()
      return null
    }
    const levelDirty = (r.records?.[0]?.after as { levelDirty?: boolean } | undefined)?.levelDirty
    if (op.groupId || levelDirty) return rebuildSlide(session, op.slideIndex)
    const rendered = applyAutofitResize(
      session,
      op.slideIndex,
      op.sourceId,
      rebuildSlide(session, op.slideIndex),
    )
    return syncAutofitScale(session, op.slideIndex, op.sourceId, rendered)
  })

  // Shim over the canonical setFont op: one per_op transaction covers the whole
  // selection (non-text elements fail their own op and are skipped, matching the
  // legacy "changed if any succeeded" semantics).
  slidesOwnedHandle('slides:set-element-font', (e, op: SetElementFontOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const font = {
      fontFamily: op.fontFamily,
      fontSizePt: op.fontSizePt,
      fontSizeStep: op.fontSizeStep,
      strike: op.strike,
      bold: op.bold,
      italic: op.italic,
      underline: op.underline,
      color: op.color,
    }
    pushHistory(session)
    const r = journaledTxn(session, 'edit', {
      isolation: 'per_op',
      ops: op.sourceIds.map((id) => ({
        op: 'setFont',
        target: { slide: op.slideIndex, el: id },
        font,
        ...(op.groupId ? { group: op.groupId } : {}),
      })),
    })
    if (!r.applied) {
      session.undoStack.pop() // All non-text elements (images etc.): nothing happened, pop the just-pushed history
      return null
    }
    let rendered = rebuildSlide(session, op.slideIndex)
    for (const id of op.sourceIds) {
      rendered = applyAutofitResize(session, op.slideIndex, id, rendered)
      rendered = syncAutofitScale(session, op.slideIndex, id, rendered)
    }
    return rendered
  })

  // Shim over the canonical setParagraphFormat op (same per_op selection semantics as setFont).
  slidesOwnedHandle('slides:set-element-paragraph-format', (e, op: SetElementParagraphFormatOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const format = {
      bullet: op.bullet,
      bulletChar: op.bulletChar,
      bulletFont: op.bulletFont,
      numType: op.numType,
      startAt: op.startAt,
      bulletImage: op.bulletImage,
      bulletHangEmu: op.bulletHangEmu,
      bulletSizePct: op.bulletSizePct,
      bulletColor: op.bulletColor,
      lineSpacingPct: op.lineSpacingPct,
      spaceBeforePt: op.spaceBeforePt,
      spaceAfterPt: op.spaceAfterPt,
      align: op.align,
      rtl: op.rtl,
      indentDelta: op.indentDelta,
    }
    pushHistory(session)
    const r = journaledTxn(session, 'edit', {
      isolation: 'per_op',
      ops: op.sourceIds.map((id) => ({
        op: 'setParagraphFormat',
        target: { slide: op.slideIndex, el: id },
        format,
        ...(op.groupId ? { group: op.groupId } : {}),
      })),
    })
    if (!r.applied) {
      session.undoStack.pop()
      return null
    }
    if (op.indentDelta) {
      // Level changes affect inherited defaults; bake into bytes then reparse
      materializeSlide(session.opened, op.slideIndex)
      return rebuildSlide(session, op.slideIndex)
    }
    let rendered = rebuildSlide(session, op.slideIndex)
    for (const id of op.sourceIds) {
      rendered = applyAutofitResize(session, op.slideIndex, id, rendered)
      rendered = syncAutofitScale(session, op.slideIndex, id, rendered)
    }
    return rendered
  })

  // px→EMU (inverting the viewport scale) for one setTransform. In-group editing: the
  // pixel box is in group-local coords (with ext/chExt scaling baked in); divide out
  // the group scale first, then convert back to the child EMU coordinate system.
  const transformPayload = (
    session: Session,
    slideIndex: number,
    fitWidthPx: number,
    item: Omit<EditTransformOp, 'slideIndex' | 'fitWidthPx' | 'preview'>,
  ) => {
    const slide = session.opened.deck.slides[slideIndex]
    if (!slide) return null
    const childId = item.groupId
      ? resolveGroupChildId(slide, item.groupId, item.sourceId)
      : item.sourceId
    const grpChild = item.groupId ? findGroupChild(slide, item.groupId, childId) : null
    if (item.groupId && !grpChild) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    let box: { x: number; y: number; cx: number; cy: number }
    if (grpChild) {
      const ch = grpChild.grp.childOffset
      const chX = ch?.x ?? grpChild.grp.transform.offset.x
      const chY = ch?.y ?? grpChild.grp.transform.offset.y
      const gExt = grpChild.grp.transform.offset
      const gsx = ch?.cx ? gExt.cx / ch.cx : 1
      const gsy = ch?.cy ? gExt.cy / ch.cy : 1
      box = {
        x: toEmu(item.xPx / gsx) + chX,
        y: toEmu(item.yPx / gsy) + chY,
        cx: toEmu(item.wPx / gsx),
        cy: toEmu(item.hPx / gsy),
      }
    } else {
      box = { x: toEmu(item.xPx), y: toEmu(item.yPx), cx: toEmu(item.wPx), cy: toEmu(item.hPx) }
    }
    return {
      op: 'setTransform' as const,
      target: { slide: slideIndex, el: item.sourceId },
      box,
      rotDeg: item.rotationDeg,
      // Tables redistribute gridCol widths / tr heights so the file matches the frame
      ...(item.groupId ? { group: item.groupId } : { resizeTableGrid: true }),
    }
  }

  // Shim over the canonical setTransform op. Preview-gesture undo bookkeeping is a
  // surface concern and stays here.
  slidesOwnedHandle('slides:edit-transform', (e, op: EditTransformOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const payload = transformPayload(session, op.slideIndex, op.fitWidthPx, op)
    if (!payload) return null
    // Validate BEFORE the preview bookkeeping: a failed first preview must not set
    // transformPreview (later frames would skip pushHistory and the eventual commit
    // would lose its undo step) and must not clear the redo stack.
    if (runTxn(session.opened, { dryRun: true, ops: [payload] }).failures?.length) return null
    // Undo semantics for preview gestures: one whole drag = one undo step.
    // The first preview pushes a pre-gesture snapshot; later previews and the final commit do not.
    let pushed = false
    if (op.preview) {
      if (!session.transformPreview) {
        session.previewRedo = session.redoStack
        pushHistory(session)
        pushed = true
        session.transformPreview = true
      }
    } else if (session.transformPreview) {
      session.transformPreview = false
      session.previewRedo = undefined
    } else {
      pushHistory(session)
      pushed = true
    }
    // Journal only the settled commit: preview frames would flood the ring with
    // intermediate boxes (undo coalesces the gesture the same way via transformPreview).
    const r = op.preview
      ? runTxn(session.opened, { ops: [payload] })
      : journaledTxn(session, 'edit', { ops: [payload] })
    if (!r.applied) {
      // Apply-time failure (e.g. a group-child slice that validation cannot see):
      // unwind everything this call did, including the preview flag it set — a stuck
      // flag would make later frames skip pushHistory and cost the commit its undo step.
      if (pushed) {
        session.undoStack.pop()
        if (op.preview) {
          session.transformPreview = false
          if (session.previewRedo) session.redoStack = session.previewRedo
          session.previewRedo = undefined
        }
      }
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  })

  // Escape mid-resize: the preview frames live in the model and their undo snapshot is the
  // pre-gesture state, so restoring that snapshot and dropping it leaves no trace of the gesture
  slidesOwnedHandle('slides:cancel-transform-preview', (e, op: { slideIndex: number }) => {
    const session = sessions.get(e.sender.id)
    if (!session || !session.transformPreview) return null
    session.transformPreview = false
    const snap = session.undoStack.pop()
    if (snap) restoreSnapshot(session, snap)
    if (session.previewRedo) session.redoStack = session.previewRedo
    session.previewRedo = undefined
    scheduleHistoryNotify(session)
    scheduleDeckBroadcast(session)
    return rebuildSlide(session, op.slideIndex)
  })

  // A multi-selection nudge/rotate: every item commits exactly like edit-transform,
  // the whole batch is one undo step (PowerPoint undoes the action, not each shape).
  slidesOwnedHandle('slides:edit-transform-multi', (e, op: EditTransformMultiOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const ops: NonNullable<ReturnType<typeof transformPayload>>[] = []
    for (const item of op.items) {
      const payload = transformPayload(session, op.slideIndex, op.fitWidthPx, item)
      if (!payload) return null
      ops.push(payload)
    }
    if (!ops.length) return null
    const r = sessionTxn(session, { ops })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  // Connector endpoint drag: box+flip re-derived from the two endpoints;
  // attach/detach writes a:stCxn/a:endCxn so the connector follows later shape moves
  slidesOwnedHandle('slides:edit-connector-endpoints', (e, op: EditConnectorEndpointsOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'setConnectorEndpoints',
          target: { slide: op.slideIndex, el: op.sourceId },
          p1: { x: toEmu(op.x1Px), y: toEmu(op.y1Px) },
          p2: { x: toEmu(op.x2Px), y: toEmu(op.y2Px) },
          start: op.start,
          end: op.end,
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  // Read-only: RenderSlide for every page of the current session (E2E driver/debug use, no state change)
  slidesOwnedHandle('slides:get-render-slides', (e) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    return session.opened.deck.slides.map((_, i) => rebuildSlide(session, i))
  })

  // Shim: the whole selection is one atomic transaction of setTransform ops — the
  // executor's plan step reproduces the legacy "every element must exist" gate.
  slidesOwnedHandle('slides:batch-edit-transform', (e, op: BatchEditTransformOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const r = sessionTxn(session, {
      ops: op.items.map((item) => ({
        op: 'setTransform',
        target: { slide: op.slideIndex, el: item.sourceId },
        box: { x: toEmu(item.xPx), y: toEmu(item.yPx), cx: toEmu(item.wPx), cy: toEmu(item.hPx) },
        rotDeg: item.rotationDeg,
        // Legacy parity: the batch path never redistributed table grids
      })),
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  // AI batch surface: raw ops arrive as one transaction — the shared core in
  // applySessionTxn (validation, atomicity/rollback/journal, autofit render pass)
  // is the same code the shell's MCP slides bridge drives.
  slidesOwnedHandle('slides:apply-txn', (e, req: ApplyTxnOp): ApplyTxnResult | null => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    return applySessionTxn(session, req)
  })

  // The whole edit script as ONE transaction: the collected primitives arrive in a
  // single IPC, compile to ops (script-map), and apply atomically — the executor
  // owns validation, rollback and the journal. Autofit is a render concern and
  // stays here, mirroring the per-op shims the script used to fan out to.
  slidesOwnedHandle('slides:apply-edit-script', (e, op: ApplyEditScriptOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const ops = mapScriptOps(session.opened, op)
    if (ops.length === 0) return null
    const plan = runTxn(session.opened, { ops, dryRun: true })
    if (plan.failures?.length) return { error: plan.failures[0]!.error }
    pushHistory(session)
    const r = journaledTxn(session, 'script', { ops })
    if (!r.applied) {
      session.undoStack.pop()
      return { error: r.failures?.[0]?.error ?? 'the transaction could not be applied' }
    }
    let rendered = rebuildSlide(session, op.slideIndex)
    const notes: string[] = []
    for (const rec of r.records ?? []) {
      const o = rec.op
      const id = o.target?.el
      const note = opNote(rec)
      if (note) notes.push(`${id ?? o.op}: ${note}`)
      if (!id || o.group || !rendered) continue
      if (o.op === 'setText') {
        // Level changes rematerialized inside the op; autofit would fight the reparse
        if ((rec.after as { levelDirty?: boolean } | undefined)?.levelDirty) continue
        rendered = applyAutofitResize(session, op.slideIndex, id, rendered)
        rendered = syncAutofitScale(session, op.slideIndex, id, rendered)
      } else if (o.op === 'setFont' || o.op === 'setParagraphFormat') {
        rendered = applyAutofitResize(session, op.slideIndex, id, rendered)
        rendered = syncAutofitScale(session, op.slideIndex, id, rendered)
      }
    }
    return rendered ? { slide: rendered, ...(notes.length ? { notes } : {}) } : null
  })
  // ── Single-page generation: a JSON slide spec written by the renderer's LLM call is built
  // directly into a one-slide pptx with pptx-engine primitives. Returns a marker that
  // slides:land-generated-pages redeems for the bytes.
  slidesOwnedHandle(
    'slides:local-page-generate',
    async (
      _e,
      op: { specJson: string },
    ): Promise<{ ok: boolean; marker?: string; error?: string; imageFailures?: string[] }> => {
      const parsed = parsePageSpec(String(op?.specJson ?? ''))
      if (!parsed.ok) return { ok: false, error: parsed.error }
      try {
        const started = Date.now()
        const { bytes, imageFailures } = await buildPagePptx(parsed.spec, {
          fontMetrics: getFontMetrics(),
          fetchImage: async (url) => {
            const resp = await fetchRemoteImage(url)
            if (!resp || !resp.ok) return null
            const buf = await readBodyCapped(resp, MAX_REMOTE_IMAGE_BYTES)
            const mime = sniffImageMime(buf) ?? resp.headers.get('content-type') ?? ''
            const ext = /png/.test(mime)
              ? 'png'
              : /gif/.test(mime)
                ? 'gif'
                : /webp/.test(mime)
                  ? 'webp'
                  : /bmp/.test(mime)
                    ? 'bmp'
                    : 'jpg'
            return { bytes: buf, ext }
          },
          imageDims: (bytes) => {
            try {
              const s = nativeImage.createFromBuffer(Buffer.from(bytes)).getSize()
              return s.width > 0 && s.height > 0 ? s : null
            } catch {
              return null
            }
          },
        })
        console.log(
          `[local-slide] page generated: bytes=${bytes.length} imageFails=${imageFailures.length} ms=${Date.now() - started}`,
        )
        const dir = join(app.getPath('temp'), 'vantage-local-pages')
        mkdirSync(dir, { recursive: true })
        const path = join(dir, `${randomUUID()}.pptx`)
        await writeFile(path, bytes)
        issuedGeneratedPages.add(path)
        return {
          ok: true,
          marker: GENERATED_PAGE_PREFIX + path,
          ...(imageFailures.length ? { imageFailures } : {}),
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  slidesOwnedHandle(
    'slides:land-generated-pages',
    async (
      e,
      pageMarkers: string[],
      fitWidthPx: number,
      mode?: 'replace' | 'append' | 'replace_at' | 'insert_at',
      atIndex?: number,
      deckName?: string,
    ): Promise<
      | (OpenResult & {
          appendedFrom?: number
          replacedIndex?: number
          insertedIndex?: number
          fallbackReason?: string
          imageFailures?: { page: number; url: string }[]
        })
      | { error: string }
    > => {
      // Every page arrives as a marker (genpptx:<path> written by
      // slides:local-page-generate, pointing at a one-slide pptx temp file); this handler only
      // reads and lands the bytes.
      // replace: assemble the whole batch into one multi-page pptx as the new deck base.
      // append/replace_at/insert_at: land the extracted pages as insertSlidePptx ops
      // (earlier pages are untouched; landing shows up in the op journal like any edit).
      const readCloudPage = async (marker: string): Promise<{ bytes: Uint8Array }> => {
        if (!marker.startsWith(GENERATED_PAGE_PREFIX))
          throw new Error('expected a generated page marker')
        const path = marker.slice(GENERATED_PAGE_PREFIX.length)
        if (!issuedGeneratedPages.has(path)) throw new Error('unknown generated page marker')
        return { bytes: new Uint8Array(await readFile(path)) }
      }
      const assembleDeck = async (): Promise<{ bytes: Uint8Array }> => {
        const perPage = await Promise.all(pageMarkers.map(readCloudPage))
        const base = await openPptx(perPage[0]!.bytes)
        for (const one of perPage.slice(1)) await mergeSlideFromPptx(base, one.bytes)
        for (const s of base.deck.slides) {
          promoteSlideBackground(s, base.deck.size)
          autofitGeneratedTextBoxes(s)
        }
        return { bytes: await savePptx(base) }
      }

      try {
        // Append: extract only the "new pages" and land them into the existing in-memory
        // deck as one per_op transaction. Already-landed pages stay untouched
        // (O(N) rather than O(N²)); no dependency on stored PageVisualData.
        if (mode === 'append') {
          const existing = sessions.get(e.sender.id)
          if (!existing) {
            return { error: tm('errNoDeckAppend') }
          }
          const opened = existing.opened
          const beforeCount = opened.deck.slides.length
          // Push an undo snapshot: appending is an ordinary edit, ⌘Z should return to the
          // pre-append state (previously the undoStack was simply cleared, making all of the
          // user's prior manual edits non-undoable — inconsistent with replace_at behavior)
          // Extract every page first (pure reads), then land them as insertSlidePptx ops so
          // the journal and undo see generation like any other edit.
          const sources: MergeSlideSource[] = []
          let lastErr: string | undefined
          for (const marker of pageMarkers) {
            try {
              const one = await readCloudPage(marker)
              const source = await extractMergeSlideSource(one.bytes)
              if (source) sources.push(source)
              else lastErr = tm('errMergeFailed')
            } catch (pageErr) {
              lastErr = pageErr instanceof Error ? pageErr.message : String(pageErr)
            }
          }
          let merged = 0
          if (sources.length > 0) {
            pushHistory(existing)
            const r = journaledTxn(existing, 'generate', {
              isolation: 'per_op',
              ops: sources.map((source) => ({ op: 'insertSlidePptx', source })),
            })
            merged = r.records?.length ?? 0
            if (merged === 0) existing.undoStack.pop() // Nothing happened, pop the just-pushed snapshot
            if (!lastErr) lastErr = r.failures?.[0]?.error
          }
          if (merged === 0) {
            return { error: tm('errAppendFailed', { reason: lastErr ?? tm('errUnknown') }) }
          }
          existing.fitWidthPx = fitWidthPx
          // Save the draft: persist the current complete deck
          const generationRevision=mainCloseRevision(existing)
          const bytes=await savePptx({deck:structuredClone(opened.deck),archive:opened.archive.clone()})
          await saveDraftAfterGenerate(e.sender, existing, bytes, 'append', deckName)
          // Draft now matches memory: reopen from the output bytes to clear dirty (same as
          // slides:save) — otherwise pure AI generation (per-page append merges mark
          // structureDirty) would trigger the close confirmation even without edits
          if(existing.path&&mainCloseRevision(existing)===generationRevision){commitSaved(existing.opened);existing.metaDirty=false}
          return {
            path: existing.path,
            slides: buildAllRenderSlides(existing.opened, fitWidthPx),
            size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
            defaultFont: deckDefaultFont(existing.opened),
            appendedFrom: beforeCount,
            ...(lastErr && merged < pageMarkers.length
              ? { fallbackReason: tm('errPartialAppend', { reason: lastErr }) }
              : {}),
          }
        }

        // Redo one page in place: the insertSlidePptx op merges the extracted page at the
        // end, moves it to atIndex and drops the displaced old page — one atomic txn, one
        // undo snapshot, so ⌘Z rolls back to the old page.
        if (mode === 'replace_at') {
          const existing = sessions.get(e.sender.id)
          if (!existing) {
            return { error: tm('errNoDeckReplace') }
          }
          const opened = existing.opened
          const total = opened.deck.slides.length
          if (atIndex == null || !Number.isInteger(atIndex) || atIndex < 0 || atIndex >= total) {
            return { error: tm('errIndexRange', { max: total - 1 }) }
          }
          const marker = pageMarkers[0]
          if (!marker || pageMarkers.length !== 1) {
            return { error: tm('errReplaceNeedsOne') }
          }
          const one = await readCloudPage(marker)
          const source = await extractMergeSlideSource(one.bytes)
          if (!source) {
            return { error: tm('errMergeFailed') }
          }
          pushHistory(existing)
          const r = journaledTxn(existing, 'generate', {
            ops: [{ op: 'insertSlidePptx', source, at: atIndex, replace: true }],
          })
          if (!r.applied) {
            existing.undoStack.pop() // The executor already restored the deck
            return { error: r.failures?.[0]?.error ?? tm('errReplaceFailed') }
          }
          existing.fitWidthPx = fitWidthPx
          const generationRevision=mainCloseRevision(existing)
          const bytes=await savePptx({deck:structuredClone(opened.deck),archive:opened.archive.clone()})
          await saveDraftAfterGenerate(e.sender, existing, bytes, 'append', deckName)
          if(existing.path&&mainCloseRevision(existing)===generationRevision){commitSaved(existing.opened);existing.metaDirty=false}
          return {
            path: existing.path,
            slides: buildAllRenderSlides(existing.opened, fitWidthPx),
            size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
            defaultFont: deckDefaultFont(existing.opened),
            replacedIndex: atIndex,
          }
        }

        // Insert one page at atIndex (later pages shift back): used to regenerate a failed middle
        // page from generate_deck and put it back in place. Same op as replace_at but without
        // dropping an old page; atIndex=total lands at the end without a move.
        if (mode === 'insert_at') {
          const existing = sessions.get(e.sender.id)
          if (!existing) {
            return { error: tm('errNoDeckInsert') }
          }
          const opened = existing.opened
          const total = opened.deck.slides.length
          if (atIndex == null || !Number.isInteger(atIndex) || atIndex < 0 || atIndex > total) {
            return { error: tm('errIndexRange', { max: total }) }
          }
          const marker = pageMarkers[0]
          if (!marker || pageMarkers.length !== 1) {
            return { error: tm('errInsertNeedsOne') }
          }
          const one = await readCloudPage(marker)
          const source = await extractMergeSlideSource(one.bytes)
          if (!source) {
            return { error: tm('errMergeFailed') }
          }
          pushHistory(existing)
          const r = journaledTxn(existing, 'generate', {
            ops: [{ op: 'insertSlidePptx', source, at: atIndex }],
          })
          if (!r.applied) {
            existing.undoStack.pop() // The executor already restored the deck
            return { error: r.failures?.[0]?.error ?? tm('errInsertFailed') }
          }
          existing.fitWidthPx = fitWidthPx
          const generationRevision=mainCloseRevision(existing)
          const bytes=await savePptx({deck:structuredClone(opened.deck),archive:opened.archive.clone()})
          await saveDraftAfterGenerate(e.sender, existing, bytes, 'append', deckName)
          if(existing.path&&mainCloseRevision(existing)===generationRevision){commitSaved(existing.opened);existing.metaDirty=false}
          return {
            path: existing.path,
            slides: buildAllRenderSlides(existing.opened, fitWidthPx),
            size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
            defaultFont: deckDefaultFont(existing.opened),
            insertedIndex: atIndex,
          }
        }

        // replace mode: assemble the whole batch into one multi-page pptx as the new deck base.
        const { bytes } = await assembleDeck()
        const opened = await openPptx(bytes)
        const replaceSession: Session = {
          path: '',
          opened,
          fitWidthPx,
          undoStack: [],
          redoStack: [],
        }
        const old=sessions.get(e.sender.id)
        if(old&&editorAttachedIds(old).length>1)throw new Error('Close the other presentation editing views before replacing the entire shared deck; their pending input was preserved.')
        await saveDraftAfterGenerate(e.sender,replaceSession,bytes,'replace',deckName)
        const result=prepareSourceCandidate(e.sender,replaceSession,{path:replaceSession.path,slides:buildAllRenderSlides(opened,fitWidthPx),size:{cx:opened.deck.size.cx,cy:opened.deck.size.cy},defaultFont:deckDefaultFont(opened)},true)
        e.sender.send('slides:opened',result)
        return result
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  slidesOwnedHandle(
    'slides:new-blank',
    async (e, fitWidthPx: number, size?: unknown): Promise<OpenResult> => {
      const opened = await openPptx(await createBlankPptx())
      // the renderer's saved default size; anything a .pptx cannot store keeps the template
      const side = (v: unknown): v is number =>
        typeof v === 'number' && Number.isInteger(v) && v >= 914400 && v <= 51206400
      const s = size as { cx?: unknown; cy?: unknown } | undefined
      if (s && side(s.cx) && side(s.cy)) setSlideSize(opened, s.cx, s.cy)
      toolSaves.cancel(e.sender.id)
      return prepareSourceCandidate(e.sender,{path:'',opened,fitWidthPx,undoStack:[],redoStack:[]},{
        path: '',
        slides: buildAllRenderSlides(opened, fitWidthPx),
        size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
        defaultFont: deckDefaultFont(opened),
      })
    },
  )

  slidesOwnedHandle('slides:add-element', (e, op: AddElementOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const paragraphs: Paragraph[] | undefined = op.paragraphs?.length
      ? (op.paragraphs as Paragraph[])
      : op.text
        ? op.text.split('\n').map((line) => ({ runs: [{ text: line }] }))
        : undefined
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'addElement',
          target: { slide: op.slideIndex },
          kind: op.kind,
          offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
          ...(paragraphs ? { paragraphs } : {}),
          ...(op.fillColor ? { fill: op.fillColor } : {}),
          ...(op.stroke
            ? {
                stroke: {
                  color: op.stroke.color,
                  widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT),
                },
              }
            : {}),
          ...(op.bodyPr ? { bodyPr: op.bodyPr } : {}),
        },
      ],
    })
    if (!r) return null
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.records![0]!.created![0]! } : null
  })

  // Shim over the canonical op (see @vantage/pptx-ops): the op owns validation/mutation/journal;
  // the shim keeps session lookup, undo bookkeeping, and RenderSlide rebuilding.
  slidesOwnedHandle('slides:delete-element', (e, op: DeleteElementOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    pushHistory(session)
    const r = journaledTxn(session, 'edit', {
      ops: [{ op: 'deleteElement', target: { slide: op.slideIndex, el: op.sourceId } }],
    })
    if (!r.applied) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  })

  // Whole-selection delete as one undo step. per_op mirrors the old per-element
  // loop: an id that already vanished is skipped instead of aborting the rest.
  slidesOwnedHandle('slides:delete-elements', (e, op: DeleteElementsOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !op.sourceIds.length) return null
    const r = sessionTxn(session, {
      isolation: 'per_op',
      ops: op.sourceIds.map((id) => ({
        op: 'deleteElement' as const,
        target: { slide: op.slideIndex, el: id },
      })),
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  // Shim over the canonical setStroke op: pt→EMU/angle conversion is surface translation
  // and stays here; validation/mutation/journal live in the op.
  slidesOwnedHandle('slides:edit-stroke', (e, op: EditStrokeOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const patch = op.stroke
      ? {
          color: op.stroke.color,
          widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT),
          ...(op.stroke.dash ? { dash: op.stroke.dash } : {}),
          ...(op.stroke.cap ? { cap: op.stroke.cap } : {}),
          ...(op.stroke.join ? { join: op.stroke.join } : {}),
          ...(op.stroke.compound ? { compound: op.stroke.compound } : {}),
          ...(op.stroke.gradient
            ? {
                gradient: {
                  stops: op.stroke.gradient.stops,
                  angle: Math.round(op.stroke.gradient.angleDeg * 60000),
                },
              }
            : {}),
        }
      : null
    pushHistory(session)
    const r = journaledTxn(session, 'edit', {
      ops: [
        {
          op: 'setStroke',
          target: { slide: op.slideIndex, el: op.sourceId },
          stroke: patch,
          ...(op.groupId ? { group: op.groupId } : {}),
        },
      ],
    })
    if (!r.applied) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  })

  // Mirror elements across their own axis: flipH/flipV is the only way to
  // point an arrow the other way — rotation cannot express a single-axis mirror
  slidesOwnedHandle('slides:flip-elements', (e, op: FlipElementOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'flipElements',
          target: { slide: op.slideIndex },
          els: op.sourceIds,
          axis: op.axis,
          ...(op.groupId ? { group: op.groupId } : {}),
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:edit-picture-src-rect', (e, op: EditPictureSrcRectOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    let box: { x: number; y: number; cx: number; cy: number } | undefined
    if (op.boxPx && op.fitWidthPx) {
      const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
      const scale = op.fitWidthPx / baseWidthPx
      const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
      box = {
        x: toEmu(op.boxPx.x),
        y: toEmu(op.boxPx.y),
        cx: toEmu(op.boxPx.w),
        cy: toEmu(op.boxPx.h),
      }
    }
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'setPictureSrcRect',
          target: { slide: op.slideIndex, el: op.sourceId },
          srcRect: op.srcRect,
          ...(box ? { box } : {}),
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:group-elements', (e, op: GroupElementsOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [{ op: 'groupElements', target: { slide: op.slideIndex }, els: op.sourceIds }],
    })
    if (!r) return null
    const renderSlide = rebuildSlide(session, op.slideIndex)
    return renderSlide ? { slide: renderSlide, groupId: r.records![0]!.created![0]! } : null
  })

  slidesOwnedHandle('slides:ungroup-element', (e, op: UngroupElementOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [{ op: 'ungroupElement', target: { slide: op.slideIndex, el: op.sourceId } }],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  // Shim over the canonical setBackground op (one slide per op; apply-to-all fans out;
  // the full-bleed backdrop repaint lives in the op). File dialogs stay here.
  slidesOwnedHandle('slides:edit-background', async (e, op: EditBackgroundOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slides = session.opened.deck.slides
    const before = slides.map((s) => s.path)
    const targets = op.slideIndex === -1 ? slides : [slides[op.slideIndex]].filter(Boolean)
    if (targets.length === 0) return null

    if (op.kind === 'image') {
      let source: { bytes: Uint8Array; ext: string } | { mediaPath: string }
      if (op.pick !== false) {
        const r = await showOpenDialogWithMemory(dialog, dialogParent(), {
          title: tm('dlgInsertImage'),
          properties: ['openFile' as const],
          filters: [
            {
              name: tm('filterImages'),
              extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'],
            },
          ],
        })
        if (r.canceled || !r.filePaths[0]) return null
        const bytes = await readFile(r.filePaths[0])
        source = {
          bytes: new Uint8Array(bytes),
          ext: r.filePaths[0].split('.').pop()!.toLowerCase(),
        }
      } else {
        // Reuse an already-landed background image (mode change / apply-to-all)
        const src = slides[op.sourceSlideIndex ?? op.slideIndex]
        if (src?.background?.type !== 'image') return null
        source = { mediaPath: src.background.mediaRef }
      }
      pushHistory(session)
      // The picked bytes land as one media part; further slides only add a rel to it
      // (each op reports the landed media path, threaded into the next op's source)
      let landed: string | null = null
      for (const [i, s] of slides.entries()) {
        if (!targets.includes(s)) continue
        const r = journaledTxn(session, 'edit', {
          ops: [
            {
              op: 'setBackground',
              target: { slide: i },
              kind: 'image',
              source: landed ? { mediaPath: landed } : source,
              tile: op.mode === 'tile',
            },
          ],
        })
        if (r.applied) {
          const used = (r.records![0]!.after as { mediaPath?: string } | undefined)?.mediaPath
          if (used) landed = used
        }
      }
      if (!landed) {
        session.undoStack.pop()
        return null
      }
    } else {
      const common: Record<string, unknown> =
        op.kind === 'solid'
          ? { kind: 'solid', color: op.color }
          : op.kind === 'gradient'
            ? {
                kind: 'gradient',
                from: op.from,
                to: op.to,
                ...(op.angleDeg !== undefined ? { angleDeg: op.angleDeg } : {}),
                ...(op.radial ? { radial: true } : {}),
              }
            : op.kind === 'reset'
              ? { kind: 'reset' }
              : { kind: 'graphics', hidden: op.hidden }
      pushHistory(session)
      const r = journaledTxn(session, 'edit', {
        ops: slides
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => targets.includes(s))
          .map(({ i }) => ({ op: 'setBackground', target: { slide: i }, ...common })),
      })
      if (!r.applied) {
        session.undoStack.pop()
        return null
      }
    }
    session.fitWidthPx = op.fitWidthPx
    return buildSlideUpdate(
      session,
      before,
      targets.map((s) => slides.indexOf(s)),
    )
  })

  slidesOwnedHandle('slides:edit-image-fill', async (e, op: EditFillImageOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide || op.targets.length === 0) return null
    let bytes: Uint8Array
    let ext: string
    if (op.source) {
      // bundled texture preset: bytes shipped inline, no picker
      bytes = new Uint8Array(Buffer.from(op.source.base64, 'base64'))
      ext = op.source.ext.toLowerCase()
    } else {
      const r = await showOpenDialogWithMemory(dialog, dialogParent(), {
        title: tm('dlgInsertImage'),
        properties: ['openFile' as const],
        filters: [
          {
            name: tm('filterImages'),
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'],
          },
        ],
      })
      if (r.canceled || !r.filePaths[0]) return null
      bytes = new Uint8Array(await readFile(r.filePaths[0]))
      ext = r.filePaths[0].split('.').pop()!.toLowerCase()
    }
    pushHistory(session)
    // The picked bytes land as one media part; further targets only add rels to it
    // (each op reports the landed media path, threaded into the next op's source)
    let landed: string | null = null
    let applied = 0
    for (const target of op.targets) {
      const r = journaledTxn(session, 'edit', {
        ops: [
          {
            op: 'setImageFill',
            target: { slide: op.slideIndex, el: target.sourceId },
            source: landed ? { mediaPath: landed } : { bytes, ext },
            tile: op.mode === 'tile',
            ...(target.groupId ? { group: target.groupId } : {}),
          },
        ],
      })
      if (r.applied) {
        applied += 1
        const used = (r.records![0]!.after as { mediaPath?: string } | undefined)?.mediaPath
        if (used) landed = used
      }
    }
    if (!applied) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  })

  // Replace picture: the renderer swaps the bytes in place through replacePictureBytes
  slidesOwnedHandle('slides:pick-picture-file', async () => {
    const r = await showOpenDialogWithMemory(dialog, dialogParent(), {
      title: tm('dlgReplacePicture'),
      properties: ['openFile' as const],
      filters: [
        {
          name: tm('filterImages'),
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'],
        },
      ],
    })
    if (r.canceled || !r.filePaths[0]) return null
    const filePath = r.filePaths[0]
    return {
      base64: (await readFile(filePath)).toString('base64'),
      ext: filePath.split('.').pop()!.toLowerCase(),
    }
  })
  slidesOwnedHandle('slides:insert-image', async (e, slideIndex: number, fitWidthPx: number) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[slideIndex]
    if (!slide) return null
    const parent = dialogParent()
    const options = {
      title: tm('dlgInsertImage'),
      properties: ['openFile' as const],
      filters: [
        {
          name: tm('filterImages'),
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'],
        },
      ],
    }
    const r = await showOpenDialogWithMemory(dialog, parent, options)
    if (r.canceled || !r.filePaths[0]) return null
    const filePath = r.filePaths[0]
    const bytes = await readFile(filePath)
    const ext = filePath.split('.').pop()!.toLowerCase()

    const deckSize = session.opened.deck.size
    let natural: { width: number; height: number } | null = null
    if (ext === 'tif' || ext === 'tiff') {
      const decoded = tiffToPng(new Uint8Array(bytes))
      if (decoded) natural = { width: decoded.width, height: decoded.height }
    } else {
      const img = nativeImage.createFromPath(filePath)
      if (!img.isEmpty()) natural = img.getSize()
    }
    const offset = pictureFrame(
      { width: deckSize.cx, height: deckSize.cy },
      natural,
      imageDpiFromBytes(new Uint8Array(bytes)),
      DEFAULT_PICTURE_DPI,
    )

    const txn = sessionTxn(session, {
      ops: [
        {
          op: 'addPicture',
          target: { slide: slideIndex },
          bytes: new Uint8Array(bytes),
          ext,
          offset,
        },
      ],
    })
    if (!txn) return { error: 'unsupported' as const, ext }
    session.fitWidthPx = fitWidthPx
    const rebuilt = rebuildSlide(session, slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: txn.records![0]!.created![0]! } : null
  })

  // Shim over the canonical setFill op: gradient normalization is surface translation
  // and stays here; validation/mutation/journal live in the op.
  slidesOwnedHandle('slides:edit-fill', (e, op: EditFillOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const fill =
      typeof op.fill === 'string'
        ? op.fill
        : {
            stops: gradientStops(op.fill.gradient),
            ...((pk) =>
              pk
                ? {
                    path: pk,
                    ...((ft) => (ft ? { fillTo: ft } : {}))(gradientFillTo(op.fill.gradient)),
                  }
                : { angle: Math.round((op.fill.gradient.angleDeg ?? 0) * 60000) })(
              gradientPathKind(op.fill.gradient),
            ),
          }
    pushHistory(session)
    const r = journaledTxn(session, 'edit', {
      ops: [
        {
          op: 'setFill',
          target: { slide: op.slideIndex, el: op.sourceId },
          fill,
          ...(op.groupId ? { group: op.groupId } : {}),
        },
      ],
    })
    if (!r.applied) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  })

  slidesOwnedHandle('slides:add-slide', (e, op: AddSlideOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'duplicateSlide',
          target: { slide: op.sourceIndex },
          ...(op.clearText ? { clearText: true } : {}),
        },
      ],
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    markMetaDirty(session)
    return {
      ...buildSlideUpdate(session, before),
      index: op.sourceIndex + 1,
    }
  })

  // App-wide, so a slide copied in one tab can be pasted into another deck.
  slidesOwnedHandle('slides:copy-slides', (e, op: CopySlidesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !op.slideIndexes.length) return false
    const bundles: SlideBundle[] = []
    for (const i of op.slideIndexes) {
      const bundle = copySlide(session.opened, i)
      if (!bundle) return false
      bundles.push(bundle)
    }
    const pngs = op.pngs?.length === bundles.length ? op.pngs : undefined
    slideClipboard = { bundles, ...(pngs ? { pngs } : {}) }
    // Marker so plain ⌘V knows the latest copy was a slide (element copies / external copies overwrite it)
    clipboard.writeBuffer('io.vantage.slides.slide', Buffer.from('1'))
    return true
  })

  slidesOwnedHandle('slides:has-slide-clipboard', () => slideClipboard !== null)

  // Several copied slides paste in order; 'picture' mode stacks every bitmap on the anchor slide.
  const performSlidePaste = (
    session: Session,
    op: PasteSlideOp,
    before = session.opened.deck.slides.map((s) => s.path),
    restored: number[] = [],
  ): PasteSlideResult | null => {
    if (!slideClipboard) return null
    const picture = op.mode === 'picture'
    const { bundles, pngs } = slideClipboard
    if (picture && !pngs) return null
    const r = journaledTxn(session, 'edit', {
      ops: bundles.map((bundle, j) => ({
        op: 'pasteSlide',
        afterIndex: picture ? op.afterIndex : op.afterIndex + j,
        mode: op.mode,
        ...(picture ? { png: pngs![j] } : { bundle }),
      })),
    })
    if (!r.applied) return null
    const rec = r.records![0]!
    session.fitWidthPx = op.fitWidthPx
    // Pasted slides are parsed fresh, so no element dirty flag is set: flag the
    // session here or the paste is invisible to the close guard and autosave.
    // repaste-slide re-runs this after restoring a snapshot that cleared the flag.
    markMetaDirty(session)
    const created = r.records!.flatMap((x) => x.created ?? [])
    const index = (rec.after as { index: number }).index
    return {
      ...buildSlideUpdate(session, before, [
        ...restored,
        ...Array.from({ length: picture ? 1 : bundles.length }, (_, j) => index + j),
      ]),
      index,
      count: picture ? 0 : bundles.length,
      ...(created.length ? { sourceIds: created } : {}),
    }
  }

  slidesOwnedHandle('slides:paste-slide', (e, op: PasteSlideOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !slideClipboard) return null
    pushHistory(session)
    const r = performSlidePaste(session, op)
    if (!r) {
      session.undoStack.pop()
      return null
    }
    lastSlidePaste.set(e.sender.id, {
      afterIndex: op.afterIndex,
      undoLen: session.undoStack.length,
      changed: op.mode === 'picture' ? [r.index] : [],
    })
    return r
  })

  // Paste-options floater: undo the just-completed paste and redo it with another
  // mode. Refused when anything (edits, ⌘Z) touched the deck in between.
  slidesOwnedHandle('slides:repaste-slide', (e, op: RepasteSlideOp) => {
    const session = sessions.get(e.sender.id)
    const rec = lastSlidePaste.get(e.sender.id)
    if (!session || !slideClipboard || !rec) return null
    if (session.undoStack.length !== rec.undoLen) return null
    const snap = session.undoStack.pop()
    if (!snap) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    restoreSnapshot(session, snap)
    pushHistory(session)
    const r = performSlidePaste(
      session,
      {
        afterIndex: rec.afterIndex,
        fitWidthPx: op.fitWidthPx,
        mode: op.mode,
      },
      before,
      rec.changed,
    )
    if (!r) {
      session.undoStack.pop()
      return null
    }
    rec.undoLen = session.undoStack.length
    rec.changed = op.mode === 'picture' ? [r.index] : []
    return r
  })

  slidesOwnedHandle('slides:add-blank-slide', (e, op: AddBlankSlideOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const r = sessionTxn(session, {
      ops: [
        { op: 'addBlankSlide', target: { slide: op.sourceIndex } },
        // ops are validated against the pre-transaction deck, so move the existing
        // source slide down past the new one rather than targeting the new index
        ...(op.before
          ? [{ op: 'moveSlide', target: { slide: op.sourceIndex }, to: op.sourceIndex + 1 }]
          : []),
      ],
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    // Always: the blank slide is parsed fresh, so neither structureDirty nor an
    // element dirty flag is set and the insert would otherwise be unsaveable.
    markMetaDirty(session)
    return {
      ...buildSlideUpdate(session, before),
      index: op.before ? op.sourceIndex : op.sourceIndex + 1,
    }
  })

  // 'builtin:<key>' virtual paths get injected into the package on first use
  const resolveLayoutPath = (session: Session, layoutPath?: string): string | undefined => {
    if (!layoutPath?.startsWith(BUILTIN_LAYOUT_PREFIX)) return layoutPath
    return (
      ensureBuiltinLayout(
        session.opened.archive,
        session.opened.deck.size,
        layoutPath.slice(BUILTIN_LAYOUT_PREFIX.length),
      ) ?? undefined
    )
  }

  slidesOwnedHandle('slides:add-slide-with-layout', (e, op: AddSlideWithLayoutOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    // 'builtin:' resolution may inject a layout part — do it before the undo snapshot
    // is taken so a failed insert still rolls back to a consistent package
    pushHistory(session)
    const layoutPath = resolveLayoutPath(session, op.layoutPath)
    const r = layoutPath
      ? journaledTxn(session, 'edit', {
          ops: [{ op: 'addSlideWithLayout', target: { slide: op.sourceIndex }, layoutPath }],
        })
      : null
    if (!r?.applied) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    markMetaDirty(session)
    return {
      ...buildSlideUpdate(session, before),
      index: op.sourceIndex + 1,
    }
  })

  slidesOwnedHandle('slides:get-layouts', (e) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const layouts = listSlideLayouts(session.opened.archive)
    // Decks whose own layouts carry no placeholders (AI-generated single blank layout)
    // get the built-in standard set, injected into the package on first use
    if (shouldOfferBuiltinLayouts(layouts)) {
      layouts.push(
        ...builtinLayoutInfos(session.opened.deck.size, new Set(layouts.map((l) => l.name))),
      )
    }
    return { layouts, size: { ...session.opened.deck.size } }
  })

  // ── Master edit view ───────────────────────────────────────────────
  // Exception to the fidelity rule: only parts the user actively changed in master view are
  // written back, using the same byte surgery as slides. Every commit writes the entry + fully
  // reparses all slides — inheritance takes effect immediately, and each undo snapshot's
  // (slides model, entries) pair stays self-consistent (rendering and file don't diverge after
  // undo).
  const buildMasterRenderSlide = (session: Session): RenderSlide | null => {
    const me = session.masterEdit
    if (!me) return null
    return buildRenderSlide(me.slide, session.opened.deck.size, {
      fitWidthPx: session.fitWidthPx,
      media: makeMediaResolver(session.opened),
      metrics: getFontMetrics(),
    })
  }

  // Master edits run as part-addressed op transactions seeded with the live
  // master slide: ops mutate me.slide itself (parse-time ids stay stable for
  // the renderer's selection/editing state — a fresh parse would re-mint them)
  // and the executor's flush serializes that same object to the entry.
  const masterTxn = (session: Session, me: { partPath: string; slide: Slide }, op: Op) =>
    sessionTxn(session, { ops: [op], parts: new Map([[me.partPath, me.slide]]) })

  const masterEditDone = (session: Session): RenderSlide | null => {
    markMetaDirty(session)
    return buildMasterRenderSlide(session)
  }

  slidesOwnedHandle('slides:master-enter', (e, fitWidthPx: number): MasterEnterResult | null => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    session.fitWidthPx = fitWidthPx
    const items: MasterEnterResult['items'] = []
    for (const p of listMasterParts(session.opened.archive)) {
      const slide = parseMasterPart(session.opened.archive, p.partPath)
      if (!slide) continue
      const rendered = buildRenderSlide(slide, session.opened.deck.size, {
        fitWidthPx,
        media: makeMediaResolver(session.opened),
        metrics: getFontMetrics(),
      })
      items.push({ partPath: p.partPath, kind: p.kind, name: p.name, slide: rendered })
      if (!session.masterEdit) session.masterEdit = { partPath: p.partPath, slide }
    }
    return items.length ? { items } : null
  })

  slidesOwnedHandle('slides:master-open', (e, partPath: string) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = parseMasterPart(session.opened.archive, partPath)
    if (!slide) return null
    session.masterEdit = { partPath, slide }
    return buildMasterRenderSlide(session)
  })

  slidesOwnedHandle('slides:master-close', (e) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    session.masterEdit = null
    // Edits were materialized one by one; here we only fetch the full render tree
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  })

  slidesOwnedHandle('slides:master-edit-text', (e, op: MasterEditTextOp) => {
    const session = sessions.get(e.sender.id)
    const me = session?.masterEdit
    if (!session || !me) return null
    const r = masterTxn(session, me, {
      op: 'setText',
      target: { part: me.partPath, el: op.sourceId },
      paragraphs: op.paragraphs,
    })
    if (!r) return null
    return masterEditDone(session)
  })

  slidesOwnedHandle('slides:master-edit-transform', (e, op: MasterEditTransformOp) => {
    const session = sessions.get(e.sender.id)
    const me = session?.masterEdit
    if (!session || !me) return null
    const el = me.slide.elements.find((x) => x.id === op.sourceId)
    if (!el) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    if (op.preview) {
      // Previews are not persisted: mutate the live master slide only (the final
      // commit at drag end goes through the op executor against the entry bytes)
      if (!session.transformPreview) {
        pushHistory(session)
        session.transformPreview = true
      }
      el.transform = {
        ...el.transform,
        offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
        rot: Math.round(op.rotationDeg * 60000),
      }
      return buildMasterRenderSlide(session)
    }
    const payload = {
      op: 'setTransform',
      target: { part: me.partPath, el: op.sourceId },
      box: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
      rotDeg: op.rotationDeg,
    }
    const seed = new Map([[me.partPath, me.slide]])
    let r: TxnResult | null
    if (session.transformPreview) {
      // The gesture's first preview frame already pushed the undo step
      session.transformPreview = false
      const applied = journaledTxn(session, 'edit', { ops: [payload], parts: seed })
      r = applied.applied ? applied : null
    } else {
      r = sessionTxn(session, { ops: [payload], parts: seed })
    }
    if (!r) return null
    return masterEditDone(session)
  })

  slidesOwnedHandle('slides:master-edit-fill', (e, op: MasterEditFillOp) => {
    const session = sessions.get(e.sender.id)
    const me = session?.masterEdit
    if (!session || !me) return null
    const fill =
      typeof op.fill === 'string'
        ? op.fill
        : {
            stops: gradientStops(op.fill.gradient),
            ...((pk) =>
              pk
                ? {
                    path: pk,
                    ...((ft) => (ft ? { fillTo: ft } : {}))(gradientFillTo(op.fill.gradient)),
                  }
                : { angle: Math.round((op.fill.gradient.angleDeg ?? 0) * 60000) })(
              gradientPathKind(op.fill.gradient),
            ),
          }
    const r = masterTxn(session, me, {
      op: 'setFill',
      target: { part: me.partPath, el: op.sourceId },
      fill,
    })
    if (!r) return null
    return masterEditDone(session)
  })

  slidesOwnedHandle('slides:master-edit-stroke', (e, op: MasterEditStrokeOp) => {
    const session = sessions.get(e.sender.id)
    const me = session?.masterEdit
    if (!session || !me) return null
    const r = masterTxn(session, me, {
      op: 'setStroke',
      target: { part: me.partPath, el: op.sourceId },
      stroke: op.stroke
        ? { color: op.stroke.color, widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT) }
        : null,
    })
    if (!r) return null
    return masterEditDone(session)
  })

  slidesOwnedHandle('slides:master-delete-element', (e, op: MasterDeleteElementOp) => {
    const session = sessions.get(e.sender.id)
    const me = session?.masterEdit
    if (!session || !me) return null
    const r = masterTxn(session, me, {
      op: 'deleteElement',
      target: { part: me.partPath, el: op.sourceId },
    })
    if (!r) return null
    return masterEditDone(session)
  })

  // Insert a text box / preset shape / line onto the current master or layout
  // part. Pixel geometry converts like slides:add-element; the op is the same
  // part-addressed addElement the slide path runs, so undo/journal/save all
  // behave like the other master edits.
  slidesOwnedHandle('slides:master-add-element', (e, op: MasterAddElementOp) => {
    const session = sessions.get(e.sender.id)
    const me = session?.masterEdit
    if (!session || !me) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const r = masterTxn(session, me, {
      op: 'addElement',
      target: { part: me.partPath },
      kind: op.kind,
      offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
      ...(op.paragraphs?.length ? { paragraphs: op.paragraphs as Paragraph[] } : {}),
      ...(op.fillColor ? { fill: op.fillColor } : {}),
      ...(op.stroke
        ? {
            stroke: {
              color: op.stroke.color,
              widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT),
            },
          }
        : {}),
      ...(op.bodyPr ? { bodyPr: op.bodyPr } : {}),
    })
    const sourceId = r?.records?.[0]?.created?.[0]
    if (!r || !sourceId) return null
    return { slide: masterEditDone(session), sourceId }
  })

  slidesOwnedHandle('slides:edit-picture-opacity', (e, op: EditPictureOpacityOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'setPictureOpacity',
          target: { slide: op.slideIndex, el: op.sourceId },
          opacity: op.opacity,
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:set-slide-size', (e, op: SetSlideSizeOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, { ops: [{ op: 'setSlideSize', cx: op.cx, cy: op.cy }] })
    if (!r) return null
    markMetaDirty(session)
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  })

  slidesOwnedHandle('slides:get-slide-size', (e) => {
    const session = sessions.get(e.sender.id)
    return session ? { ...session.opened.deck.size } : null
  })

  slidesOwnedHandle('slides:set-slide-layout', (e, op: SetSlideLayoutOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    pushHistory(session)
    const layoutPath = resolveLayoutPath(session, op.layoutPath)
    // A named layout that fails to resolve is an error; an absent layoutPath means reset
    const r =
      op.layoutPath && !layoutPath
        ? null
        : journaledTxn(session, 'edit', {
            ops: [
              {
                op: 'setSlideLayout',
                target: { slide: op.slideIndex },
                ...(layoutPath ? { layoutPath } : {}),
              },
            ],
          })
    if (!r?.applied) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  })

  slidesOwnedHandle('slides:find-replace', (e, op: FindReplaceOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'findReplace',
          find: op.find,
          replace: op.replace,
          matchCase: op.matchCase,
          firstOnly: op.firstOnly,
          slideIndex: op.slideIndex,
          elementId: op.elementId,
        },
      ],
    })
    if (!r) return { count: 0, update: null }
    const { count, changedSlides } = r.records![0]!.after as {
      count: number
      changedSlides: number[]
    }
    return { count, update: buildSlideUpdate(session, before, changedSlides) }
  })

  slidesOwnedHandle('slides:delete-slide', (e, slideIndex: number) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const r = sessionTxn(session, { ops: [{ op: 'deleteSlide', target: { slide: slideIndex } }] })
    if (!r) return null
    markMetaDirty(session)
    return buildSlideUpdate(session, before)
  })

  // Highest index first: every op is validated against the pre-transaction deck
  // and applied in sequence, so the remaining indexes stay valid.
  slidesOwnedHandle('slides:delete-slides', (e, op: DeleteSlidesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const indexes = [...new Set(op.slideIndexes)].sort((a, b) => b - a)
    if (!indexes.length || indexes.length >= session.opened.deck.slides.length) return null
    const r = sessionTxn(session, {
      ops: indexes.map((i) => ({ op: 'deleteSlide' as const, target: { slide: i } })),
    })
    if (!r) return null
    markMetaDirty(session)
    return buildSlideUpdate(session, before)
  })

  slidesOwnedHandle('slides:duplicate-slides', (e, op: DuplicateSlidesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const steps = planSlideDuplicates(op.slideIndexes)
    if (!steps.length) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const r = sessionTxn(session, {
      ops: steps.map((st) =>
        'duplicate' in st
          ? { op: 'duplicateSlide' as const, target: { slide: st.duplicate } }
          : { op: 'moveSlide' as const, target: { slide: st.from }, to: st.to },
      ),
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    // Not just for multi-slide plans: a single duplicate is parsed fresh too and
    // would otherwise leave the deck changed but reported clean.
    markMetaDirty(session)
    return {
      ...buildSlideUpdate(session, before),
      index: Math.max(...op.slideIndexes) + 1,
    }
  })

  slidesOwnedHandle('slides:set-slides-hidden', (e, op: SetSlidesHiddenOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !op.slideIndexes.length) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const r = sessionTxn(session, {
      ops: op.slideIndexes.map((i) => ({
        op: 'setHidden' as const,
        target: { slide: i },
        hidden: op.hidden,
      })),
    })
    return r ? buildSlideUpdate(session, before, op.slideIndexes) : null
  })

  slidesOwnedHandle('slides:edit-table-cell', (e, op: EditTableCellOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'setTableCell',
          target: { slide: op.slideIndex, el: op.sourceId },
          row: op.row,
          col: op.col,
          paragraphs: op.paragraphs,
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:table-merge', (e, op: TableMergeIpcOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'tableMerge',
          target: { slide: op.slideIndex, el: op.sourceId },
          kind: op.kind,
          row: op.row,
          col: op.col,
        },
      ],
    })
    if (!r) return null
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt
      ? { slide: rebuilt, sourceId: (r.records![0]!.after as { elementId: string }).elementId }
      : null
  })

  slidesOwnedHandle('slides:table-structure', (e, op: TableStructureIpcOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'tableStructure',
          target: { slide: op.slideIndex, el: op.sourceId },
          kind: op.kind,
          index: op.index,
          ...(op.before ? { before: true } : {}),
        },
      ],
    })
    if (!r) return null
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt
      ? { slide: rebuilt, sourceId: (r.records![0]!.after as { elementId: string }).elementId }
      : null
  })

  slidesOwnedHandle('slides:set-table-row-height', (e, op: SetTableRowHeightOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'setTableRowHeight',
          target: { slide: op.slideIndex, el: op.sourceId },
          row: op.row,
          hEmu: (op.hPx / scale) * EMU_PER_PX_96,
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:set-table-cell-anchor', (e, op: SetTableCellAnchorOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'setTableCellAnchor',
          target: { slide: op.slideIndex, el: op.sourceId },
          row: op.row,
          col: op.col,
          anchor: op.anchor,
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:set-table-col-width', (e, op: SetTableColWidthOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'setTableColWidth',
          target: { slide: op.slideIndex, el: op.sourceId },
          col: op.col,
          wEmu: (op.wPx / scale) * EMU_PER_PX_96,
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:edit-table-style', (e, op: EditTableStyleOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    // A reparse regenerates element ids: look up the new id by element index; the renderer uses it to keep the selection
    const elIdx = slide.elements.findIndex((el) => matchesElementRef(el, op.sourceId))
    pushHistory(session)
    const { slideIndex, sourceId, ...style } = op
    const r = journaledTxn(session, 'edit', {
      ops: [{ op: 'setTableStyle', target: { slide: slideIndex, el: sourceId }, ...style }],
    })
    if (!r.applied) {
      session.undoStack.pop()
      return null
    }
    // The patch is written on anchor.originalXml; a materialize reparse is needed before it shows in the render model
    const rebuilt = rebuildSlideWithReparse(session, op.slideIndex)
    if (!rebuilt) return null
    const newId = session.opened.deck.slides[op.slideIndex]?.elements[elIdx]?.id ?? null
    return { slide: rebuilt, sourceId: newId }
  })

  slidesOwnedHandle('slides:edit-chart', async (e, op: EditChartOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    // A reparse regenerates element ids: look up the new id by element index; the renderer uses it to keep the selection
    const elIdx = slide.elements.findIndex((el) => matchesElementRef(el, op.sourceId))
    // Confirm before the first edit of a chart from an imported file: editing rebuilds it from the template,
    // and unmodeled fine-grained formatting (number formats/trendlines/error bars/per-point styles) is lost
    const chartEl = slide.elements[elIdx] as { type?: string; descr?: string } | undefined
    if (chartEl?.type === 'chart' && chartEl.descr !== 'aislides-chart') {
      const parent = dialogParent()
      const options = {
        type: 'warning' as const,
        buttons: [tm('chartSimplifyOk'), tm('btnCancel')],
        defaultId: 0,
        cancelId: 1,
        message: tm('chartSimplifyTitle'),
        detail: tm('chartSimplifyBody'),
      }
      const r = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options)
      if (r.response !== 0) return null
    }
    const patch: Parameters<typeof editChartElement>[3] = {
      ...(op.kind ? { kind: op.kind === 'barH' ? 'bar' : op.kind } : {}),
      ...(op.kind === 'barH' ? { barDir: 'bar' as const } : {}),
      ...(op.categories ? { categories: op.categories } : {}),
      ...(op.series ? { series: op.series } : {}),
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.colorScheme
        ? {
            colorScheme:
              chartColorSchemes(session.opened).find((s) => s.key === op.colorScheme)?.colors ??
              CHART_COLOR_SCHEMES[op.colorScheme],
          }
        : {}),
      ...(op.legendPos ? { legendPos: op.legendPos } : {}),
      ...(op.dataLabels !== undefined ? { dataLabels: op.dataLabels } : {}),
      ...(op.gridlines !== undefined ? { gridlines: op.gridlines } : {}),
      ...(op.catAxisTitle !== undefined ? { catAxisTitle: op.catAxisTitle } : {}),
      ...(op.valAxisTitle !== undefined ? { valAxisTitle: op.valAxisTitle } : {}),
      ...(op.gapWidthPct !== undefined ? { gapWidthPct: op.gapWidthPct } : {}),
      ...(op.switchRowCol ? { switchRowCol: true } : {}),
      ...(op.pointColors ? { pointColors: op.pointColors } : {}),
    }
    const r = sessionTxn(session, {
      ops: [{ op: 'setChart', target: { slide: op.slideIndex, el: op.sourceId }, patch }],
    })
    if (!r) return null
    // The chart part XML is updated; reparse the whole page to refresh the model
    const rebuilt = rebuildSlideWithReparse(session, op.slideIndex)
    if (!rebuilt) return null
    const newId = session.opened.deck.slides[op.slideIndex]?.elements[elIdx]?.id ?? null
    return { slide: rebuilt, sourceId: newId }
  })

  slidesOwnedHandle('slides:chart-color-schemes', (e) => {
    const session = sessions.get(e.sender.id)
    return session ? chartColorSchemes(session.opened) : null
  })

  slidesOwnedHandle('slides:get-chart-data', (e, slideIndex: number, sourceId: string) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[slideIndex]
    if (!slide) return null
    return getChartElementData(slide, sourceId)
  })

  slidesOwnedHandle('slides:reorder-element', (e, op: ReorderElementOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [
        { op: 'reorderElement', target: { slide: op.slideIndex, el: op.sourceId }, dir: op.dir },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle(
    'slides:change-shape',
    (e, op: { slideIndex: number; sourceId: string; prst: string; groupId?: string }) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const r = sessionTxn(session, {
        ops: [
          {
            op: 'setShapeGeometry',
            target: { slide: op.slideIndex, el: op.sourceId },
            prst: op.prst,
            ...(op.groupId ? { group: op.groupId } : {}),
          },
        ],
      })
      return r ? rebuildSlide(session, op.slideIndex) : null
    },
  )

  slidesOwnedHandle(
    'slides:set-shape-adjust',
    (
      e,
      op: {
        slideIndex: number
        sourceId: string
        adjust: Record<string, number>
        groupId?: string
        preview?: boolean
      },
    ) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const payload = {
        op: 'setShapeAdjust',
        target: { slide: op.slideIndex, el: op.sourceId },
        adjust: op.adjust,
        ...(op.groupId ? { group: op.groupId } : {}),
      }
      // Validate before the preview bookkeeping (same contract as edit-transform):
      // a failed first preview must not set transformPreview or clear the redo stack.
      if (runTxn(session.opened, { dryRun: true, ops: [payload] }).failures?.length) return null
      // Gesture undo semantics: one whole drag = one undo step. The first preview
      // pushes a pre-gesture snapshot; later previews and the final commit do not.
      let pushed = false
      if (op.preview) {
        if (!session.transformPreview) {
          pushHistory(session)
          session.transformPreview = true
          pushed = true
        }
      } else if (session.transformPreview) {
        session.transformPreview = false
      } else {
        pushHistory(session)
        pushed = true
      }
      const r = journaledTxn(session, 'edit', { ops: [payload] })
      if (!r.applied) {
        if (pushed) {
          session.undoStack.pop()
          if (op.preview) session.transformPreview = false
        }
        return null
      }
      return rebuildSlide(session, op.slideIndex)
    },
  )

  // Edit Points: same gesture-undo contract as set-shape-adjust (one drag = one undo step)
  slidesOwnedHandle('slides:set-shape-geometry', (e, op: SetShapeGeometryOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const scale = op.fitWidthPx / (session.opened.deck.size.cx / EMU_PER_PX_96)
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const payload = {
      op: 'setShapeCustomGeometry',
      target: { slide: op.slideIndex, el: op.sourceId },
      path: {
        w: toEmu(op.pathPx.w),
        h: toEmu(op.pathPx.h),
        cmds: op.pathPx.cmds.map((c) => ({ op: c.op, pts: c.pts.map(toEmu) })),
      },
      ...(op.groupId ? { group: op.groupId } : {}),
    }
    if (runTxn(session.opened, { dryRun: true, ops: [payload] }).failures?.length) return null
    let pushed = false
    if (op.preview) {
      if (!session.transformPreview) {
        pushHistory(session)
        session.transformPreview = true
        pushed = true
      }
    } else if (session.transformPreview) {
      session.transformPreview = false
    } else {
      pushHistory(session)
      pushed = true
    }
    const r = journaledTxn(session, 'edit', { ops: [payload] })
    if (!r.applied) {
      if (pushed) {
        session.undoStack.pop()
        if (op.preview) session.transformPreview = false
      }
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  })

  slidesOwnedHandle(
    'slides:set-text-anchor',
    (e, op: { slideIndex: number; sourceId: string; anchor: 'top' | 'middle' | 'bottom' }) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const r = sessionTxn(session, {
        ops: [
          {
            op: 'setTextAnchor',
            target: { slide: op.slideIndex, el: op.sourceId },
            anchor: op.anchor,
          },
        ],
      })
      return r ? rebuildSlide(session, op.slideIndex) : null
    },
  )

  slidesOwnedHandle(
    'slides:set-text-body-props',
    (
      e,
      op: {
        slideIndex: number
        sourceId: string
        props: {
          vert?: 'horz' | 'eaVert' | 'vert' | 'vert270' | 'wordArtVert'
          autofit?: 'none' | 'shrink' | 'resize'
          insets?: Partial<{ l: number; t: number; r: number; b: number }>
          wrap?: boolean
        }
      },
    ) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const r = sessionTxn(session, {
        ops: [
          {
            op: 'setTextBodyProps',
            target: { slide: op.slideIndex, el: op.sourceId },
            props: op.props,
          },
        ],
      })
      if (!r) return null
      // Autofit must take effect immediately on toggle, not only on the next text edit:
      // 'resize' fits the shape height to the content now, 'shrink' runs the ladder and
      // writes the used fontScale back into bodyPr (a bare <a:normAutofit/> opens at
      // 100% in PowerPoint). Insets/wrap/vert changes re-fit under the same rules.
      const rendered = applyAutofitResize(
        session,
        op.slideIndex,
        op.sourceId,
        rebuildSlide(session, op.slideIndex),
      )
      return syncAutofitScale(session, op.slideIndex, op.sourceId, rendered)
    },
  )

  slidesOwnedHandle(
    'slides:set-effects',
    (e, op: { slideIndex: number; sourceId: string; effects: SetEffectsPatch }) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const r = sessionTxn(session, {
        ops: [
          {
            op: 'setEffects',
            target: { slide: op.slideIndex, el: op.sourceId },
            effects: op.effects,
          },
        ],
      })
      return r ? rebuildSlide(session, op.slideIndex) : null
    },
  )

  // Our marker still present = the last copy came from this app -> use internal element paste
  // (on macOS custom formats don't appear in availableFormats, so check via readBuffer)
  const clipboardMarker = (format: string) => {
    try {
      return clipboard.readBuffer(format).length > 0
    } catch {
      return false
    }
  }

  slidesOwnedHandle('slides:clipboard-external', () => {
    if (slideClipboard && clipboardMarker('io.vantage.slides.slide')) return { kind: 'slide' }
    if (elementClipboard && elementClipboardMarkerMatches(elementClipboard.token))
      return { kind: 'internal' }
    const img = clipboard.readImage()
    if (!img.isEmpty()) return { kind: 'image', base64: img.toPNG().toString('base64'), ext: 'png' }
    const text = clipboard.readText()
    if (text.trim()) return { kind: 'text', text }
    return { kind: 'none' }
  })

  // Menu-enable probe: is there anything a paste would act on? (no image decode)
  slidesOwnedHandle('slides:clipboard-probe', () => {
    if (slideClipboard && clipboardMarker('io.vantage.slides.slide')) return true
    if (elementClipboard && elementClipboardMarkerMatches(elementClipboard.token)) return true
    if (clipboard.availableFormats().some((f) => f.startsWith('image/'))) return true
    return clipboard.readText().trim().length > 0
  })

  slidesOwnedHandle('slides:copy-elements', (e, op: CopyElementsOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return 0
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return 0
    const items = op.sourceIds
      .map((id) => slide.elements.find((el) => el.id === id))
      .filter((el): el is NonNullable<typeof el> => !!el)
      .map((el) => copyElementData(session.opened, slide, el))
    if (items.length) {
      const token = isElementClipboardToken(op.clipboardToken) ? op.clipboardToken : randomUUID()
      elementClipboard = {
        items,
        cascade: newPasteCascade(op.cut ? null : pageKey(e.sender.id, op.slideIndex)),
        token,
        senderId: e.sender.id,
      }
      // Write our marker to the OS clipboard: an external copy overwrites it, so at paste time it tells whether internal or external is newer
      clipboard.writeBuffer(ELEMENT_CLIPBOARD_FORMAT, Buffer.from(token))
    }
    return items.length
  })

  slidesOwnedHandle('slides:copy-elements-image', (e, clipboardToken: string, pngBase64: string) => {
    if (!canWriteElementClipboardImage(elementClipboard, e.sender.id, clipboardToken)) return false
    return writeElementClipboardImage(clipboardToken, pngBase64)
  })

  slidesOwnedHandle('slides:paste-elements', (e, op: PasteElementsOp) => {
    const session = sessions.get(e.sender.id)
    const clip = elementClipboard
    if (!session || !clip?.items.length) return null
    if (!session.opened.deck.slides[op.slideIndex]) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    // Cascade only past occupied spots: the first paste onto another page lands
    // at the source coordinates exactly; the copy page and repeat
    // pastes keep shifting 16px per landing relative to the original.
    const target = pageKey(e.sender.id, op.slideIndex)
    const shiftPx = pasteShiftPx(clip.cascade, target)
    const shift = Math.round((shiftPx / scale) * EMU_PER_PX_96)
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'pasteElements',
          target: { slide: op.slideIndex },
          items: clip.items,
          dx: shift,
          dy: shift,
        },
      ],
    })
    if (!r) return null
    recordPaste(clip.cascade, target)
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceIds: r.records![0]!.created! } : null
  })

  // Duplicate in place (⌘D / Option+drag copy): does not touch the app clipboard; the caller supplies the offset
  slidesOwnedHandle('slides:duplicate-elements', (e, op: DuplicateElementsOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const items = op.sourceIds
      .map((id) => slide.elements.find((el) => el.id === id))
      .filter((el): el is NonNullable<typeof el> => !!el)
      .map((el) => copyElementData(session.opened, slide, el))
    if (!items.length) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'pasteElements',
          target: { slide: op.slideIndex },
          items,
          dx: toEmu(op.dxPx),
          dy: toEmu(op.dyPx),
        },
      ],
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceIds: r.records![0]!.created! } : null
  })

  slidesOwnedHandle('slides:add-table', (e, op: AddTableOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    if (!session.opened.deck.slides[op.slideIndex]) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const rowH = op.rowHeightEmu && op.rowHeightEmu > 0 ? Math.round(op.rowHeightEmu) : null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'addTable',
          target: { slide: op.slideIndex },
          rows: op.rows,
          cols: op.cols,
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: toEmu(op.wPx),
            cy: rowH ? rowH * op.rows : toEmu(op.hPx),
          },
          ...(rowH ? { rowHeightsEmu: Array.from({ length: op.rows }, () => rowH) } : {}),
        },
      ],
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.records![0]!.created![0]! } : null
  })

  // Freehand ink stroke commit: one transparent PNG picture element per stroke (cNvPr name has
  // the aislides-ink prefix, descr stores the vector points as JSON); undo/save/thumbnails all
  // go through the existing picture-element pipeline.
  slidesOwnedHandle('slides:add-ink', (e, op: AddInkOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'addPicture',
          target: { slide: op.slideIndex },
          bytes: new Uint8Array(Buffer.from(op.base64, 'base64')),
          ext: 'png',
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: Math.max(1, toEmu(op.wPx)),
            cy: Math.max(1, toEmu(op.hPx)),
          },
          name: `aislides-ink ${Date.now().toString(36)}`,
          descr: op.payload,
        },
      ],
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.records![0]!.created![0]! } : null
  })

  // ── New insert capabilities: charts / SmartArt / icon bitmaps / audio-video / 3D / links / header-footer ──

  slidesOwnedHandle('slides:add-chart', (e, op: AddChartOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'addChart',
          target: { slide: op.slideIndex },
          kind: op.kind === 'barH' ? 'bar' : op.kind,
          ...(op.kind === 'barH' ? { barDir: 'bar' as const } : {}),
          ...(op.title ? { title: op.title } : {}),
          categories: op.categories,
          series: op.series,
          offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
        },
      ],
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.records![0]!.created![0]! } : null
  })

  slidesOwnedHandle('slides:add-smartart', (e, op: AddSmartArtOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'addSmartArt',
          target: { slide: op.slideIndex },
          layout: op.layout,
          items: op.items,
          offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
        },
      ],
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.records![0]!.created![0]! } : null
  })

  slidesOwnedHandle('slides:add-image-bytes', (e, op: AddImageBytesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const deckSize = session.opened.deck.size
    const baseWidthPx = deckSize.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const bytes = new Uint8Array(Buffer.from(op.base64, 'base64'))
    let offset: { x: number; y: number; cx: number; cy: number }
    if ('naturalPx' in op) {
      offset = pictureFrame(
        { width: deckSize.cx, height: deckSize.cy },
        op.naturalPx,
        imageDpiFromBytes(bytes),
        DEFAULT_PICTURE_DPI,
        {
          center: op.centerPx ? { x: toEmu(op.centerPx.x), y: toEmu(op.centerPx.y) } : undefined,
          minEmu: toEmu(24),
        },
      )
    } else {
      offset = {
        x: toEmu(op.xPx),
        y: toEmu(op.yPx),
        cx: Math.max(1, toEmu(op.wPx)),
        cy: Math.max(1, toEmu(op.hPx)),
      }
    }
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'addPicture',
          target: { slide: op.slideIndex },
          bytes,
          ext: op.ext,
          offset,
          ...(op.name ? { name: op.name } : {}),
        },
      ],
    })
    if (!r) return { error: 'unsupported' as const, ext: op.ext }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.records![0]!.created![0]! } : null
  })

  slidesOwnedHandle('slides:replace-picture-bytes', (e, op: ReplacePictureBytesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'replacePicture',
          target: { slide: op.slideIndex, el: op.sourceId },
          bytes: new Uint8Array(Buffer.from(op.base64, 'base64')),
          ext: op.ext,
          ...(op.keepSrcRect ? { keepSrcRect: true } : {}),
        },
      ],
    })
    if (!r) return { error: 'unsupported' as const, ext: op.ext }
    return rebuildSlide(session, op.slideIndex)
  })

  // In-app playback caveats: AVI has no Chromium demuxer at all; mp4/m4v/mov
  // with e.g. AC-3/DTS audio plays silent.
  const mediaPlaybackWarning = (kind: 'video' | 'audio', ext: string, bytes: Uint8Array) => {
    if (kind !== 'video') return null
    if (ext === 'avi') return tm('mediaAviBody')
    if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') {
      const codec = unplayableAudioCodec(bytes)
      if (codec) return tm('mediaNoAudioBody', { codec })
    }
    return null
  }

  // Video poster frame prefers the system thumbnail (QuickLook), falling back to a solid color on failure.
  const videoPoster = async (filePath: string) => {
    try {
      const thumb = await nativeImage.createThumbnailFromPath(filePath, { width: 960, height: 540 })
      if (!thumb.isEmpty()) return { bytes: new Uint8Array(thumb.toPNG()), ext: 'png' }
    } catch {
      /* Solid-color fallback */
    }
    return undefined
  }

  const embedMedia = async (
    session: Session,
    slideIndex: number,
    kind: 'video' | 'audio',
    bytes: Uint8Array,
    ext: string,
    name: string | undefined,
    opts: { filePath?: string; natural?: Size | null; center?: Point; fitWidthPx: number },
  ): Promise<AddMediaResult | null> => {
    const poster = kind === 'video' && opts.filePath ? await videoPoster(opts.filePath) : undefined
    const deckSize = session.opened.deck.size
    const slideSize = { width: deckSize.cx, height: deckSize.cy }
    const offset =
      kind === 'video'
        ? videoFrame(slideSize, opts.natural ?? videoSize(bytes, ext), opts.center)
        : audioFrame(slideSize, opts.center)
    const txn = sessionTxn(session, {
      ops: [
        {
          op: 'addMedia',
          target: { slide: slideIndex },
          kind,
          bytes,
          ext,
          ...(poster ? { poster } : {}),
          offset,
          ...(name ? { name } : {}),
        },
      ],
    })
    if (!txn) return null
    session.fitWidthPx = opts.fitWidthPx
    const rebuilt = rebuildSlide(session, slideIndex)
    if (!rebuilt) return null
    const warning = mediaPlaybackWarning(kind, ext, bytes)
    return {
      slide: rebuilt,
      sourceId: txn.records![0]!.created![0]!,
      ...(warning ? { warning } : {}),
    }
  }

  // Show a dialog to pick video/audio and embed it.
  slidesOwnedHandle(
    'slides:insert-media',
    async (e, slideIndex: number, kind: 'video' | 'audio', fitWidthPx: number) => {
      const session = sessions.get(e.sender.id)
      if (!session || !session.opened.deck.slides[slideIndex]) return null
      const parent = dialogParent()
      const filters =
        kind === 'video'
          ? [{ name: tm('filterVideo'), extensions: [...VIDEO_EXTS] }]
          : [{ name: tm('filterAudio'), extensions: [...AUDIO_EXTS] }]
      const options = {
        title: kind === 'video' ? tm('dlgInsertVideo') : tm('dlgInsertAudio'),
        properties: ['openFile' as const],
        filters,
      }
      const r = await showOpenDialogWithMemory(dialog, parent, options)
      if (r.canceled || !r.filePaths[0]) return null
      const filePath = r.filePaths[0]
      const bytes = new Uint8Array(await readFile(filePath))
      const ext = filePath.split('.').pop()!.toLowerCase()
      const fileName = baseName(filePath)

      // Warn up front, before the file lands on the slide
      const detail = mediaPlaybackWarning(kind, ext, bytes)
      if (detail) {
        const warn = {
          type: 'warning' as const,
          buttons: [tm('legacyPptOk')],
          message: tm('mediaUnsupportedTitle'),
          detail,
        }
        if (parent) await dialog.showMessageBox(parent, warn)
        else await dialog.showMessageBox(warn)
      }

      const result = await embedMedia(session, slideIndex, kind, bytes, ext, fileName, {
        filePath,
        fitWidthPx,
      })
      return result ? { slide: result.slide, sourceId: result.sourceId } : null
    },
  )

  // Double-click playback: read the media bytes of an audio/video element (embedded converts to dataUrl, external links return as-is)
  const AV_MIME: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    // Chromium refuses to even load video/quicktime, but demuxes QuickTime bytes
    // fine through the ISO-BMFF path when served as video/mp4
    mov: 'video/mp4',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
  }
  slidesOwnedHandle('slides:media-data', (e, slideIndex: number, sourceId: string) => {
    const session = sessions.get(e.sender.id)
    const slide = session?.opened.deck.slides[slideIndex]
    if (!session || !slide) return null
    const el = slide.elements.find((x) => x.id === sourceId)
    if (!el || el.type !== 'picture') return null
    const media = (
      el as { media?: { kind: 'video' | 'audio'; target?: string; external?: boolean } }
    ).media
    if (!media?.target) return null
    if (media.external) return { kind: media.kind, dataUrl: media.target }
    const bytes = session.opened.archive.readBytes(media.target)
    if (!bytes) return null
    const ext = media.target.split('.').pop()?.toLowerCase() ?? ''
    const mime = AV_MIME[ext] ?? (media.kind === 'video' ? 'video/mp4' : 'audio/mpeg')
    return {
      kind: media.kind,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    }
  })

  // Media recorded by the renderer (screen-recording webm) or dropped on the canvas: placed like an inserted file
  slidesOwnedHandle('slides:add-media-bytes', async (e, op: AddMediaBytesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    let bytes: Uint8Array
    try {
      bytes =
        'path' in op
          ? new Uint8Array(await readFile(op.path))
          : new Uint8Array(Buffer.from(op.base64, 'base64'))
    } catch {
      return null
    }
    const deckSize = session.opened.deck.size
    const scale = op.fitWidthPx / (deckSize.cx / EMU_PER_PX_96)
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    return embedMedia(session, op.slideIndex, op.kind, bytes, op.ext, op.name, {
      filePath: 'path' in op ? op.path : undefined,
      natural: op.natural,
      center: op.centerPx ? { x: toEmu(op.centerPx.x), y: toEmu(op.centerPx.y) } : undefined,
      fitWidthPx: op.fitWidthPx,
    })
  })

  // 3D model (simplified): glb embed + poster placeholder image
  slidesOwnedHandle('slides:pick-model3d', async () => {
    const r = await showOpenDialogWithMemory(dialog, dialogParent(), {
      title: tm('dlgInsert3d'),
      properties: ['openFile' as const],
      filters: [{ name: tm('filter3d'), extensions: ['glb'] }],
    })
    if (r.canceled || !r.filePaths[0]) return null
    const bytes = await readFile(r.filePaths[0])
    return { name: baseName(r.filePaths[0]), bytes: new Uint8Array(bytes) }
  })

  slidesOwnedHandle('slides:add-model3d', (e, op: AddModel3dOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    const deckSize = session.opened.deck.size
    const cy = Math.round(deckSize.cy * 0.5)
    const cx = Math.round(cy * op.aspect)
    const txn = sessionTxn(session, {
      ops: [
        {
          op: 'addModel3d',
          target: { slide: op.slideIndex },
          bytes: op.bytes,
          ext: 'glb',
          ...(op.posterBase64
            ? {
                poster: {
                  bytes: new Uint8Array(Buffer.from(op.posterBase64, 'base64')),
                  ext: 'png',
                },
              }
            : {}),
          offset: {
            x: Math.round((deckSize.cx - cx) / 2),
            y: Math.round((deckSize.cy - cy) / 2),
            cx,
            cy,
          },
          name: op.name,
        },
      ],
    })
    if (!txn) return null
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: txn.records![0]!.created![0]! } : null
  })

  slidesOwnedHandle('slides:model3d-data', (e, slideIndex: number, sourceId: string) => {
    const session = sessions.get(e.sender.id)
    const el = session?.opened.deck.slides[slideIndex]?.elements.find((x) => x.id === sourceId)
    const target = el?.type === 'picture' ? el.model3d?.target : undefined
    const bytes = target ? session!.opened.archive.readBytes(target) : undefined
    return bytes ? new Uint8Array(bytes) : null
  })

  slidesOwnedHandle('slides:set-model3d-view', (e, op: SetModel3dViewOp) => {
    const session = sessions.get(e.sender.id)
    if (!session?.opened.deck.slides[op.slideIndex]) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'setModel3dView',
          target: { slide: op.slideIndex, el: op.sourceId },
          ...op.rot,
          ...(op.posterBase64 ? { poster: op.posterBase64, posterExt: 'png' } : {}),
        },
      ],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:set-link', (e, op: SetLinkOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    // A javascript:/file: target must never be saved into the package.
    if (
      op.target?.kind === 'url' &&
      safeExternalUrl(op.target.url, { allowedProtocols: DECK_LINK_PROTOCOLS }) === null
    ) {
      return null
    }
    const r = sessionTxn(session, {
      ops: [{ op: 'setLink', target: { slide: op.slideIndex, el: op.sourceId }, link: op.target }],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  slidesOwnedHandle('slides:get-link', (e, slideIndex: number, sourceId: string) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    return getElementLink(session.opened, slideIndex, sourceId)
  })

  slidesOwnedHandle('slides:get-slide-links', (e, slideIndex: number) => {
    const session = sessions.get(e.sender.id)
    if (!session) return []
    return getSlideLinks(session.opened, slideIndex).map(({ elementId, target }) => ({
      sourceId: elementId,
      target,
    }))
  })

  slidesOwnedHandle('slides:get-run-links', (e, slideIndex: number) => {
    const session = sessions.get(e.sender.id)
    if (!session) return []
    return getRunLinks(session.opened, slideIndex).map(({ elementId, ...rest }) => ({
      sourceId: elementId,
      ...rest,
    }))
  })

  slidesOwnedHandle('slides:apply-header-footer', (e, op: HeaderFooterOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'applyHeaderFooter',
          settings: {
            footer: op.footer ?? null,
            slideNum: !!op.slideNum,
            date: op.date ?? null,
            ...(op.dateAuto ? { dateAuto: true } : {}),
          },
        },
      ],
    })
    if (!r) return null
    session.fitWidthPx = op.fitWidthPx
    return buildAllRenderSlides(session.opened, op.fitWidthPx)
  })

  slidesOwnedHandle('slides:get-header-footer', (e, slideIndex: number) => {
    const session = sessions.get(e.sender.id)
    const slide = session?.opened.deck.slides[slideIndex]
    return slide ? readHeaderFooter(slide) : { footer: null, slideNum: false, date: null }
  })

  // Apply a theme (Design tab theme gallery): rewrite theme*.xml colors/fonts (scheme-referenced
  // colors follow), and remap the deck's explicit srgbClr wholesale to the new theme palette
  // (real-world decks have almost entirely explicit colors, so swapping only the theme changes
  // nothing visually). Element resolved colors come from the parse-time inheritance chain, so
  // after the surgery the deck reparses in memory; undo snapshots roll back as usual.
  slidesOwnedHandle('slides:apply-theme', (e, op: ApplyThemeOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const payload = {
      op: 'applyTheme',
      name: op.name,
      colors: op.colors,
      ...(op.majorFont ? { majorFont: op.majorFont } : {}),
      ...(op.minorFont ? { minorFont: op.minorFont } : {}),
    }
    // Plan first so an invalid request doesn't clear the redo stack
    const plan = runTxn(session.opened, { ops: [payload], dryRun: true })
    if (plan.failures?.length) return { error: plan.failures[0]!.error }
    pushHistory(session)
    const r = journaledTxn(session, 'edit', { ops: [payload] })
    if (!r.applied) {
      session.undoStack.pop()
      return { error: r.failures?.[0]?.error ?? 'applyTheme failed' }
    }
    const after = r.records![0]!.after as { patched: number; remapped: number }
    if (after.patched === 0 && after.remapped === 0) {
      // Nothing matched the spec; the op only baked pending edits — not an undo step
      session.undoStack.pop()
      return null
    }
    // Reparse so every element's resolved colors/fonts refresh. In-memory
    // (reparseDeck) instead of savePptx -> openPptx: the zip roundtrip's
    // contiguous buffer fails on large decks
    session.opened = reparseDeck(session.opened)
    // Reopening cleared element-level dirty; the session-level flag preserves the "unsaved" state (reset on save)
    markMetaDirty(session)
    session.fitWidthPx = op.fitWidthPx
    return buildAllRenderSlides(session.opened, op.fitWidthPx)
  })

  slidesOwnedHandle('slides:set-transition', (e, op: SetTransitionOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return false
    const slides = session.opened.deck.slides
    const idxs =
      op.slideIndex === -1 ? slides.map((_, i) => i) : slides[op.slideIndex] ? [op.slideIndex] : []
    if (idxs.length === 0) return false
    const r = sessionTxn(session, {
      ops: idxs.map((i) => ({ op: 'setTransition', target: { slide: i }, kind: op.kind })),
    })
    return r !== null
  })

  slidesOwnedHandle('slides:get-transition', (e, slideIndex: number) => {
    const session = sessions.get(e.sender.id)
    const slide = session?.opened.deck.slides[slideIndex]
    return slide ? getSlideTransition(slide) : 'none'
  })

  slidesOwnedHandle('slides:get-show-timing', (e, slideIndex: number): ShowTiming => {
    const slide = sessions.get(e.sender.id)?.opened.deck.slides[slideIndex]
    if (!slide) return { advanceMs: null, narrationIds: [] }
    const narration = new Set(narrationSpids(slide))
    return {
      advanceMs: getSlideAdvanceTime(slide),
      narrationIds: slide.elements
        .filter((el) => narration.has(elementSpid(el) ?? -1))
        .map((el) => el.id),
    }
  })

  // Rehearsal timing save: batch-write each page's auto-advance time (<p:transition advTm>, ms)
  slidesOwnedHandle('slides:set-advance-times', (e, op: SetAdvanceTimesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return false
    const slides = session.opened.deck.slides
    const targets = op.times.filter((t) => slides[t.slideIndex])
    if (targets.length === 0) return false
    const r = sessionTxn(session, {
      ops: targets.map((t) => ({
        op: 'setAdvanceTime',
        target: { slide: t.slideIndex },
        ms: t.ms,
      })),
    })
    return r !== null
  })

  // ── Slide Show > Record: narration per slide plus its advance time, one undo step ──
  slidesOwnedHandle('slides:save-recording', (e, op: SaveRecordingOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slides = session.opened.deck.slides
    const recorded = op.slides.filter((s) => slides[s.slideIndex])
    if (recorded.length === 0) return null
    const r = sessionTxn(session, {
      ops: recorded.flatMap((s) => [
        {
          op: 'addNarration',
          target: { slide: s.slideIndex },
          bytes: s.wavBase64,
          ext: 'wav',
          durationMs: s.durationMs,
        },
        { op: 'setAdvanceTime', target: { slide: s.slideIndex }, ms: s.advanceMs },
      ]),
    })
    return r ? slides.map((_, i) => rebuildSlide(session, i)) : null
  })

  slidesOwnedHandle('slides:clear-narration', (e, slideIndexes: number[]) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slides = session.opened.deck.slides
    const targets = slideIndexes.filter((i) => slides[i] && narrationSpids(slides[i]).length > 0)
    if (targets.length === 0) return null
    const r = sessionTxn(session, {
      ops: targets.map((i) => ({ op: 'clearNarration', target: { slide: i } })),
    })
    return r ? slides.map((_, i) => rebuildSlide(session, i)) : null
  })

  slidesOwnedHandle('slides:microphone-access', async () => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })

  // ── Shape animations (<p:timing>; the spid <-> temporary element id mapping happens here) ──
  slidesOwnedHandle('slides:get-animations', (e, slideIndex: number): AnimationItem[] => {
    const session = sessions.get(e.sender.id)
    const slide = session?.opened.deck.slides[slideIndex]
    if (!slide) return []
    const bySpid = new Map<number, (typeof slide.elements)[number]>()
    for (const el of slide.elements) {
      const spid = elementSpid(el)
      if (spid != null && !bySpid.has(spid)) bySpid.set(spid, el)
    }
    const typeLabel: Record<string, string> = {
      text: tm('labelTextBox'),
      shape: tm('labelShape'),
      picture: tm('labelPicture'),
      group: tm('labelGroup'),
      table: tm('labelTable'),
      chart: tm('labelChart'),
      passthrough: tm('labelObject'),
    }
    const out: AnimationItem[] = []
    for (const a of getSlideAnimations(slide)) {
      const el = bySpid.get(a.spid)
      if (!el) continue // Leftover animations whose target shape was deleted are not echoed back
      out.push({
        sourceId: el.id,
        targetName: el.name || typeLabel[el.type] || tm('labelObject'),
        effect: a.effect,
        trigger: a.trigger,
        durationMs: a.durationMs,
        delayMs: a.delayMs,
        // a modelled directional effect carries its own direction; a top wipe must not
        // come back to the player as a bare 'wipe' and play bottom-up
        ...(a.direction != null ? { direction: a.direction } : {}),
        ...(a.motionPath != null ? { motionPath: a.motionPath } : {}),
        ...(a.paragraph != null ? { paragraph: a.paragraph } : {}),
      })
    }
    return out
  })

  // Pairing keys for Morph transitions: sourceId changes on every reparse, so match across pages by cNvPr id/name
  slidesOwnedHandle('slides:get-shape-keys', (e, slideIndex: number): ShapeKey[] => {
    const session = sessions.get(e.sender.id)
    const slide = session?.opened.deck.slides[slideIndex]
    if (!slide) return []
    return slide.elements.map((el) => ({
      sourceId: el.id,
      spid: elementSpid(el),
      name: el.name ?? '',
    }))
  })

  slidesOwnedHandle('slides:set-animations', (e, op: SetAnimationsOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return false
    const r = sessionTxn(session, {
      ops: [{ op: 'setAnimations', target: { slide: op.slideIndex }, items: op.items }],
    })
    return r !== null
  })

  slidesOwnedHandle('slides:set-hidden', (e, op: SetSlideHiddenOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, {
      ops: [{ op: 'setHidden', target: { slide: op.slideIndex }, hidden: op.hidden }],
    })
    return r ? rebuildSlide(session, op.slideIndex) : null
  })

  // ── Section management: presentation.xml surgery, riding on snapshot undo and savePptx ──
  slidesOwnedHandle('slides:get-sections', (e) => {
    const session = sessions.get(e.sender.id)
    return session ? getSections(session.opened) : []
  })

  // Section shims share one shape: single op, metaDirty, echo the op's section payload back.
  const sectionShim = (e: Electron.IpcMainInvokeEvent, op: Record<string, unknown>) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const r = sessionTxn(session, { ops: [op as Parameters<typeof runTxn>[1]['ops'][0]] })
    if (!r) return null
    markMetaDirty(session)
    return r.records![0]!.after
  }

  slidesOwnedHandle('slides:set-sections', (e, sections: SectionInfo[]) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    if (!sectionShim(e, { op: 'setSections', sections })) return null
    return getSections(session.opened)
  })

  slidesOwnedHandle('slides:add-section', (e, op: AddSectionOp) =>
    sectionShim(e, { op: 'addSection', atSlideIndex: op.atSlideIndex, name: op.name }),
  )

  slidesOwnedHandle('slides:rename-section', (e, op: RenameSectionOp) =>
    sectionShim(e, { op: 'renameSection', id: op.id, name: op.name }),
  )

  slidesOwnedHandle('slides:remove-section', (e, op: RemoveSectionOp) =>
    sectionShim(e, { op: 'removeSection', id: op.id }),
  )

  // Section header + its slides in one undo step. Slides go highest index first so the
  // numeric targets stay valid as the deck shrinks; the deck keeps at least one slide.
  slidesOwnedHandle('slides:remove-section-slides', (e, op: RemoveSectionSlidesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const total = session.opened.deck.slides.length
    const { lead, sections } = normalizeSections(getSections(session.opened), total)
    const indices = op.id == null ? lead : sections.find((s) => s.id === op.id)?.slideIndices
    if (!indices || indices.length >= total) return null
    const ops: Parameters<typeof runTxn>[1]['ops'] = [...indices]
      .reverse()
      .map((i) => ({ op: 'deleteSlide', target: { slide: i } }))
    if (op.id != null) ops.push({ op: 'removeSection', id: op.id })
    if (!ops.length) return null
    const r = sessionTxn(session, { ops })
    if (!r) return null
    markMetaDirty(session)
    return {
      ...buildSlideUpdate(session, before),
      sections: getSections(session.opened),
    }
  })

  // Drag to reorder slides (sldIdLst + deck.slides + section membership)
  slidesOwnedHandle('slides:move-slide', (e, op: MoveSlideOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const r = sessionTxn(session, {
      ops: [{ op: 'moveSlide', target: { slide: op.fromIndex }, to: op.toIndex }],
    })
    if (!r) return null
    markMetaDirty(session)
    return {
      ...buildSlideUpdate(session, before),
      sections: getSections(session.opened),
    }
  })

  slidesOwnedHandle('slides:move-slides', (e, op: MoveSlidesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const steps = planSlideMoves(session.opened.deck.slides.length, op.slideIndexes, op.insertAt)
    if (!steps.length) return null
    const r = sessionTxn(session, {
      ops: steps.map((st) => ({ op: 'moveSlide' as const, target: { slide: st.from }, to: st.to })),
    })
    if (!r) return null
    markMetaDirty(session)
    return {
      ...buildSlideUpdate(session, before),
      sections: getSections(session.opened),
    }
  })

  // Moving a whole section changes slide order (sldIdLst + deck.slides)
  slidesOwnedHandle('slides:move-section', (e, op: MoveSectionOp) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const before = session.opened.deck.slides.map((s) => s.path)
    const sections = sectionShim(e, { op: 'moveSection', id: op.id, dir: op.dir })
    if (!sections) return null
    return {
      ...buildSlideUpdate(session, before),
      sections,
    }
  })

  // ── Speaker notes / comments (archive surgery, riding on snapshot undo and savePptx) ────
  slidesOwnedHandle('slides:get-notes', (e, slideIndex: number, partPath?: string) => {
    const session = sessions.get(e.sender.id)
    const index = session ? notesPartIndex(session.opened.deck.slides, slideIndex, partPath) : -1
    if (partPath !== undefined && index < 0)
      throw new Error('The requested speaker notes part is unavailable; its text was not replaced.')
    const slide = session?.opened.deck.slides[index]
    return session && slide ? getSlideNotes(session.opened.archive, slide.path) : ''
  })

  slidesOwnedHandle('slides:set-notes', (e, op: SetNotesOp) => {
    const session = sessions.get(e.sender.id)
    if (!session || !op || typeof op.text !== 'string') return false
    return writeNotesPart(session.opened.deck.slides, op, (index) => {
      const r = sessionTxn(session, {
        ops: [{ op: 'setNotes', target: { slide: index }, text: op.text }],
      })
      if (r) markMetaDirty(session)
      return r !== null
    })
  })

  slidesOwnedHandle('slides:get-comments', (e, slideIndex: number) => {
    const session = sessions.get(e.sender.id)
    const slide = session?.opened.deck.slides[slideIndex]
    return session && slide ? getSlideComments(session.opened.archive, slide.path) : []
  })

  slidesOwnedHandle('slides:add-comment', (e, op: AddCommentOp) => {
    const session = sessions.get(e.sender.id)
    const slide = session?.opened.deck.slides[op.slideIndex]
    if (!session || !slide) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'addComment',
          target: { slide: op.slideIndex },
          author: commentAuthorName(),
          text: op.text,
        },
      ],
    })
    if (!r) return null
    markMetaDirty(session)
    return getSlideComments(session.opened.archive, slide.path)
  })

  slidesOwnedHandle('slides:delete-comment', (e, op: DeleteCommentOp) => {
    const session = sessions.get(e.sender.id)
    const slide = session?.opened.deck.slides[op.slideIndex]
    if (!session || !slide) return null
    const r = sessionTxn(session, {
      ops: [
        {
          op: 'deleteComment',
          target: { slide: op.slideIndex },
          authorId: op.authorId,
          idx: op.idx,
        },
      ],
    })
    if (!r) return null
    markMetaDirty(session)
    return getSlideComments(session.opened.archive, slide.path)
  })

  // System clipboard while text-editing (menu commands are echoed back by the renderer per context)
  slidesOwnedHandle('slides:native-clipboard', (e, op: 'cut' | 'copy' | 'paste') => {
    if (op === 'cut') e.sender.cut()
    else if (op === 'copy') e.sender.copy()
    else e.sender.paste()
  })

  slidesOwnedHandle('slides:history-batch-begin',(event)=>historyBatches.begin(event.sender,historyBatchFrame(event)))
  // Capability-only continuation. The broker validates nonce+owner+frame and
  // joins actual running invokes before its exact synchronous collapse. This
  // endpoint grants no ordinary mutation/source-envelope bypass.
  ipcMain.handle('slides:history-batch-owned-finish',(event,ticket:unknown)=>historyBatches.finish(event.sender,historyBatchFrame(event),ticket))

  slidesOwnedHandle('slides:ai-snapshot-restore', (e, id: number) => {
    const session = sessions.get(e.sender.id)
    if (!session || session.masterEdit || session.historyBatch) return null
    invalidateToolCloseForSession(session)
    if (!restoreAiSnapshot(session, id)) return null
    scheduleDeckBroadcast(session)
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  })

  slidesOwnedHandle('slides:undo', (e) => {
    const session = sessions.get(e.sender.id)
    // Undo disabled in master view: the masterEdit.slide model cannot roll back with snapshots (v1 trade-off; undoable after exiting)
    if (!session || session.masterEdit) return null
    historyBatches.assertReplayAllowed(session.historyBatch)
    settleStaleHistoryBatch(session)
    if (session.undoStack.length === 0) return null
    session.redoStack.push(takeSnapshot(session))
    invalidateToolCloseForSession(session)
    restoreSnapshot(session, session.undoStack.pop()!)
    scheduleHistoryNotify(session)
    scheduleDeckBroadcast(session)
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  })

  slidesOwnedHandle('slides:redo', (e) => {
    const session = sessions.get(e.sender.id)
    if (!session || session.masterEdit) return null
    historyBatches.assertReplayAllowed(session.historyBatch)
    settleStaleHistoryBatch(session)
    if (session.redoStack.length === 0) return null
    session.undoStack.push(takeSnapshot(session))
    invalidateToolCloseForSession(session)
    restoreSnapshot(session, session.redoStack.pop()!)
    scheduleHistoryNotify(session)
    scheduleDeckBroadcast(session)
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  })

  slidesOwnedHandle('slides:is-dirty', (e) => {
    const session = sessions.get(e.sender.id)
    if (!session) return false
    return slidesIsDirty(e.sender.id)
  })

  slidesOwnedHandle('slides:save',async e=>{
    const session=sessions.get(e.sender.id);if(!session)return{ok:false,error:'no file open'}
    const filePath=session.path||pickDraftPath(getDraftsDir(),tm('untitledDeck'))
    try{await saveSessionDeckTo(session,filePath);return{ok:true,path:filePath,dirty:sessionDirty(session),slides:buildAllRenderSlides(session.opened,session.fitWidthPx)}}catch(error){return{ok:false,error:String(error)}}
  })
  slidesOwnedHandle('slides:save-as',async(e,defaultName:string)=>{
    const session=sessions.get(e.sender.id);if(!session)return{ok:false,error:'no file open'}
    const publication=publicationForSession(session),source=publication.snapshot()
    const r=await showSaveDialogWithMemory(dialog,dialogParent(),{defaultPath:saveAsSuggestion(session.path,defaultName),filters:[{name:'PowerPoint',extensions:['pptx']}]},getDraftsDir())
    if(r.canceled||!r.filePath)return{ok:false}
    if(sessions.get(e.sender.id)!==session||publication.snapshot()!==source)return{ok:false,error:'The presentation changed while Save As was open.'}
    try{
      const target=await observePublicationTarget(r.filePath)
      if(target.version){const parent=dialogParent(),choice={type:'warning' as const,message:'Replace the selected file?',detail:r.filePath+'\nThe exact version now on disk will be replaced. A later change will stop this save.',buttons:['Replace','Cancel'],defaultId:1,cancelId:1,noLink:true};const answer=parent&&!parent.isDestroyed()?await dialog.showMessageBox(parent,choice):await dialog.showMessageBox(choice);if(answer.response!==0)return{ok:false}}
      if(sessions.get(e.sender.id)!==session||publication.snapshot()!==source)return{ok:false,error:'The presentation changed before the selected write.'}
      await saveSessionDeckTo(session,r.filePath,{source,target});return{ok:true,path:r.filePath,dirty:sessionDirty(session),slides:buildAllRenderSlides(session.opened,session.fitWidthPx)}
    }catch(error){return{ok:false,error:String(error)}}
  })

  // ── Export (PDF / images): the renderer renders hi-res PNGs with offscreen Konva; the main process handles dialogs/writing ──

  slidesOwnedHandle('slides:pick-export-dir', async (event,plan:{baseName:string;count:number}) => {
    return selectCurrentSlidesOutput({captureProof:()=>slidesExportSourceProof(event.sender),pick:async()=>{
    const parent = dialogParent()
    const options = {
      title: tm('dlgPickExportDir'),
      buttonLabel: tm('btnExport'),
      properties: ['openDirectory' as const, 'createDirectory' as const],
    }
    const r = await showOpenDialogWithMemory(dialog, parent, options)
    if(r.canceled||!r.filePaths[0])return null
    return r.filePaths[0]
    },pin:async(dir,proof)=>{
    const paths=selectedSlidesImagePaths(dir,plan?.baseName,plan?.count)
    const selectionId=await slidesOutputSelections.capture(event.sender,paths,proof)
    return{path:dir,selectionId}
    }})
  })

  slidesOwnedHandle(
    'slides:export-images',
    async (_e, op: ExportImagesOp): Promise<ExportImagesResult> => {
      try {
        const paths=selectedSlidesImagePaths(op.dir,op.baseName,op.pngsBase64.length)
        const selected=slidesOutputSelections.claim(_e.sender,op.selectionId,paths)
        await publishSelectedUserOutputs(paths.map((path,index)=>({path,expectedVersion:selected.versions[index]!,prepare:async()=>Buffer.from(op.pngsBase64[index]!, 'base64')})),selected.proof)
        return { ok: true, paths }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
  )

  slidesOwnedHandle('slides:pick-export-pdf-path', async (_e, defaultName: string) => {
    return selectCurrentSlidesOutput({captureProof:()=>slidesExportSourceProof(_e.sender),pick:async()=>{
    const parent = dialogParent()
    const options = {
      title: tm('dlgExportPdf'),
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }
    const r = await showSaveDialogWithMemory(dialog, parent, options, getDraftsDir())
    if(r.canceled||!r.filePath)return null
    return r.filePath
    },pin:async(path,proof)=>{
    const selectionId=await slidesOutputSelections.capture(_e.sender,[path],proof)
    return{path,selectionId}
    }})
  })

  slidesOwnedHandle(
    'slides:save-picture',
    async (_e, op: SavePictureOp): Promise<SavePictureResult> => {
      const options = {
        title: tm('dlgSavePicture'),
        defaultPath: `${op.defaultName}.png`,
        filters: [{ name: 'PNG', extensions: ['png'] }],
      }
      const r = await showSaveDialogWithMemory(dialog, dialogParent(), options, getDraftsDir())
      if (r.canceled || !r.filePath) return { ok: false }
      try {
        await publishSelectedUserOutput(r.filePath, async()=>Buffer.from(op.pngBase64, 'base64'))
        return { ok: true, path: r.filePath }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
  )

  slidesOwnedHandle('slides:export-pdf', async (_e, op: ExportPdfOp): Promise<ExportPdfResult> => {
    const actual=async()=>{
    const selected=slidesOutputSelections.claim(_e.sender,op.selectionId??headlessOutputSelectionIds.get(_e.sender.id),[op.filePath])
    return exportSlidesPdf({
      ...op,
      selectedVersion:selected.versions[0]!,
      sourceProof:selected.proof,
      // hidden window: without this, throttled timers/rAF stall the
      // PRINT_READY_SCRIPT settle wait (same as the headless export window)
      createWindow: () =>
        new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, backgroundThrottling: false },
        }),
      openExportedPdf,
    })
    }
    const admission=headlessExportAdmissions.get(_e.sender.id)
    return admission?admission.run(actual):actual()
  })

  slidesOwnedHandle(
    'slides:print',
    async (e, op: PrintSlidesOp): Promise<{ ok: boolean; error?: string }> => {
      // Page assembly is shared with the renderer's print-preview pane (print-html.ts)
      const html = buildPrintDocumentHtml({
        srcs: op.pngsBase64.map((b64) => `data:image/png;base64,${b64}`),
        ratio: op.widthPx / op.heightPx,
        layout: op.layout ?? 'full',
        ...(op.notes ? { notes: op.notes } : {}),
        ...(op.orientation ? { orientation: op.orientation } : {}),
        ...(op.frame ? { frame: true } : {}),
      })
      const owner = hostWindowFor(e.sender) ?? dialogParent()
      const win = new BrowserWindow({
        show: false,
        ...(owner && !owner.isDestroyed() ? { parent: owner } : {}),
        ...(process.platform === 'win32'
          ? {
              width: 900,
              height: 700,
              autoHideMenuBar: true,
              closable: false,
              skipTaskbar: true,
            }
          : {}),
        webPreferences: { sandbox: true },
      })
      return printSlidesHtml(html, win)
    },
  )

  slidesOwnedHandle('slides:recent', () => readRecent())

  // ---- headless export mode (--headless-export) ----

  slidesOwnedHandle('slides:consume-headless-export', (e): string | null => {
    const target = headlessExportTargets.get(e.sender.id) ?? null
    headlessExportTargets.delete(e.sender.id)
    return target
  })

  ipcMain.on('slides:headless-export-done', (e, result: unknown) => {
    const settle = headlessExportWaiters.get(e.sender.id)
    if (!settle) return
    headlessExportWaiters.delete(e.sender.id)
    const state = result as { ok?: unknown; error?: unknown } | null
    settle({
      ok: state?.ok === true,
      ...(typeof state?.error === 'string' ? { error: state.error } : {}),
    })
  })

  // ── Show fullscreen: macOS native fullscreen is an animated Space transition, so
  // the slideshow would render windowed for ~1s mid-flight. Instead one call covers
  // everything while the show's black root hides the relayout: the tab view bleeds
  // over the tab strip (shell hook) and the window snaps via simpleFullScreen (same
  // trick as the audience window in presenter-show.ts). The renderer skips HTML
  // fullscreen on macOS entirely. Snap is skipped when the user already fullscreened
  // the window into its own Space; Windows/Linux keep HTML fullscreen (instant there)
  // and only need the bleed. Release is debounced: React strict-mode remounts and
  // presenter→show handoffs flip off→on within a tick, and honoring the off
  // immediately makes the window visibly bounce. ──
  let showFsRelease: ReturnType<typeof setTimeout> | null = null
  slidesOwnedHandle('slides:show-fullscreen', (e, on: boolean) => {
    // a detached editor window fullscreens itself, never the shell behind it
    const win = hostWindowFor(e.sender)
    if (!win || win.isDestroyed()) return
    const wc = e.sender
    if (showFsRelease) {
      clearTimeout(showFsRelease)
      showFsRelease = null
    }
    if (on) {
      showChrome.setBleed?.(wc, true)
      if (process.platform === 'darwin' && !win.isFullScreen()) {
        win.setFullScreenable(false)
        if (!win.isSimpleFullScreen()) win.setSimpleFullScreen(true)
      }
      // The snap can leave the window's first responder on the shell chrome view, so
      // keys land in the tab-strip renderer (Esc dead until a click on the show).
      // win.focus() must NOT be used here — it focuses the shell renderer itself.
      // Focus the tab's webContents now and once more on the next tick (the snap's
      // responder change lands async). HTML fullscreen used to do this implicitly.
      wc.focus()
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.focus()
      }, 50)
    } else {
      showFsRelease = setTimeout(() => {
        showFsRelease = null
        if (!wc.isDestroyed()) showChrome.setBleed?.(wc, false)
        if (win.isDestroyed()) return
        if (process.platform === 'darwin') {
          if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false)
          win.setFullScreenable(true)
        }
      }, 150)
    }
  })

  // ── Chat attachments (slides:files-*) ──
  registerAttachmentIpc()

  // ── Presenter-view multi-screen show (registered inside registerSlidesIpc: shell
  // aggregate mode only calls this function) ──
  registerPresenterIpc()

  registerSlidesOnlyAiIpc()
}

// ── project-store IPC (standalone mode) ───────────────────────────────────
// In shell mode docs-main.registerProjectIpc registers these centrally (idempotent guard,
// registers once). Slides standalone calls this function.

let slidesProjectStore: ProjectStore | null = null
let slidesProjectIpcRegistered = false

function getSlidesProjectStore(): ProjectStore {
  if (!slidesProjectStore) slidesProjectStore = new ProjectStore(app.getPath('userData'))
  return slidesProjectStore
}

export function registerProjectIpc(): void {
  if (slidesProjectIpcRegistered) return
  slidesProjectIpcRegistered = true

  slidesOwnedHandle(
    'project:resolveChat',
    (_event, args: { filePath: string | null; tempChatId?: string }) => {
      const store = getSlidesProjectStore()
      store.ensureDefaultProject()
      if (!args.filePath) {
        return { projectId: 'default', chatId: args.tempChatId ?? `unsaved-${Date.now()}` }
      }
      return store.resolveChatForFile(args.filePath)
    },
  )

  slidesOwnedHandle(
    'project:appendChat',
    (
      _event,
      args: {
        projectId: string
        chatId: string
        role: 'user' | 'assistant'
        text: string
        tools?: Array<{
          name: string
          summary: string
          isError?: boolean
          input?: string
          output?: string
        }>
        attachments?: Array<{ name: string; path?: string; ext?: string; sizeBytes?: number }>
        scope?: { label: string; text?: string }
      },
    ) => {
      if (args.role !== 'user' && args.role !== 'assistant') {
        throw new Error(`Invalid chat role: ${String(args.role)}`)
      }
      if (typeof args.text !== 'string' || args.text.length > 200_000) {
        throw new Error('Invalid chat text: must be a string up to 200000 chars')
      }
      if (args.tools && !Array.isArray(args.tools)) throw new Error('Invalid chat tools')
      if (args.attachments && !Array.isArray(args.attachments)) {
        throw new Error('Invalid chat attachments')
      }
      const msg: Parameters<ProjectStore['appendChatMessage']>[2] = {
        role: args.role,
        text: args.text,
      }
      if (args.tools) msg.tools = args.tools
      if (args.attachments) msg.attachments = args.attachments
      if (args.scope) msg.scope = args.scope

      getSlidesProjectStore().appendChatMessage(args.projectId, args.chatId, msg)
    },
  )

  slidesOwnedHandle(
    'project:loadChat',
    (_event, args: { projectId: string; chatId: string; limit?: number }) => {
      return getSlidesProjectStore().loadChat(args.projectId, args.chatId, args.limit ?? 200)
    },
  )

  slidesOwnedHandle(
    'project:rebindChat',
    (
      _event,
      args: { projectId: string; tempChatId: string; newChatId?: string; newFilePath?: string },
    ) => {
      const store = getSlidesProjectStore()
      if (args.newFilePath) {
        return store.rebindChatToFile(args.projectId, args.tempChatId, args.newFilePath)
      }
      if (args.newChatId) store.rebindChat(args.projectId, args.tempChatId, args.newChatId)
      return { projectId: args.projectId, chatId: args.newChatId ?? args.tempChatId }
    },
  )
}

/** hidden export windows: webContents id -> the PDF path the renderer must write */
const slidesOutputSelections=new UserOutputSelections<WebContents>()
const headlessOutputSelectionIds=new Map<number,string>()
const headlessExportAdmissions=new Map<number,SlidesExportAdmission>()
function slidesExportSourceProof(owner:WebContents):UserOutputSourceProof{
 const session=sessions.get(owner.id)
 if(!session)throw new Error('The presentation source is unavailable.')
 const sourcePath=session.path,revision=draftRevision(session)
 return{sourcePaths:sourcePath?[sourcePath]:[],assertCurrent:()=>{
  if(owner.isDestroyed()||sessions.get(owner.id)!==session||session.path!==sourcePath||draftRevision(session)!==revision)
   throw new Error('The presentation changed while its export destination was selected.')
 }}
}
function selectedSlidesImagePaths(dir:string,baseName:string,count:number):string[]{
 if(typeof baseName!=='string'||baseName.length>200||!Number.isSafeInteger(count)||count<1||count>4096)throw new Error('Invalid image export target plan.')
 const pad=count>=100?3:2
 const paths=Array.from({length:count},(_,index)=>join(dir,`${baseName}-${String(index+1).padStart(pad,'0')}.png`))
 if(paths.some(path=>resolve(dirname(path))!==resolve(dir)))throw new Error('Image export targets must remain inside the selected directory.')
 return paths
}
const headlessExportTargets = new Map<number, string>()
/** settled by 'slides:headless-export-done' (or by the renderer dying) */
const headlessExportWaiters = new Map<number, (result: HeadlessSlidesReport) => void>()

interface HeadlessSlidesReport {
  ok: boolean
  error?: string
}

/**
 * Render `input` to `outPath` with no visible window: a hidden slides
 * renderer opens the deck through the normal pending-open queue, rasterizes
 * every visible page offscreen exactly as the File menu export does, and
 * hands the PNGs to the same hidden print window (main/pdf-export.ts).
 */
export async function exportSlidesPdfHeadless(
  input: string,
  outPath: string,
  timeoutMs = 300_000,
): Promise<void> {
  const startedAt=Date.now()
  registerSlidesIpc()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 840,
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  const wcId = win.webContents.id
  trackSlidesWebContents(win.webContents)
  pendingByWc.set(wcId, input)
  headlessExportTargets.set(wcId, outPath)
  const lifecycle=new SlidesHeadlessExportLifecycle(timeoutMs,startedAt)
  const admission=lifecycle.admission
  headlessExportAdmissions.set(wcId,admission)
  // Register terminal ownership before metadata capture can yield.
  const terminal=(value:HeadlessSlidesReport)=>lifecycle.terminal(value)
  headlessExportWaiters.set(wcId,terminal)
  win.webContents.on('render-process-gone',(_event,details)=>terminal({ok:false,error:`slides renderer stopped (${details.reason})`}))
  try {
    const selectionId=await lifecycle.pin(()=>slidesOutputSelections.capture(win.webContents,[outPath],{sourcePaths:[input],assertCurrent:()=>{
      lifecycle.assertActive()
      if(win.isDestroyed())throw new Error('The registered headless export ended.')
    }}))
    lifecycle.assertActive()
    headlessOutputSelectionIds.set(wcId,selectionId)
    void win.webContents.loadURL(rendererUrl(runtime.rendererDevUrl,'slides')).catch(error=>terminal({ok:false,error:String(error)}))
    const report=await lifecycle.report
    if (!report.ok) throw new Error(report.error ?? 'slides export failed')
  } finally {
    terminal({ok:false,error:'The registered headless export ended.'})
    try{await admission.drain()}finally{
    headlessExportAdmissions.delete(wcId)
    headlessOutputSelectionIds.delete(wcId)
    slidesOutputSelections.forget(win.webContents)
    lifecycle.dispose()
    headlessExportWaiters.delete(wcId)
    headlessExportTargets.delete(wcId)
    pendingByWc.delete(wcId)
    if (!win.isDestroyed()) win.destroy()
    }
  }
}

export function createSlidesWindow(openPath?: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Vantage Slides',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#ffffff', symbolColor: '#444444', height: 40 },
        }),
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  trackSlidesWebContents(win.webContents)
  standaloneWindows.set(win.webContents.id, win)
  const standaloneWcId = win.webContents.id
  win.on('closed', () => standaloneWindows.delete(standaloneWcId))
  // The focused window owns the process-global menu-command target and the app
  // menu (the shell's tab manager re-claims both on its own window's focus)
  win.on('focus', () => {
    setActiveSlidesWebContents(win.webContents)
    installSlidesMenu()
  })
  // Titles are owned by the main process (initial file name, Save As updates);
  // the renderer's static <title> must not overwrite them
  win.on('page-title-updated', (event) => event.preventDefault())
  // Close guard for standalone-window mode (tab mode runs the same flow via the shell's tab-manager/window-close path)
  win.on('close', (event) => {
    event.preventDefault()
    void prepareSlidesNativeClose(win.webContents,win).then(receipt=>{if(!receipt)return;try{completeSlidesClose(win.webContents,receipt,()=>{if(win.isDestroyed())return false;win.destroy();return true})}finally{void cancelSlidesClose(win.webContents,receipt)}}).catch(error=>warnSlidesDraft(win.webContents.id,error))
  })

  void win.loadURL(rendererUrl(runtime.rendererDevUrl, 'slides'))

  if (openPath) {
    win.setTitle(basename(openPath))
    win.webContents.once('did-finish-load', async () => {
      try {
        const result = await openAndBuild(win.webContents, openPath, 1280)
        win.webContents.send('slides:opened', result)
      } catch {
        /* ignore */
      }
    })
  }
  return win
}

/** per-webContents background setter: opaque white while (re)loading, flipped
 * to transparent by consume-pending-open once the renderer has mounted, so the
 * vibrancy hole never shows the raw desktop behind an unpainted page */
const vibFlip = new Map<number, (color: string) => void>()

function armVibrancy(view: WebContentsView): void {
  if (process.platform !== 'darwin') return
  const setColor = (c: string) => view.setBackgroundColor(c)
  setColor('#ffffff')
  // view.webContents becomes undefined after destroy, so grab the id beforehand
  const wcId = view.webContents.id
  vibFlip.set(wcId, setColor)
  view.webContents.on('did-start-loading', () => setColor('#ffffff'))
  view.webContents.once('destroyed', () => vibFlip.delete(wcId))
}

/** Tab version of createSlidesWindow: same runtime/IPC, hosted in the shell's WebContentsView */
export function createSlidesView(openPath?: string | null): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  registerSlidesIpc()
  trackSlidesWebContents(view.webContents)
  armVibrancy(view)
  // The renderer calls consumePendingOpen on mount; use that to avoid a did-finish-load timing race
  if (openPath && existsSync(openPath)) pendingByWc.set(view.webContents.id, openPath)
  // mode=tab: the shell's tab strip owns the traffic lights / caption buttons,
  // so the ribbon must not reserve space for them
  void view.webContents.loadURL(rendererUrl(runtime.rendererDevUrl, 'slides', { mode: 'tab' }))
  return view
}

/** Items the shell injects into the File menu (e.g. Back to Home) */
let extraFileMenuItems: Electron.MenuItemConstructorOptions[] = []
export function setSlidesExtraFileMenuItems(items: Electron.MenuItemConstructorOptions[]): void {
  extraFileMenuItems = items
}

/** Tab mode: Cmd+W closes the current tab rather than the whole shell window */
let closeActiveTabHook: (() => void) | null = null
export function setSlidesCloseTabHook(fn: (() => void) | null): void {
  closeActiveTabHook = fn
}

export function buildSlidesMenu(): Menu {
  const send = (cmd: string) =>
    (windowRefs.activeWebContents ?? BrowserWindow.getFocusedWindow()?.webContents)?.send(
      'slides:menu',
      cmd,
    )
  const isMac = process.platform === 'darwin'
  const labels = appMenuLabels(getUiLang())
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        { label: tm('menuOpen'), accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        {
          // Detached second editor window on the same saved file: it attaches to
          // the shared session (openAndBuild), so both windows co-edit live
          label: tm('menuOpenNewWindow'),
          click: () => {
            const wc = windowRefs.activeWebContents ?? BrowserWindow.getFocusedWindow()?.webContents
            const path = wc ? sessions.get(wc.id)?.path : undefined
            if (path) createSlidesWindow(path)
          },
        },
        ...(extraFileMenuItems.length > 0
          ? [{ type: 'separator' as const }, ...extraFileMenuItems]
          : []),
        { type: 'separator' },
        { label: tm('menuSave'), accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: tm('menuSaveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        // The ribbon's File tab is Windows-only, so without these macOS had no way
        // to export or print at all
        { label: tm('menuExportPdf'), click: () => send('export-pdf') },
        { label: tm('menuExportImages'), click: () => send('export-images') },
        { label: tm('menuPrint'), accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        closeActiveTabHook
          ? {
              label: isMac ? tm('menuClose') : tm('menuQuit'),
              accelerator: isMac ? 'CmdOrCtrl+W' : 'CmdOrCtrl+Q',
              click: () => closeActiveTabHook?.(),
            }
          : isMac
            ? { role: 'close' as const, label: tm('menuClose') }
            : { role: 'quit' as const, label: tm('menuQuit') },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    {
      label: tm('menuEdit'),
      submenu: [
        // Undo/redo are sent to the renderer: text-editing state uses native execCommand, otherwise document history
        { label: tm('menuUndo'), accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: tm('menuRedo'), accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        // Cut/copy/paste forward the same way: in text state the renderer calls back to the native clipboard; in canvas state the element clipboard is used
        { label: tm('menuCut'), accelerator: 'CmdOrCtrl+X', click: () => send('cut') },
        { label: tm('menuCopy'), accelerator: 'CmdOrCtrl+C', click: () => send('copy') },
        { label: tm('menuPaste'), accelerator: 'CmdOrCtrl+V', click: () => send('paste') },
        { role: 'selectAll', label: labels.selectAll },
      ],
    },
    {
      label: tm('menuView'),
      submenu: [
        { label: tm('menuZoomIn'), accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: tm('menuZoomOut'), accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        {
          label: tm('menuActualSize'),
          accelerator: 'CmdOrCtrl+0',
          click: () => send('zoom-reset'),
        },
        { type: 'separator' },
        toggleDevToolsItem(labels),
      ],
    },
    helpMenuTemplate(labels),
  ]
  return Menu.buildFromTemplate(template)
}

export function installSlidesMenu(): void {
  Menu.setApplicationMenu(buildSlidesMenu())
}

/**
 * Attach a proxy to the main process's global fetch. Environment variables take priority;
 * otherwise, after app ready, read the system proxy via session.resolveProxy() (the critical
 * path for packaged builds launched by double-click).
 */
async function applyMainProcessProxy(): Promise<void> {
  const setDispatcher = async (proxyUrl: string) => {
    // spawned gsk CLI children do their own fetch and never see the
    // dispatcher below — forward the proxy to them via env
    setGskProxyUrl(proxyUrl)
    try {
      const { setGlobalDispatcher } = await import('undici')
      // loopback stays direct: a Custom provider on 127.0.0.1 must not ride
      // the proxy as an absolute-form request (vantage#2084)
      setGlobalDispatcher(await createMainProcessProxyDispatcher(proxyUrl))
      // strip user:pass credentials before logging
      console.log('[proxy] main-process fetch via', proxyUrl.replace(/\/\/[^@/]*@/, '//***@'))
    } catch (e) {
      console.warn('[proxy] failed to set proxy dispatcher:', e)
    }
  }
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (envProxy) {
    await setDispatcher(envProxy)
    return
  }
  // No environment variables: read the system proxy (requires app ready)
  try {
    await app.whenReady()
    // PAC/rule proxies answer per-host: probe the host the login flow, the
    // Genspark LLM proxy and the gsk CLI actually target
    const resolved = await electronSession.defaultSession.resolveProxy('https://www.genspark.ai/')
    // resolveProxy returns strings like "PROXY 127.0.0.1:1087" or "DIRECT"
    const m = /PROXY\s+([^;]+)/i.exec(resolved || '')
    if (m) {
      await setDispatcher(`http://${m[1].trim()}`)
    } else {
      console.log('[proxy] system proxy = DIRECT, no dispatcher set')
    }
  } catch (e) {
    console.warn('[proxy] resolveProxy failed:', e)
  }
}

export function startSlidesStandalone(): void {
  registerRendererScheme()
  installNavigationGuard(app)
  installContextMenu(app, () => contextMenuLabels(getUiLang()))
  // Optional debug switch: enable CDP only in dev with SLIDES_CDP_PORT explicitly set (for
  // automated testing/troubleshooting); packaged builds (isPackaged) are unaffected.
  if (!app.isPackaged && process.env.SLIDES_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.SLIDES_CDP_PORT)
    app.commandLine.appendSwitch('remote-allow-origins', '*')
  }
  // VANTAGE_USER_DATA: test drivers point this at a scratch dir so automated
  // instances get their own userData AND single-instance lock (the lock is scoped
  // to userData), allowing parallel instances alongside a normal dev run.
  if (!app.isPackaged && process.env.VANTAGE_USER_DATA) {
    app.setPath('userData', process.env.VANTAGE_USER_DATA)
  }
  // The main process's Node fetch (undici) does not use the system proxy by default, so access
  // from mainland China to overseas LLM APIs like api.anthropic.com hits ETIMEDOUT on direct
  // connections. Route the global dispatcher through the proxy; the renderer (Chromium) uses
  // the system proxy on its own and is unaffected. Prefer environment variables (terminal
  // launches); packaged builds launched by double-click don't inherit terminal environment
  // variables, so fall back to Electron session.resolveProxy() reading the system proxy
  // settings.
  void applyMainProcessProxy()
  const standaloneRecoveryProfile = configureRecoveryProfile({ app, mode: 'gui', guiProfile: app.getPath('userData') })
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  initializeStandaloneRecovery({ app, ...standaloneRecoveryProfile, lockAcquired: true,
    warning: message => { void dialog.showMessageBox({ type: 'warning', message }).catch(() => {}) },
    terminal: cleanup => { app.once('will-quit', cleanup) },
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (app.isReady()) {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        openAndBuild(win.webContents, path, 1280).then((r) =>
          win.webContents.send('slides:opened', r),
        )
        win.focus()
      } else createSlidesWindow(path)
    } else pendingOpenPath = path
  })

  const argPath = process.argv.find((a) => a.toLowerCase().endsWith('.pptx'))
  if (argPath && existsSync(argPath)) pendingOpenPath = argPath

  app.whenReady().then(async () => {
  // RECOVERY_BOOTSTRAP: runtime belongs to GUI startup, not handler registration.
    installRendererProtocol({ slides: join(__dirname, '../renderer') })
    setUiLang(normalizeLang(process.env.VANTAGE_LANG ?? app.getLocale()))
    registerSlidesIpc()
    registerAiIpc()
    registerProjectIpc()
    Menu.setApplicationMenu(buildSlidesMenu())
    const win = createSlidesWindow(pendingOpenPath)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createSlidesWindow()
    })

    // Test-only: with SLIDES_SMOKE_SHOT=/path, take a screenshot after loading and quit
    if (!app.isPackaged && process.env.SLIDES_SMOKE_SHOT) {
      win.webContents.once('did-finish-load', async () => {
        await new Promise((r) => setTimeout(r, 1800))
        try {
          const info = await win.webContents.executeJavaScript(
            `({ thumbs: document.querySelectorAll('.thumb').length,` +
              ` canvases: document.querySelectorAll('canvas').length,` +
              ` empty: !!document.querySelector('.empty') })`,
          )

          console.log('SMOKE_INFO=' + JSON.stringify(info))
          const png = await win.webContents.capturePage()
          const { writeFileSync } = await import('node:fs')
          writeFileSync(process.env.SLIDES_SMOKE_SHOT!, png.toPNG())

          console.log('SMOKE_SHOT_OK')
        } catch (e) {
          console.error('SMOKE_ERR', e)
        }
        app.quit()
      })
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
