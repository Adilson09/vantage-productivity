import { pendingCssCanBeCommitted } from './document/html-close-pending'
import { CloseMutationBarrier } from '../../../../packages/electron-utils/src/renderer-close-barrier'
import { bindHtmlCloseBarrier, htmlCloseStamp, mutateHtml, beforeHtmlMutation, runHtmlAsyncMutation, requireHtmlMutation, installHtmlCloseInputFence } from './close-lease'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Dropdown,
  FindPanel,
  type FindFocusRequest,
  type AiScopeQuoteData,
  useAutoSavePref,
  type FindPanelStrings,
  type FindTarget,
  aiPanelInitiallyOpen,
  rememberAiPanelOpen,
  useAiSidebarEnabled,
} from '@vantage/ui'
import { pollUntilReady, runHeadlessRendererExport } from '@vantage/electron-utils/headless-export'
import { useI18n } from './i18n/locale'
import { parseDocText, serializeDocText, type Envelope } from './document/envelope'
import {
  SourceEditor,
  type CursorInfo,
  type SourceRange,
  type SourceEditorHandle,
} from './source/SourceEditor'
import { PreviewFrame, type PreviewFrameHandle } from './preview/PreviewFrame'
import { instrumentForPreview } from './preview/instrument'
import type { ComputedSnapshot, ElementRect, FromInspector } from './preview/inspector-protocol'
import inspectorSource from './preview/inspector.js?raw'
import { AiPanel, GensparkMark, type AiPreset, type HtmlAiDeps } from './ai/AiPanel'
import { AiAskPopover, type AnchorRect, type AskMode } from './components/AiAskPopover'
import {
  EDIT_QUEUE_MAX,
  buildSelectionInstruction,
  resolveQueueItem,
  type EditQueueItem,
} from './ai/edit-queue'
import { buildProjection } from './ai/redact'
import { Breadcrumb, type NodeState } from './components/Breadcrumb'
import {
  Ribbon,
  type PresentKind,
  VIEW_MODES,
  type CanvasMode,
  type ViewMode,
} from './components/Ribbon'
import { CropDialog, CutoutDialog, type ImageDialogLabels } from '@vantage/ui'
import { FloatToolbar } from './components/FloatToolbar'
import { RedactDialog } from './components/RedactDialog'
import { redactClearPlan, redactMarkPlan, type RedactPlan } from './document/redact-edit'
import {
  insertOp,
  insertPresetHtml,
  type InsertOptions,
  TEXT_INSERT_KINDS,
  type InsertKind,
} from './document/insert-presets'
import { isDocEmpty } from './document/blank'
import { documentSkeleton } from './document/skeleton'
import { moveTarget } from './document/move-target'
import { StylePanel } from './components/StylePanel'
import { floatPosition, parseDeclarations } from './document/float-position'
import {
  buildParseMap,
  childrenOf,
  elementCovering,
  sourceText,
  type ParseMap,
} from './document/parse-map'
import { compileOps, type HtmlOp, type OpError } from './document/ops'
import { injectBrief, parseBrief, type Brief } from './document/brief'
import { applyPatches } from './document/patch'
import { adoptImageRewrites } from './document/image-rewrites'
import { deriveAutoFileName, deriveNameFromPrompt } from './document/auto-name'
import { localFileName, modelSaveAsName } from './file-naming'
import { runGuardedPrint } from './print-guard'
import {
  captureHtmlRecoveryText,
  readHtmlRecoveryState,
  type HtmlPanelRecoveryState,
  type HtmlRecoveryUi,
} from './document/html-recovery-snapshot'
import { HTML_DRAFT_MAX_BYTES } from '../shared/html-draft'
import {
  prepareAndApplyHtmlReload,
  type HtmlReloadLiveState,
} from './document/html-reload-controller'
import {
  completeHtmlSaveAcknowledgment,
  htmlSaveStateIsDirty,
  type HtmlSaveLiveState,
} from './document/html-save-acknowledgment'
import type { ExportFormat, SaveMode } from '../shared/ipc'

type LoadStatus = 'loading' | 'ready' | 'error'
type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

interface TextSel {
  sid: number
  textNodeIndex: number
  start: number
  end: number
}

const MIN_ZOOM = 50
const MAX_ZOOM = 200
const ZOOM_STEP = 10
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
const inTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest('.cm-editor, input, textarea, [contenteditable=""], [contenteditable="true"]')
const PREVIEW_DEBOUNCE_MS = 150
const DEFAULT_ENVELOPE: Envelope = { bom: false, eol: '\n', trailingNewline: true }
/** live style pokes are written to the source as one set_style op this long after the last change */
const STYLE_COMMIT_MS = 600
type Device = 'desktop' | 'tablet' | 'mobile'
const DEVICES: Device[] = ['desktop', 'tablet', 'mobile']
/** document scaffolding: selectable in the source, never a target for element ops */
const STRUCTURAL = new Set(['html', 'head', 'body'])
const IS_MAC = /Mac/i.test(navigator.platform)

function readViewMode(): ViewMode {
  const stored = localStorage.getItem('htmlapp.viewMode')
  return VIEW_MODES.includes(stored as ViewMode) ? (stored as ViewMode) : 'preview'
}

function isDarkTheme(): boolean {
  const explicit = document.documentElement.getAttribute('data-theme')
  if (explicit === 'dark') return true
  if (explicit === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** picture bytes as a data URL: inline data, a remote URL through the main-process fetcher, or a file next to the document */
async function loadImageDataUrl(src: string): Promise<string | null> {
  if (/^data:image\//i.test(src)) return src
  if (/^https?:/i.test(src)) {
    const r = await window.htmlApi.fetchImage(src)
    return r ? `data:${r.mime};base64,${r.base64}` : null
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null
  const r = await window.htmlApi.readImage(src)
  return r ? `data:${r.mime};base64,${r.base64}` : null
}

export default function App() {
  const { lang, t } = useI18n()
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [path, setPath] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  // Vantage Productivity: retain actionable storage errors and rescue paths for the reader.
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveWarning,setSaveWarning]=useState<string|null>(null)
  const [closeError,setCloseError]=useState<string|null>(null)
  const [sourceOnlyClose,setSourceOnlyClose]=useState(false)
  const sourceOnlyCloseRef=useRef(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [reloadCleanupError, setReloadCleanupError] = useState<string | null>(null)
  const [recoveryRemoteCount, setRecoveryRemoteCount] = useState(0)
  const [panelPending, setPanelPending] = useState(false)
  const [visualPending, setVisualPending] = useState(false)
  const [view, setView] = useState<ViewMode>(readViewMode)
  const [canvasMode, setCanvasModeState] = useState<CanvasMode>('edit')
  /** Present → Fullscreen: the presenting view also takes the whole screen */
  const [presentFull, setPresentFull] = useState(false)
  const [zoom, setZoom] = useState(100)
  const [autoSave, setAutoSave] = useAutoSavePref('htmlapp.autoSave', window.htmlApi)
  const [findTarget, setFindTarget] = useState<FindTarget | null>(null)
  const [findFocus, setFindFocus] = useState<FindFocusRequest>({ field: 'find', nonce: 0 })
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, col: 1, pos: 0 })
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)
  const [draftHtml, setDraftHtml] = useState<string | null>(null)
  const [historyState, setHistoryState] = useState({ undo: false, redo: false })
  const [aiOpen, setAiOpen] = useState(() => aiPanelInitiallyOpen('htmlapp.showAi'))
  // the sidebar switch is a soft hide; it closes the panel when it turns off
  const aiSidebarEnabled = useAiSidebarEnabled(setAiOpen)
  const [aiPreset, setAiPreset] = useState<AiPreset | null>(null)
  const [editQueue, setEditQueue] = useState<EditQueueItem[]>([])
  const [askMode, setAskMode] = useState<AskMode | null>(null)
  const [selectedSid, setSelectedSid] = useState<number | null>(null)
  const [selectedState, setSelectedState] = useState<NodeState>('static')
  const [textSel, setTextSel] = useState<TextSel | null>(null)
  const wrapSelectionRef = useRef<(tag: string) => void>(() => {})
  const moveSelectedRef = useRef<(dir: -1 | 1) => void>(() => {})
  // selected element as the preview sees it: drives the floating toolbar and the style panel
  const [selRect, setSelRect] = useState<ElementRect | null>(null)
  const [selComputed, setSelComputed] = useState<ComputedSnapshot | null>(null)
  const [selText, setSelText] = useState<{
    run: string | null
    index: number
    /** the element edits inline (single run or rich phrasing content) */
    editable: boolean
  }>({
    run: null,
    index: -1,
    editable: false,
  })
  const [pendingCount, setPendingCount] = useState(0)
  const [barSize, setBarSize] = useState({ w: 440, h: 32 })
  const [stageTick, setStageTick] = useState(0)
  const [device, setDevice] = useState<Device>(() => {
    const stored = localStorage.getItem('htmlapp.device')
    return DEVICES.includes(stored as Device) ? (stored as Device) : 'desktop'
  })
  const [panelOpen, setPanelOpen] = useState(
    () => localStorage.getItem('htmlapp.stylePanel') !== '0',
  )
  const [panelDismissedSid, setPanelDismissedSid] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** a resize / reorder drag is in progress inside the frame: the floating chrome would only get in the way */
  const [dragging, setDragging] = useState(false)
  /** freshly inserted text element: opens for typing once the reloaded frame reports ready */
  const editAfterLoadRef = useRef<number | null>(null)
  const insertedSidRef = useRef<number | null>(null)
  const previewStyleRef = useRef<(styles: Record<string, string | null>) => void>(() => {})
  // a release over the host chrome (or a window switch) never reaches the frame's listeners
  useEffect(() => {
    if (!dragging) return
    const end = () => previewRef.current?.post({ type: 'gx:endDrag' })
    window.addEventListener('mouseup', end, true)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('mouseup', end, true)
      window.removeEventListener('blur', end)
    }
  }, [dragging])
  const [pictureDialog, setPictureDialog] = useState<{
    kind: 'crop' | 'cutout'
    sid: number
    /** authored src at open time: the result only lands on an <img> that still carries it */
    src: string
    image: string
    source:string
    generation:number
  } | null>(null)
  const pictureGenerationRef=useRef(0),pictureActiveRef=useRef(false)
  /** the range awaiting a label, with the selection text it was opened on */
  const [redactDialog, setRedactDialog] = useState<(SourceRange & { seed: string;source:string }) | null>(null)

  const editorRef = useRef<SourceEditorHandle>(null)
  const previewRef = useRef<PreviewFrameHandle>(null)
  const previewFrameNameRef=useRef('html-preview-'+crypto.randomUUID())
  const discardPreviewRef=useRef(false)
  const [previewRetired,setPreviewRetired]=useState(false)
  const envelopeRef = useRef<Envelope>(DEFAULT_ENVELOPE)
  const textRef = useRef('')
  const savedTextRef = useRef('')
  /** text last read from or written to disk; a watcher tick that reads the same text is a touch, not an edit */
  const diskTextRef = useRef<string | null>(null)
  const overwriteRef = useRef(false)
  const [diskNotice, setDiskNoticeState] = useState<'changed' | 'conflict' | null>(null)
  const diskNoticeRef = useRef<'changed' | 'conflict' | null>(null)
  const setDiskNotice = (next: 'changed' | 'conflict' | null) => {
    diskNoticeRef.current = next
    setDiskNoticeState(next)
  }
  const savingRef = useRef(false)
  const statusRef = useRef<LoadStatus>('loading')
  const pushedTextRef = useRef<string | null>(null)
  const previewTimerRef = useRef<number | null>(null)
  /** parse-map version of the copy currently served to the preview; messages from older copies are ignored */
  const pushedVersionRef = useRef(-1)
  /** versions whose sids the running frame still describes: the loaded copy plus every in-place commit since
   * (style / text edits the frame already showed; they leave the element structure, and so the sids, alone) */
  const frameVersionsRef = useRef<Set<number>>(new Set())
  /** window scroll of the running frame, restored after an edit reloads it */
  const frameScrollRef = useRef<number | null>(null)
  /** bumped on every text change; AI staleness checks compare against lastManualVersionRef */
  const versionRef = useRef(0)
  const lastManualVersionRef = useRef(0)
  const mapRef = useRef<ParseMap | null>(null)
  const mapSourceRef = useRef('')
  const pathRef = useRef<string | null>(null)
  const publicationIdRef=useRef<string|null>(null)
  const selectedSidRef = useRef<number | null>(null)
  const editQueueRef = useRef<EditQueueItem[]>([])
  const canvasModeRef = useRef<CanvasMode>('edit')
  const queueSeqRef = useRef(0)
  /** brief confirmed on the AI card; pinned into the head of the next generated document */
  const briefRef = useRef<Brief | null>(null)
  /** name taken from the first AI request of an untitled document: tab title now, file name at the first save */
  const provisionalNameRef = useRef<string | null>(null)
  const pendingStylesRef = useRef<Record<string, string | null>>({})
  const styleTimerRef = useRef<number | null>(null)
  const flushingStylesRef = useRef(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  editQueueRef.current = editQueue
  const draftTokenRef = useRef<string | null>(null)
  const draftActivationRef = useRef(0)
  const draftRevisionRef = useRef(0)
  const closeInstanceRef=useRef(crypto.randomUUID()),closeAliveRef=useRef(true),closePublishingRef=useRef<()=>void>(()=>{})
  const closeBarrierRef=useRef<CloseMutationBarrier|null>(null)
  if(!closeBarrierRef.current)closeBarrierRef.current=new CloseMutationBarrier({source:()=>closeInstanceRef.current+':'+draftActivationRef.current,claim:ticket=>window.htmlApi.claimCloseLease(ticket),cancel:(ticket,reason)=>window.htmlApi.cancelCloseLease(ticket,reason),report:error=>setCloseError(String(error))})
  const publicationSequenceRef=useRef(0)
  const preparingCloseRef=useRef(false),deferredClosePreviewReloadRef=useRef(false),resumeClosePreviewRef=useRef<()=>void>(()=>{})

  const draftSequenceRef = useRef(0)
  const draftBusyRef = useRef(false)
  const draftSuppressedRef = useRef(false)
  const draftActivatingRef = useRef<Promise<void> | null>(null)
  const panelRecoveryRef = useRef<(() => HtmlPanelRecoveryState) | null>(null)
  const discardPanelDraftsRef = useRef<(() => void) | null>(null)
  const recoveryUiRef = useRef<HtmlRecoveryUi | null>(null)
  const visualPendingRef = useRef(false)
  const composingRef = useRef(false)
  const dirty = text !== savedText
  const activateDraft = useCallback((documentPath: string | null): Promise<void> => {
    requireHtmlMutation()
    pictureGenerationRef.current++;pictureActiveRef.current=false;setPictureDialog(null);setRedactDialog(null)
    const generation = ++draftActivationRef.current
    draftTokenRef.current = null
    draftSequenceRef.current = 0
    draftSuppressedRef.current = false
    const pending = window.htmlApi
      .activateDraft(documentPath, draftRevisionRef.current)
      .then((token) => {
        if (generation !== draftActivationRef.current) return
        draftTokenRef.current = token
        window.htmlApi.draftChanged({
          token,
          revision: draftRevisionRef.current,
          dirty:
            textRef.current !== savedTextRef.current ||
            visualPendingRef.current ||
            !!panelRecoveryRef.current?.().dirty ||
            Object.keys(pendingStylesRef.current).length > 0,
        })
      })
    draftActivatingRef.current = pending
    void pending
      .finally(() => {
        if (draftActivatingRef.current === pending) draftActivatingRef.current = null
      })
      .catch(() => {})
    return pending
  }, [])
  const touchDraft = useCallback(() => {
    mutateHtml(()=>{
    draftRevisionRef.current++
    const token = draftTokenRef.current
    if (token)
      window.htmlApi.draftChanged({ token, revision: draftRevisionRef.current, dirty: true })
    else if (statusRef.current === 'ready' && !draftActivatingRef.current)
      void activateDraft(pathRef.current).catch((error) => setRecoveryError(String(error)))
    })
  }, [activateDraft])

  const readSaveLiveState = useCallback((): HtmlSaveLiveState => {
    const editor = editorRef.current?.recoveryState()
    return {
      token: draftTokenRef.current,
      activation: draftActivationRef.current,
      revision: draftRevisionRef.current,
      text: textRef.current,
      savedText: savedTextRef.current,
      sourceText: editor?.text ?? null,
      sourceComposing: editor?.composing ?? false,
      composing: composingRef.current,
      panelPending: panelRecoveryRef.current?.().dirty ?? false,
      visualPending: visualPendingRef.current,
      stylesPending: Object.keys(pendingStylesRef.current).length > 0,
    }
  }, [])

  closePublishingRef.current=()=>{const state=readSaveLiveState(),barrier=closeBarrierRef.current!;window.htmlApi.closeSourceState({stamp:barrier.snapshot(),path:pathRef.current,ready:statusRef.current==='ready',dirty:htmlSaveStateIsDirty(state),pending:state.panelPending||state.visualPending||state.stylesPending||state.sourceText!==null&&state.sourceText!==state.text||pictureActiveRef.current||!!redactDialog,busy:barrier.busy||savingRef.current||!!draftActivatingRef.current,composing:state.composing||state.sourceComposing})}
  useEffect(()=>{
    closeAliveRef.current=true
    const barrier=closeBarrierRef.current!,unbind=bindHtmlCloseBarrier({barrier,publish:()=>closePublishingRef.current(),alive:()=>closeAliveRef.current}),fence=installHtmlCloseInputFence(barrier)
    const off=window.htmlApi.onCloseLeaseRelease(ticket=>{previewRef.current?.releaseClose(ticket);barrier.release(ticket);resumeClosePreviewRef.current()})
    const unregister=barrier.registerLock(()=>{
      if(styleTimerRef.current!==null)window.clearTimeout(styleTimerRef.current);styleTimerRef.current=null
      const controls=[...document.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('.hx-panel input,.hx-panel textarea,.hx-panel select,.image-dialog input,.redact-dialog input')].map(element=>({element,disabled:element.disabled}));for(const item of controls)item.element.disabled=true
      return()=>{for(const item of controls)if(item.element.isConnected)item.element.disabled=item.disabled;if(closeAliveRef.current&&Object.keys(pendingStylesRef.current).length)styleTimerRef.current=window.setTimeout(()=>flushStylesRef.current?.(),STYLE_COMMIT_MS)}
    })
    return()=>{closeAliveRef.current=false;draftActivationRef.current++;const ticket=barrier.ticket;if(ticket)void window.htmlApi.cancelCloseLease(ticket,'HTML view unmounted');fence();off();unregister();unbind()}
  },[])
  useEffect(()=>{closePublishingRef.current()})

  const readReloadLiveState = useCallback(
    (): HtmlReloadLiveState => ({
      ...readSaveLiveState(),
      path: pathRef.current,
      highestSequence: draftSequenceRef.current,
      ready: statusRef.current === 'ready' && !savingRef.current,
      pendingSignature: JSON.stringify({
        panel: panelRecoveryRef.current?.() ?? null,
        styles: pendingStylesRef.current,
        visual: visualPendingRef.current,
      }),
    }),
    [readSaveLiveState],
  )

  const getMap = useCallback((): ParseMap => {
    const cached = mapRef.current
    // the initial load swaps the text without bumping the version, so the source itself is part of the key
    if (cached && cached.version === versionRef.current && mapSourceRef.current === textRef.current)
      return cached
    const next = buildParseMap(textRef.current, versionRef.current, cached)
    mapRef.current = next
    mapSourceRef.current = textRef.current
    return next
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const pending=await window.htmlApi.consumePending()
        const loaded=pending?await window.htmlApi.readPublication(pending):null
        const raw=loaded?.text??''
        if (cancelled) return
        diskTextRef.current = raw
        const doc = parseDocText(raw)
        const recovery = readHtmlRecoveryState(doc.text)
        doc.text = recovery.text
        recoveryUiRef.current = recovery.ui
        setRecoveryRemoteCount(recovery.remoteReferences)
        pathRef.current = pending
        savedTextRef.current = doc.text
        await activateDraft(pending)
        if (cancelled) return
        envelopeRef.current = doc.envelope
        textRef.current = doc.text
        publicationIdRef.current=loaded?.publicationId??null
        if(pending&&loaded){closePublishingRef.current();window.htmlApi.publicationLoaded({publicationId:loaded.publicationId,path:pending,stamp:htmlCloseStamp()})}
        // the frame must never race the first push: serve the buffer before the URL is known to React
        const map0 = getMap()
        const instrumented=instrumentForPreview(doc.text,map0,inspectorSource)
        closePublishingRef.current()
        window.htmlApi.updatePreview(instrumented)
        let initialPreview:{id:string;url:string}|null=null
        try{initialPreview=await window.htmlApi.publishPreview({source:doc.text,instrumented,stamp:htmlCloseStamp()})}catch(error){sourceOnlyCloseRef.current=true;setSourceOnlyClose(true);setView('source');setCloseError('The preview is unavailable; the source is kept and can still be saved. '+String(error))}
        if(cancelled){if(initialPreview)await window.htmlApi.retirePreview(initialPreview.id);return}
        pushedTextRef.current = doc.text
        pushedVersionRef.current = map0.version
        frameVersionsRef.current = new Set([map0.version])
        frameScrollRef.current = null
        setPath(pending)
        setText(doc.text)
        setSavedText(doc.text)
        setPreviewUrl(initialPreview?.url??null)
        statusRef.current='ready'
        setStatus('ready')
      } catch (err) {
        console.error('[html] open failed:', err)
        if (!cancelled){statusRef.current='error';setStatus('error')}
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getMap, activateDraft])

  // mirror dirtiness to the main process (close prompt) — untitled blank docs never count
  useEffect(() => {
    if (status !== 'ready') return
    const dirtyNow = htmlSaveStateIsDirty(readSaveLiveState())
    const token = draftTokenRef.current
    if (token) {
      window.htmlApi.draftChanged({ token, revision: draftRevisionRef.current, dirty: dirtyNow })
      if (!dirtyNow)
        void window.htmlApi
          .acknowledgeDraftSaved({
            token,
            revision: draftRevisionRef.current,
            throughSequence: draftSequenceRef.current,
            documentPath: pathRef.current,
            clean: true,
          })
          .catch((error) => setRecoveryError(String(error)))
    }
  }, [dirty, pendingCount, panelPending, visualPending, status,readSaveLiveState])
  useEffect(() => {
    const start = () => {
      composingRef.current = true
    }
    const end = () => {
      composingRef.current = false
    }
    document.addEventListener('compositionstart', start, true)
    document.addEventListener('compositionend', end, true)
    const off = window.htmlApi.onDraftDiscarded((token) => {
      if (token !== draftTokenRef.current) return
      draftActivationRef.current++
      draftTokenRef.current = null
      draftSequenceRef.current = 0
      draftSuppressedRef.current = true
      setRecoveryError(null)
    })
    return () => {
      document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true)
      off()
    }
  }, [])

  /**
   * Serve the current source to html-preview://. `reload` = false for a commit the frame already
   * displays (a style poke or an inline text edit it made itself): the buffer is refreshed so the
   * next real reload and exports see it, but the running frame stays, without the flash and the
   * scroll jump of a reload, and keeps talking under its own (older) version.
   */
  const pushPreview = useCallback(
    (nextText: string, reload = true) => {
      if(nextText!==textRef.current)return
      if(reload&&(preparingCloseRef.current||closeBarrierRef.current?.locked)){deferredClosePreviewReloadRef.current=true;reload=false}
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current)
        previewTimerRef.current = null
      }
      if (pushedTextRef.current === nextText) return
      const map = getMap()
      const instrumented=instrumentForPreview(nextText,map,inspectorSource)
      window.htmlApi.updatePreview(instrumented)
      pushedTextRef.current = nextText
      pushedVersionRef.current = map.version
      frameVersionsRef.current.add(map.version)
      if(reload&&!sourceOnlyCloseRef.current&&!discardPreviewRef.current){
        const source=htmlCloseStamp().source,version=map.version
        void runHtmlAsyncMutation(async()=>{
          const published=await window.htmlApi.publishPreview({source:nextText,instrumented,stamp:htmlCloseStamp()})
          if(!closeAliveRef.current||source!==htmlCloseStamp().source||version!==versionRef.current||nextText!==textRef.current||sourceOnlyCloseRef.current||discardPreviewRef.current||preparingCloseRef.current||closeBarrierRef.current?.locked){await window.htmlApi.retirePreview(published.id);if(source===htmlCloseStamp().source&&nextText===textRef.current)deferredClosePreviewReloadRef.current=true;return}
          frameVersionsRef.current=new Set([map.version]);setPreviewUrl(published.url)
        }).catch(error=>setCloseError('The previous preview is kept because its source update failed: '+String(error)))
      }
    },
    [getMap],
  )
  resumeClosePreviewRef.current=()=>{if(!deferredClosePreviewReloadRef.current||preparingCloseRef.current||closeBarrierRef.current?.locked||visualPendingRef.current||panelRecoveryRef.current?.().dirty||Object.keys(pendingStylesRef.current).length)return;deferredClosePreviewReloadRef.current=false;pushedTextRef.current=null;pushPreview(textRef.current)}
  // push the instrumented buffer to html-preview:// and reload the frame, debounced per keystroke
  useEffect(() => {
    if (status !== 'ready' || pushedTextRef.current === text) return
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current)
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null
      pushPreview(text)
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current)
        previewTimerRef.current = null
      }
    }
  }, [text, status, pushPreview])

  useEffect(() => {
    localStorage.setItem('htmlapp.viewMode', view)
  }, [view])
  const frameMode = (mode: CanvasMode) => (mode === 'edit' ? 'inspect' : 'browse')
  const prevCanvasModeRef = useRef(canvasMode)
  useEffect(() => {
    // a presentation lets links navigate the frame; coming back reloads the instrumented document
    if (prevCanvasModeRef.current === 'present' && canvasMode !== 'present')
      setPreviewNonce((n) => n + 1)
    prevCanvasModeRef.current = canvasMode
    previewRef.current?.post({ type: 'gx:setMode', mode: frameMode(canvasMode) })
  }, [canvasMode])

  useEffect(() => {
    rememberAiPanelOpen('htmlapp.showAi', aiOpen)
  }, [aiOpen])

  useEffect(() => {
    localStorage.setItem('htmlapp.device', device)
  }, [device])

  useEffect(() => {
    localStorage.setItem('htmlapp.stylePanel', panelOpen ? '1' : '0')
  }, [panelOpen])

  // the device host is centred in the stage: any stage resize (split view, AI dock, device) moves it
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || status !== 'ready') return
    const ro = new ResizeObserver(() => setStageTick((n) => n + 1))
    ro.observe(stage)
    return () => ro.disconnect()
  }, [status])

  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width && (r.width !== barSize.w || r.height !== barSize.h))
      setBarSize({ w: r.width, h: r.height })
  }, [selRect, selText.run, barSize.w, barSize.h])

  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(id)
  }, [notice])

  const refreshHistory = useCallback(() => {
    const editor = editorRef.current
    if (editor) setHistoryState({ undo: editor.canUndo(), redo: editor.canRedo() })
  }, [])

  /** every text change goes through here so the version counter and the map cache stay coherent */
  const commitText = useCallback(
    (next: string, manual: boolean, preservePending = false) => {
      mutateHtml(()=>{
      textRef.current = next
      versionRef.current += 1
      touchDraft()
      if (manual) lastManualVersionRef.current = versionRef.current
      // text-range coordinates never survive a document change
      setTextSel(null)
      // any other document change reloads the preview and drops the live pokes; forget them too rather than
      // committing them later against sids the rebuilt parse map may have reassigned
      if (!flushingStylesRef.current && !preservePending) {
        if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current)
        styleTimerRef.current = null
        pendingStylesRef.current = {}
        setPendingCount(0)
      }
      setText(next)
      refreshHistory()
      })
    },
    [refreshHistory, touchDraft],
  )

  const onEditorChange = useCallback(
    (next: string) => {
      editorRef.current?.clearHighlights()
      commitText(next, true)
    },
    [commitText],
  )

  /** compile + apply one batch; manual batches are not highlighted and count as user edits for AI staleness */
  const applyOps = useCallback(
    (
      ops: HtmlOp[],
      manual: boolean,
    ): { ok: true; ranges: Array<[number, number]> } | { ok: false; errors: OpError[] } => {
      requireHtmlMutation()
      const base = textRef.current
      const compiled = compileOps(base, getMap(), ops)
      if (compiled.errors.length > 0) return { ok: false, errors: compiled.errors }
      const editor = editorRef.current
      const ranges = editor
        ? editor.applyPatches(compiled.patches, !manual)
        : compiled.patches.map((p) => [p.from, p.from + p.text.length] as [number, number])
      commitText(applyPatches(base, compiled.patches), manual)
      return { ok: true, ranges }
    },
    [commitText, getMap],
  )

  const flushStylesRef = useRef<(() => void) | null>(null)
  const flushDraftsRef = useRef<(() => void) | null>(null)
  /** land live style pokes and open panel drafts in the source before anything reads, saves or edits it */
  const flushPending = useCallback(() => {
    flushDraftsRef.current?.()
    flushStylesRef.current?.()
  }, [])

  const replaceAll = useCallback(
    (html: string, highlight: boolean) => {
      requireHtmlMutation()
      flushPending()
      // a generated document carries the confirmed brief so later turns (and re-opens) stay anchored to it
      const pinned =
        highlight && briefRef.current && !parseBrief(html)
          ? injectBrief(html, briefRef.current)
          : html
      editorRef.current?.replaceDoc(pinned, highlight)
      // a new page, not an edit of the one on screen: it opens at the top
      frameScrollRef.current = null
      commitText(pinned, false)
    },
    [commitText, flushPending],
  )

  /** apply a toolbar/inspector batch; the selection follows the edited element (or clears when it is gone) */
  const runManual = useCallback(
    (
      ops: HtmlOp[],
      follow: 'reselect' | 'clear' | 'keep' | 'inserted' = 'reselect',
      opts: {
        /** the frame already shows exactly this result (its own inline edit / live style): no reload */
        inPlace?: boolean
      } = {},
    ) => {
      requireHtmlMutation()
      // live style pokes and open panel drafts are written first, while their sid still names the element they were made on
      flushPending()
      const before = selectedSidRef.current
      const r = applyOps(ops, true)
      if (!r.ok) {
        setNotice(r.errors[0]?.message ?? 'edit rejected')
        return false
      }
      if (opts.inPlace) pushPreview(textRef.current, false)
      if (follow === 'clear') {
        selectSidRef.current?.(null, {})
        return true
      }
      if (follow === 'inserted' || (follow === 'reselect' && before !== null)) {
        const map = getMap()
        // sids are matched by path, so after a move / rename / replace the old sid may now name the
        // sibling that took the old position; re-derive the target from the largest applied range
        const relocates = ops.some(
          (o) => o.op === 'move' || o.op === 'set_tag' || o.op === 'replace_element',
        )
        const widest = r.ranges.reduce<[number, number] | null>(
          (best, cur) => (!best || cur[1] - cur[0] > best[1] - best[0] ? cur : best),
          null,
        )
        // moved chunks carry their line's indentation and newline; trim so the covering
        // element is the moved element itself, not its parent
        const trimmed = (() => {
          if (!widest) return null
          const src = textRef.current
          let [a, b] = widest
          while (a < b && /\s/.test(src[a]!)) a++
          while (b > a && /\s/.test(src[b - 1]!)) b--
          return [a, b] as [number, number]
        })()
        const covering = trimmed ? elementCovering(map, trimmed[0], trimmed[1]) : null
        if (follow === 'inserted') {
          const target = covering && !STRUCTURAL.has(covering.tag) ? covering.sid : null
          insertedSidRef.current = target
          selectSidRef.current?.(target, { reveal: true })
          return true
        }
        if (relocates && trimmed) {
          selectSidRef.current?.(covering && !STRUCTURAL.has(covering.tag) ? covering.sid : null, {
            reveal: true,
          })
        } else if (before !== null && !map.bySid.has(before)) {
          selectSidRef.current?.(covering && !STRUCTURAL.has(covering.tag) ? covering.sid : null, {
            reveal: true,
          })
        }
      }
      return true
    },
    [applyOps, getMap, flushPending, pushPreview],
  )

  /**
   * Land a redaction plan. The marks the op vocabulary can express go through
   * `runManual`, so they are validated, journaled and undoable like any toolbar
   * edit; the one insertion that no op can address (the comment in front of a
   * `<script>` literal) is spliced through the same patch primitive and the same
   * commit path, one step earlier in the pipeline.
   */
  const applyRedaction = useCallback(
    (plan: RedactPlan | null): boolean => {
      if (!plan) return false
      if (plan.ops.length > 0) return runManual(plan.ops, 'keep')
      if (plan.patches.length === 0) return false
      // pending style pokes land first: they move the offsets the plan was built on
      flushPending()
      const base = textRef.current
      editorRef.current?.applyPatches(plan.patches, false)
      commitText(applyPatches(base, plan.patches), true)
      return true
    },
    [commitText, flushPending, runManual],
  )

  /**
   * The source pane's "hide this from the model" command.
   *
   * An already-marked region is taken off rather than labelled again, which is
   * what makes coming back to a mark undo it. The seed is collapsed to one line
   * because a selection can cross lines and the label goes into a single-line
   * field — and because a label is meant to name the span, not quote it. The raw
   * selection is kept alongside it: a mark may only be written over the exact text
   * the reader was looking at when they opened the dialog.
   */
  const onRedactSelection = useCallback(
    (range: SourceRange) => {
      flushPending()
      const base = textRef.current
      const clear = redactClearPlan(base, getMap(), range.from, range.to)
      if (clear) {
        applyRedaction(clear)
        return
      }
      setRedactDialog({ ...range, source:htmlCloseStamp().source, seed: range.text.replace(/\s+/g, ' ').trim() })
    },
    [applyRedaction, flushPending, getMap],
  )

  /** the label is in: write the mark, unless the range moved out from under the dialog */
  const confirmRedaction = useCallback(
    (label: string) => {
      requireHtmlMutation()
      const range = redactDialog
      if(range&&range.source!==htmlCloseStamp().source)throw new Error('The dialog belongs to a replaced source.')
      setRedactDialog(null)
      if (!range) return
      flushPending()
      const base = textRef.current
      if (base.slice(range.from, range.to) !== range.text) return
      applyRedaction(redactMarkPlan(base, getMap(), range.from, range.to, label))
      editorRef.current?.focus()
    },
    [applyRedaction, flushPending, getMap, redactDialog],
  )

  const cancelRedaction = useCallback(() => {
    setRedactDialog(null)
    editorRef.current?.focus()
  }, [])

  // ── selection model: one current element shared by the preview, the source pane, the toolbar and the AI ──

  const selectSidRef = useRef<
    | ((
        sid: number | null,
        opts: { reveal?: boolean; toPreview?: boolean; state?: NodeState },
      ) => void)
    | null
  >(null)

  const selectSid = useCallback(
    (
      sid: number | null,
      opts: { reveal?: boolean; toPreview?: boolean; state?: NodeState } = {},
    ) => {
      if (sid !== selectedSidRef.current) flushPending()
      selectedSidRef.current=sid
      setSelectedSid(sid)
      setSelectedState(opts.state ?? 'static')
      setTextSel(null)
      // geometry, styles and text run all belong to the previous element; the frame re-reports them via gx:rect
      setSelRect(null)
      setSelComputed(null)
      setSelText({ run: null, index: -1, editable: false })
      if (opts.toPreview !== false) previewRef.current?.post({ type: 'gx:select', sid })
      if (sid !== null && opts.reveal) {
        const e = getMap().bySid.get(sid)
        if (e) editorRef.current?.revealRange(e.range[0], e.range[1], false)
      }
    },
    [getMap, flushPending],
  )
  selectSidRef.current = selectSid

  /** numbered pins for queued edits; stale items (element gone) get no pin */
  const postMarks = useCallback(() => {
    const items = canvasModeRef.current === 'present' ? [] : editQueueRef.current
    // no getMap() before the document is loaded: it would cache an empty map under version 0
    const map = items.length ? getMap() : null
    const src = textRef.current
    // one pin per element; several queued edits on the same element share it and list their ordinals
    const bySid = new Map<number, string[]>()
    const proj = map && buildProjection(src, map)
    items.forEach((item, i) => {
      const target = proj && resolveQueueItem(proj, map, item).target
      if (target) bySid.set(target.sid, [...(bySid.get(target.sid) ?? []), String(i + 1)])
    })
    const marks = [...bySid].map(([sid, ordinals]) => ({ sid, label: ordinals.join('·') }))
    previewRef.current?.post({ type: 'gx:mark', marks })
  }, [getMap])
  useEffect(postMarks, [editQueue, canvasMode, postMarks])

  const onInspectorMessage = useCallback(
    (msg: FromInspector) => {
      if(sourceOnlyCloseRef.current||discardPreviewRef.current)return
      if(['gx:recoveryChanged','gx:textEditCommit','gx:htmlEditCommit','gx:resize','gx:moveTo','gx:keyCommand'].includes(msg.type))requireHtmlMutation()
      // a click that lands while the frame is reloading carries sids from the previous copy
      if (!frameVersionsRef.current.has(msg.version)) return
      switch (msg.type) {
        case 'gx:recoveryChanged':
          mutateHtml(()=>{})
          if (typeof msg.dirty !== 'boolean') return
          visualPendingRef.current = msg.dirty
          setVisualPending(msg.dirty)
          touchDraft()
          return
        case 'gx:ready': {
          previewRef.current?.post({ type: 'gx:theme', dark: isDarkTheme() })
          previewRef.current?.post({ type: 'gx:setMode', mode: frameMode(canvasModeRef.current) })
          // an edit reloaded the page under the reader: put it back where it was before selecting
          if (frameScrollRef.current !== null)
            previewRef.current?.post({ type: 'gx:scrollTo', y: frameScrollRef.current })
          const sid = selectedSidRef.current
          if (sid !== null) previewRef.current?.post({ type: 'gx:select', sid })
          if (editAfterLoadRef.current !== null && editAfterLoadRef.current === sid)
            previewRef.current?.post({ type: 'gx:beginTextEdit', sid })
          editAfterLoadRef.current = null
          const restored = recoveryUiRef.current
          if (restored) {
            const entry = getMap().elements.find((element) => element.path === restored.path)
            if (entry && selectedSidRef.current === null) {
              setPanelOpen(true)
              setPanelDismissedSid(null)
              selectSid(entry.sid, { reveal: true })
            }
          }
          postMarks()
          return
        }
        case 'gx:markClick': {
          const map = getMap()
          const proj = buildProjection(textRef.current, map)
          // a shared pin opens the most recent edit on that element; the others stay reachable from the queue card
          const item = editQueueRef.current
            .filter((q) => resolveQueueItem(proj, map, q).target?.sid === msg.sid)
            .at(-1)
          if (!item) return
          selectSid(item.sid, { reveal: true })
          setAskMode({ kind: 'edit', qid: item.qid })
          return
        }
        case 'gx:select': {
          if (!msg.element || msg.dynamic || msg.element.sid === null) {
            if (msg.element) {
              flushPending()
              setSelectedSid(null)
              setSelectedState('dynamic')
              setNotice(t('nodeDynamic'))
            } else selectSid(null, { toPreview: false })
            return
          }
          const map = getMap()
          const e = map.bySid.get(msg.element.sid)
          if (!e) {
            selectSid(null, { toPreview: false })
            return
          }
          const src = textRef.current
          const tag = src.slice(e.startTag[0], e.startTag[1])
          const cls = (/\sclass\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .sort()
            .join(' ')
          const liveCls = msg.element.className.trim().split(/\s+/).filter(Boolean).sort().join(' ')
          const srcText = sourceText(src, e)
          const liveText = msg.element.text
          const textMatches =
            srcText.length > 400 ? srcText.startsWith(liveText.slice(0, 380)) : srcText === liveText
          const dirty =
            cls !== liveCls ||
            childrenOf(map, e.sid).length !== msg.element.childElementCount ||
            !textMatches
          selectSid(e.sid, { reveal: true, toPreview: false, state: dirty ? 'dirty' : 'static' })
          setSelRect(msg.element.rect)
          setSelComputed(msg.element.computed)
          setSelText({
            run: msg.element.textRun,
            index: msg.element.textRunIndex,
            editable: msg.element.inlineEditable,
          })
          return
        }
        case 'gx:hover':
          return
        case 'gx:rect':
          if (msg.sid !== selectedSidRef.current) return
          setSelRect(msg.rect)
          setSelComputed(msg.computed)
          setSelText({ run: msg.textRun, index: msg.textRunIndex, editable: msg.inlineEditable })
          return
        case 'gx:textSelect':
          setTextSel({
            sid: msg.sid,
            textNodeIndex: msg.textNodeIndex,
            start: msg.start,
            end: msg.end,
          })
          return
        case 'gx:textEditCommit':
          runManual(
            [{ op: 'set_text_node', sid: msg.sid, index: msg.textNodeIndex, text: msg.newText }],
            'reselect',
            { inPlace: true },
          )
          return
        case 'gx:scroll':
          frameScrollRef.current = msg.y
          return
        case 'gx:htmlEditCommit':
          runManual([{ op: 'set_inner_html', sid: msg.sid, html: msg.html }])
          return
        case 'gx:textEditCancel':
          return
        case 'gx:zoom':
          if (canvasModeRef.current !== 'present') setZoom((z) => clampZoom(z - msg.delta * 0.6))
          return
        case 'gx:keyCommand': {
          if (canvasModeRef.current === 'present') {
            if(msg.command==='escape')mutateHtml(()=>{canvasModeRef.current='edit';setCanvasModeState('edit')})
            return
          }
          if (msg.command === 'undo' || msg.command === 'redo') {
            editorRef.current?.[msg.command]()
            return
          }
          if (msg.command === 'zoomIn' || msg.command === 'zoomOut') {
            const dir = msg.command === 'zoomIn' ? 1 : -1
            setZoom((z) => clampZoom(Math.round(z) + dir * ZOOM_STEP))
            return
          }
          if (msg.command === 'zoomReset') {
            setZoom(100)
            return
          }
          const sid = selectedSidRef.current
          if (sid === null) return
          const map = getMap()
          const e = map.bySid.get(sid)
          if (!e) return
          if (msg.command === 'moveUp' || msg.command === 'moveDown')
            moveSelectedRef.current(msg.command === 'moveUp' ? -1 : 1)
          else if (msg.command === 'delete') runManual([{ op: 'remove', sid }], 'clear')
          else if (msg.command === 'escape') selectSid(null)
          else if (msg.command === 'askAi') setAskMode({ kind: 'new' })
          else if (msg.command === 'bold') wrapSelectionRef.current('strong')
          else if (msg.command === 'italic') wrapSelectionRef.current('em')
          else if (msg.command === 'parent' && e.parentSid !== null) {
            const parent = map.bySid.get(e.parentSid)
            if (parent && parent.tag !== 'body' && parent.tag !== 'html')
              selectSid(parent.sid, { reveal: true })
          } else if (msg.command === 'child') {
            const first = childrenOf(map, sid)[0]
            if (first) selectSid(first.sid, { reveal: true })
          } else if (msg.command === 'next' || msg.command === 'prev') {
            const siblings = e.parentSid !== null ? childrenOf(map, e.parentSid) : []
            const i = siblings.findIndex((s) => s.sid === sid)
            const target = siblings[msg.command === 'next' ? i + 1 : i - 1]
            if (target) selectSid(target.sid, { reveal: true })
          }
          return
        }
        case 'gx:navigateBlocked':
          window.open(msg.href)
          setNotice(t('openExternal'))
          return
        case 'gx:resize':
          if (msg.sid === selectedSidRef.current) previewStyleRef.current(msg.styles)
          return
        case 'gx:moveTo':
          if (msg.sid === selectedSidRef.current)
            runManual([{ op: 'move', sid: msg.sid, position: msg.position, ref_sid: msg.ref_sid }])
          return
        case 'gx:drag':
          setDragging(msg.active)
          return
        default:
          return
      }
    },
    [getMap, postMarks, runManual, selectSid, t, flushPending, touchDraft],
  )

  // the source cursor picks the covering element (no reveal: the user is already there)
  const onCursor = useCallback(
    (c: CursorInfo) => {
      setCursor(c)
      // [pos, pos+1): a cursor sitting on a boundary belongs to the element that starts there
      const e = elementCovering(getMap(), c.pos, Math.min(c.pos + 1, textRef.current.length))
      const sid = e && !STRUCTURAL.has(e.tag) ? e.sid : null
      if (sid !== selectedSidRef.current) selectSid(sid, { toPreview: true })
    },
    [getMap, selectSid],
  )

  const selectedEntry = selectedSid !== null ? getMap().bySid.get(selectedSid) : undefined

  const duplicateSelected = () => {
    if (!selectedEntry) return
    const html = textRef.current.slice(selectedEntry.range[0], selectedEntry.range[1])
    runManual([{ op: 'insert_html', sid: selectedEntry.sid, position: 'after', html: `\n${html}` }])
  }
  const moveSelected = (dir: -1 | 1) => {
    if (!selectedEntry) return
    const target = moveTarget(getMap(), selectedEntry.sid, dir)
    if (target) runManual([{ op: 'move', sid: selectedEntry.sid, ...target }])
  }
  moveSelectedRef.current = moveSelected
  const wrapSelection = (tag: string, attrs?: Record<string, string>) => {
    if (!textSel) return
    if (runManual([{ op: 'wrap_text', ...textSel, index: textSel.textNodeIndex, tag, attrs }]))
      setTextSel(null)
  }
  wrapSelectionRef.current = wrapSelection
  const askAi = () => {
    if (selectedEntry) setAskMode({ kind: 'new' })
  }
  const setAttr = (name: string, value: string | null) => {
    // may run from the panel's unmount after the element was deleted
    if (selectedEntry && getMap().bySid.has(selectedEntry.sid))
      runManual([{ op: 'set_attr', sid: selectedEntry.sid, name, value }])
  }
  /** picks a file, copies it into the document's assets/ and points src at it; needs a saved document */
  const replaceImage = () => runHtmlAsyncMutation(async source=>{
    if (!selectedEntry) return
    if (!pathRef.current) {
      setNotice(t('imageNeedsSave'))
      return
    }
    const sid = selectedEntry.sid
    const rel = await window.htmlApi.pickImage(htmlCloseStamp())
    await beforeHtmlMutation(source)
    if (rel && selectedSidRef.current === sid)
      runManual([{ op: 'set_attr', sid, name: 'src', value: rel }])
  })
  /** ribbon Insert > Insert skeleton: a standards-mode page in the UI language, for a still-blank document */
  const insertSkeleton = useCallback(() => {
    // the menu is disabled once the page has content, and re-checked here so
    // the action cannot fire from a stale render (a keyboard path, a queued click)
    if (!isDocEmpty(textRef.current)) return
    replaceAll(documentSkeleton(lang), false)
  }, [lang, replaceAll])

  /** ribbon Insert menu: a starter element after the selection (or at the end of the body), then straight into editing */
  const insertElement = (kind: InsertKind, opts: InsertOptions = {}) => runHtmlAsyncMutation(async source=>{
    let imageSrc: string | undefined
    if (kind === 'image' && opts.url) {
      imageSrc = opts.url
    } else if (kind === 'image') {
      if (!pathRef.current) {
        setNotice(t('imageNeedsSave'))
        return
      }
      const rel = await window.htmlApi.pickImage(htmlCloseStamp())
    await beforeHtmlMutation(source)
      if (!rel) return
      imageSrc = rel
    }
    flushPending()
    const map = getMap()
    const selected =
      selectedSidRef.current !== null ? map.bySid.get(selectedSidRef.current) : undefined
    const html = insertPresetHtml(
      kind,
      {
        heading: t('insertPlaceholderHeading'),
        paragraph: t('insertPlaceholderParagraph'),
        listItem: t('insertPlaceholderListItem'),
        button: t('insertPlaceholderButton'),
        sectionTitle: t('insertPlaceholderHeading'),
        sectionBody: t('insertPlaceholderParagraph'),
        imageAlt: '',
        tableHeaders: Array.from({ length: Math.max(1, opts.cols ?? 3) }, (_, i) =>
          t('insertPlaceholderTableHeader', { n: i + 1 }),
        ),
        tableCell: t('insertPlaceholderTableCell'),
      },
      { imageSrc, tableBodyRows: Math.max(1, (opts.rows ?? 3) - 1) },
    )
    const op = insertOp(map, selected, html)
    if (!op) {
      setNotice(t('insertNoBody'))
      return
    }
    insertedSidRef.current = null
    if (runManual([op], 'inserted') && TEXT_INSERT_KINDS.has(kind))
      editAfterLoadRef.current = insertedSidRef.current
  })
  /** crop / remove background edit the pixels: read the picture, open the dialog, write a new asset */
  const openPictureDialog = (kind: 'crop' | 'cutout') => runHtmlAsyncMutation(async source=>{
    const src = selComputed?.image?.src
    if (!selectedEntry || !src) return
    if (!pathRef.current) {
      setNotice(t('imageNeedsSave'))
      return
    }
    const sid = selectedEntry.sid
    const image = await loadImageDataUrl(src).catch(() => null)
    if (selectedSidRef.current !== sid) return
    if (!image) {
      setNotice(t('imageLoadFail'))
      return
    }
    await beforeHtmlMutation(source)
    pictureActiveRef.current=true
    setPictureDialog({ kind, sid, src, image,source,generation:++pictureGenerationRef.current })
    closePublishingRef.current()
  })
  const applyPictureBytes = (sid: number, src: string, png: string,expectedSource:string,generation:number) => runHtmlAsyncMutation(async source=>{
    await beforeHtmlMutation(expectedSource)
    if(generation!==pictureGenerationRef.current)throw new Error('The picture edit was cancelled with its original document.')
    pictureActiveRef.current=false;pictureGenerationRef.current++
    setPictureDialog(null)
    const rel = await window.htmlApi.saveImage({ base64: png, ext: 'png',closeSource:htmlCloseStamp() })
    await beforeHtmlMutation(source)
    // sids are matched by path, so after an edit during the write the sid may name another
    // element: the target must still be the <img> with the src the dialog was opened on
    const entry = rel ? getMap().bySid.get(sid) : undefined
    // compare through the same attribute decoding the frame used (entities such as &amp; in the query)
    const authoredSrc =
      entry?.tag === 'img'
        ? new DOMParser()
            .parseFromString(
              textRef.current.slice(entry.startTag[0], entry.startTag[1]),
              'text/html',
            )
            .querySelector('img')
            ?.getAttribute('src')
        : null
    const stillThere = authoredSrc === src
    if (!rel || !stillThere) {
      // an unreferenced pending asset is discarded by the save-time reconciliation
      setNotice(t('imageProcessFail'))
      return
    }
    runManual([{ op: 'set_attr', sid, name: 'src', value: rel }])
  })
  const imageDialogLabels: ImageDialogLabels = {
    cancel: t('cancel'),
    apply: t('imageApply'),
    applying: t('imageProcessing'),
    loading: t('imageLoading'),
    loadFailed: t('imageLoadFail'),
    processFailed: t('imageProcessFail'),
    cutoutTitle: t('imageRemoveBg'),
    tolerance: t('imageCutoutTolerance'),
    cutoutHint: (pct) => t('imageCutoutHint', { pct }),
    cropTitle: t('imageCrop'),
    cropHint: t('imageCropHint'),
  }

  // ── element-scoped AI edits: queue them on the selected element or run one right away ──
  const askTarget = useMemo(() => {
    if (!selectedEntry || STRUCTURAL.has(selectedEntry.tag)) return null
    return {
      sid: selectedEntry.sid,
      tag: selectedEntry.tag,
      // user-facing popover: the raw source text, unlike the queue's model-facing excerpt
      excerpt: sourceText(text, selectedEntry).trim() || `<${selectedEntry.tag}>`,
      start: selectedEntry.range[0],
    }
  }, [selectedEntry, text])
  const queueAdd = (instruction: string) => {
    setAskMode(null)
    if (!askTarget || editQueue.length >= EDIT_QUEUE_MAX) return
    const qid = `q${++queueSeqRef.current}`
    setEditQueue((prev) => [
      ...prev,
      { qid, sid: askTarget.sid, tag: askTarget.tag, capturedText: askTarget.excerpt, instruction },
    ])
    setAiOpen(true)
  }
  const queueUpdate = (qid: string, instruction: string) => {
    setAskMode(null)
    setEditQueue((prev) => prev.map((q) => (q.qid === qid ? { ...q, instruction } : q)))
  }
  const queueRemove = (qid: string) => {
    setAskMode(null)
    setEditQueue((prev) => prev.filter((q) => q.qid !== qid))
  }
  const queueConsume = (qids: string[]) =>
    setEditQueue((prev) => prev.filter((q) => !qids.includes(q.qid)))
  const queueFocus = (qid: string) => {
    const item = editQueue.find((q) => q.qid === qid)
    const target = item && resolveQueueItem(buildProjection(text, getMap()), getMap(), item).target
    if (target) selectSid(target.sid, { reveal: true })
  }
  const askSendNow = (instruction: string) => {
    setAskMode(null)
    if (!askTarget) return
    flushPending()
    setAiOpen(true)
    const scope: AiScopeQuoteData = {
      label: t('aiScopeElement', { tag: askTarget.tag }),
      ...(askTarget.excerpt.trim() ? { text: askTarget.excerpt.trim() } : {}),
    }
    setAiPreset({
      text: buildSelectionInstruction(askTarget, instruction),
      displayText: instruction,
      nonce: Date.now(),
      scope,
    })
  }
  /** viewport rect of the selected element, clipped to the stage; identity changes whenever the geometry does */
  const getAskAnchorRect = useCallback((): AnchorRect | null => {
    // stageTick: the stage moved or resized (AI dock, split view, device recentre) without the frame-local rect changing
    void stageTick
    const stage = stageRef.current?.getBoundingClientRect()
    const host = stageRef.current?.querySelector('.preview-host')?.getBoundingClientRect()
    if (!selRect || !stage || !host) return null
    const z = zoom / 100
    const left = Math.max(stage.left, host.left + selRect.x * z)
    const top = Math.max(stage.top, host.top + selRect.y * z)
    const right = Math.min(stage.right, host.left + (selRect.x + selRect.width) * z)
    const bottom = Math.min(stage.bottom, host.top + (selRect.y + selRect.height) * z)
    if (right <= left || bottom <= top) return null
    return { left, top, right, bottom, viewTop: stage.top, viewBottom: stage.bottom }
  }, [selRect, zoom, stageTick])

  // ── live style editing: poke the preview DOM now, write one set_style op to the source shortly after ──
  const flushStyles = useCallback(() => {
    requireHtmlMutation()
    if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current)
    styleTimerRef.current = null
    const styles = pendingStylesRef.current
    pendingStylesRef.current = {}
    setPendingCount(0)
    const sid = selectedSidRef.current
    if (sid === null || Object.keys(styles).length === 0) return
    flushingStylesRef.current = true
    try {
      // every poke went to the frame as gx:previewStyle: it already shows the committed state
      runManual([{ op: 'set_style', sid, styles }], 'reselect', { inPlace: true })
    } finally {
      flushingStylesRef.current = false
    }
  }, [runManual])
  flushStylesRef.current = flushStyles

  const previewStyle = (styles: Record<string, string | null>) => {
    mutateHtml(()=>{
    const sid = selectedSidRef.current
    if (sid === null) return
    previewRef.current?.post({ type: 'gx:previewStyle', sid, styles })
    pendingStylesRef.current = { ...pendingStylesRef.current, ...styles }
    touchDraft()
    setPendingCount(Object.keys(pendingStylesRef.current).length)
    if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current)
    styleTimerRef.current = window.setTimeout(flushStyles, STYLE_COMMIT_MS)
    })
  }

  previewStyleRef.current = previewStyle

  /** drop uncommitted previews: reload the frame from the last pushed source */
  const revertStyles = () => {
    mutateHtml(()=>{
    if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current)
    styleTimerRef.current = null
    pendingStylesRef.current = {}
    touchDraft()
    setPendingCount(0)
    setPreviewNonce((n) => n + 1)
    })
  }

  const setCanvasMode = useCallback(
    (mode: CanvasMode) => {
      mutateHtml(()=>{
        if(canvasModeRef.current===mode)return
        if(mode==='present')selectSid(null)
        canvasModeRef.current=mode;setCanvasModeState(mode)
        flushPending();setAskMode(null)
      })
    },
    [flushPending, selectSid],
  )
  useEffect(() => {
    if (canvasMode !== 'present') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCanvasMode('edit')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvasMode, setCanvasMode])

  const startPresent = useCallback(
    (kind: PresentKind) => {
      if (kind === 'newTab') {
        // the new tab reads html-preview:// as it stands: land pending pokes and the debounced push first
        flushPending()
        pushPreview(textRef.current)
        void window.htmlApi.presentInNewTab(path?.split(/[\\/]/).pop() ?? '')
        return
      }
      setPresentFull(kind === 'fullscreen')
      setCanvasMode('present')
      // HTML fullscreen needs the click's user activation; macOS snaps via simpleFullScreen instead
      if (kind === 'fullscreen' && !IS_MAC)
        void document.documentElement.requestFullscreen?.().catch(() => {})
    },
    [path, setCanvasMode, flushPending, pushPreview],
  )

  // a link navigation inside the presented frame keeps focus in a document without our
  // inspector; hand it back to the app so Esc still ends the presentation
  const onPreviewLoad = useCallback(() => {
    if (canvasModeRef.current !== 'present') return
    const active = document.activeElement
    if (active instanceof HTMLIFrameElement) active.blur()
  }, [])

  // Same shape as the slides show: the main process snaps the window (tab-strip bleed,
  // macOS simpleFullScreen without the Space animation), HTML fullscreen only elsewhere.
  // Entry is read from fullscreenchange, not the request promise, and only a loss that
  // sticks (not a strict-mode remount blip) ends the presentation.
  useEffect(() => {
    if (canvasMode !== 'present' || !presentFull) return
    let entered = !!document.fullscreenElement
    let exitTimer = 0
    void window.htmlApi.setPresentFullScreen(true).catch(() => {})
    const onFsChange = () => {
      if (document.fullscreenElement) {
        entered = true
        window.clearTimeout(exitTimer)
        return
      }
      if (!entered) return
      window.clearTimeout(exitTimer)
      exitTimer = window.setTimeout(() => {
        if (!document.fullscreenElement) setCanvasMode('edit')
      }, 150)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => {
      window.clearTimeout(exitTimer)
      document.removeEventListener('fullscreenchange', onFsChange)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      void window.htmlApi.setPresentFullScreen(false).catch(() => {})
    }
  }, [canvasMode, presentFull, setCanvasMode])

  const setRunText = (text: string) => {
    if (!selectedEntry || selText.index < 0 || !getMap().bySid.has(selectedEntry.sid)) return
    runManual([{ op: 'set_text_node', sid: selectedEntry.sid, index: selText.index, text }])
  }

  const doSaveImpl = useCallback(
    async (
      mode: SaveMode,
      suggestedName?: string,
      proposedName?: string,
      saveRequestId?: string,
      automatic=false,
    ): Promise<boolean> => {
      if(automatic&&closeBarrierRef.current?.locked)return false
      if (statusRef.current !== 'ready') return false
      if (diskNoticeRef.current && !overwriteRef.current) {
        // the user has not chosen between the two versions yet; autosave must not pick for them
        setDiskNotice('conflict')
        return false
      }
      // uncommitted live style pokes belong to the document being saved
      flushPending()
      // a menu save or ⌘S during an autosave queues behind it instead of being dropped;
      // the main-process waiter is resolved by the save() call that follows
      while (savingRef.current) await new Promise((r) => setTimeout(r, 50))
      if (!draftTokenRef.current) {
        try {
          await (draftActivatingRef.current ?? activateDraft(pathRef.current))
        } catch {
          return false
        }
      }
      savingRef.current = true
      setSaveState('saving')
      try {
        const tokenAtSave = draftTokenRef.current!
        const activationAtSave = draftActivationRef.current
        const revisionAtSave = draftRevisionRef.current
        const sequenceAtSave = draftSequenceRef.current
        const textAtSave = textRef.current
        const serialized = serializeDocText({ text: textAtSave, envelope: envelopeRef.current })
        // A page that has never been saved is offered a name derived from its
        // own content: the model's, when the reader asked for one, and the
        // page's own title otherwise. It prefills the save dialog rather than
        // replacing it — the reader still chooses where the file goes. A plain
        // Save of a page that already has a path needs no name at all, and a
        // Save As of one opens on the file's own name: a name the reader asked
        // for arrives as `proposedName`, before the save begins, and a prompt
        // left over from an earlier request is nobody's default.
        const untitled = !pathRef.current
        const defaultName = proposedName
          ? proposedName
          : untitled
            ? localFileName(textAtSave, provisionalNameRef.current)
            : undefined
        const result = await window.htmlApi.save({
          publicationId:publicationIdRef.current,
          automatic,
          closeSource:htmlCloseStamp(),
          requestId: saveRequestId,
          draft: { token: tokenAtSave, revision: revisionAtSave, throughSequence: sequenceAtSave },
          text: serialized,
          imageSources: [],
          mode,
          suggestedName,
          defaultName,
          overwrite: overwriteRef.current,
        })
        if(result.ok&&'path'in result)publicationSequenceRef.current++
        if (
          draftActivationRef.current !== activationAtSave ||
          draftTokenRef.current !== tokenAtSave
        )
          return false
        setSaveWarning(result.warnings?.join(' ')??null)
        if (result.ok && 'path' in result) {
          if(result.publicationId)publicationIdRef.current=result.publicationId
          setSaveError(null)
          diskTextRef.current = serialized
          overwriteRef.current = false
          setDiskNotice(null)
          const revisionWasSaved = draftRevisionRef.current === revisionAtSave
          const adopted = adoptImageRewrites(textAtSave, textRef.current, result.imageRewrites)
          if (adopted.liveText !== textRef.current) {
            editorRef.current?.setDoc(adopted.liveText)
            commitText(adopted.liveText, false, true)
          }
          const previousPath=pathRef.current
          pathRef.current=result.path
          if(previousPath!==result.path){if(preparingCloseRef.current||closeBarrierRef.current?.locked)deferredClosePreviewReloadRef.current=true;else setPreviewNonce(n=>n+1)}
          setPath(result.path)
          savedTextRef.current = adopted.savedText
          setSavedText(adopted.savedText)
          pathRef.current = result.path
          const saved =
            adopted.liveText === adopted.savedText &&
            revisionWasSaved &&
            !visualPendingRef.current &&
            !panelRecoveryRef.current?.().dirty &&
            Object.keys(pendingStylesRef.current).length === 0
          await completeHtmlSaveAcknowledgment(
            window.htmlApi.acknowledgeDraftSaved({
              token: tokenAtSave,
              throughSequence: sequenceAtSave,
              revision: draftRevisionRef.current,
              documentPath: result.path,
              clean: saved,
            }),
            {
              token: tokenAtSave,
              activation: activationAtSave,
              revision: draftRevisionRef.current,
              representedClean: saved,
            },
            readSaveLiveState,
            (current) => {
              setSaveState(current.clean ? 'saved' : 'idle')
              window.htmlApi.draftChanged({
                token: tokenAtSave,
                revision: current.revision,
                dirty: current.dirty,
              })
              pushPreview(textRef.current)
            },
          )
          return true
        }
        if (!result.ok && result.conflict) setDiskNotice('conflict')
        if (!result.ok && !result.conflict) setSaveError(result.error)
        setSaveState(result.ok ? 'idle' : 'failed')
        return false
      } catch (err) {
        console.error('[html] save failed:', err)
        setSaveError(err instanceof Error ? err.message : String(err))
        setSaveState('failed')
        return false
      } finally {
        savingRef.current = false
        closePublishingRef.current()
      }
    },
    [commitText, flushPending, pushPreview, activateDraft, readSaveLiveState],
  )

  const doSave=useCallback((mode:SaveMode,suggestedName?:string,proposedName?:string,requestId?:string,automatic=false):Promise<boolean>=>automatic&&closeBarrierRef.current?.locked?Promise.resolve(false):runHtmlAsyncMutation(async()=>automatic&&closeBarrierRef.current?.locked?false:doSaveImpl(mode,suggestedName,proposedName,requestId,automatic)),[doSaveImpl])

  /** Read/validate first; every await precedes the synchronous source replacement. */
  const reloadFromDisk = useCallback(
    (documentPath: string): Promise<boolean> => runHtmlAsyncMutation(async()=>{
      const captured = readReloadLiveState()
      if (captured.path !== documentPath) return false
      let cleanup: Promise<void> | null = null
      let committedGeneration = captured.activation
      try {
        const applied = await prepareAndApplyHtmlReload(
          captured,
          async () => {
            const initialFrame = sourceOnlyCloseRef.current?{version:getMap().version,ops:[],composing:false,busy:false}:await previewRef.current?.readRecovery()
            if (!initialFrame || initialFrame.composing || initialFrame.busy)
              throw new Error(
                'Finish the current preview edit or composition before Reload; the document is retained.',
              )
            const loaded = await window.htmlApi.readPublication(documentPath,{
              token: captured.token!,
              documentPath,
              revision: captured.revision,
            })
            const raw=loaded.text
            const doc = parseDocText(raw),
              recovery = readHtmlRecoveryState(doc.text)
            doc.text = recovery.text
            const map = buildParseMap(doc.text, versionRef.current + 1, mapRef.current)
            const finalFrame = sourceOnlyCloseRef.current?{version:getMap().version,ops:[],composing:false,busy:false}:await previewRef.current?.readRecovery()
            if (
              !finalFrame ||
              finalFrame.composing ||
              finalFrame.busy ||
              finalFrame.version !== initialFrame.version ||
              JSON.stringify(finalFrame.ops) !== JSON.stringify(initialFrame.ops)
            )
              throw new Error(
                'The preview changed while Reload was reading; current edits are retained.',
              )
            return { raw, doc, recovery, map, publicationId:loaded.publicationId }
          },
          readReloadLiveState,
          (prepared, receipt) => {
            // IPC is initiated here without awaiting. Renderer replacement is one
            // synchronous block; main retires only snapshots at or below this floor.
            cleanup = window.htmlApi.applyDraftReload(receipt)
            requireHtmlMutation()
            pictureGenerationRef.current++;pictureActiveRef.current=false;setPictureDialog(null);setRedactDialog(null)
            committedGeneration = ++draftActivationRef.current
            discardPanelDraftsRef.current?.()
            if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current)
            styleTimerRef.current = null
            pendingStylesRef.current = {}
            setPendingCount(0)
            visualPendingRef.current = false
            setVisualPending(false)
            setPanelPending(false)
            recoveryUiRef.current = prepared.recovery.ui
            setRecoveryRemoteCount(prepared.recovery.remoteReferences)
            diskTextRef.current = prepared.raw
            overwriteRef.current = false
            setDiskNotice(null)
            envelopeRef.current = prepared.doc.envelope
            commitText(prepared.doc.text, false)
            mapRef.current = prepared.map
            mapSourceRef.current = prepared.doc.text
            editorRef.current?.setDoc(prepared.doc.text)
            selectedSidRef.current = null
            setSelectedSid(null)
            setSelRect(null)
            setSelComputed(null)
            setSelText({ run: null, index: -1, editable: false })
            savedTextRef.current = prepared.doc.text
            setSavedText(prepared.doc.text)
            setSaveState('idle')
            setSaveError(null)
            setRecoveryError(null)
            window.htmlApi.draftChanged({
              token: receipt.token,
              revision: draftRevisionRef.current,
              dirty: false,
            })
            pushedTextRef.current = null
            pushPreview(prepared.doc.text)
            publicationIdRef.current=prepared.publicationId
            closePublishingRef.current()
            window.htmlApi.publicationLoaded({publicationId:prepared.publicationId,path:documentPath,stamp:htmlCloseStamp()})
            window.htmlApi.ackFileChangedOnDisk()
          },
        )
        if (!applied)
          throw new Error(
            'The document changed while Reload was preparing; current edits and recovery are retained.',
          )
        try {
          await cleanup
          if (
            draftTokenRef.current === captured.token &&
            draftActivationRef.current === committedGeneration
          )
            setReloadCleanupError(null)
        } catch (error) {
          if (
            draftTokenRef.current === captured.token &&
            draftActivationRef.current === committedGeneration
          )
            setReloadCleanupError(
              'The source reloaded, but its previous recovery copy could not be removed: ' +
                (error instanceof Error ? error.message : String(error)),
            )
        }
        return true
      } catch (error) {
        if (
          draftTokenRef.current === captured.token &&
          draftActivationRef.current === captured.activation
        )
          setRecoveryError(error instanceof Error ? error.message : String(error))
        return false
      }
    }),
    [readReloadLiveState, commitText, pushPreview],
  )

  const reloadNow = useCallback(async () => {
    const current = pathRef.current
    if (current) await reloadFromDisk(current)
  }, [reloadFromDisk])

  const keepMine = useCallback(() => {
    overwriteRef.current = true
    setDiskNotice(null)
    window.htmlApi.ackFileChangedOnDisk()
  }, [])

  const overwriteNow = useCallback(() => {
    overwriteRef.current = true
    setDiskNotice(null)
    void doSave('save')
  }, [doSave])

  /**
   * Ask the model to name this page, on request, then open Save As with its
   * answer prefilled.
   *
   * The stem goes into the dialog rather than renaming the file on disk: a file
   * that may be open elsewhere, referenced from a note, or synced is not
   * something to move behind the reader's back. A declined or empty answer
   * leaves the dialog on the page's current name, so this is a no-op rather
   * than a failure.
   */
  const nameWithAi = useCallback(async () => {
    if (statusRef.current !== 'ready') return
    const stem = await modelSaveAsName(textRef.current, getMap())
    if (!stem) return
    await doSave('saveAs', undefined, stem)
  }, [doSave, getMap])

  const zoomIn = useCallback(() => setZoom((z) => clampZoom(Math.round(z) + ZOOM_STEP)), [])
  const zoomOut = useCallback(() => setZoom((z) => clampZoom(Math.round(z) - ZOOM_STEP)), [])
  const cycleView = useCallback(
    () => setView((v) => VIEW_MODES[(VIEW_MODES.indexOf(v) + 1) % VIEW_MODES.length]!),
    [],
  )

  const openFind = useCallback((replace: boolean) => {
    if (statusRef.current !== 'ready' || canvasModeRef.current === 'present') return
    const target = editorRef.current?.findTarget()
    if (!target) return
    setFindTarget(target)
    setFindFocus((f) => ({ field: replace ? 'replace' : 'find', nonce: f.nonce + 1 }))
    // hits live in the source pane, so it must be on screen
    setView((v) => (v === 'preview' ? 'split' : v))
  }, [])
  const closeFind = useCallback(() => setFindTarget(null), [])
  useEffect(() => {
    if (canvasMode === 'present') closeFind()
  }, [canvasMode, closeFind])

  const exportingRef = useRef(false)
  /** `outPath` (headless export only) skips the save dialog; resolves true when a file was written. */
  const runExport = useCallback(async (format: ExportFormat, outPath?: string) => {
    if (statusRef.current !== 'ready' || exportingRef.current) return false
    exportingRef.current = true
    try {
      flushPending()
      const html = textRef.current
      const suggestedName =
        pathRef.current?.replace(/^.*[/\\]/, '').replace(/\.html?$/i, '') ||
        deriveAutoFileName(html) ||
        ''
      const request = { html, suggestedName, ...(outPath ? { outPath } : {}) }
      const result =
        format === 'pdf'
          ? await window.htmlApi.exportPdf(request)
          : format === 'html'
            ? await window.htmlApi.exportHtml(request)
            : await window.htmlApi.exportDocx(request)
      if (!result.ok) {
        console.error('[html] export failed:', result.error)
        setNotice(`${t('exportFailed')}: ${result.error}`)
        return false
      }
      if ('skipped' in result && result.skipped?.length) {
        setNotice(
          t('exportHtmlSkipped', { count: result.skipped.length, first: result.skipped[0]! }),
        )
      }
      return !('canceled' in result)
    } catch (error) {
      console.error('[html] export failed:', error)
      setNotice(`${t('exportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      exportingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is not referentially stable
  }, [])

  const printingRef = useRef(false)
  const runPrint = useCallback(async () => {
    if (statusRef.current !== 'ready') return false
    return runGuardedPrint(
      printingRef,
      async () => {
        // serialize inside the gate so a throw still releases the flag
        flushPending()
        return window.htmlApi.printHtml({
          html: serializeDocText({ text: textRef.current, envelope: envelopeRef.current }),
        })
      },
      (error) => {
        console.error('[html] print failed:', error)
        setNotice(t('printFailed', { error }))
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is not referentially stable
  }, [])

  // Headless export mode (--headless-export): this renderer lives in a hidden
  // window whose only job is to run the File menu's PDF or Word export against
  // a path the CLI chose, then report back so the main process can quit.
  const headlessExportStartedRef = useRef(false)
  useEffect(() => {
    if (headlessExportStartedRef.current) return
    headlessExportStartedRef.current = true
    void (async () => {
      const target = await window.htmlApi.consumeHeadlessExport()
      if (!target) return
      const report = await runHeadlessRendererExport(
        target.outPath,
        () =>
          pollUntilReady(() => {
            if (statusRef.current === 'error') throw new Error('the input document did not open')
            return statusRef.current === 'ready'
          }, 'no document opened'),
        (outPath) => runExport(target.format === 'docx' ? 'docx' : 'pdf', outPath),
      )
      window.htmlApi.headlessExportDone(report)
    })()
  }, [runExport])

  useEffect(() => {
    const offSave=window.htmlApi.onSaveRequest((mode,requestId,targetPath,ticket)=>{
      const barrier=closeBarrierRef.current!,source=htmlCloseStamp().source,sourceMatches=!ticket||ticket.sourcePath===pathRef.current,beforePublication=publicationSequenceRef.current
      const isCurrent=()=>closeAliveRef.current&&statusRef.current==='ready'&&sourceMatches&&source===htmlCloseStamp().source
      const idle=()=>!barrier.busy&&!savingRef.current&&!draftActivatingRef.current&&!composingRef.current&&!editorRef.current?.recoveryState()?.composing
      const canFreeze=()=>isCurrent()&&idle()&&!htmlSaveStateIsDirty(readSaveLiveState())&&!pictureActiveRef.current&&!redactDialog
      const exactApproved=()=>!!ticket?.approved&&ticket.approved.source===htmlCloseStamp().source&&ticket.approved.revision===htmlCloseStamp().revision
      let held:import('../shared/html-close-lease').HtmlCloseLease|undefined
      let previewProof:string|undefined
      const proveFrame=async()=>{
        const token=draftTokenRef.current,stamp=htmlCloseStamp(),serialized=serializeDocText({text:textRef.current,envelope:envelopeRef.current})
        if(!token)throw new Error('The current document activation is unavailable.')
        const verified=await window.htmlApi.validateCloseSource({requestId,token,revision:draftRevisionRef.current,text:serialized,stamp,sourceOnly:sourceOnlyCloseRef.current,frameName:previewFrameNameRef.current})
        if(!verified.ok||!verified.proof)throw new Error(verified.error??'The actual loaded preview could not be verified.')
        if(!isCurrent()||stamp.source!==htmlCloseStamp().source||stamp.revision!==htmlCloseStamp().revision||serialized!==serializeDocText({text:textRef.current,envelope:envelopeRef.current}))throw new Error('The authored state changed during loaded-source verification.')
        previewProof=verified.proof;return {id:verified.proof,stamp,serialized}
      }
      const releaseFrame=()=>{if(ticket?.closeLease)previewRef.current?.releaseClose(ticket.closeLease)}
      void(async()=>{
        const deadline=Date.now()+110000
        if(ticket?.requireClean&&(!ticket.closeLease||!await window.htmlApi.claimCloseLease(ticket.closeLease)))throw new Error('The close request expired before preparation.')
        while(!idle()){if(!isCurrent()||Date.now()>deadline)throw new Error('An asynchronous edit or composition is still active.');await new Promise(resolve=>setTimeout(resolve,50))}
        if(!isCurrent())throw new Error('The HTML source was replaced before Save.')
        if(!ticket?.requireClean){const clean=!htmlSaveStateIsDirty(readSaveLiveState())&&(!targetPath||targetPath===pathRef.current)&&mode==='save';if(!clean)await doSave(mode,undefined,undefined,requestId);return}
        if(!ticket.closeLease)throw new Error('Close requires its main-owned ticket.')
        preparingCloseRef.current=true
        try{
          if(ticket.intent==='discard'){
            if(!exactApproved())throw new Error('The document changed after discard was approved.')
            const stamp=await barrier.acquire(ticket.closeLease,()=>isCurrent()&&idle()&&exactApproved())
            if(!stamp)throw new Error('The approved discard was cancelled by newer work.')
            held={ticket:ticket.closeLease,stamp}
            // Retire captured child/dialog work, rather than trusting a scripted page to attest it.
            discardPreviewRef.current=true;setPreviewRetired(true);pictureGenerationRef.current++;pictureActiveRef.current=false;setPictureDialog(null)
            const retirementDeadline=Date.now()+3000
            while(!await window.htmlApi.isCloseFrameRetired({requestId,frameName:previewFrameNameRef.current})){
              if(!isCurrent()||!exactApproved()||Date.now()>retirementDeadline)throw new Error('The approved preview did not finish retiring. The document remains open.')
              await new Promise(resolve=>setTimeout(resolve,25))
            }
            await proveFrame();closePublishingRef.current()
          }else{
            if(pictureActiveRef.current)throw new Error('Finish or cancel the picture dialog before Save and Close.')
            if(redactDialog)throw new Error('Finish or cancel the open document dialog before Save and Close.')
            await runHtmlAsyncMutation(async currentSource=>{
              for(let pass=0;pass<3;pass++){
                await beforeHtmlMutation(currentSource)
                const proof=await proveFrame()
                const frame=sourceOnlyCloseRef.current?null:await previewRef.current?.prepareClose(ticket.closeLease!,proof.id)
                if(frame&&!await window.htmlApi.confirmCloseFrame({requestId,proof:proof.id}))throw new Error('The loaded frame navigated or changed identity after attestation.')
                if(!sourceOnlyCloseRef.current&&(!frame||frame.busy||frame.composing||!frameVersionsRef.current.has(frame.version)))throw new Error('The live preview cannot attest its current pending edit.')
                const panel=panelRecoveryRef.current?.(),styles={...pendingStylesRef.current},sid=selectedSidRef.current
                if(panel?.css&&!pendingCssCanBeCommitted(panel.css,(property,value)=>CSS.supports(property,value)))throw new Error('The CSS field contains unfinished or unsupported declarations. Finish or cancel that field before closing; its text is retained.')
                const pending=!!frame?.ops.length||!!panel?.dirty||Object.keys(styles).length>0
                if(ticket.intent==='clean'&&(pending||htmlSaveStateIsDirty(readSaveLiveState())))throw new Error('The renderer has pending changes; close needs a new Save or Discard decision.')
                if(pending){
                  if((panel?.dirty||Object.keys(styles).length)&&sid===null)throw new Error('A pending style edit has no current target.')
                  const panelOps:HtmlOp[]=[]
                  if(sid!==null){if(panel?.text!==null&&panel?.text!==undefined){if(selText.index<0)throw new Error('The pending text field has no current text run.');panelOps.push({op:'set_text_node',sid,index:selText.index,text:panel.text})}if(panel?.alt!==null&&panel?.alt!==undefined)panelOps.push({op:'set_attr',sid,name:'alt',value:panel.alt})}
                  if(frame?.ops.some(op=>panelOps.some(panelOp=>op.sid===panelOp.sid&&(op.op==='set_inner_html'||op.op==='set_text_node'&&panelOp.op==='set_text_node'&&op.index===panelOp.index&&op.text!==panelOp.text))))throw new Error('The inline editor and style panel have different pending text. Apply one editing surface before closing; both drafts are retained.')
                  const allStyles={...styles,...(panel?.css?parseDeclarations(panel.css):{})}
                  const captured=captureHtmlRecoveryText(textRef.current,getMap(),[frame?.ops??[],panelOps,sid!==null&&Object.keys(allStyles).length?[{op:'set_style',sid,styles:allStyles}]:[]])
                  // One synchronous replacement adopts all pending editors against one parse map.
                  if(captured!==textRef.current){editorRef.current?.replaceDoc(captured,false);commitText(captured,true,true)}
                  if(styleTimerRef.current!==null)window.clearTimeout(styleTimerRef.current);styleTimerRef.current=null
                  pendingStylesRef.current={};setPendingCount(0);discardPanelDraftsRef.current?.();setPanelPending(false);recoveryUiRef.current=null;visualPendingRef.current=false;setVisualPending(false)
                  if(frame){const acknowledged=await previewRef.current?.commitCloseCapture(ticket.closeLease!);if(!acknowledged||acknowledged.ops.length)throw new Error('The preview did not acknowledge its captured inline edit.')}
                }
                const clean=!htmlSaveStateIsDirty(readSaveLiveState())&&(!targetPath||targetPath===pathRef.current)&&mode==='save'
                if(clean){
                  if(!isCurrent()||proof.stamp.revision!==htmlCloseStamp().revision||proof.stamp.source!==htmlCloseStamp().source||proof.serialized!==serializeDocText({text:textRef.current,envelope:envelopeRef.current}))throw new Error('The document changed after its loaded frame was attested.')
                  return
                }
                releaseFrame()
                if(!await doSave(mode,undefined,undefined,requestId))throw new Error('The requested HTML revision was not published.')
              }
              throw new Error('New edits kept arriving during Save. The document remains open.')
            })
          }
          if(!isCurrent())throw new Error('The document was replaced before final close readiness.')
          if(ticket.intent!=='discard'){
            const stamp=await barrier.acquire(ticket.closeLease,()=>isCurrent()&&idle()&&(sourceOnlyCloseRef.current||previewRef.current?.closeCaptureCurrent(ticket.closeLease!)===true)&&canFreeze())
            if(!stamp)throw new Error('Close was cancelled by newer document work.')
            held={ticket:ticket.closeLease,stamp}
          }
          closePublishingRef.current()
        }catch(error){await window.htmlApi.cancelCloseLease(ticket.closeLease,'HTML close preparation failed');releaseFrame();throw error}
        finally{preparingCloseRef.current=false;resumeClosePreviewRef.current()}
      })().then(()=>{
        const state=readSaveLiveState(),current=isCurrent();window.htmlApi.sendSaveRequestAck(requestId,{requestId,published:publicationSequenceRef.current>beforePublication,current,clean:current&&!htmlSaveStateIsDirty(state)&&!pictureActiveRef.current&&!redactDialog,...(held?{closeLease:held,previewProof}:{}),...(state.token?{draft:{token:state.token,revision:state.revision,throughSequence:draftSequenceRef.current,documentPath:pathRef.current}}:{})})
      },error=>{setCloseError(String(error));window.htmlApi.sendSaveRequestAck(requestId,{requestId,published:publicationSequenceRef.current>beforePublication,current:isCurrent(),clean:false,error:String(error)})})
    })
    // MCP read of this open document: hand back the same serialization a save
    // would write, so uncommitted edits are included. Staying silent while the
    // editor is still loading keeps the main process retrying its request
    // instead of failing on a document that is merely not ready yet.
    const offReadText = window.htmlApi.onReadTextRequest(() => {
      if (statusRef.current !== 'ready') return
      try {
        flushPending()
        const serialized = serializeDocText({
          text: textRef.current,
          envelope: envelopeRef.current,
        })
        window.htmlApi.sendReadTextResult({ text: serialized })
      } catch (err) {
        window.htmlApi.sendReadTextResult({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
    const offClose = window.htmlApi.onCloseSaveRequest(() => {
      void (async () => {
        while (savingRef.current) await new Promise((r) => setTimeout(r, 50))
        flushPending()
        if (textRef.current === savedTextRef.current) {
          window.htmlApi.sendCloseSaveResult(true)
          return
        }
        window.htmlApi.sendCloseSaveResult(await doSave('save'))
      })()
    })
    const offRenamed = window.htmlApi.onFileRenamed((next) => {
      mutateHtml(()=>{pathRef.current=next;setPath(next)})
    })
    const offDisk = window.htmlApi.onFileChangedOnDisk((changedPath) => {
      // the watcher keeps refusing saves until the change is acknowledged; a
      // change parked behind the bar stays unacknowledged until the user decides
      let awaitingUser = false
      void (async () => {
        try {
          if (changedPath !== pathRef.current || statusRef.current !== 'ready') return
          const token = draftTokenRef.current
          if (!token) {
            setDiskNotice('changed')
            awaitingUser = true
            return
          }
          const raw = await window.htmlApi.readReloadSource({
            token,
            documentPath: changedPath,
            revision: draftRevisionRef.current,
          })
          if (changedPath !== pathRef.current || raw === diskTextRef.current) return
          // uncommitted style pokes are edits too, even though the text still equals the saved text
          const dirtyNow =
            textRef.current !== savedTextRef.current ||
            Object.keys(pendingStylesRef.current).length > 0 ||
            !!panelRecoveryRef.current?.().dirty ||
            visualPendingRef.current ||
            savingRef.current
          if (dirtyNow) {
            diskTextRef.current = raw
            setDiskNotice('changed')
            awaitingUser = true
            return
          }
          if (!(await reloadFromDisk(changedPath))) {
            setDiskNotice('changed')
            awaitingUser = true
          }
        } catch (err) {
          console.error('[html] reload after external change failed:', err)
          if (changedPath === pathRef.current) {
            setDiskNotice('changed')
            awaitingUser = true
          }
        } finally {
          if (!awaitingUser) window.htmlApi.ackFileChangedOnDisk()
        }
      })()
    })
    const offExport = window.htmlApi.onExportRequest((format) => void runExport(format))
    // Shell menu Print / ⌘P. The menu owns the accelerator, so this subscription
    // is the only route the keystroke takes; without it ⌘P did nothing at all.
    const offPrint = window.htmlApi.onPrintRequest(() => void runPrint())
    const offTheme = window.htmlApi.onThemeChanged(() => {
      // let main.tsx flip data-theme first
      window.setTimeout(
        () => previewRef.current?.post({ type: 'gx:theme', dark: isDarkTheme() }),
        0,
      )
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void doSave(event.shiftKey ? 'saveAs' : 'save')
      } else if (key === '\\') {
        event.preventDefault()
        cycleView()
      } else if (key === 'f' && !event.shiftKey) {
        event.preventDefault()
        openFind(false)
      } else if (key === 'h' && !event.shiftKey) {
        // Word's replace shortcut: Ctrl+H on Windows/Linux, Control+H on macOS —
        // its ⌘H belongs to the system Hide role, so the menu keeps that key
        event.preventDefault()
        openFind(true)
      } else if (key === '=' || key === '+') {
        event.preventDefault()
        zoomIn()
      } else if (key === '-' || key === '_') {
        event.preventDefault()
        zoomOut()
      } else if (key === '0') {
        event.preventDefault()
        setZoom(100)
      } else if (key === 'b' || key === 'i') {
        if (inTextField(event.target)) return
        event.preventDefault()
        wrapSelectionRef.current(key === 'b' ? 'strong' : 'em')
      } else if (key === 'z' || (key === 'y' && !event.shiftKey)) {
        // CodeMirror and form fields keep their own history
        if (inTextField(event.target)) return
        event.preventDefault()
        if (key === 'z' && !event.shiftKey) editorRef.current?.undo()
        else editorRef.current?.redo()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      offSave()
      offReadText()
      offClose()
      offRenamed()
      offDisk()
      offExport()
      offPrint()
      offTheme()
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [
    doSave,
    runExport,
    runPrint,
    cycleView,
    zoomIn,
    zoomOut,
    flushPending,
    openFind,
    reloadFromDisk,
    readSaveLiveState,
  ])

  // pinch / ctrl+wheel over the stage chrome around the frame; wheel inside the frame arrives as gx:zoom
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      if (canvasModeRef.current === 'present') return
      if (!(event.target as HTMLElement | null)?.closest?.('.preview-stage')) return
      event.preventDefault()
      setZoom((z) => clampZoom(z - event.deltaY * 0.6))
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  // Crash recovery is independent of the reader's normal AutoSave preference.
  // Sequence/revision are captured before the asynchronous iframe request.
  const captureRecovery = useCallback(async () => {
    const token = draftTokenRef.current
    if (
      statusRef.current !== 'ready' ||
      !token ||
      draftSuppressedRef.current ||
      closeBarrierRef.current?.locked ||
      draftBusyRef.current ||
      composingRef.current ||
      savingRef.current
    )
      return
    const sourceEditor = editorRef.current?.recoveryState()
    if (sourceEditor?.composing || (sourceEditor && sourceEditor.text !== textRef.current)) return
    const panel = panelRecoveryRef.current?.()
    if (
      textRef.current === savedTextRef.current &&
      !panel?.dirty &&
      !visualPendingRef.current &&
      !Object.keys(pendingStylesRef.current).length
    )
      return
    const sequence = ++draftSequenceRef.current
    const revision = draftRevisionRef.current
    const activation = draftActivationRef.current
    const documentPath = pathRef.current
    const source = textRef.current
    const map = getMap()
    const sid = selectedSidRef.current
    const styles = { ...pendingStylesRef.current }
    draftBusyRef.current = true
    try {
      const frame = sourceOnlyCloseRef.current?{version:getMap().version,ops:[],composing:false,busy:false}:await previewRef.current?.readRecovery()
      if (!frame) throw new Error('The live preview is not ready for recovery.')
      if (
        closeBarrierRef.current?.locked ||
        frame.composing ||
        frame.busy ||
        !sourceOnlyCloseRef.current&&!frameVersionsRef.current.has(frame.version) ||
        composingRef.current
      )
        return
      if (
        activation !== draftActivationRef.current ||
        token !== draftTokenRef.current ||
        revision !== draftRevisionRef.current ||
        documentPath !== pathRef.current
      )
        return
      const panelOps: HtmlOp[] = []
      if (sid !== null) {
        if (panel?.text !== null && panel?.text !== undefined && selText.index >= 0)
          panelOps.push({ op: 'set_text_node', sid, index: selText.index, text: panel.text })
        if (panel?.alt !== null && panel?.alt !== undefined)
          panelOps.push({ op: 'set_attr', sid, name: 'alt', value: panel.alt })
      }
      if ((panel?.dirty && sid === null) || (Object.keys(styles).length && sid === null))
        throw new Error('Pending visual edits have no current element.')
      const entry = sid === null ? undefined : map.bySid.get(sid)
      const privateText = captureHtmlRecoveryText(
        source,
        map,
        [
          frame.ops,
          panelOps,
          sid !== null && Object.keys(styles).length ? [{ op: 'set_style', sid, styles }] : [],
        ],
        panel?.css && entry ? { path: entry.path, css: panel.css } : undefined,
      )
      const serialized = serializeDocText({ text: privateText, envelope: envelopeRef.current })
      const bytes = new TextEncoder().encode(serialized)
      if (bytes.byteLength > HTML_DRAFT_MAX_BYTES)
        throw new Error('The complete HTML draft exceeds 16 MiB.')
      const result = await window.htmlApi.writeDraft({
        token,
        sequence,
        revision,
        documentPath,
        data: bytes.buffer as ArrayBuffer,
      })
      if (
        activation !== draftActivationRef.current ||
        token !== draftTokenRef.current ||
        revision !== draftRevisionRef.current
      )
        return
      if (result.written) {
        setRecoveryError(null)
        setRecoveryRemoteCount(result.remoteReferences)
      }
    } catch (error) {
      if (
        activation === draftActivationRef.current &&
        token === draftTokenRef.current &&
        revision === draftRevisionRef.current
      )
        setRecoveryError(error instanceof Error ? error.message : String(error))
    } finally {
      draftBusyRef.current = false
    }
  }, [getMap, selText.index])
  const recoveryCaptureRef = useRef(captureRecovery)
  recoveryCaptureRef.current = captureRecovery
  useEffect(() => {
    const timer = window.setInterval(() => {
      void recoveryCaptureRef.current()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // autosave: every 30s and on window blur; untitled documents wait for an explicit first save
  useEffect(() => {
    if (!autoSave || !path) return
    const tick = () => {
      // a native Save As dialog blurs the window: autosave must not queue a write behind
      // a user-driven save, only explicit saves do
      if (closeBarrierRef.current?.locked || savingRef.current) return
      flushPending()
      if (textRef.current === savedTextRef.current) return
      void doSave('save',undefined,undefined,undefined,true)
    }
    const id = window.setInterval(tick, 30_000)
    window.addEventListener('blur', tick)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('blur', tick)
    }
  }, [autoSave, path, doSave, flushPending])

  const resumeLivePreview=(next:ViewMode='split')=>mutateHtml(()=>{sourceOnlyCloseRef.current=false;discardPreviewRef.current=false;setSourceOnlyClose(false);setPreviewRetired(false);setPreviewUrl(null);setView(next);pushedTextRef.current=null;pushPreview(textRef.current)})
  const useSourceOnlyForClose=()=>mutateHtml(()=>{
    // Explicitly approved visual discard; committed source and ordinary Save remain intact.
    pictureGenerationRef.current++;pictureActiveRef.current=false;setPictureDialog(null)
    discardPanelDraftsRef.current?.();pendingStylesRef.current={};if(styleTimerRef.current!==null)window.clearTimeout(styleTimerRef.current);styleTimerRef.current=null;setPendingCount(0);visualPendingRef.current=false;setVisualPending(false);setPanelPending(false);frameVersionsRef.current.clear();sourceOnlyCloseRef.current=true;setSourceOnlyClose(true);setView('source');touchDraft();setCloseError(null)
  })

  const aiDeps: HtmlAiDeps = {
    access: {
      getText: () => textRef.current,
      getVersion: () => versionRef.current,
      getMap,
      getLastManualVersion: () => lastManualVersionRef.current,
      getFilePath: () => pathRef.current,
      getSelectedSid: () => selectedSidRef.current,
      applyOps: (ops) => {
        flushPending()
        return applyOps(ops, false)
      },
      replaceAll: (html) => replaceAll(html, true),
    },
    getSnapshot: () => ({ text: textRef.current,source:htmlCloseStamp().source }),
    restoreSnapshot: (snapshot) => {if(snapshot.source&&snapshot.source!==htmlCloseStamp().source)throw new Error('The snapshot belongs to a replaced source.');replaceAll(snapshot.text,false)},
    onPrompt: (text) => {
      if (pathRef.current || provisionalNameRef.current) return
      const name = deriveNameFromPrompt(text)
      if (!name) return
      provisionalNameRef.current = name
      window.htmlApi.setProvisionalTitle(name)
    },
    onRunDone: (mutated) => {
      // AI wrote into a never-saved document: save it silently under the page's own title,
      // falling back to the name of the request that started it
      if (!mutated || pathRef.current) return
      const text = textRef.current
      const name = localFileName(text, provisionalNameRef.current)
      if (name) void doSave('save', name)
    },
    clearHighlights: () => editorRef.current?.clearHighlights(),
    onBriefConfirmed: (brief) => {
      briefRef.current = brief
    },
    previewDraft: setDraftHtml,
    navigateTo: (sid) => {
      const e = getMap().bySid.get(sid)
      if (!e) return
      selectSid(sid, { reveal: true })
    },
  }

  const statusText = useMemo(() => {
    if (saveState === 'saving') return t('saving')
    if (saveState === 'failed') return t('saveFailedStatus')
    if (dirty || pendingCount > 0 || panelPending || visualPending) return t('unsaved')
    if (saveState === 'saved') return t('savedOk')
    return ''
  }, [saveState, dirty, pendingCount, panelPending, visualPending, t])

  if (status === 'error') return <div className="center-note">{t('loadFailed')}</div>
  if (status === 'loading') return <div className="center-note">{t('loading')}</div>

  const hasElement = !!selectedEntry && !STRUCTURAL.has(selectedEntry.tag)
  const panelShown = panelOpen && selectedEntry?.sid !== panelDismissedSid

  /** stage geometry for the floating toolbar: frame coordinates scale with the CSS zoom and shift by the centred device host */
  const floatLayout = () => {
    void stageTick
    const stage = stageRef.current?.getBoundingClientRect()
    const host = stageRef.current?.querySelector('.preview-host')?.getBoundingClientRect()
    return {
      zoom,
      offsetX: stage && host ? host.left - stage.left : 0,
      offsetY: stage && host ? host.top - stage.top : 0,
      // the style panel floats over the right edge of the stage
      stageWidth: Math.max(0, (stage?.width ?? 0) - (panelShown && hasElement ? 280 : 0)),
      barWidth: barSize.w,
      barHeight: barSize.h,
    }
  }

  const findStrings: FindPanelStrings = {
    findPlaceholder: t('findPlaceholder'),
    replacePlaceholder: t('replacePlaceholder'),
    matchCase: t('matchCase'),
    wholeWord: t('wholeWord'),
    noResults: t('noResults'),
    prevMatch: t('prevMatch'),
    nextMatch: t('nextMatch'),
    closeEsc: t('closeEsc'),
    replace: t('replace'),
    replaceAll: t('replaceAll'),
  }

  return (
    <div
      className={`app${canvasMode === 'present' ? ` present${presentFull ? ' present-full' : ''}` : ''}`}
    >
      <Ribbon
        disabled={status !== 'ready'}
        dirty={dirty}
        onSave={() => void doSave('save')}
        onSaveAs={() => void doSave('saveAs')}
        onNameWithAi={() => void nameWithAi()}
        onFind={() => openFind(false)}
        canUndo={historyState.undo}
        canRedo={historyState.redo}
        onUndo={() => {
          editorRef.current?.undo()
          editorRef.current?.focus()
        }}
        onRedo={() => {
          editorRef.current?.redo()
          editorRef.current?.focus()
        }}
        autoSave={autoSave}
        onToggleAutoSave={setAutoSave}
        view={view}
        onView={next=>{if(next!=='source'&&(sourceOnlyCloseRef.current||discardPreviewRef.current))resumeLivePreview(next);else mutateHtml(()=>setView(next))}}
        aiOpen={aiOpen}
        onToggleAi={() => setAiOpen((v) => !v)}
        canInsert={canvasMode === 'edit'}
        onInsert={(kind, opts) => void insertElement(kind, opts)}
        onInsertSkeleton={insertSkeleton}
        canInsertSkeleton={canvasMode === 'edit' && isDocEmpty(textRef.current)}
        onAiPreset={(text) => {
          flushPending()
          setAiOpen(true)
          setAiPreset({ text, nonce: Date.now() })
        }}
        canvasMode={canvasMode}
        onPresent={startPresent}
      />

      <div className="app-main">
        <div
          className={`ai-dock${aiOpen ? '' : ' collapsed'}${
            !aiSidebarEnabled && !aiOpen ? ' ai-dock-off' : ''
          }`}
        >
          {!aiOpen && aiSidebarEnabled && (
            <button
              className="ai-rail"
              data-tip={t('aiOpenAssistant')}
              aria-label={t('aiOpenAssistant')}
              onClick={() => setAiOpen(true)}
            >
              <GensparkMark size={18} />
            </button>
          )}
          {/* stays mounted while collapsed: an in-flight run, its snapshots and the loop context survive */}
          <AiPanel
            deps={aiDeps}
            filePath={path}
            preset={aiPreset}
            editQueue={editQueue}
            onQueueEditInstruction={queueUpdate}
            onQueueRemove={queueRemove}
            onQueueClear={() => setEditQueue([])}
            onQueueFocus={queueFocus}
            onQueueConsume={queueConsume}
            onCollapse={() => setAiOpen(false)}
          />
        </div>
        <div className="app-content">
          {closeError&&<div className="disk-notice" role="alert"><span>{closeError}</span><button type="button" onClick={useSourceOnlyForClose}>Use source only and discard preview edits</button><button type="button" onClick={()=>void doSave('save')}>Save</button></div>}
          {(sourceOnlyClose||previewRetired)&&<div className="disk-notice" role="status"><span>Preview editing is paused. The source is kept.</span><button type="button" onClick={()=>resumeLivePreview()}>Resume preview</button></div>}
          {reloadCleanupError && (
            <div className="disk-notice" role="alert">
              <span>{t('recoveryFailed', { error: reloadCleanupError })}</span>
            </div>
          )}
          {recoveryError && (
            <div className="disk-notice" role="alert">
              <span>{t('recoveryFailed', { error: recoveryError })}</span>
              <button type="button" onClick={() => void captureRecovery()}>
                {t('recoveryRetry')}
              </button>
            </div>
          )}
          {recoveryRemoteCount > 0 && (
            <div className="disk-notice" role="status">
              <span>{t('recoveryRemote', { count: recoveryRemoteCount })}</span>
            </div>
          )}
          {saveWarning&&<div className="disk-notice" role="status"><span>{saveWarning}</span></div>}
          {saveError && (
            <div className="disk-notice vantage-save-error" role="alert">
              <span>{saveError}</span>
              <button
                type="button"
                onClick={() => void doSave('saveAs')}
                disabled={saveState === 'saving'}
              >
                {t('saveAs')}
              </button>
            </div>
          )}
          {diskNotice && (
            <div className="disk-notice" role="status">
              <span>{t(diskNotice === 'changed' ? 'diskChangedMsg' : 'diskConflictMsg')}</span>
              <button type="button" onClick={() => void reloadNow()}>
                {t('diskReload')}
              </button>
              <button type="button" onClick={diskNotice === 'changed' ? keepMine : overwriteNow}>
                {t(diskNotice === 'changed' ? 'diskKeepMine' : 'diskOverwrite')}
              </button>
            </div>
          )}
          {findTarget && (
            <FindPanel
              target={findTarget}
              strings={findStrings}
              onClose={closeFind}
              focusRequest={findFocus}
            />
          )}
          {view !== 'preview' && (
            <Breadcrumb
              text={text}
              map={getMap()}
              sid={selectedSid}
              state={selectedState}
              onSelect={(sid) => selectSid(sid, { reveal: true })}
            />
          )}
          <div className={`workspace view-${canvasMode === 'present' ? 'preview' : view}`}>
            <div className="pane pane-preview">
              <div
                className="preview-stage"
                ref={stageRef}
                data-device={device}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) selectSid(null)
                }}
              >
                {!sourceOnlyClose&&!previewRetired&&<PreviewFrame
                  ref={previewRef}
                  name={previewFrameNameRef.current}
                  url={previewUrl}
                  nonce={previewNonce}
                  zoom={zoom}
                  onMessage={onInspectorMessage}
                  onLoad={onPreviewLoad}
                  draft={draftHtml}
                />}
                {canvasMode === 'present' && (
                  <button
                    type="button"
                    className="present-exit"
                    onClick={() => setCanvasMode('edit')}
                  >
                    {t('presentExit')}
                  </button>
                )}
                {canvasMode === 'edit' &&
                  !dragging &&
                  hasElement &&
                  selectedEntry &&
                  selRect &&
                  selComputed && (
                    <FloatToolbar
                      barRef={barRef}
                      {...floatPosition(selRect, floatLayout())}
                      computed={selComputed}
                      pending={pendingStylesRef.current}
                      canEditText={selText.editable}
                      onStyle={previewStyle}
                      onEditText={() =>
                        previewRef.current?.post({
                          type: 'gx:beginTextEdit',
                          sid: selectedEntry.sid,
                        })
                      }
                      onReplaceImage={replaceImage}
                      onCropImage={() => void openPictureDialog('crop')}
                      onCutoutImage={() => void openPictureDialog('cutout')}
                      canAskAi={askTarget !== null}
                      onAskAi={askAi}
                      tag={selectedEntry.tag}
                      onMove={moveSelected}
                      onDuplicate={duplicateSelected}
                      onDelete={() =>
                        runManual([{ op: 'remove', sid: selectedEntry.sid }], 'clear')
                      }
                      panelOpen={panelShown}
                      onTogglePanel={() => {
                        if (panelShown) setPanelOpen(false)
                        else {
                          setPanelDismissedSid(null)
                          setPanelOpen(true)
                        }
                      }}
                    />
                  )}
                {canvasMode === 'edit' &&
                  hasElement &&
                  selectedEntry &&
                  selComputed &&
                  panelShown && (
                    <StylePanel
                      key={selectedEntry.sid}
                      tag={selectedEntry.tag}
                      computed={selComputed}
                      textRun={selText.run}
                      onStyle={previewStyle}
                      onText={setRunText}
                      onAttr={setAttr}
                      draftRef={flushDraftsRef}
                      recoveryRef={panelRecoveryRef}
                      discardDraftsRef={discardPanelDraftsRef}
                      recoveryCss={
                        recoveryUiRef.current?.path === selectedEntry.path
                          ? recoveryUiRef.current.css
                          : undefined
                      }
                      onDraftChange={() => {
                        touchDraft()
                        setPanelPending(panelRecoveryRef.current?.().dirty ?? false)
                      }}
                      onPendingChange={(value) => {
                        setPanelPending(value)
                        if (!value && !panelRecoveryRef.current?.().css)
                          recoveryUiRef.current = null
                      }}
                      onCustomCss={(css) => {
                        const decls = parseDeclarations(css)
                        if (Object.keys(decls).length) previewStyle(decls)
                      }}
                      pending={pendingCount > 0}
                      onRevert={revertStyles}
                      onClose={() => setPanelDismissedSid(selectedEntry.sid)}
                    />
                  )}
              </div>
            </div>
            <div className="pane pane-source">
              <SourceEditor
                ref={editorRef}
                className="source-editor"
                initialText={text}
                onChange={onEditorChange}
                onCursor={onCursor}
                onBeforeReplace={flushPending}
                onRedact={onRedactSelection}
              />
            </div>
          </div>

          <footer className="status-bar">
            <div className="status-left">
              {notice ? (
                <span className="status-item status-notice">{notice}</span>
              ) : (
                !path && <span className="status-item status-hint">{t('previewNeedsSave')}</span>
              )}
            </div>
            <div className="status-right">
              {statusText && (
                <span className={`status-save status-${saveState}`}>{statusText}</span>
              )}
              {view !== 'preview' && (
                <span className="status-item">
                  {t('cursorPos', { line: cursor.line, col: cursor.col })}
                </span>
              )}
              <span className="status-item">{t('charCount', { n: text.length })}</span>
              <Dropdown
                className="device-dd"
                value={device}
                ariaLabel={t('device')}
                tip={t('device')}
                options={DEVICES.map((d) => ({
                  value: d,
                  label: t(
                    d === 'desktop' ? 'devDesktop' : d === 'tablet' ? 'devTablet' : 'devPhone',
                  ),
                }))}
                onPick={setDevice}
              />
              <button
                type="button"
                className="zoom-btn"
                aria-label={t('zoomOut')}
                onClick={zoomOut}
                disabled={zoom <= MIN_ZOOM}
              >
                −
              </button>
              <input
                className="zoom-slider"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={ZOOM_STEP}
                value={Math.round(zoom)}
                aria-label={t('zoom')}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
              <button
                type="button"
                className="zoom-btn"
                aria-label={t('zoomIn')}
                onClick={zoomIn}
                disabled={zoom >= MAX_ZOOM}
              >
                +
              </button>
              <span className="zoom-value">{Math.round(zoom)}%</span>
            </div>
          </footer>
        </div>
      </div>
      {askTarget && askMode && canvasMode !== 'present' && (
        <AiAskPopover
          key={askMode.kind === 'edit' ? askMode.qid : 'new'}
          target={askTarget}
          mode={askMode}
          initialText={
            askMode.kind === 'edit'
              ? editQueue.find((q) => q.qid === askMode.qid)?.instruction
              : undefined
          }
          getAnchorRect={getAskAnchorRect}
          onSubmit={(instruction) =>
            askMode.kind === 'edit' ? queueUpdate(askMode.qid, instruction) : queueAdd(instruction)
          }
          onCancel={() => setAskMode(null)}
          onSendNow={askSendNow}
          onRemove={() => askMode.kind === 'edit' && queueRemove(askMode.qid)}
          queueFull={editQueue.length >= EDIT_QUEUE_MAX}
        />
      )}
      {redactDialog && (
        <RedactDialog
          seed={redactDialog.seed}
          onSubmit={confirmRedaction}
          onCancel={cancelRedaction}
        />
      )}
      {pictureDialog?.kind === 'cutout' && (
        <CutoutDialog
          labels={imageDialogLabels}
          image={pictureDialog.image}
          onApply={(png) => void applyPictureBytes(pictureDialog.sid, pictureDialog.src, png,pictureDialog.source,pictureDialog.generation)}
          onCancel={()=>mutateHtml(()=>{pictureGenerationRef.current++;pictureActiveRef.current=false;setPictureDialog(null)})}
        />
      )}
      {pictureDialog?.kind === 'crop' && (
        <CropDialog
          labels={imageDialogLabels}
          lang={lang}
          image={pictureDialog.image}
          onApply={(png) => void applyPictureBytes(pictureDialog.sid, pictureDialog.src, png,pictureDialog.source,pictureDialog.generation)}
          onCancel={()=>mutateHtml(()=>{pictureGenerationRef.current++;pictureActiveRef.current=false;setPictureDialog(null)})}
        />
      )}
    </div>
  )
}
