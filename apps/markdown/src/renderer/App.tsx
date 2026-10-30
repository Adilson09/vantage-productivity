import { CloseMutationBarrier } from '../../../../packages/electron-utils/src/renderer-close-barrier'
import { MarkdownCloseTransactionGuard } from './editor/close-lease-guard'
import { bindMarkdownCloseBarrier, beforeMarkdownMutation, flushMarkdownPendingSurfaces, hasMarkdownPendingSurface, installMarkdownCloseInputFence, markdownCloseStamp, mutateMarkdown, runMarkdownAsyncMutation } from './close-lease'
import {
  captureMarkdownSource,
  roundTripMarkdownEnabled,
  serializeMarkdownForSave,
  sameMarkdownEnvelope,
  type MarkdownSourceSnapshot,
} from './markdown/roundtripSerializer'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ImageViewer,
  aiPanelInitiallyOpen,
  rememberAiPanelOpen,
  useAutoSavePref,
  useAiSidebarEnabled,
} from '@vantage/ui'
import {
  pollUntilReady,
  runHeadlessRendererExport,
} from '@vantage/electron-utils/headless-export'
import { EditorContent, useEditor } from '@tiptap/react'
import { FindPanel, type FindFocusRequest, type FindPanelStrings } from '@vantage/ui'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { exportImages } from './export/imageExport'
import type { StringKey } from './i18n/locale'
import { countWords } from '../../../docs/src/renderer/word-count'
import { t as translate, useI18n } from './i18n/locale'
import {
  buildFrontmatterRaw,
  frontmatterInner,
  parseDocText,
  stripLegacyFencedDivs,
  type DocEnvelope,
} from './markdown/docText'
import { buildSourceMap, spliceMarkdown, type SourceMap } from './markdown/sourceSplice'
import { applySourceText } from './markdown/sourceView'
import { isSourceMode, textModeForPath, type TextMode } from '../shared/text-mode'
import { renameAction } from '../shared/rename-mode'
import { readSourceText, writeSourceText, type SourceTextFormat } from '../shared/source-text'
import { PlainTextEditor, type PlainTextEditorHandle } from './source/PlainTextEditor'
import { buildExtensions } from './editor/extensions'
import { tiptapFindTarget } from './editor/findTarget'
import { collectOutline, type OutlineItem } from './editor/outline'
import { buildSlashItems } from './editor/slashCommand'
import type { SlashController, SlashMenuState } from './editor/slashCommand'
import { wikiFragmentPosition, wikiTargetOf } from './editor/wikilink'
import type { WikiSuggestController, WikiSuggestState } from './editor/wikiSuggest'
import { dirOf, setImageBaseDir, VIEW_IMAGE_EVENT } from './editor/localImage'
import { Ribbon } from './components/Ribbon'
import { deriveAutoFileName } from './auto-file-name'
import { modelSaveAsName, proposedSaveName } from './file-naming'
import { saveMarkdownForClose } from './save-for-close'
import type { MarkdownTheme } from '../shared/markdown-theme'
import { ImageHostDialog } from './components/ImageHostDialog'
import { RedactMenu } from './components/RedactMenu'
import { OutlinePane } from './components/OutlinePane'
import { SourcePane } from './components/SourcePane'
import { SlashMenu, type SlashMenuHandle } from './components/SlashMenu'
import { WikiSuggestMenu, type WikiSuggestMenuHandle } from './components/WikiSuggestMenu'
import { BacklinksPane } from './components/BacklinksPane'
import { TagsPane } from './components/TagsPane'
import { GraphView } from './components/GraphView'
import { ToastHost } from './components/toast'
import { showToast } from './components/toast-bus'
import { TableMenu } from './components/TableMenu'
import { FrontmatterPanel } from './components/FrontmatterPanel'
import { AiAskPopover } from './components/AiAskPopover'
import { AiPanel, GensparkMark, type AiPreset, type MarkdownAiDeps } from './ai/AiPanel'
import { EDIT_QUEUE_MAX, selectionForAnchor, type EditQueueItem } from './ai/edit-queue'
import { addQueueAnchor, clearQueueAnchors, removeQueueAnchors } from './editor/aiQueueAnchors'
import { DOCX_MAX_IMAGE_PX, exportDocxBytes } from './export/docxExport'
import { decodeImageDataUrl, toDocxImage } from './export/exportImage'
import { buildPrintHtml } from './export/printHtml'
import { diagramSvgToPng, renderDiagram } from './editor/diagrams'
import type { DiagramLanguage } from './editor/diagrams'
import type { ExportFormat, SaveMode } from '../shared/ipc'
import { uiOp } from './editor/ops'

type LoadStatus = 'loading' | 'ready' | 'error'
type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

const MIN_ZOOM = 50
const MAX_ZOOM = 200
const ZOOM_STEP = 10
const SOURCE_APPLY_DEBOUNCE_MS = 150

const EMPTY_ENVELOPE: DocEnvelope = {
  frontmatter: '',
  body: '',
  eol: '\n',
  trailingNewline: true,
  bom: false,
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function imageSourcesFromEditor(editor: Editor): string[] {
  const sources: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image' && typeof node.attrs.src === 'string') {
      sources.push(node.attrs.src)
    }
  })
  return sources
}

function applyImageRewrites(
  editor: Editor,
  rewrites: ReadonlyArray<{ from: string; to: string }>,
): void {
  const bySource = new Map(rewrites.map(({ from, to }) => [from, to]))
  if (bySource.size === 0) return
  let transaction = editor.state.tr
  let changed = false
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image') return
    const replacement = bySource.get(String(node.attrs.src ?? ''))
    if (!replacement || replacement === node.attrs.src) return
    transaction = transaction.setNodeMarkup(pos, undefined, { ...node.attrs, src: replacement })
    changed = true
  })
  if (!changed) return
  transaction.setMeta('addToHistory', false).setMeta('uiOnly', true)
  editor.view.dispatch(transaction)
}

/** Measure a document image via the DOM (the editor already displays it) */
export { deriveAutoFileName } from './auto-file-name'

export default function App() {
  const { lang, t } = useI18n()
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [filePath, setFilePath] = useState<string | null>(null)
  // a .txt/.json has no block document behind it: it is edited as source so
  // that saving cannot reinterpret it as markdown
  const [textMode, setTextMode] = useState<TextMode>('markdown')
  const sourceRef = useRef<PlainTextEditorHandle | null>(null)
  const sourceTextRef = useRef('')
  const sourceFormatRef = useRef<SourceTextFormat>({ bom: false, eol: '\n', trailingNewline: true })
  const sourceMode = isSourceMode(textMode)
  // bumped on every CodeMirror doc change so the ribbon's undo/redo state re-renders
  const [sourceRev, setSourceRev] = useState(0)

  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  // Vantage Productivity: retain actionable storage errors and rescue paths for the reader.
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveWarning,setSaveWarning]=useState<string|null>(null)
  const exportingImagesRef = useRef(false)
  const [imageExportStatus, setImageExportStatus] = useState<{
    key: StringKey
    params?: Record<string, string | number>
  } | null>(null)
  const [slashState, setSlashState] = useState<SlashMenuState | null>(null)
  const [wikiSuggestState, setWikiSuggestState] = useState<WikiSuggestState | null>(null)
  const [fmOpen, setFmOpen] = useState(false)
  const [fmText, setFmText] = useState('')
  // Persisted so a closed AI panel stays closed on next launch (docs/slides parity)
  const [aiOpen, setAiOpen] = useState(() => aiPanelInitiallyOpen('mdapp.showAi'))
  // the sidebar switch is a soft hide; it closes the panel when it turns off
  const aiSidebarEnabled = useAiSidebarEnabled(setAiOpen)
  const [aiPreset, setAiPreset] = useState<AiPreset | null>(null)
  const [editQueue, setEditQueue] = useState<EditQueueItem[]>([])
  const editQueueRef = useRef(editQueue)
  editQueueRef.current = editQueue
  const queueSeqRef = useRef(0)
  const [autoSave, setAutoSave] = useAutoSavePref('mdapp.autoSave', window.markdownApi)
  const [showFind, setShowFind] = useState(false)
  const [findFocus, setFindFocus] = useState<FindFocusRequest>({ field: 'find', nonce: 0 })
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineWidth, setOutlineWidth] = useState(
    () => Number(localStorage.getItem('mdapp.outlineWidth')) || undefined,
  )
  const [backlinksOpen, setBacklinksOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [sourceViewOpen, setSourceViewOpen] = useState(false)
  const [sourceText, setSourceText] = useState('')
  const sourceViewOpenRef = useRef(false)
  const pendingSourceRef = useRef<string | null>(null)
  const sourceApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncSourceFromEditorRef = useRef<() => void>(() => {})
  const [spellcheck, setSpellcheck] = useState(
    () => localStorage.getItem('mdapp.spellcheck') !== '0',
  )
  // paper theme (markdown-themes.css scopes the palette on data-markdown-theme)
  const [mdTheme, setMdTheme] = useState<MarkdownTheme>('default')
  useEffect(() => {
    window.markdownApi
      .getMarkdownTheme?.()
      .then(setMdTheme)
      .catch(() => {})
  }, [])
  const pickMarkdownTheme = (theme: MarkdownTheme): void => {
    setMdTheme(theme)
    // the boot path sets this once; live picks re-scope it here
    if (theme === 'default') document.documentElement.removeAttribute('data-markdown-theme')
    else document.documentElement.setAttribute('data-markdown-theme', theme)
    window.markdownApi.setMarkdownTheme(theme).catch(() => {})
  }
  // off by default: it takes over the editor's right-click menu, and a reader
  // should opt into that rather than discover it
  const [redactEnabled, setRedactEnabled] = useState(
    () => localStorage.getItem('mdapp.redact') === '1',
  )
  const [viewImage, setViewImage] = useState<string | null>(null)
  useEffect(() => {
    const onEvent = (e: Event) => setViewImage((e as CustomEvent<{ src: string }>).detail.src)
    window.addEventListener(VIEW_IMAGE_EVENT, onEvent)
    const off = window.markdownApi.onViewImage((src) => setViewImage(src))
    return () => {
      window.removeEventListener(VIEW_IMAGE_EVENT, onEvent)
      off()
    }
  }, [])
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([])
  const [zoom, setZoom] = useState(100)

  const statusRef = useRef<LoadStatus>('loading')
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const sourceGenerationRef = useRef(0)
  const rendererInstanceRef = useRef(crypto.randomUUID())
  const closeAliveRef = useRef(true)
  const redactDialogGenerationRef=useRef(0)
  const [redactCloseEpoch,setRedactCloseEpoch]=useState(0)
  const renderedRedactGeneration=redactDialogGenerationRef.current
  const renderedRedactSource=rendererInstanceRef.current+':'+sourceGenerationRef.current
  const composingRef = useRef(false)
  const activeGestureRef = useRef(false)
  const [closeLocked, setCloseLocked] = useState(false)
  const publishCloseRef = useRef<() => void>(() => {})
  const closeBarrierRef = useRef<CloseMutationBarrier | null>(null)
  if (!closeBarrierRef.current) closeBarrierRef.current = new CloseMutationBarrier({
    source: () => rendererInstanceRef.current + ':' + sourceGenerationRef.current,
    claim: ticket => window.markdownApi.claimCloseLease(ticket),
    cancel: (ticket, reason) => window.markdownApi.cancelCloseLease(ticket, reason),
    report: error => showToast(error instanceof Error ? error.message : String(error), 'error'),
  })
  const activeSaveRequestRef = useRef<string | undefined>(undefined)
  const publicationSequenceRef = useRef(0)
  const [roundTripEnabled] = useState(roundTripMarkdownEnabled)
  const originalSourceRef = useRef<MarkdownSourceSnapshot | undefined>(undefined)
  const envelopeRef = useRef<DocEnvelope>(EMPTY_ENVELOPE)
  const editorRef = useRef<Editor | null>(null)
  // blocks of the text on disk paired with the editor's nodes; null until a
  // file is loaded or saved, and whenever the pairing could not be established
  const sourceMapRef = useRef<SourceMap | null>(null)
  /** the body a save writes: unchanged blocks verbatim from disk, edited runs re-serialized */
  const bodyMarkdown = (current: Editor): string => {
    const map = sourceMapRef.current
    return map ? spliceMarkdown(current, current.state.doc, map) : current.getMarkdown()
  }
  const filePathRef = useRef<string | null>(null)
  const publicationIdRef=useRef<string|null>(null)
  /** text last read from or written to disk; a watcher tick that reads the same text is a touch, not an edit */
  const diskTextRef = useRef<string | null>(null)
  const overwriteRef = useRef(false)
  const [diskNotice, setDiskNoticeState] = useState<'changed' | 'conflict' | null>(null)
  const diskNoticeRef = useRef<'changed' | 'conflict' | null>(null)
  const setDiskNotice = (next: 'changed' | 'conflict' | null) => {
    diskNoticeRef.current = next
    setDiskNoticeState(next)
  }
  const slashMenuRef = useRef<SlashMenuHandle>(null)
  const wikiSuggestMenuRef = useRef<WikiSuggestMenuHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const zoomOut = useCallback(
    () => setZoom((value) => Math.max(MIN_ZOOM, Math.round(value) - ZOOM_STEP)),
    [],
  )
  const zoomIn = useCallback(
    () => setZoom((value) => Math.min(MAX_ZOOM, Math.round(value) + ZOOM_STEP)),
    [],
  )

  publishCloseRef.current = () => {
    const barrier = closeBarrierRef.current!
    window.markdownApi.closeSourceState?.({
      stamp: barrier.snapshot(), path: filePathRef.current, ready: statusRef.current === 'ready',
      dirty: dirtyRef.current, pending: pendingSourceRef.current !== null || hasMarkdownPendingSurface() || !!document.querySelector('.redact-dialog') || activeGestureRef.current,
      busy: barrier.busy || savingRef.current,
      composing: composingRef.current || !!editorRef.current?.view.composing || !!sourceRef.current?.composing(),
    })
  }
  useEffect(() => {
    closeAliveRef.current = true
    const barrier = closeBarrierRef.current!
    const unbind = bindMarkdownCloseBarrier({barrier,publish:()=>publishCloseRef.current(),alive:()=>closeAliveRef.current})
    const inputFence = installMarkdownCloseInputFence(barrier)
    const release = window.markdownApi.onCloseLeaseRelease(ticket => barrier.release(ticket))
    const lock = barrier.registerLock(() => {
      setCloseLocked(true)
      const current = editorRef.current, editable = current?.isEditable ?? false
      current?.setEditable(false, false)
      const releaseSource = sourceRef.current?.lockForClose()
      const controls = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.source-textarea,.fm-textarea,.md-math-input,.redact-dialog-input')].map(element=>({element,readOnly:element.readOnly}))
      for (const control of controls) control.element.readOnly = true
      return () => { if (current && !current.isDestroyed) current.setEditable(editable,false); releaseSource?.(); for (const control of controls) if(control.element.isConnected)control.element.readOnly=control.readOnly; if(closeAliveRef.current)setCloseLocked(false) }
    })
    const compositionStart = () => { composingRef.current=true; publishCloseRef.current() }
    const compositionEnd = () => { composingRef.current=false; publishCloseRef.current() }
    const gestureStart = (event: Event) => { if ((event.target as Element | null)?.closest?.('.doc-page,.source-pane,.source-editor,.md-math-pop')) {activeGestureRef.current=true;publishCloseRef.current()} }
    const gestureEnd = () => { activeGestureRef.current=false;publishCloseRef.current() }
    document.addEventListener('compositionstart',compositionStart,true);document.addEventListener('compositionend',compositionEnd,true)
    document.addEventListener('pointerdown',gestureStart,true);document.addEventListener('pointerup',gestureEnd,true);document.addEventListener('pointercancel',gestureEnd,true)
    document.addEventListener('dragstart',gestureStart,true);document.addEventListener('dragend',gestureEnd,true)
    return () => { closeAliveRef.current=false;sourceGenerationRef.current++;const ticket=barrier.ticket;if(ticket)void window.markdownApi.cancelCloseLease(ticket,'Markdown source unmounted');inputFence();lock();release();unbind();document.removeEventListener('compositionstart',compositionStart,true);document.removeEventListener('compositionend',compositionEnd,true);document.removeEventListener('pointerdown',gestureStart,true);document.removeEventListener('pointerup',gestureEnd,true);document.removeEventListener('pointercancel',gestureEnd,true);document.removeEventListener('dragstart',gestureStart,true);document.removeEventListener('dragend',gestureEnd,true) }
  }, [])

  const markDirty = useCallback(() => {
    publishCloseRef.current()
    if (statusRef.current !== 'ready' || dirtyRef.current) return
    dirtyRef.current = true
    setDirty(true)
    setSaveState('idle')
    window.markdownApi.setDirty(true,markdownCloseStamp())
    publishCloseRef.current()
  }, [])

  const [imageHostOpen, setImageHostOpen] = useState(false)

  const insertImage = useCallback(() => {
    void runMarkdownAsyncMutation(async source => {
      const relPath = await window.markdownApi.pickImage(markdownCloseStamp())
      await beforeMarkdownMutation(source)
      const current = editorRef.current
      if (relPath && current) uiOp(current, { op: 'insertImage', after: 'selection', src: relPath })
    }).catch(error => showToast(String(error), 'error'))
  }, [])

  /**
   * Land on the heading a wiki link pointed at. The fragment waited in main
   * for this path — the shell activates an open tab without waking anything —
   * so it is taken here, once the note is actually on screen.
   */
  const jumpToWikiFragment = useCallback((path: string): void => {
    const current = editorRef.current
    if (!current) return
    // The browser test harness stubs markdownApi without the Electron-only
    // wiki channels; a missing API here means nothing to jump to, not a
    // failed load.
    if (typeof window.markdownApi.takeWikiFragment !== 'function') return
    void window.markdownApi.takeWikiFragment(path).then((fragment) => {
      if (!fragment || filePathRef.current !== path) return
      const pos = wikiFragmentPosition(current.state.doc, fragment)
      if (pos === null) return
      const selection = TextSelection.near(current.state.doc.resolve(pos))
      current.view.dispatch(current.state.tr.setSelection(selection).scrollIntoView())
      current.view.focus()
    })
  }, [])

  /**
   * Close an unresolved `[[link]]` the Obsidian way: create the note it names
   * and open it. Main decides where the file lands (beside this document, or
   * under the vault root when the target carries a directory) and never
   * overwrites; the answer carries the `#fragment`, so opening rides the same
   * path every resolved link takes and no document text has to change.
   */
  const createWikiNoteAndOpen = useCallback(
    (target: string): void => {
      // The browser test harness stubs markdownApi without the Electron-only
      // wiki channels; a missing API leaves the link as written.
      if (typeof window.markdownApi.createWikiNote !== 'function') return
      void window.markdownApi.createWikiNote({ target }).then((result) => {
        if (!result.ok) {
          showToast(translate('wikiLinkUnresolved', { target }), 'error')
          return
        }
        void window.markdownApi.rememberWikiFragment(result.path, result.fragment)
        void window.markdownApi.openSourcePath(result.path)
        // a link into the note already on screen opens no tab; jump here
        if (filePathRef.current === result.path) jumpToWikiFragment(result.path)
      })
    },
    [jumpToWikiFragment],
  )

  const extensions = useMemo(() => {
    const controller: SlashController = {
      onOpen: setSlashState,
      onUpdate: setSlashState,
      onKeyDown: (event) => slashMenuRef.current?.handleKey(event) ?? false,
      onClose: () => setSlashState(null),
    }
    const wikiSuggestController: WikiSuggestController = {
      onOpen: setWikiSuggestState,
      onUpdate: setWikiSuggestState,
      onKeyDown: (event) => wikiSuggestMenuRef.current?.handleKey(event) ?? false,
      onClose: () => setWikiSuggestState(null),
    }
    return [MarkdownCloseTransactionGuard, ...buildExtensions({
      slashController: controller,
      slashItems: () =>
        buildSlashItems({ insertImage: filePathRef.current ? insertImage : undefined }),
      wikiSuggestController,
      wikiLink: {
        getDocumentPath: () => filePathRef.current ?? '',
        onOpen: (path, fragment) => {
          void window.markdownApi.rememberWikiFragment(path, fragment)
          void window.markdownApi.openSourcePath(path)
          // a link into the note already on screen opens no tab; jump here
          if (filePathRef.current === path) jumpToWikiFragment(path)
        },
        // the module-level `t`, not the hook's: this memo holds the closure for
        // the life of the editor, and the hook's `t` is a new function each render
        onUnresolved: (target, embed) => {
          // an embed of a missing file usually names a picture, which an empty
          // note cannot stand in for; only a link creates its note
          if (embed) {
            showToast(translate('wikiLinkUnresolved', { target }), 'error')
            return
          }
          createWikiNoteAndOpen(wikiTargetOf(target))
        },
      },
      blockLink: {
        getDocumentPath: () => filePathRef.current ?? '',
        onCopied: (link) => showToast(translate('blockLinkCopied', { link })),
        onNothing: () => showToast(translate('blockLinkNone'), 'error'),
      },
    })]
  }, [createWikiNoteAndOpen, insertImage, jumpToWikiFragment])

  // status-bar text statistics: Word's CJK counting rule (asian chars count
  // one by one, non-asian words by whitespace) shared with the docs status bar
  const [docStats, setDocStats] = useState<{ words: number; chars: number } | null>(null)
  const statsOf = (text: string) => ({
    words: countWords(text),
    chars: Array.from(text).length,
  })

  const editor = useEditor({
    extensions,
    content: '',
    autofocus: true,
    editorProps: { attributes: { class: 'doc-editor', spellcheck: String(spellcheck) } },
    // uiOnly transactions (toggle fold state) never reach the file — not dirty
    onUpdate: ({ editor: updated, transaction }) => {
      if (!transaction.getMeta('uiOnly')) markDirty()
      setOutlineItems(collectOutline(updated))
      setDocStats(statsOf(updated.getText()))
      syncSourceFromEditorRef.current()
      publishCloseRef.current()
    },
  })
  editorRef.current = editor

  useEffect(() => {
    localStorage.setItem('mdapp.spellcheck', spellcheck ? '1' : '0')
    editor?.setOptions({
      editorProps: { attributes: { class: 'doc-editor', spellcheck: String(spellcheck) } },
    })
  }, [editor, spellcheck])

  useEffect(() => {
    if (outlineWidth) localStorage.setItem('mdapp.outlineWidth', String(outlineWidth))
  }, [outlineWidth])
  const tiptapTarget = useMemo(() => (editor ? tiptapFindTarget(editor) : null), [editor])
  // source mode searches the buffer the user is actually looking at
  const findTarget = sourceMode ? (sourceRef.current?.findTarget() ?? null) : tiptapTarget

  useEffect(() => {
    setImageBaseDir(filePath ? dirOf(filePath) : null)
  }, [filePath])

  /**
   * Read `path` and put it on the surface its extension calls for. Shared by
   * the initial load and by a rename that crossed surfaces, so a file cannot
   * end up on one surface because of the path it happened to be renamed to.
   */
  const loadFromPath = useCallback(
    (path: string, raw: string, publicationId?:string) => {
      mutateMarkdown(() => {
      const commitPublication=()=>{publicationIdRef.current=publicationId??null;publishCloseRef.current();if(publicationId)window.markdownApi.publicationLoaded({publicationId,path,stamp:markdownCloseStamp()})}
      filePathRef.current = path
      sourceGenerationRef.current++
      diskTextRef.current = raw
      overwriteRef.current = false
      setDiskNotice(null)
      const mode = textModeForPath(path)
      setTextMode(mode)
      if (sourceApplyTimerRef.current) clearTimeout(sourceApplyTimerRef.current)
      sourceApplyTimerRef.current = null
      pendingSourceRef.current = null
      setSourceViewOpen(false)
      if (isSourceMode(mode)) {
        // source files keep their own bytes; the block editor never sees them
        const { text, format } = readSourceText(raw)
        sourceTextRef.current = text
        sourceFormatRef.current = format
        setDocStats(statsOf(text))
        setFilePath(path)
        setFmText('')
        setFmOpen(false)
        setOutlineItems([])
        commitPublication()
        return
      }
      const envelope = parseDocText(raw)
      envelopeRef.current = envelope
      setImageBaseDir(dirOf(path))
      // the initial load must not be undoable — Cmd+Z right after opening
      // would otherwise blank the document (and Cmd+S overwrite the file)
      const body = stripLegacyFencedDivs(envelope.body)
      editor
        ?.chain()
        .setMeta('addToHistory', false)
        .setContent(body, { contentType: 'markdown' })
        .setTextSelection(1)
        .run()
      if (editor) {
        sourceMapRef.current = buildSourceMap(editor, editor.state.doc, body)
        // Exact source is safe for a provably unchanged document even when
        // edited-document experimental round trips remain disabled.
        originalSourceRef.current = captureMarkdownSource(raw, envelope, editor.state.doc)
      }
      setFilePath(path)
      const inner = frontmatterInner(envelope.frontmatter)
      setFmText(inner)
      setFmOpen(inner !== '')
      commitPublication()
      })
    },
    [editor, roundTripEnabled],
  )

  useEffect(() => {
    if (!editor) return
    let cancelled = false
    void (async () => {
      try {
        const path = await window.markdownApi.consumePending()
        if (cancelled) return
        if (path) {
          const loaded=await window.markdownApi.readPublication(path),raw=loaded.text
          if (cancelled) return
          loadFromPath(path, raw, loaded.publicationId)
          jumpToWikiFragment(path)
        } else {
          envelopeRef.current = { ...EMPTY_ENVELOPE }
        }
        statusRef.current = 'ready'
        setStatus('ready')
        publishCloseRef.current()
      } catch (err) {
        console.error('[markdown] load failed:', err)
        if (!cancelled) {
          statusRef.current = 'error'
          setStatus('error')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editor, roundTripEnabled, loadFromPath, jumpToWikiFragment])

  const onFrontmatterChange = useCallback(
    (inner: string) => {
      mutateMarkdown(() => {
      setFmText(inner)
      envelopeRef.current.frontmatter = buildFrontmatterRaw(inner)
      markDirty()
      })
    },
    [markDirty],
  )

  /**
   * Write a source-mode file. The text goes to disk exactly as the editor
   * holds it, with the file's own BOM and line endings restored — no markdown
   * serialization, no image extraction, no trailing-newline fixups.
   */
  const doSaveSource = useCallback(async (mode: SaveMode, automatic=false): Promise<boolean> => {
    if (statusRef.current !== 'ready' || savingRef.current) return false
    if (diskNoticeRef.current && !overwriteRef.current) {
      // the user has not chosen between the two versions yet; autosave must not pick for them
      setDiskNotice('conflict')
      return false
    }
    savingRef.current = true
    setSaveState('saving')
    const textAtSave = sourceTextRef.current
    const sourceAtSave=markdownCloseStamp().source
    try {
      const written = writeSourceText(textAtSave, sourceFormatRef.current)
      const result = await window.markdownApi.save({
        publicationId:publicationIdRef.current,
        automatic,
        text: written,
        imageSources: [],
        mode,
        overwrite: overwriteRef.current,
        requestId: activeSaveRequestRef.current, closeSource: markdownCloseStamp(),
      })
      if (result.ok && 'path' in result) {
        publicationSequenceRef.current++
        if(markdownCloseStamp().source!==sourceAtSave)return true
        if(result.publicationId)publicationIdRef.current=result.publicationId
        setSaveWarning(result.warnings?.join(' ')??null)
        setSaveError(null)
        diskTextRef.current = written
        overwriteRef.current = false
        setDiskNotice(null)
        // an edit that landed mid-write is still unsaved
        const unchanged = sourceTextRef.current === textAtSave && !composingRef.current && !sourceRef.current?.composing()
        filePathRef.current=result.path
        setFilePath(result.path)
        if (unchanged) {
          dirtyRef.current = false
          setDirty(false)
          window.markdownApi.setDirty(false,markdownCloseStamp())
          setSaveState('saved')
        } else {
          dirtyRef.current = true
          setDirty(true)
          window.markdownApi.setDirty(true,markdownCloseStamp())
          setSaveState('idle')
        }
        return true
      }
      if(markdownCloseStamp().source!==sourceAtSave)return false
      setSaveWarning(result.warnings?.join(' ')??null)
      if (!result.ok && result.conflict) setDiskNotice('conflict')
      if (!result.ok && !result.conflict) setSaveError(result.error)
      setSaveState(result.ok ? 'idle' : 'failed')
      return false
    } catch (err) {
      console.error('[markdown] save failed:', err)
      if(markdownCloseStamp().source!==sourceAtSave)return false
      setSaveError(err instanceof Error ? err.message : String(err))
      setSaveState('failed')
      return false
    } finally {
      savingRef.current = false
      publishCloseRef.current()
    }
  }, [])

  /** The exact text a save would write right now; null before the document is ready. */
  const currentFileText = useCallback((): string | null => {
    const current = editorRef.current
    if (!current || statusRef.current !== 'ready') return null
    return serializeMarkdownForSave(
      envelopeRef.current,
      current.state.doc,
      () => bodyMarkdown(current),
      { original: originalSourceRef.current, clean: !dirtyRef.current, experimental: roundTripEnabled },
    )
  }, [roundTripEnabled])

  const openSource = useCallback(() => {
    const text = currentFileText()
    if (text === null) return
    setSourceText(text)
    // the Find panel drives a selection in the canvas the user can no longer see
    setShowFind(false)
    setSourceViewOpen(true)
  }, [currentFileText])

  /** Push the pane's pending text into the editor now (the keystroke path is debounced). */
  const flushSource = useCallback(() => {
    if (sourceApplyTimerRef.current) clearTimeout(sourceApplyTimerRef.current)
    sourceApplyTimerRef.current = null
    const text = pendingSourceRef.current
    if (text === null) return
    mutateMarkdown(() => {
    pendingSourceRef.current = null
    const current = editorRef.current
    if (!current || statusRef.current !== 'ready') return
    const hadFrontmatter = envelopeRef.current.frontmatter !== ''
    const applied = applySourceText(current, text)
    envelopeRef.current = applied.envelope
    sourceMapRef.current = applied.sourceMap
    // Source text can change syntax absent from the visual projection. An old
    // model fingerprint must never resurrect the pre-edit raw source.
    originalSourceRef.current = undefined
    const inner = frontmatterInner(applied.envelope.frontmatter)
    setFmText(inner)
    // surface a frontmatter block that just appeared, but leave a panel the
    // user closed on purpose closed
    if (inner && !hadFrontmatter) setFmOpen(true)
    })
  }, [])

  const closeSource = useCallback(() => {
    flushSource()
    setSourceViewOpen(false)
  }, [flushSource])

  const toggleSource = useCallback(() => {
    if (sourceViewOpenRef.current) closeSource()
    else openSource()
  }, [closeSource, openSource])

  // A keystroke is re-parsed into the editor rather than saved, so save,
  // autosave, the AI tools and the outline keep reading one document. The
  // re-parse is debounced; the pane itself updates immediately.
  const onSourceChange = useCallback(
    (text: string) => {
      mutateMarkdown(() => {
      setSourceText(text)
      pendingSourceRef.current = text
      setDocStats(statsOf(text))
      markDirty()
      if (sourceApplyTimerRef.current) clearTimeout(sourceApplyTimerRef.current)
      sourceApplyTimerRef.current = setTimeout(flushSource, SOURCE_APPLY_DEBOUNCE_MS)
      })
    },
    [flushSource, markDirty],
  )

  const onSourceFocusChange = useCallback(() => {
    flushSource()
    const text = currentFileText()
    if (text !== null) setSourceText(text)
  }, [currentFileText, flushSource])

  // An AI run or external reload landing while the pane is open must show up
  // there; while the textarea is focused the user's own half-typed text wins.
  syncSourceFromEditorRef.current = () => {
    if (!sourceViewOpenRef.current || pendingSourceRef.current !== null) return
    if (document.activeElement?.classList.contains('source-textarea')) return
    const text = currentFileText()
    if (text !== null) setSourceText(text)
  }

  useEffect(() => {
    sourceViewOpenRef.current = sourceViewOpen
  }, [sourceViewOpen])

  useEffect(() => () => clearTimeout(sourceApplyTimerRef.current ?? undefined), [])

  /** Serialize and write to disk; false when canceled/failed (caller keeps the tab open) */
  const doSaveImpl = useCallback(
    async (mode: SaveMode, suggestedName?: string, proposedName?: string, automatic=false): Promise<boolean> => {
      if(automatic&&closeBarrierRef.current?.locked)return false
      if (sourceMode) return doSaveSource(mode,automatic)
      flushSource()
      const current = editorRef.current
      if (!current || statusRef.current !== 'ready' || savingRef.current) return false
      if (diskNoticeRef.current && !overwriteRef.current) {
        setDiskNotice('conflict')
        return false
      }
      savingRef.current = true
      setSaveState('saving')
      const activationAtSave=markdownCloseStamp().source
      try {
        // edits landing while the write is in flight (AI streaming, fast typing)
        // must keep the document dirty — compare doc identity after the await
        const docAtSave = current.state.doc
        const envelopeAtSave = { ...envelopeRef.current }
        const sourceAtSave = originalSourceRef.current
        let body: string | undefined
        const text = serializeMarkdownForSave(
          envelopeRef.current,
          current.state.doc,
          () => (body = bodyMarkdown(current)),
          { original: sourceAtSave, clean: !dirtyRef.current, experimental: roundTripEnabled },
        )
        const imageSources = imageSourcesFromEditor(current)
        // A never-saved document is offered a name derived from its own
        // content: its first heading, else its first words. It prefills the
        // save dialog rather than replacing it — the reader still chooses where
        // the file goes, and a save never waits on a model. A name the caller
        // proposed outright (the ribbon's "Name with AI") wins over both.
        const defaultName = await proposedSaveName(current, {
          filePath: filePathRef.current,
          suggestedName,
          proposedName,
        })
        await beforeMarkdownMutation(activationAtSave)
        const result = await window.markdownApi.save({
        publicationId:publicationIdRef.current,
        automatic,
          requestId: activeSaveRequestRef.current, closeSource: markdownCloseStamp(),
          text,
          imageSources,
          mode,
          suggestedName,
          overwrite: overwriteRef.current,
          ...(defaultName ? { defaultName } : {}),
        })
        if (result.ok && 'path' in result) {
          publicationSequenceRef.current++
          if(markdownCloseStamp().source!==activationAtSave)return true
          if(result.publicationId)publicationIdRef.current=result.publicationId
          setSaveWarning(result.warnings?.join(' ')??null)
          setSaveError(null)
          diskTextRef.current = result.writtenText ?? text
          overwriteRef.current = false
          setDiskNotice(null)
          const unchanged =
            editorRef.current?.state.doc === docAtSave &&
            sameMarkdownEnvelope(envelopeRef.current, envelopeAtSave) &&
            pendingSourceRef.current===null && !hasMarkdownPendingSurface() && !composingRef.current && !editorRef.current?.view.composing
          // Save As can rewrite sources absent from the visual projection (e.g. HTML).
          // Never reuse a snapshot containing paths from the previous location.
          if (result.imageRewrites?.length) originalSourceRef.current = undefined
          if (result.imageRewrites?.length && editorRef.current) {
            applyImageRewrites(editorRef.current, result.imageRewrites)
          }
          // the next save splices against what is now on disk: after image
          // rewrites that is writtenText paired with the rewritten document
          if (result.writtenText === undefined) {
            sourceMapRef.current = buildSourceMap(
              current,
              docAtSave,
              body ?? stripLegacyFencedDivs(parseDocText(text).body),
            )
          } else {
            sourceMapRef.current =
              unchanged && editorRef.current
                ? buildSourceMap(
                    editorRef.current,
                    editorRef.current.state.doc,
                    stripLegacyFencedDivs(parseDocText(result.writtenText).body),
                  )
                : null
          }
          if (unchanged && editorRef.current) {
            originalSourceRef.current = captureMarkdownSource(
              result.writtenText ?? text,
              envelopeRef.current,
              editorRef.current.state.doc,
            )
          }
          setImageBaseDir(dirOf(result.path))
          filePathRef.current=result.path
          setFilePath(result.path)
          if (unchanged) {
            dirtyRef.current = false
            setDirty(false)
            window.markdownApi.setDirty(false,markdownCloseStamp())
            setSaveState('saved')
          } else {
            // the main process cleared its dirty flag on write — re-assert it
            dirtyRef.current = true
            setDirty(true)
            window.markdownApi.setDirty(true,markdownCloseStamp())
            setSaveState('idle')
          }
          return true
        }
        if(markdownCloseStamp().source!==activationAtSave)return false
        setSaveWarning(result.warnings?.join(' ')??null)
        if (!result.ok && result.conflict) setDiskNotice('conflict')
        if (!result.ok && !result.conflict) setSaveError(result.error)
        setSaveState(result.ok ? 'idle' : 'failed')
        return false
      } catch (err) {
        console.error('[markdown] save failed:', err)
        if(markdownCloseStamp().source!==activationAtSave)return false
        setSaveError(err instanceof Error ? err.message : String(err))
        setSaveState('failed')
        return false
      } finally {
        savingRef.current = false
        publishCloseRef.current()
      }
    },
    [flushSource, sourceMode, doSaveSource, roundTripEnabled],
  )

  const doSave=useCallback((mode:SaveMode,suggestedName?:string,proposedName?:string,automatic=false):Promise<boolean>=>automatic&&closeBarrierRef.current?.locked?Promise.resolve(false):runMarkdownAsyncMutation(async()=>automatic&&closeBarrierRef.current?.locked?false:doSaveImpl(mode,suggestedName,proposedName,automatic)),[doSaveImpl])

  /** another program wrote the file: swap the text in, keep caret and scroll, leave undo history alone */
  const reloadFromDisk = useCallback(
    (path: string, raw: string, publicationId?:string) => {
      mutateMarkdown(()=>{
      const current = editorRef.current
      const caret = current?.state.selection.from ?? 1
      const scrollTop = scrollRef.current?.scrollTop ?? 0
      // loadFromPath replaces the content; with the status parked the resulting update is not an edit
      statusRef.current = 'loading'
      try {
        loadFromPath(path, raw, publicationId)
        if (isSourceMode(textModeForPath(path))) sourceRef.current?.setDoc(readSourceText(raw).text)
      } finally {
        statusRef.current = 'ready'
      }
      if (current && !isSourceMode(textModeForPath(path))) {
        current
          .chain()
          .setMeta('addToHistory', false)
          .setMeta('uiOnly', true)
          .setTextSelection(Math.min(caret, current.state.doc.content.size))
          .run()
      }
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollTop
      })
      dirtyRef.current = false
      setDirty(false)
      window.markdownApi.setDirty(false,markdownCloseStamp())
      setSaveState('idle')
      setSaveError(null)
      })
    },
    [loadFromPath],
  )

  const reloadNow = useCallback(() => runMarkdownAsyncMutation(async source => {
    const path = filePathRef.current
    if (!path) return
    try {
      window.markdownApi.ackFileChangedOnDisk()
      const loaded=await window.markdownApi.readPublication(path),raw=loaded.text
      await beforeMarkdownMutation(source)
      reloadFromDisk(path,raw,loaded.publicationId)
    } catch (err) {
      console.error('[markdown] reload from disk failed:', err)
    }
  }), [reloadFromDisk])

  const keepMine = useCallback(() => {
    overwriteRef.current = true
    setDiskNotice(null)
    window.markdownApi.ackFileChangedOnDisk()
  }, [])

  const overwriteNow = useCallback(() => {
    overwriteRef.current = true
    setDiskNotice(null)
    void doSave('save')
  }, [doSave])

  /**
   * Ask the model to name this document, on request, then open Save As with its
   * answer prefilled.
   *
   * The stem goes into the dialog rather than renaming the file on disk: a file
   * that may be open elsewhere, referenced from a note, or synced is not
   * something to move behind the reader's back. A declined or empty answer
   * leaves the dialog on the document's current name, so this is a no-op
   * rather than a failure.
   */
  const nameWithAi = useCallback(async () => {
    const current = editorRef.current
    if (!current || statusRef.current !== 'ready' || savingRef.current) return
    const stem = await modelSaveAsName(current)
    if (!stem) return
    await doSave('saveAs', undefined, stem)
  }, [doSave])

  /** `outPath` (headless export only) skips the save dialog; resolves true when a file was written. */
  const runExport = useCallback(
    async (format: ExportFormat, outPath?: string) => {
      // a source file has no rendered document to export
      if (sourceMode) return false
      const current = editorRef.current
      if (!current || statusRef.current !== 'ready') return false
      const suggestedName =
        (filePathRef.current
          ? filePathRef.current.replace(/^.*[/\\]/, '').replace(/\.(md|markdown)$/i, '')
          : deriveAutoFileName(current)) || 'Untitled'
      if (format === 'png') {
        if (exportingImagesRef.current) return false
        exportingImagesRef.current = true
        setImageExportStatus({ key: 'appExportingImages' })
        try {
          await document.fonts.ready
          await Promise.all(
            [
              ...current.view.dom.querySelectorAll<HTMLImageElement>(
                'img[src]:not(.ProseMirror-separator)',
              ),
            ].map((image) => image.decode().catch(() => {})),
          )
          const result = await exportImages(
            buildPrintHtml(current.view.dom, suggestedName),
            suggestedName,
            (count) => setImageExportStatus({ key: 'appExportImagesProgress', params: { count } }),
          )
          if (!result.ok) throw new Error(result.error)
          if ('canceled' in result) {
            setImageExportStatus(null)
            return false
          }
          setImageExportStatus({
            key: 'appExportImagesDone',
            params: { count: result.count ?? 0, dir: result.path },
          })
          return true
        } catch (err) {
          setImageExportStatus({
            key: 'appExportImagesFailed',
            params: { error: err instanceof Error ? err.message : String(err) },
          })
          return false
        } finally {
          exportingImagesRef.current = false
        }
      }
      try {
        if (format === 'pdf') {
          const html = buildPrintHtml(current.view.dom, suggestedName)
          const result = await window.markdownApi.exportPdf({
            html,
            suggestedName,
            ...(outPath ? { outPath } : {}),
          })
          if (!result.ok) {
            console.error('[markdown] pdf export failed:', result.error)
            showToast(result.error, 'error')
          }
          return result.ok && !('canceled' in result)
        }
        const loadImage = async (src: string) => {
          const data = decodeImageDataUrl(src) ?? (await window.markdownApi.readImage(src))
          return data ? toDocxImage(data, DOCX_MAX_IMAGE_PX) : null
        }
        const rasterizeDiagram = async (source: string, language: DiagramLanguage) => {
          const result = await renderDiagram(language, source)
          return result.ok ? diagramSvgToPng(result.svg, DOCX_MAX_IMAGE_PX) : null
        }
        const bytes = await exportDocxBytes(current.getJSON(), loadImage, rasterizeDiagram)
        const result = await window.markdownApi.exportDocx({
          base64: bytesToBase64(bytes),
          suggestedName,
          mode: format === 'docs' ? 'openInDocs' : 'dialog',
        })
        if (!result.ok) {
          console.error('[markdown] docx export failed:', result.error)
          showToast(result.error, 'error')
        }
        return result.ok && !('canceled' in result)
      } catch (err) {
        console.error('[markdown] export failed:', err)
        showToast(err instanceof Error ? err.message : String(err), 'error')
        return false
      }
    },
    [sourceMode],
  )

  // Headless export mode (--headless-export): this renderer lives in a hidden
  // window whose only job is to run the File menu's PDF export against a path
  // the CLI chose, then report back so the main process can quit.
  const headlessExportStartedRef = useRef(false)
  useEffect(() => {
    if (headlessExportStartedRef.current) return
    headlessExportStartedRef.current = true
    void (async () => {
      const outPath = await window.markdownApi.consumeHeadlessExport()
      if (!outPath) return
      const report = await runHeadlessRendererExport(
        outPath,
        () =>
          pollUntilReady(() => {
            if (statusRef.current === 'error') throw new Error('the input document did not open')
            return statusRef.current === 'ready'
          }, 'no document opened'),
        (target) => runExport('pdf', target),
      )
      window.markdownApi.headlessExportDone(report)
    })()
  }, [runExport])

  /**
   * Print through the same self-contained HTML the PDF export uses, loaded into a
   * hidden same-session iframe (md-asset:// images keep resolving) — printing the
   * live page would drag the ribbon/panels along, and Electron has no built-in
   * preview to crop them out.
   */
  const sourceHistory = useMemo(
    () => ({
      canUndo: sourceRef.current?.canUndo() ?? false,
      canRedo: sourceRef.current?.canRedo() ?? false,
      undo: () => {
        sourceRef.current?.undo()
        sourceRef.current?.focus()
      },
      redo: () => {
        sourceRef.current?.redo()
        sourceRef.current?.focus()
      },
    }),
    // sourceRev is the change signal; the ref itself is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceRev, sourceMode],
  )

  const printingRef = useRef(false)
  const printDoc = useCallback(async () => {
    const current = editorRef.current
    if (!current || statusRef.current !== 'ready' || printingRef.current) return
    printingRef.current = true
    const title =
      (filePathRef.current
        ? filePathRef.current.replace(/^.*[/\\]/, '').replace(/\.(md|markdown|txt|json)$/i, '')
        : deriveAutoFileName(current)) || 'Untitled'
    let printRoot: HTMLElement = current.view.dom
    if (sourceMode) {
      printRoot = document.createElement('div')
      const pre = document.createElement('pre')
      pre.textContent = sourceTextRef.current
      printRoot.appendChild(pre)
    }
    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.right = '100%'
    frame.style.bottom = '100%'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    try {
      await new Promise<void>((resolve) => {
        frame.onload = () => resolve()
        frame.srcdoc = buildPrintHtml(printRoot, title)
        document.body.appendChild(frame)
      })
      const fdoc = frame.contentDocument
      const fwin = frame.contentWindow
      if (!fdoc || !fwin) return
      // the export path passes printToPDF margins instead; the dialog needs @page
      const pageStyle = fdoc.createElement('style')
      pageStyle.textContent = '@page { margin: 0.6in; }'
      fdoc.head.appendChild(pageStyle)
      await Promise.all([...fdoc.images].map((img) => img.decode().catch(() => {})))
      // resolve on afterprint so the frame survives until the dialog closes (cancel included)
      await new Promise<void>((resolve) => {
        fwin.addEventListener('afterprint', () => resolve())
        fwin.print()
      })
    } catch (err) {
      console.error('[markdown] print failed:', err)
    } finally {
      frame.remove()
      printingRef.current = false
    }
  }, [sourceMode])

  useEffect(() => {
    const offExport = window.markdownApi.onExportRequest((format) => void runExport(format))
    const offPrint = window.markdownApi.onPrintRequest(() => void printDoc())
    return () => {
      offExport()
      offPrint()
    }
  }, [runExport, printDoc])

  const openFind = useCallback((replace: boolean) => {
    if (statusRef.current !== 'ready') return
    setShowFind(true)
    setFindFocus((f) => ({ field: replace ? 'replace' : 'find', nonce: f.nonce + 1 }))
  }, [])

  useEffect(() => {
    const offSave=window.markdownApi.onSaveRequest((mode,request)=>{
      const generation=markdownCloseStamp().source,barrier=closeBarrierRef.current!
      const requestedSource=request.sourcePath===filePathRef.current
      const isCurrent=()=>requestedSource&&markdownCloseStamp().source===generation&&closeAliveRef.current&&statusRef.current==='ready'
      const settled=()=>!savingRef.current&&!barrier.busy&&!composingRef.current&&!editorRef.current?.view.composing&&!sourceRef.current?.composing()&&!activeGestureRef.current
      const canClose=()=>isCurrent()&&settled()&&!dirtyRef.current&&pendingSourceRef.current===null&&!hasMarkdownPendingSurface()&&!document.querySelector('.redact-dialog')
      const flushPending=()=>{const pending=pendingSourceRef.current!==null;if(pending&&hasMarkdownPendingSurface())throw new Error('Apply the pending source or math edit before closing; both editing surfaces have changes.');if(!flushMarkdownPendingSurfaces())throw new Error('Finish the pending math edit before closing.');flushSource();if(pending)markDirty()}
      const beforePublication=publicationSequenceRef.current
      let held:import('../shared/markdown-close-lease').MarkdownCloseLease|undefined
      void(async()=>{
        const deadline=Date.now()+110000
        if(request.requireClean&&(!request.closeLease||!await window.markdownApi.claimCloseLease(request.closeLease)))throw new Error('The close request expired before preparation.')
        while(!settled()){if(!isCurrent()||Date.now()>=deadline)throw new Error('Pending input or an asynchronous writer is still active.');await new Promise(resolve=>setTimeout(resolve,50))}
        if(!isCurrent())return false
        activeSaveRequestRef.current=request.requestId
        try{
          if(request.intent==='discard'){
            const stamp=markdownCloseStamp();if(!request.approved||stamp.source!==request.approved.source||stamp.revision!==request.approved.revision)throw new Error('The document changed after discard was approved.')
          }else{
            flushPending()
            const alreadyClean=canClose()&&(!request.targetPath||request.targetPath===filePathRef.current)&&mode==='save'
            if(request.intent==='clean'&&!alreadyClean)throw new Error('The editor has pending changes; close needs a new decision.')
            if(!alreadyClean&&!await doSave(mode))return false
            if(request.requireClean&&!await saveMarkdownForClose({waitUntilIdle:async()=>{while(savingRef.current)await new Promise(resolve=>setTimeout(resolve,50))},isCurrent,flushPending,canClose,save:()=>doSave('save')},2))return false
          }
        }finally{activeSaveRequestRef.current=undefined}
        if(!request.requireClean)return true
        if(!request.closeLease)return false
        if(request.intent==='discard'){redactDialogGenerationRef.current++;setRedactCloseEpoch(value=>value+1)}
        const stamp=await barrier.acquire(request.closeLease,()=>isCurrent()&&settled()&&(request.intent==='discard'?!!request.approved&&markdownCloseStamp().source===request.approved.source&&markdownCloseStamp().revision===request.approved.revision:canClose()))
        if(!stamp)return false
        held={ticket:request.closeLease,stamp};publishCloseRef.current();return true
      })().then(complete=>window.markdownApi.sendSaveRequestAck({requestId:request.requestId,published:publicationSequenceRef.current>beforePublication,current:isCurrent(),clean:complete&&canClose(),...(held?{closeLease:held}:{})}),error=>window.markdownApi.sendSaveRequestAck({requestId:request.requestId,published:publicationSequenceRef.current>beforePublication,current:isCurrent(),clean:false,error:String(error)}))
    })
    // MCP read of this open document: hand back the same serialization a save
    // would write, so unsaved edits are included. Staying silent while the
    // editor is still loading keeps the main process retrying its request
    // instead of failing on a document that is merely not ready yet.
    const offReadText = window.markdownApi.onReadTextRequest(() => {
      const current = editorRef.current
      if (!current || statusRef.current !== 'ready') return
      try {
        const text = serializeMarkdownForSave(
          envelopeRef.current,
          current.state.doc,
          () => bodyMarkdown(current),
          { original: originalSourceRef.current, clean: !dirtyRef.current, experimental: roundTripEnabled },
        )
        window.markdownApi.sendReadTextResult({ text })
      } catch (err) {
        window.markdownApi.sendReadTextResult({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
    const offClose = window.markdownApi.onCloseSaveRequest(() => {
      const generation = sourceGenerationRef.current
      const isCurrent = () =>
        sourceGenerationRef.current === generation &&
        statusRef.current === 'ready' &&
        !editorRef.current?.view.composing
      const canClose = () =>
        isCurrent() && !dirtyRef.current && pendingSourceRef.current === null
      void saveMarkdownForClose({
        waitUntilIdle: async () => {
          while (savingRef.current) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        },
        isCurrent,
        flushPending: () => {
          const pending = pendingSourceRef.current !== null
          flushSource()
          // A raw-source edit can leave the visual model equal while changing
          // the next serialized file. A prior save must not consume that edit.
          if (pending) markDirty()
        },
        canClose,
        save: () => doSave('save'),
      }).then(
        (ok) => window.markdownApi.sendCloseSaveResult(ok && canClose()),
        () => window.markdownApi.sendCloseSaveResult(false),
      )
    })
    const offDisk = window.markdownApi.onFileChangedOnDisk((changedPath) => {
      // the watcher keeps refusing saves until the change is acknowledged; a
      // change parked behind the bar stays unacknowledged until the user decides
      let awaitingUser = false
      void runMarkdownAsyncMutation(async source => {
        try {
          if (changedPath !== filePathRef.current || statusRef.current !== 'ready') return
          const loaded=await window.markdownApi.readPublication(changedPath),raw=loaded.text
          await beforeMarkdownMutation(source)
          if (changedPath !== filePathRef.current || raw === diskTextRef.current) return
          const dirtyNow = dirtyRef.current || savingRef.current
          if (dirtyNow) {
            diskTextRef.current = raw
            setDiskNotice('changed')
            awaitingUser = true
            return
          }
          reloadFromDisk(changedPath, raw, loaded.publicationId)
        } catch (err) {
          console.error('[markdown] reload after external change failed:', err)
        } finally {
          if (!awaitingUser) window.markdownApi.ackFileChangedOnDisk()
        }
      }).catch(error=>showToast(String(error),'error'))
    })
    const offRenamed = window.markdownApi.onFileRenamed((newPath) => {
      // A rename that changes the extension changes what the file is, so the
      // open document has to follow it onto the matching surface. Reloading
      // throws away unsaved edits, so a dirty document is refused instead —
      // the file on disk is untouched and the tab stays open.
      void runMarkdownAsyncMutation(async source=>{
      const action = renameAction(filePathRef.current, newPath, dirtyRef.current)
      if (action === 'keep') {
        mutateMarkdown(()=>{filePathRef.current=newPath;setFilePath(newPath)},source)
        return
      }
      if (action === 'block-dirty') {
        showToast(t('renameNeedsSave'), 'error')
        return
      }
      try {
          const loaded=await window.markdownApi.readPublication(newPath),raw=loaded.text
          await beforeMarkdownMutation(source)
          // loadFromPath replaces the content with addToHistory off, so the
          // old surface's undo stack cannot walk back into a document that
          // has a different shape now
          loadFromPath(newPath, raw, loaded.publicationId)
        } catch (err) {
          console.error('[markdown] reload after rename failed:', err)
        }
      }).catch(error=>showToast(String(error),'error'))
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void doSave(event.shiftKey ? 'saveAs' : 'save')
      } else if (key === 'p' && !event.shiftKey) {
        event.preventDefault()
        void printDoc()
      } else if (key === 'f' && !event.shiftKey) {
        event.preventDefault()
        openFind(false)
      } else if (key === 'h' && !event.shiftKey) {
        // Word's replace shortcut: Ctrl+H on Windows/Linux, Control+H on macOS —
        // its ⌘H belongs to the system Hide role, so the menu keeps that key
        event.preventDefault()
        openFind(true)
      } else if (key === 'e' && !event.shiftKey) {
        // Obsidian's edit/preview toggle: the source view
        event.preventDefault()
        toggleSource()
      } else if (key === '=' || key === '+') {
        event.preventDefault()
        zoomIn()
      } else if (key === '-' || key === '_') {
        event.preventDefault()
        zoomOut()
      } else if (key === '0') {
        event.preventDefault()
        setZoom(100)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      offSave()
      offReadText()
      offClose()
      offDisk()
      offRenamed()
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [doSave, printDoc, zoomIn, zoomOut, openFind, toggleSource, loadFromPath, reloadFromDisk, roundTripEnabled, flushSource, markDirty, t])

  // Chromium reports trackpad pinch as ctrl+wheel. Also support Cmd/Ctrl+scroll
  // while the pointer is over the document canvas.
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      if (!(event.target as HTMLElement | null)?.closest?.('.editor-scroll')) return
      event.preventDefault()
      setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value - event.deltaY * 0.6)))
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    rememberAiPanelOpen('mdapp.showAi', aiOpen)
  }, [aiOpen])

  // autosave: every 30s and on window blur, silently persist pending changes
  // (same policy as the docs app; untitled documents are skipped — the first
  // save must go through the explicit save path that names the file)
  useEffect(() => {
    if (!autoSave || !filePath) return
    const tick = () => {
      if (closeBarrierRef.current?.locked || !dirtyRef.current) return
      if (editorRef.current?.view.composing) return // don't interrupt IME input
      void doSave('save',undefined,undefined,true)
    }
    const id = window.setInterval(tick, 30_000)
    window.addEventListener('blur', tick)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('blur', tick)
    }
  }, [autoSave, filePath, doSave])

  // The crash journal protects unnamed documents too. It records the current
  // source without publishing it over the user's document or changing dirty state.
  const draftWarningRef = useRef(false)
  useEffect(() => {
    let pending = false
    const tick = async () => {
      if (closeBarrierRef.current?.locked || pending || !dirtyRef.current || statusRef.current !== 'ready' || editorRef.current?.view.composing) return
      flushSource()
      const text = sourceMode ? writeSourceText(sourceTextRef.current, sourceFormatRef.current) : currentFileText()
      if (text === null) return
      pending = true
      try {
        const result = await window.markdownApi.writeDraft({text,stamp:markdownCloseStamp()})
        if (!result.ok && !draftWarningRef.current) {
          draftWarningRef.current = true
          showToast(`Crash recovery could not record this draft: ${result.error}`, 'error')
        } else if (result.ok) draftWarningRef.current = false
      } catch (error) {
        if (!draftWarningRef.current) {
          draftWarningRef.current = true
          showToast(`Crash recovery is unavailable: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
      } finally { pending = false }
    }
    const interval = window.setInterval(() => { void tick() }, 15_000)
    const blur = () => { void tick() }
    window.addEventListener('blur', blur)
    return () => { window.clearInterval(interval); window.removeEventListener('blur', blur) }
  }, [flushSource, currentFileText, sourceMode])

  // ---- selection-scoped AI edit queue (anchors live in the editor as decorations) ----
  const getQueueItem = useCallback(
    (qid: string) => editQueueRef.current.find((item) => item.qid === qid),
    [],
  )
  const queueAdd = useCallback((instruction: string): void => {
    const current = editorRef.current
    if (!current) return
    const { from, to, empty } = current.state.selection
    if (empty || editQueueRef.current.length >= EDIT_QUEUE_MAX) return
    const qid = `q${++queueSeqRef.current}`
    addQueueAnchor(current, qid, from, to)
    const capturedText = current.state.doc
      .textBetween(from, to, ' ', ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    setEditQueue((queue) => [...queue, { qid, instruction, capturedText }])
  }, [])
  const queueUpdate = useCallback(
    (qid: string, instruction: string): void =>
      setEditQueue((queue) => queue.map((i) => (i.qid === qid ? { ...i, instruction } : i))),
    [],
  )
  const queueRemove = useCallback((qid: string): void => {
    if (editorRef.current) removeQueueAnchors(editorRef.current, [qid])
    setEditQueue((queue) => queue.filter((i) => i.qid !== qid))
  }, [])
  const queueClear = useCallback((): void => {
    if (editorRef.current) clearQueueAnchors(editorRef.current)
    setEditQueue([])
  }, [])
  /** a submission hands its items to the run and drops them from the queue */
  const queueConsume = useCallback((qids: string[]): void => {
    if (editorRef.current) removeQueueAnchors(editorRef.current, qids)
    setEditQueue((queue) => queue.filter((i) => !qids.includes(i.qid)))
  }, [])
  const queueFocus = useCallback((qid: string): void => {
    const current = editorRef.current
    if (!current) return
    const selection = selectionForAnchor(current, qid)
    if (!selection) return
    current.view.dispatch(current.state.tr.setSelection(selection).scrollIntoView())
    current.view.focus()
  }, [])
  /** outline click: move the cursor into the heading and scroll it into view */
  const jumpToOutline = useCallback((pos: number): void => {
    const current = editorRef.current
    if (!current) return
    const selection = TextSelection.near(current.state.doc.resolve(pos))
    current.view.dispatch(current.state.tr.setSelection(selection).scrollIntoView())
    current.view.focus()
  }, [])
  const askSendNow = useCallback((text: string): void => {
    setAiOpen(true)
    setAiPreset((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  const aiDeps: MarkdownAiDeps = {
    getEditor: () => editorRef.current,
    // envelopeRef, not fmText state: a write-then-read within one AI run must
    // see the new value before React commits
    getFrontmatter: () => frontmatterInner(envelopeRef.current.frontmatter),
    setFrontmatter: (inner) => {
      onFrontmatterChange(inner)
      setFmOpen(inner.trim() !== '')
    },
    // snapshots carry body + the raw frontmatter block (structured, no
    // file-text round-trip) so a rollback also reverts set_frontmatter and
    // an untouched block restores byte-for-byte
    getSnapshot: () => ({
      source: markdownCloseStamp().source,
      body: editorRef.current ? bodyMarkdown(editorRef.current) : '',
      frontmatter: envelopeRef.current.frontmatter,
    }),
    restoreSnapshot: (snapshot) => {
      if (snapshot.source && snapshot.source !== markdownCloseStamp().source) throw new Error('The source changed before AI rollback.')
      mutateMarkdown(() => {
      const current = editorRef.current
      if (!current) return
      envelopeRef.current.frontmatter = snapshot.frontmatter
      const inner = frontmatterInner(snapshot.frontmatter)
      setFmText(inner)
      setFmOpen(inner !== '')
      current.commands.setContent(snapshot.body, { contentType: 'markdown' })
      sourceMapRef.current = buildSourceMap(current, current.state.doc, snapshot.body)
      markDirty()
      })
    },
    onRunDone: (mutated) => {
      // AI wrote into a never-saved document → name it from the content and save silently
      if (!mutated || filePathRef.current || !editorRef.current) return
      const name = deriveAutoFileName(editorRef.current)
      if (name) void doSave('save', name)
    },
  }

  const fileName = filePath ? filePath.replace(/^.*[/\\]/, '') : null
  const statusText =
    saveState === 'saving'
      ? t('saving')
      : saveState === 'failed'
        ? t('saveFailed')
        : dirty
          ? t('unsaved')
          : saveState === 'saved'
            ? t('savedOk')
            : ''

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

  if (status === 'error') {
    return (
      <div className="app">
        <div className="center-note">{t('loadError')}</div>
      </div>
    )
  }

  return (
    <div className="app">
      <Ribbon
        editor={editor}
        disabled={status !== 'ready'}
        dirty={dirty}
        onSave={() => void doSave('save')}
        onSaveAs={() => void doSave('saveAs')}
        onNameWithAi={() => void nameWithAi()}
        onFind={() => openFind(false)}
        autoSave={autoSave}
        onToggleAutoSave={setAutoSave}
        imageEnabled={Boolean(filePath)}
        mdTheme={mdTheme}
        onMarkdownTheme={pickMarkdownTheme}
        onInsertImage={insertImage}
        onImageHost={() => setImageHostOpen(true)}
        frontmatterOpen={fmOpen}
        onToggleFrontmatter={() => setFmOpen((v) => !v)}
        sourceViewOpen={sourceViewOpen}
        onToggleSource={toggleSource}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        hasOutline={outlineItems.length > 0}
        backlinksOpen={backlinksOpen}
        tagsOpen={tagsOpen}
        onToggleBacklinks={() => setBacklinksOpen((v) => !v)}
        onToggleTags={() => setTagsOpen((v) => !v)}
        onOpenGraph={() => setGraphOpen(true)}
        onCopyBlockLink={() => editor?.commands.copyBlockLink()}
        spellcheck={spellcheck}
        onToggleSpellcheck={() => setSpellcheck((v) => !v)}
        sourceMode={sourceMode}
        sourceHistory={sourceMode ? sourceHistory : undefined}
        aiOpen={aiOpen}
        onToggleAi={() => setAiOpen((v) => !v)}
        onAiPreset={(text) => {
          setAiOpen(true)
          setAiPreset((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }))
        }}
        redactEnabled={redactEnabled}
        onToggleRedact={(on) => {
          setRedactEnabled(on)
          localStorage.setItem('mdapp.redact', on ? '1' : '0')
        }}
      />
      {status === 'loading' && <div className="center-note">{t('loading')}</div>}
      <div className="app-main" style={status === 'ready' ? undefined : { display: 'none' }}>
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
              <GensparkMark size={22} />
            </button>
          )}
          {/* mounted only after the file is loaded so chat history resolves against the real path */}
          {status === 'ready' && (
            <AiPanel
              deps={aiDeps}
              filePath={filePath}
              preset={aiPreset}
              onCollapse={() => setAiOpen(false)}
              editQueue={editQueue}
              onQueueEditInstruction={queueUpdate}
              onQueueRemove={queueRemove}
              onQueueClear={queueClear}
              onQueueFocus={queueFocus}
              onQueueConsume={queueConsume}
            />
          )}
        </div>
        {outlineOpen && !sourceMode && (
          <OutlinePane
            items={outlineItems}
            onJump={jumpToOutline}
            width={outlineWidth}
            onResize={setOutlineWidth}
          />
        )}
        {backlinksOpen && !sourceMode && (
          <BacklinksPane
            path={filePath}
            onOpen={(path) => void window.markdownApi.openSourcePath(path)}
          />
        )}
        {tagsOpen && !sourceMode && (
          <TagsPane onOpen={(path) => void window.markdownApi.openSourcePath(path)} />
        )}
        <div className="app-content">
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
          {showFind && findTarget && (
            <FindPanel
              target={findTarget}
              strings={findStrings}
              onClose={() => setShowFind(false)}
              focusRequest={findFocus}
            />
          )}
          {/* Two different things, three branches. A .txt/.json has no block
              document behind it at all, so its source text replaces the canvas
              outright. The markdown source view is a different case: there the
              editor still owns a live ProseMirror view, and unmounting
              EditorContent tears it down, so the canvas stays mounted and only
              hidden while SourcePane sits beside it. */}
          {sourceMode ? (
            <div className="source-editor">
              <PlainTextEditor
                ref={sourceRef}
                initialText={sourceTextRef.current}
                mode={textMode === 'json' ? 'json' : 'plain'}
                spellcheck={spellcheck}
                onChange={(text) => {
                  mutateMarkdown(() => { sourceTextRef.current = text; setSourceRev((n) => n + 1); markDirty() })
                }}
              />
            </div>
          ) : (
            <>
              <div
                className={`editor-scroll${sourceViewOpen ? ' source-off' : ''}`}
                ref={scrollRef}
              >
                <div className="doc-page" style={{ zoom: zoom / 100 }}>
                  {fmOpen && <FrontmatterPanel value={fmText} onChange={onFrontmatterChange} readOnly={closeLocked} />}
                  <EditorContent editor={editor} />
                </div>
              </div>
              {sourceViewOpen && (
                <SourcePane
                  value={sourceText}
                  onChange={onSourceChange}
                  onFocusChange={onSourceFocusChange}
                />
              )}
            </>
          )}
          <footer className="status-bar">
            <div className="status-left">
              {imageExportStatus && (
                <span className="status-item status-export" role="status">
                  {t(imageExportStatus.key, imageExportStatus.params)}
                </span>
              )}
              {fileName && <span className="status-item status-file">{fileName}</span>}
              {fileName && docStats && (
                <span className="status-item status-stats">
                  {t('statusWords', { n: docStats.words })} ·{' '}
                  {t('statusChars', {
                    n: docStats.chars,
                  })}
                </span>
              )}
            </div>
            <div className="status-right">
              {statusText && (
                <span className={`status-save status-${saveState}`}>{statusText}</span>
              )}
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
      {!sourceMode && (
        <SlashMenu ref={slashMenuRef} state={slashState} onDismiss={() => setSlashState(null)} />
      )}
      {!sourceMode && (
        <WikiSuggestMenu
          ref={wikiSuggestMenuRef}
          state={wikiSuggestState}
          onDismiss={() => setWikiSuggestState(null)}
        />
      )}
      <RedactMenu key={renderedRedactSource+':'+redactCloseEpoch} editor={editor} enabled={redactEnabled} sourceCurrent={()=>closeAliveRef.current&&markdownCloseStamp().source===renderedRedactSource&&redactDialogGenerationRef.current===renderedRedactGeneration} />
      <ToastHost />
      {graphOpen && (
        <GraphView
          current={filePath}
          onClose={() => setGraphOpen(false)}
          onOpen={(path) => {
            setGraphOpen(false)
            void window.markdownApi.openSourcePath(path)
          }}
        />
      )}
      {imageHostOpen && (
        <ImageHostDialog onClose={() => setImageHostOpen(false)} onSaved={() => {}} />
      )}
      {viewImage && (
        <ImageViewer
          src={viewImage}
          lang={lang}
          labels={{
            zoomIn: t('zoomIn'),
            zoomOut: t('zoomOut'),
            actualSize: t('imageActualSize'),
            fitToWindow: t('imageFitWindow'),
            save: t('saveImageAs'),
            close: t('closeEsc'),
          }}
          onClose={() => setViewImage(null)}
          onSave={() => void window.markdownApi.saveImageAs(viewImage)}
        />
      )}
      {!sourceMode && <TableMenu editor={editor} scrollRef={scrollRef} zoom={zoom} />}
      {editor && !sourceMode && status === 'ready' && (
        <AiAskPopover
          editor={editor}
          queueFull={editQueue.length >= EDIT_QUEUE_MAX}
          getItem={getQueueItem}
          onSendNow={askSendNow}
          onQueueAdd={queueAdd}
          onQueueUpdate={queueUpdate}
          onQueueRemove={queueRemove}
        />
      )}
    </div>
  )
}
