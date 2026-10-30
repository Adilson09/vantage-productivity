import type {
  SlidesToolSaveRequest,
  SlidesToolSaveIdentity,
  SlidesToolSaveResult,
} from '../shared/slides-tool-save'
import type { AiPanelPrefs } from '@vantage/ui'
import type {
  SlidesDraftDiscarded,
  SlidesDraftSaveAcknowledgment,
  SlidesDraftWriteRequest,
} from '../shared/slides-draft'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
import type { SlidesCloseQuery } from '../shared/slides-tool-save'
let authoredSource = ''
const invokeSlides = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(
    channel,
    ...args,
    ...(channel.startsWith('slides:') || channel.startsWith('ai:')
      ? [{ __slidesAuthoredSource: authoredSource }]
      : []),
  )

import type { ProjectApi } from '@vantage/project-store'
import { installDropOpenBridge } from '@vantage/electron-utils/drop-open'
import type {
  DeckChange,
  AddChartOp,
  AddElementOp,
  AiRunFailure,
  ApplyEditScriptOp,
  ApplyTxnOp,
  AddImageBytesOp,
  AddInkOp,
  AddMediaBytesOp,
  ReplacePictureBytesOp,
  AddModel3dOp,
  SetModel3dViewOp,
  AddSmartArtOp,
  ApplyThemeOp,
  AddBlankSlideOp,
  AddSlideOp,
  PasteSlideOp,
  RepasteSlideOp,
  CopySlidesOp,
  DeleteSlidesOp,
  DuplicateSlidesOp,
  MoveSlidesOp,
  SetSlidesHiddenOp,
  AddSlideWithLayoutOp,
  AddTableOp,
  HeaderFooterOp,
  SetLinkOp,
  AiSettings,
  CopyElementsOp,
  PasteElementsOp,
  DuplicateElementsOp,
  EditTableCellOp,
  EditTableStyleOp,
  EditChartOp,
  EditPictureSrcRectOp,
  EditPictureOpacityOp,
  GroupElementsOp,
  UngroupElementOp,
  BatchEditTransformOp,
  SetTableColWidthOp,
  SetTableRowHeightOp,
  SetTableCellAnchorOp,
  TableStructureIpcOp,
  TableMergeIpcOp,
  ReorderElementOp,
  SaveRecordingOp,
  SetAdvanceTimesOp,
  SetAnimationsOp,
  SetSlideHiddenOp,
  SetTransitionOp,
  SectionInfo,
  AddSectionOp,
  RenameSectionOp,
  RemoveSectionOp,
  RemoveSectionSlidesOp,
  MoveSectionOp,
  MoveSlideOp,
  AiStreamChunk,
  AiStreamRequest,
  AudienceNavAction,
  ShowInkEvent,
  ShowSyncState,
  DeleteElementOp,
  DeleteElementsOp,
  DesktopFilesApi,
  EditBackgroundOp,
  EditFillOp,
  EditFillImageOp,
  EditStrokeOp,
  FlipElementOp,
  EditTextOp,
  EditTransformOp,
  EditTransformMultiOp,
  EditConnectorEndpointsOp,
  SetShapeGeometryOp,
  SetElementFontOp,
  SetElementParagraphFormatOp,
  FindReplaceOp,
  SetSlideLayoutOp,
  SetSlideSizeOp,
  MasterEditTextOp,
  MasterEditTransformOp,
  MasterEditFillOp,
  MasterEditStrokeOp,
  MasterDeleteElementOp,
  MasterAddElementOp,
  ExportImagesOp,
  SavePictureOp,
  ExportPdfOp,
  PrintSlidesOp,
  MenuCommand,
  OpenResult,
  SlidesApi,
  AutoSaveDefault,
  UiTheme,
  SetEffectsPatch,
} from '../shared/ipc'

const api: SlidesApi = {
  getLanguage: () => invokeSlides('app:get-language'),
  onLanguageChanged: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      lang: 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar',
    ) => handler(lang)
    ipcRenderer.on('app:language-changed', listener)
    return () => ipcRenderer.removeListener('app:language-changed', listener)
  },
  getTheme: () => invokeSlides('app:get-theme'),
  onThemeChanged: (handler) => {
    const listener = (_event: IpcRendererEvent, theme: UiTheme) => handler(theme)
    ipcRenderer.on('app:theme-changed', listener)
    return () => ipcRenderer.removeListener('app:theme-changed', listener)
  },
  getAutoSaveDefault: () => invokeSlides('app:get-auto-save-default'),
  onAutoSaveDefaultChanged: (handler) => {
    const listener = (_event: IpcRendererEvent, value: AutoSaveDefault) => handler(value)
    ipcRenderer.on('app:auto-save-default-changed', listener)
    return () => ipcRenderer.removeListener('app:auto-save-default-changed', listener)
  },
  getAiPanelPrefs: () => invokeSlides('app:get-ai-panel-prefs'),
  setAiPanelPrefs: (patch) => invokeSlides('app:set-ai-panel-prefs', patch),
  onAiPanelPrefsChanged: (handler) => {
    const listener = (_event: IpcRendererEvent, prefs: AiPanelPrefs) => handler(prefs)
    ipcRenderer.on('app:ai-panel-prefs-changed', listener)
    return () => ipcRenderer.removeListener('app:ai-panel-prefs-changed', listener)
  },
  onChromePressed: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('app:chrome-pressed', listener)
    return () => ipcRenderer.removeListener('app:chrome-pressed', listener)
  },
  setShowFullScreen: (on) => invokeSlides('slides:show-fullscreen', on),
  privateFontFaces: () => invokeSlides('slides:private-font-faces'),
  privateFontData: (id) => invokeSlides('slides:private-font-data', id),
  fontCatalog: () => invokeSlides('slides:font-catalog'),
  fontDownload: (family) => invokeSlides('slides:font-download', family),
  fontInstallLocal: () => invokeSlides('slides:font-install-local'),
  fontMissing: () => invokeSlides('slides:font-missing'),
  onFontsChanged: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('slides:fonts-changed', listener)
    return () => ipcRenderer.removeListener('slides:fonts-changed', listener)
  },
  openPptx: (fitWidthPx) => invokeSlides('slides:open', fitWidthPx),
  openPptxPath: (path, fitWidthPx) => invokeSlides('slides:open-path', path, fitWidthPx),
  consumePendingOpen: (fitWidthPx) => invokeSlides('slides:consume-pending-open', fitWidthPx),
  consumeHeadlessExport: () => invokeSlides('slides:consume-headless-export'),
  headlessExportDone: (result: { ok: boolean; error?: string }) =>
    ipcRenderer.send('slides:headless-export-done', result),
  newBlank: (fitWidthPx, size) => invokeSlides('slides:new-blank', fitWidthPx, size),
  landGeneratedPages: (
    pageMarkers: string[],
    fitWidthPx: number,
    mode?: 'replace' | 'append' | 'replace_at' | 'insert_at',
    atIndex?: number,
    deckName?: string,
  ) =>
    invokeSlides('slides:land-generated-pages', pageMarkers, fitWidthPx, mode, atIndex, deckName),
  localGeneratePage: (op: { specJson: string }) => invokeSlides('slides:local-page-generate', op),
  editText: (op: EditTextOp) => invokeSlides('slides:edit-text', op),
  setElementFont: (op: SetElementFontOp) => invokeSlides('slides:set-element-font', op),
  setElementParagraphFormat: (op: SetElementParagraphFormatOp) =>
    invokeSlides('slides:set-element-paragraph-format', op),
  findReplace: (op: FindReplaceOp) => invokeSlides('slides:find-replace', op),
  setSlideLayout: (op: SetSlideLayoutOp) => invokeSlides('slides:set-slide-layout', op),
  setSlideSize: (op: SetSlideSizeOp) => invokeSlides('slides:set-slide-size', op),
  getSlideSize: () => invokeSlides('slides:get-slide-size'),
  editTransform: (op: EditTransformOp) => invokeSlides('slides:edit-transform', op),
  cancelTransformPreview: (op: { slideIndex: number }) =>
    invokeSlides('slides:cancel-transform-preview', op),
  editTransformMulti: (op: EditTransformMultiOp) => invokeSlides('slides:edit-transform-multi', op),
  editConnectorEndpoints: (op: EditConnectorEndpointsOp) =>
    invokeSlides('slides:edit-connector-endpoints', op),
  editPictureSrcRect: (op: EditPictureSrcRectOp) =>
    invokeSlides('slides:edit-picture-src-rect', op),
  editPictureOpacity: (op: EditPictureOpacityOp) => invokeSlides('slides:edit-picture-opacity', op),
  editImageFill: (op: EditFillImageOp) => invokeSlides('slides:edit-image-fill', op),
  changeShape: (op: { slideIndex: number; sourceId: string; prst: string; groupId?: string }) =>
    invokeSlides('slides:change-shape', op),
  setShapeAdjust: (op: {
    slideIndex: number
    sourceId: string
    adjust: Record<string, number>
    groupId?: string
    preview?: boolean
  }) => invokeSlides('slides:set-shape-adjust', op),
  setShapeGeometry: (op: SetShapeGeometryOp) => invokeSlides('slides:set-shape-geometry', op),
  setTextAnchor: (op: {
    slideIndex: number
    sourceId: string
    anchor: 'top' | 'middle' | 'bottom'
  }) => invokeSlides('slides:set-text-anchor', op),
  setTextBodyProps: (op: {
    slideIndex: number
    sourceId: string
    props: {
      vert?: 'horz' | 'eaVert' | 'vert' | 'vert270' | 'wordArtVert'
      autofit?: 'none' | 'shrink' | 'resize'
      insets?: Partial<{ l: number; t: number; r: number; b: number }>
      wrap?: boolean
    }
  }) => invokeSlides('slides:set-text-body-props', op),
  setEffects: (op: { slideIndex: number; sourceId: string; effects: SetEffectsPatch }) =>
    invokeSlides('slides:set-effects', op),
  clipboardExternal: () => invokeSlides('slides:clipboard-external'),
  groupElements: (op: GroupElementsOp) => invokeSlides('slides:group-elements', op),
  ungroupElement: (op: UngroupElementOp) => invokeSlides('slides:ungroup-element', op),
  batchEditTransform: (op: BatchEditTransformOp) => invokeSlides('slides:batch-edit-transform', op),
  getRenderSlides: () => invokeSlides('slides:get-render-slides'),
  addElement: (op: AddElementOp) => invokeSlides('slides:add-element', op),
  deleteElement: (op: DeleteElementOp) => invokeSlides('slides:delete-element', op),
  deleteElements: (op: DeleteElementsOp) => invokeSlides('slides:delete-elements', op),
  addSlide: (op: AddSlideOp) => invokeSlides('slides:add-slide', op),
  addBlankSlide: (op: AddBlankSlideOp) => invokeSlides('slides:add-blank-slide', op),
  addSlideWithLayout: (op: AddSlideWithLayoutOp) =>
    invokeSlides('slides:add-slide-with-layout', op),
  getLayouts: () => invokeSlides('slides:get-layouts'),
  masterEnter: (fitWidthPx: number) => invokeSlides('slides:master-enter', fitWidthPx),
  masterOpen: (partPath: string) => invokeSlides('slides:master-open', partPath),
  masterClose: () => invokeSlides('slides:master-close'),
  masterEditText: (op: MasterEditTextOp) => invokeSlides('slides:master-edit-text', op),
  masterEditTransform: (op: MasterEditTransformOp) =>
    invokeSlides('slides:master-edit-transform', op),
  masterEditFill: (op: MasterEditFillOp) => invokeSlides('slides:master-edit-fill', op),
  masterEditStroke: (op: MasterEditStrokeOp) => invokeSlides('slides:master-edit-stroke', op),
  masterDeleteElement: (op: MasterDeleteElementOp) =>
    invokeSlides('slides:master-delete-element', op),
  masterAddElement: (op: MasterAddElementOp) => invokeSlides('slides:master-add-element', op),
  editFill: (op: EditFillOp) => invokeSlides('slides:edit-fill', op),
  editStroke: (op: EditStrokeOp) => invokeSlides('slides:edit-stroke', op),
  flipElements: (op: FlipElementOp) => invokeSlides('slides:flip-elements', op),
  editBackground: (op: EditBackgroundOp) => invokeSlides('slides:edit-background', op),
  pickPictureFile: () => invokeSlides('slides:pick-picture-file'),
  insertImage: (slideIndex: number, fitWidthPx: number) =>
    invokeSlides('slides:insert-image', slideIndex, fitWidthPx),
  copySlides: (op: CopySlidesOp) => invokeSlides('slides:copy-slides', op),
  pasteSlide: (op: PasteSlideOp) => invokeSlides('slides:paste-slide', op),
  repasteSlide: (op: RepasteSlideOp) => invokeSlides('slides:repaste-slide', op),
  hasSlideClipboard: () => invokeSlides('slides:has-slide-clipboard'),
  clipboardProbe: () => invokeSlides('slides:clipboard-probe'),
  deleteSlide: (slideIndex: number) => invokeSlides('slides:delete-slide', slideIndex),
  deleteSlides: (op: DeleteSlidesOp) => invokeSlides('slides:delete-slides', op),
  duplicateSlides: (op: DuplicateSlidesOp) => invokeSlides('slides:duplicate-slides', op),
  reorderElement: (op: ReorderElementOp) => invokeSlides('slides:reorder-element', op),
  editTableCell: (op: EditTableCellOp) => invokeSlides('slides:edit-table-cell', op),
  tableStructure: (op: TableStructureIpcOp) => invokeSlides('slides:table-structure', op),
  tableMerge: (op: TableMergeIpcOp) => invokeSlides('slides:table-merge', op),
  setTableColWidth: (op: SetTableColWidthOp) => invokeSlides('slides:set-table-col-width', op),
  setTableRowHeight: (op: SetTableRowHeightOp) => invokeSlides('slides:set-table-row-height', op),
  setTableCellAnchor: (op: SetTableCellAnchorOp) =>
    invokeSlides('slides:set-table-cell-anchor', op),
  editTableStyle: (op: EditTableStyleOp) => invokeSlides('slides:edit-table-style', op),
  editChart: (op: EditChartOp) => invokeSlides('slides:edit-chart', op),
  getChartColorSchemes: () => invokeSlides('slides:chart-color-schemes'),
  getChartData: (slideIndex: number, sourceId: string) =>
    invokeSlides('slides:get-chart-data', slideIndex, sourceId),
  copyElements: (op: CopyElementsOp) => invokeSlides('slides:copy-elements', op),
  copyElementsImage: (clipboardToken: string, pngBase64: string) =>
    invokeSlides('slides:copy-elements-image', clipboardToken, pngBase64),
  pasteElements: (op: PasteElementsOp) => invokeSlides('slides:paste-elements', op),
  duplicateElements: (op: DuplicateElementsOp) => invokeSlides('slides:duplicate-elements', op),
  addTable: (op: AddTableOp) => invokeSlides('slides:add-table', op),
  addInk: (op: AddInkOp) => invokeSlides('slides:add-ink', op),
  addChart: (op: AddChartOp) => invokeSlides('slides:add-chart', op),
  addSmartArt: (op: AddSmartArtOp) => invokeSlides('slides:add-smartart', op),
  addImageBytes: (op: AddImageBytesOp) => invokeSlides('slides:add-image-bytes', op),
  replacePictureBytes: (op: ReplacePictureBytesOp) =>
    invokeSlides('slides:replace-picture-bytes', op),
  insertMedia: (slideIndex: number, kind: 'video' | 'audio', fitWidthPx: number) =>
    invokeSlides('slides:insert-media', slideIndex, kind, fitWidthPx),
  addMediaBytes: (op: AddMediaBytesOp) => invokeSlides('slides:add-media-bytes', op),
  getMediaData: (slideIndex: number, sourceId: string) =>
    invokeSlides('slides:media-data', slideIndex, sourceId),
  pickModel3d: () => invokeSlides('slides:pick-model3d'),
  addModel3d: (op: AddModel3dOp) => invokeSlides('slides:add-model3d', op),
  getModel3dData: (slideIndex: number, sourceId: string) =>
    invokeSlides('slides:model3d-data', slideIndex, sourceId),
  setModel3dView: (op: SetModel3dViewOp) => invokeSlides('slides:set-model3d-view', op),
  setLink: (op: SetLinkOp) => invokeSlides('slides:set-link', op),
  getLink: (slideIndex: number, sourceId: string) =>
    invokeSlides('slides:get-link', slideIndex, sourceId),
  getSlideLinks: (slideIndex: number) => invokeSlides('slides:get-slide-links', slideIndex),
  getRunLinks: (slideIndex: number) => invokeSlides('slides:get-run-links', slideIndex),
  applyHeaderFooter: (op: HeaderFooterOp) => invokeSlides('slides:apply-header-footer', op),
  getHeaderFooter: (slideIndex: number) => invokeSlides('slides:get-header-footer', slideIndex),
  applyTheme: (op: ApplyThemeOp) => invokeSlides('slides:apply-theme', op),
  setTransition: (op: SetTransitionOp) => invokeSlides('slides:set-transition', op),
  getTransition: (slideIndex: number) => invokeSlides('slides:get-transition', slideIndex),
  getShowTiming: (slideIndex: number) => invokeSlides('slides:get-show-timing', slideIndex),
  setAdvanceTimes: (op: SetAdvanceTimesOp) => invokeSlides('slides:set-advance-times', op),
  saveRecording: (op: SaveRecordingOp) => invokeSlides('slides:save-recording', op),
  clearNarration: (slideIndexes: number[]) => invokeSlides('slides:clear-narration', slideIndexes),
  microphoneAccess: () => invokeSlides('slides:microphone-access'),
  getAnimations: (slideIndex: number) => invokeSlides('slides:get-animations', slideIndex),
  getShapeKeys: (slideIndex: number) => invokeSlides('slides:get-shape-keys', slideIndex),
  setAnimations: (op: SetAnimationsOp) => invokeSlides('slides:set-animations', op),
  setSlideHidden: (op: SetSlideHiddenOp) => invokeSlides('slides:set-hidden', op),
  setSlidesHidden: (op: SetSlidesHiddenOp) => invokeSlides('slides:set-slides-hidden', op),
  getSections: () => invokeSlides('slides:get-sections'),
  setSections: (sections: SectionInfo[]) => invokeSlides('slides:set-sections', sections),
  addSection: (op: AddSectionOp) => invokeSlides('slides:add-section', op),
  renameSection: (op: RenameSectionOp) => invokeSlides('slides:rename-section', op),
  removeSection: (op: RemoveSectionOp) => invokeSlides('slides:remove-section', op),
  removeSectionSlides: (op: RemoveSectionSlidesOp) =>
    invokeSlides('slides:remove-section-slides', op),
  moveSection: (op: MoveSectionOp) => invokeSlides('slides:move-section', op),
  moveSlide: (op: MoveSlideOp) => invokeSlides('slides:move-slide', op),
  moveSlides: (op: MoveSlidesOp) => invokeSlides('slides:move-slides', op),
  getNotes: (slideIndex: number, partPath?: string) =>
    invokeSlides('slides:get-notes', slideIndex, partPath),
  setNotes: (op) => invokeSlides('slides:set-notes', op),
  getComments: (slideIndex: number) => invokeSlides('slides:get-comments', slideIndex),
  addComment: (op) => invokeSlides('slides:add-comment', op),
  deleteComment: (op) => invokeSlides('slides:delete-comment', op),
  nativeClipboard: (op: 'cut' | 'copy' | 'paste') => invokeSlides('slides:native-clipboard', op),
  beginOwnedHistoryBatch: () => invokeSlides('slides:history-batch-begin'),
  // Only this exact receipt can authorize its captured batch cleanup after a
  // callback generation retires. No ordinary mutation bypass is exposed.
  finishOwnedHistoryBatch: (ticket) =>
    ipcRenderer.invoke('slides:history-batch-owned-finish', ticket),
  applyEditScript: (op: ApplyEditScriptOp) => invokeSlides('slides:apply-edit-script', op),
  applyTxn: (op: ApplyTxnOp) => invokeSlides('slides:apply-txn', op),
  aiSnapshotRestore: (id: number) => invokeSlides('slides:ai-snapshot-restore', id),
  undo: () => invokeSlides('slides:undo'),
  redo: () => invokeSlides('slides:redo'),
  pickExportDir: (plan: { baseName: string; count: number }) =>
    invokeSlides('slides:pick-export-dir', plan),
  exportImages: (op: ExportImagesOp) => invokeSlides('slides:export-images', op),
  pickExportPdfPath: (defaultName: string) =>
    invokeSlides('slides:pick-export-pdf-path', defaultName),
  savePicture: (op: SavePictureOp) => invokeSlides('slides:save-picture', op),
  exportPdf: (op: ExportPdfOp) => invokeSlides('slides:export-pdf', op),
  printSlides: (op: PrintSlidesOp) => invokeSlides('slides:print', op),
  onToolSaveRequest: (handler: (request: SlidesToolSaveRequest) => void) => {
    const listener = (_event: IpcRendererEvent, request: SlidesToolSaveRequest) => handler(request)
    ipcRenderer.on('slides:tool-save-request', listener)
    return () => ipcRenderer.removeListener('slides:tool-save-request', listener)
  },
  onToolSaveRelease: (handler: (requestId: string) => void) => {
    const listener = (_event: IpcRendererEvent, requestId: string) => handler(requestId)
    ipcRenderer.on('slides:tool-save-release', listener)
    return () => ipcRenderer.removeListener('slides:tool-save-release', listener)
  },
  probeToolSave: (identity: SlidesToolSaveIdentity) =>
    invokeSlides('slides:tool-save-probe', identity),
  saveToolToPath: (identity: SlidesToolSaveIdentity) =>
    invokeSlides('slides:tool-save-write', identity),
  reportToolSaveResult: (result: SlidesToolSaveResult) =>
    ipcRenderer.send('slides:tool-save-result', result),
  cancelToolSave: (requestId: string) => invokeSlides('slides:tool-save-cancel', requestId),
  confirmSourceAdoption: (candidateId: string) =>
    invokeSlides('slides:source-confirm', candidateId),
  onSourceAdopted: (handler: (result: OpenResult) => void) => {
    const listener = (_event: IpcRendererEvent, result: OpenResult) => handler(result)
    ipcRenderer.on('slides:source-adopted', listener)
    return () => ipcRenderer.removeListener('slides:source-adopted', listener)
  },
  claimCloseLease: (ticket: CloseLeaseTicket) => invokeSlides('slides:close-claim', ticket),
  cancelCloseLease: (ticket: CloseLeaseTicket, reason: string) =>
    invokeSlides('slides:close-cancel', ticket, reason),
  onCloseRelease: (handler: (ticket: CloseLeaseTicket) => void) => {
    const listener = (_event: IpcRendererEvent, ticket: CloseLeaseTicket) => handler(ticket)
    ipcRenderer.on('slides:close-release', listener)
    return () => ipcRenderer.removeListener('slides:close-release', listener)
  },
  onCloseQuery: (handler: (id: string) => void) => {
    const listener = (_event: IpcRendererEvent, id: string) => handler(id)
    ipcRenderer.on('slides:close-query', listener)
    return () => ipcRenderer.removeListener('slides:close-query', listener)
  },
  reportCloseQuery: (result: SlidesCloseQuery) =>
    ipcRenderer.send('slides:close-query-result', result),
  save: (automatic = false) => invokeSlides('slides:save', automatic),
  activateDraft: (path: string | null, sourceIdentity?: string) => {
    if (sourceIdentity) authoredSource = sourceIdentity
    return invokeSlides('slides:draft-activate', path, authoredSource)
  },
  writeDraft: (request: SlidesDraftWriteRequest) => invokeSlides('slides:draft-write', request),
  acknowledgeDraftSave: (request: SlidesDraftSaveAcknowledgment) =>
    invokeSlides('slides:draft-saved', request),
  draftState: () => invokeSlides('slides:draft-state'),
  setPendingEditState: (token: string, dirty: boolean) =>
    ipcRenderer.send('slides:draft-pending', { token, dirty }),
  onDraftDiscarded: (handler: (notice: SlidesDraftDiscarded) => void) => {
    const listener = (_event: IpcRendererEvent, notice: SlidesDraftDiscarded) => handler(notice)
    ipcRenderer.on('slides:draft-discarded', listener)
    return () => ipcRenderer.removeListener('slides:draft-discarded', listener)
  },
  onDraftWarning: (handler: (message: string) => void) => {
    const listener = (_event: IpcRendererEvent, message: string) => handler(message)
    ipcRenderer.on('slides:draft-warning', listener)
    return () => ipcRenderer.removeListener('slides:draft-warning', listener)
  },
  onCloseFlushRequest: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('slides:close-flush-request', listener)
    return () => ipcRenderer.removeListener('slides:close-flush-request', listener)
  },
  reportCloseFlushResult: (ok: boolean) =>
    ipcRenderer.send('slides:close-flush-result', ok === true),
  saveAs: (defaultName: string) => invokeSlides('slides:save-as', defaultName),
  onCloseSaveRequest: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('slides:close-save-request', listener)
    return () => ipcRenderer.removeListener('slides:close-save-request', listener)
  },
  onHistoryChanged: (handler: (state: { canUndo: boolean; canRedo: boolean }) => void) => {
    const listener = (_e: IpcRendererEvent, state: { canUndo: boolean; canRedo: boolean }) =>
      handler(state)
    ipcRenderer.on('slides:history-changed', listener)
    return () => ipcRenderer.removeListener('slides:history-changed', listener)
  },
  onDeckChanged: (handler: (state: DeckChange) => void) => {
    const listener = (_e: IpcRendererEvent, state: DeckChange) => handler(state)
    ipcRenderer.on('slides:deck-changed', listener)
    return () => ipcRenderer.removeListener('slides:deck-changed', listener)
  },
  reportCloseSaveResult: (ok: boolean) => ipcRenderer.send('slides:close-save-result', ok === true),
  setAutoSavePref: (on: boolean) => ipcRenderer.send('slides:autosave-pref', on === true),
  isDirty: () => invokeSlides('slides:is-dirty'),
  getRecentFiles: () => invokeSlides('slides:recent'),
  onMenuCommand: (handler: (command: MenuCommand) => void) => {
    const listener = (_e: IpcRendererEvent, cmd: MenuCommand) => handler(cmd)
    ipcRenderer.on('slides:menu', listener)
    return () => ipcRenderer.removeListener('slides:menu', listener)
  },
  onOpened: (handler: (result: OpenResult) => void) => {
    const listener = (_e: IpcRendererEvent, result: OpenResult) => handler(result)
    ipcRenderer.on('slides:opened', listener)
    return () => ipcRenderer.removeListener('slides:opened', listener)
  },
  onRenamed: (handler: (newPath: string) => void) => {
    const listener = (_e: IpcRendererEvent, newPath: string) => handler(newPath)
    ipcRenderer.on('slides:renamed', listener)
    return () => ipcRenderer.removeListener('slides:renamed', listener)
  },
  onDraftSourceChanged: (handler: (newPath: string) => void) => {
    const listener = (_e: IpcRendererEvent, newPath: string) => handler(newPath)
    ipcRenderer.on('slides:draft-source-changed', listener)
    return () => ipcRenderer.removeListener('slides:draft-source-changed', listener)
  },
  getAiSettings: () => invokeSlides('ai:get-settings'),
  setAiSettings: (settings: AiSettings) => invokeSlides('ai:set-settings', settings),
  onAiSettingsChanged: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('ai:settings-changed', listener)
    return () => ipcRenderer.removeListener('ai:settings-changed', listener)
  },
  openAiModelSettings: () => invokeSlides('ai:open-model-settings'),
  openSkillsSettings: () => invokeSlides('ai:open-skills-settings'),
  skillsList: () => invokeSlides('ai:skills-list'),
  skillText: (name: string) => invokeSlides('ai:skill-text', name),
  aiStream: (request: AiStreamRequest) => invokeSlides('ai:stream', request),
  aiStreamCancel: (requestId: string) => invokeSlides('ai:stream-cancel', requestId),
  aiGskStatus: (withEmail?: boolean) => invokeSlides('ai:gsk-status', withEmail),
  aiGskLogin: () => invokeSlides('ai:gsk-login'),
  aiLogRunFailure: (entry: AiRunFailure) => invokeSlides('ai:log-run-failure', entry),
  webSearch: (query: string, maxResults?: number) =>
    invokeSlides('ai:web-search', query, maxResults),
  imageSearch: (query: string, maxResults?: number) =>
    invokeSlides('ai:image-search', query, maxResults),
  insertImageUrl: (op: {
    slideIndex: number
    url?: string
    /** raw base64 of a user attachment (attachment:// reference) — no network fetch */
    base64?: string
    ext?: string
    xPx: number
    yPx: number
    wPx: number
    hPx: number
    fitWidthPx: number
  }) => invokeSlides('ai:insert-image-url', op),
  replacePictureUrl: (op: {
    slideIndex: number
    sourceId: string
    url?: string
    /** raw base64 of a user attachment (attachment:// reference) — no network fetch */
    base64?: string
    ext?: string
    keepSrcRect?: boolean
  }) => invokeSlides('ai:replace-picture-url', op),
  generateImage: (op: {
    prompt: string
    model?: string
    referenceImageUrls?: string[]
    aspectRatio?: string
    imageSize?: string
    transparentBackground?: boolean
  }) => invokeSlides('ai:generate-image', op),
  analyzeMedia: (op: { mediaUrls: string[]; requirements: string }) =>
    invokeSlides('ai:analyze-media', op),
  gskStatus: () => invokeSlides('ai:gsk-status'),
  onAiStream: (handler: (chunk: AiStreamChunk) => void) => {
    const listener = (_e: IpcRendererEvent, chunk: AiStreamChunk) => handler(chunk)
    ipcRenderer.on('ai:stream-chunk', listener)
    return () => ipcRenderer.removeListener('ai:stream-chunk', listener)
  },
  saveStyleSidecar: (data: { topic: string; styleSkill: string; createdAt: string }) =>
    invokeSlides('ai:save-sidecar', data),
  saveStyleTemplate: (
    name: string,
    data: { topic: string; styleSkill: string; createdAt: string; layout?: unknown },
  ) => invokeSlides('ai:save-style-template', name, data),
  listStyleTemplates: () => invokeSlides('ai:list-style-templates'),
  loadStyleTemplate: (name: string) => invokeSlides('ai:load-style-template', name),
  presenterStart: () => invokeSlides('slides:presenter-start'),
  presenterSync: (state: ShowSyncState) => ipcRenderer.send('slides:presenter-sync', state),
  presenterInk: (ev: ShowInkEvent) => ipcRenderer.send('slides:presenter-ink', ev),
  presenterSwap: () => invokeSlides('slides:presenter-swap'),
  presenterEnd: () => invokeSlides('slides:presenter-end'),
  audienceReady: () => invokeSlides('slides:audience-ready'),
  audienceNav: (action: AudienceNavAction) => ipcRenderer.send('slides:audience-nav', action),
  onShowSync: (handler: (state: ShowSyncState) => void) => {
    const listener = (_e: IpcRendererEvent, state: ShowSyncState) => handler(state)
    ipcRenderer.on('slides:show-sync', listener)
    return () => ipcRenderer.removeListener('slides:show-sync', listener)
  },
  onShowInk: (handler: (ev: ShowInkEvent) => void) => {
    const listener = (_e: IpcRendererEvent, ev: ShowInkEvent) => handler(ev)
    ipcRenderer.on('slides:show-ink', listener)
    return () => ipcRenderer.removeListener('slides:show-ink', listener)
  },
  onAudienceNav: (handler: (action: AudienceNavAction) => void) => {
    const listener = (_e: IpcRendererEvent, action: AudienceNavAction) => handler(action)
    ipcRenderer.on('slides:audience-nav', listener)
    return () => ipcRenderer.removeListener('slides:audience-nav', listener)
  },
}

/**
 * Model file naming: the transport half of `suggestFileName`.
 *
 * Inlined rather than imported — a preload entry must stay a single-file bundle,
 * or the sandbox drops every global it exposed. The one `ai:` channel is
 * registered app-wide by the shell (`registerAiNamingIpc`), not by this app, the
 * same arrangement the `project:*` bridge below already depends on. A slides
 * window running on its own has no such handler: the invoke rejects, and the
 * shared client treats that as a declined naming, which leaves the deck with
 * the name it already had.
 *
 * `content` crosses this bridge verbatim and the main process cannot see what
 * this editor withheld, so what the caller hands over is exactly what the model
 * sees. A caller that passed raw document text would undo its own redactions.
 *
 * The global is `aiNamingApi`, not `aiOffice`: `aiOffice` is the shell's home
 * API, and a partial one in an editor window would shadow it there.
 */
const aiNamingApi = {
  suggestFileName: (input: { content: string }) => invokeSlides('ai:suggest-file-name', input),
}

contextBridge.exposeInMainWorld('slidesApi', api)
contextBridge.exposeInMainWorld('aiNamingApi', aiNamingApi)

// Chat attachment bridge: method names/signatures match the window.desktop attachment subset in docs, so the renderer's files-skill is copied over wholesale
const filesApi: DesktopFilesApi = {
  pickAttachments: () => invokeSlides('slides:files-pick'),
  addAttachmentPaths: (paths: string[]) => invokeSlides('slides:files-add', paths),
  addPastedImage: (data: ArrayBuffer, ext: string) =>
    invokeSlides('slides:files-add-pasted-image', data, ext),
  readAttachment: (path: string, offset: number, maxChars: number) =>
    invokeSlides('slides:files-read', path, offset, maxChars),
  readAttachmentImage: (path: string) => invokeSlides('slides:files-read-image', path),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('desktop', filesApi)

const projectApi: ProjectApi = {
  resolveChat: (args) => invokeSlides('project:resolveChat', args),
  appendChat: (args) => invokeSlides('project:appendChat', args),
  loadChat: (args) => invokeSlides('project:loadChat', args),
  rebindChat: (args) => invokeSlides('project:rebindChat', args),
  listChats: (args) => invokeSlides('project:listChats', args),
  deleteChat: (args) => invokeSlides('project:deleteChat', args),
}
contextBridge.exposeInMainWorld('projectApi', projectApi)

// open documents dragged from the OS onto this tab as a new shell tab
installDropOpenBridge()
