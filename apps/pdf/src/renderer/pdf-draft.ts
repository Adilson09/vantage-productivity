import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { usePdfAuthoredState, readPdfAuthored, pdfAuthoredSource } from './pdf-authored'
import {
  encodePdfWorkspaceState,
  plainPdfWorkspaceData,
  pdfWorkspacePendingReasons,
  type PdfWorkspaceStateV1,
  type PdfSourceRead,
  type PdfDraftActivation,
  type PdfDraftSnapshotRequest,
  type PdfWorkspaceSaveProof,
  type PdfCopyReceipt,
  type PdfDraftCloseFloor,
} from '../shared/pdf-workspace'

export interface PdfDraftApi {
  activateDraft(readId: string, unjournaledPath?: string): Promise<PdfDraftActivation>
  writeDraft(request: PdfDraftSnapshotRequest): Promise<{ ok: true; skipped?: boolean }>
  discardDraft(token: string): Promise<void>
  acknowledgeCopy(request: {
    token: string
    copyId: string
    state: ArrayBuffer
    sequence: number
  }): Promise<void>
  onDraftRetired(
    handler: (value: {
      token: string
      reason: 'discarded' | 'checkpoint' | 'redacted' | 'close'
    }) => void,
  ): () => void
}
export function pdfAuthoredFingerprint(state: PdfWorkspaceStateV1): string {
  return JSON.stringify({
    edits: {
      ...state.edits,
      textEdits: state.edits.textEdits.map((value) => ({ id: value.id, input: value.input })),
      imageEdits: state.edits.imageEdits.map(
        ({ png: _preview, origAbove: _band, ...authored }) => authored,
      ),
      formEdits: [...state.edits.formEdits].sort(([a], [b]) => a.localeCompare(b)),
      formWidgetEdits: [...state.edits.formWidgetEdits].sort(([a], [b]) => a.localeCompare(b)),
      rotations: [...state.edits.rotations].sort(([a], [b]) => a - b),
      deleted: [...state.edits.deleted].sort((a, b) => a - b),
    },
    outline: state.outline.pending,
    text: { ...state.text, caret: null },
    comments: { ...state.comments, active: null },
    forms: {
      heldFieldId: state.forms.heldFieldId,
      signatureTarget: state.forms.signatureTarget,
      tool: state.forms.tool,
    },
    annotations: {
      pendingLink: state.annotations.pendingLink,
      pendingSign: state.annotations.pendingSign,
      imagePick: state.annotations.imagePick,
      pendingStaticFill: state.annotations.pendingStaticFill,
      staticFormFills: state.annotations.staticFormFills,
    },
    redactions: state.redactions.regions,
    pendingEditors: [...state.pendingEditors].sort(([a], [b]) => a.localeCompare(b)),
  })
}
/** All authored child content lives in App or this explicit registry. No DOM dump. */
const editors = new Map<string, { kind: string; read: () => unknown }>()
const editorEpochs = new Map<string, number>()
const pendingListeners = new Set<() => void>()
export function onPdfPendingContentChanged(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => {
    pendingListeners.delete(listener)
  }
}
export function hasPdfPendingEditors(): boolean {
  return (
    [...restoredEditors.keys()].some((id) => !editors.has(id)) ||
    [...editors.values()].some((editor) => editor.read() !== undefined)
  )
}
function notifyPending(): void {
  for (const listener of pendingListeners) listener()
}
export function pdfPendingContentChanged(): void {
  notifyPending()
}
let restoredEditors = new Map<string, { kind: string; value: unknown }>()
export function registerPdfPendingEditor(
  id: string,
  kind: string,
  read: () => unknown,
): () => void {
  const entry = { kind, read }
  restoredEditors.delete(id)
  editors.set(id, entry)
  return () => {
    if (editors.get(id) === entry) {
      // Virtualization and a closed side panel are not authoring decisions. Keep
      // their unsubmitted value until accepted/canceled explicitly or source reset.
      const value = entry.read()
      if (value === undefined) restoredEditors.delete(id)
      else restoredEditors.set(id, { kind, value })
      editors.delete(id)
      notifyPending()
    }
  }
}
export function discardPdfPendingEditors(filter: { id?: string; kind?: string }): void {
  for (const id of new Set([...editors.keys(), ...restoredEditors.keys()])) {
    const kind = editors.get(id)?.kind ?? restoredEditors.get(id)?.kind
    if (
      (filter.id !== undefined && filter.id !== id) ||
      (filter.kind !== undefined && filter.kind !== kind)
    )
      continue
    editors.delete(id)
    restoredEditors.delete(id)
    editorEpochs.set(id, (editorEpochs.get(id) ?? 0) + 1)
  }
  notifyPending()
}
export function pendingPdfEditors(): PdfWorkspaceStateV1['pendingEditors'] {
  const result = new Map(restoredEditors)
  for (const [id, editor] of editors) {
    const value = editor.read()
    if (value === undefined) result.delete(id)
    else result.set(id, { kind: editor.kind, value })
  }
  return plainPdfWorkspaceData([...result]) as PdfWorkspaceStateV1['pendingEditors']
}
export function restorePdfPendingEditors(values: PdfWorkspaceStateV1['pendingEditors']): void {
  editors.clear()
  restoredEditors = new Map(structuredClone(values))
}
export function consumePdfPendingEditor<T>(id: string, kind: string): T | undefined {
  const value = restoredEditors.get(id)
  if (!value || value.kind !== kind) return undefined
  restoredEditors.delete(id)
  return value.value as T
}
export function clearPdfPendingEditors(): void {
  editors.clear()
  restoredEditors.clear()
  editorEpochs.clear()
}
export function usePdfEditorState<T>(
  id: string,
  kind: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const source = pdfAuthoredSource()
  const [state, setState] = usePdfAuthoredState<T>(
    `editor:${id}`,
    () => consumePdfPendingEditor<T>(id, kind) ?? initial,
  )
  const ref = useRef(state)
  ref.current = state
  const baseline = useRef(JSON.stringify(initial))
  baseline.current = JSON.stringify(initial)
  const registration = useRef<{ identity: string; remove(): void } | null>(null)
  const ensureRegistered = useCallback(() => {
    const identity = `${source}:${kind}:${id}:${editorEpochs.get(id) ?? 0}`
    if (registration.current?.identity === identity) return registration.current
    registration.current?.remove()
    const entry = {
      identity,
      remove: registerPdfPendingEditor(id, kind, () => {
        const current = readPdfAuthored<T>(`editor:${id}`, ref.current)
        return JSON.stringify(current) === baseline.current ? undefined : current
      }),
    }
    registration.current = entry
    return entry
  }, [id, kind, source])
  useEffect(() => {
    const entry = ensureRegistered()
    return () => {
      entry.remove()
      if (registration.current === entry) registration.current = null
    }
  }, [ensureRegistered])
  useEffect(() => {
    notifyPending()
  }, [state])
  const setPending = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      if (source !== pdfAuthoredSource()) return
      // A just-mounted field can receive input before its passive effect. Its first
      // authored update must already be visible to synchronous complete capture.
      ensureRegistered()
      setState(action)
      notifyPending()
    },
    [ensureRegistered, setState, source],
  )
  return [state, setPending]
}

export class PdfDraftClient {
  private generation = 0
  private sequence = 0
  private activation: PdfDraftActivation | null = null
  private read: PdfSourceRead | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: (() => void) | undefined
  private running: number | null = null
  private suppressed: string | null = null
  private written: string | null = null
  private needsActivation = false
  private lastError = ''
  private reauthorizing: Promise<void> | null = null
  private paused = false
  private stopped = true
  private sourceToken: string | null = null
  constructor(
    private readonly dependencies: {
      api: PdfDraftApi
      capture(forSave?: boolean): PdfWorkspaceStateV1
      composing(): boolean
      report(message: string): void
      sanitized?(): void
    },
  ) {}
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.unsubscribe = this.dependencies.api.onDraftRetired((value) => {
      if (value.token !== this.sourceToken) return
      this.generation++
      if (value.reason === 'close') {
        this.paused = true
        return
      }
      this.activation = null
      this.paused = false
      this.written = null
      this.needsActivation = value.reason === 'discarded'
      if (value.reason === 'redacted') this.dependencies.sanitized?.()
      if (value.reason === 'discarded') {
        try {
          this.suppressed = pdfAuthoredFingerprint(this.capture())
        } catch {
          this.suppressed = null
        }
      }
    })
    this.timer = setInterval(() => {
      void this.snapshot()
    }, 30000)
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.generation++
  }
  suspendForSource(): void {
    this.generation++
    this.activation = null
    this.read = null
    this.needsActivation = false
    this.written = null
    this.suppressed = null
    this.paused = false
    this.sourceToken = null
  }
  async activate(read: PdfSourceRead): Promise<void> {
    const generation = ++this.generation
    this.read = read
    this.activation = null
    this.sequence = 0
    this.paused = false
    this.sourceToken = null
    this.suppressed = null
    this.written = null
    this.needsActivation = false
    try {
      const activation = await this.dependencies.api.activateDraft(
        read.readId,
        read.readId ? undefined : read.helperPath,
      )
      if (generation === this.generation && activation.token && read.draftCapability.available) {
        this.activation = activation
        this.sourceToken = activation.token
        this.sequence = Math.max(this.sequence, activation.sequenceFloor ?? 0)
      }
      if (!read.draftCapability.available && generation === this.generation)
        this.warn(read.draftCapability.reason ?? 'Recovery is unavailable for this PDF.')
    } catch (error) {
      if (generation === this.generation) this.warn(error)
    }
  }
  capture(forSave = false): PdfWorkspaceStateV1 {
    return plainPdfWorkspaceData(this.dependencies.capture(forSave))
  }
  hasPending(): boolean {
    return (
      this.read?.unpublishedBase === true || pdfWorkspacePendingReasons(this.capture()).length > 0
    )
  }
  mode(): 'native' | 'workspace' {
    return this.read?.mode ?? 'native'
  }
  currentRead(): PdfSourceRead | null {
    return this.read
  }
  renamed(oldPath: string, nextPath: string): void {
    if (this.read?.mode === 'native' && this.read.helperPath === oldPath)
      this.read = { ...this.read, helperPath: nextPath, displayPath: nextPath }
    else if (this.read?.mode === 'workspace' && this.read.displayPath === oldPath)
      this.read = { ...this.read, displayPath: nextPath }
  }
  available(): boolean {
    return this.activation !== null && !this.paused
  }
  pauseForClose(): PdfDraftCloseFloor | null {
    this.paused = true
    this.generation++
    return this.activation && this.read
      ? { token: this.activation.token, readId: this.read.readId, throughSequence: this.sequence }
      : null
  }
  closeFloor(): PdfDraftCloseFloor | null {
    return this.activation && this.read
      ? { token: this.activation.token, readId: this.read.readId, throughSequence: this.sequence }
      : null
  }
  resumeClose(floor: PdfDraftCloseFloor | null): void {
    if (!floor) {
      if (!this.activation) {
        this.paused = false
        this.generation++
      }
      return
    }
    if (
      !this.read ||
      this.read.readId !== floor.readId ||
      this.activation?.token !== floor.token ||
      this.sourceToken !== floor.token
    )
      return
    this.sequence = Math.max(this.sequence, floor.throughSequence)
    this.paused = false
    this.generation++
    void this.snapshot()
  }
  ensureActiveForSave(): Promise<void> {
    if (this.paused) return Promise.reject(new Error('The PDF is still reserved for closing.'))
    if (this.activation || !this.read?.draftCapability.available) return Promise.resolve()
    if (this.reauthorizing) return this.reauthorizing
    const read = this.read
    const operation = this.activate(read).then(() => {
      if (!this.activation || this.read !== read)
        throw new Error('The PDF source changed while its save receipt was being prepared.')
    })
    this.reauthorizing = operation
    void operation.then(
      () => {
        if (this.reauthorizing === operation) this.reauthorizing = null
      },
      () => {
        if (this.reauthorizing === operation) this.reauthorizing = null
      },
    )
    return operation
  }
  ticket(): { generation: number } {
    return { generation: this.generation }
  }
  isCurrent(ticket: { generation: number }): boolean {
    return ticket.generation === this.generation
  }
  proof(
    state = this.capture(),
    renderedStampConfig: PdfWorkspaceStateV1['edits']['stampCfg'] = state.edits.stampCfg,
  ): PdfWorkspaceSaveProof {
    if (!this.activation || this.paused)
      throw new Error(
        'This PDF recovery source is not active. Reopen it before saving a workspace copy.',
      )
    return {
      token: this.activation.token,
      sequence: ++this.sequence,
      state: encodePdfWorkspaceState(state),
      renderedStampConfig: structuredClone(renderedStampConfig),
    }
  }
  async snapshot(): Promise<boolean> {
    if (
      this.stopped ||
      this.paused ||
      !this.read?.draftCapability.available ||
      this.running === this.generation ||
      this.dependencies.composing()
    )
      return false
    let generation = this.generation
    const running = generation
    this.running = running
    // Reserve the sequence before any activation/read delay.
    const sequence = ++this.sequence
    try {
      const state = this.capture(),
        fingerprint = pdfAuthoredFingerprint(state)
      if (
        (!this.read.unpublishedBase && !pdfWorkspacePendingReasons(state).length) ||
        fingerprint === this.suppressed ||
        fingerprint === this.written
      )
        return false
      if (this.needsActivation) {
        const activation = await this.dependencies.api.activateDraft(this.read.readId)
        if (generation !== this.generation) return false
        this.activation = activation
        this.sourceToken = activation.token
        this.needsActivation = false
        this.suppressed = null
      }
      const activation = this.activation
      if (!activation) return false
      const result = await this.dependencies.api.writeDraft({
        token: activation.token,
        sequence,
        state: encodePdfWorkspaceState(state),
      })
      if (generation !== this.generation) return false
      if (!result.skipped) {
        this.written = fingerprint
        this.lastError = ''
      }
      return !result.skipped
    } catch (error) {
      if (generation === this.generation) this.warn(error)
      return false
    } finally {
      if (this.running === running) this.running = null
    }
  }
  async acknowledge(receipt: PdfCopyReceipt): Promise<void> {
    if (!receipt.complete || !this.activation) return
    const state = this.capture()
    await this.dependencies.api.acknowledgeCopy({
      token: this.activation.token,
      copyId: receipt.copyId,
      state: encodePdfWorkspaceState(state),
      sequence: ++this.sequence,
    })
  }
  report(error: unknown): void {
    this.warn(error)
  }
  private warn(error: unknown): void {
    const message = `PDF recovery: ${error instanceof Error ? error.message : String(error)}`
    if (message === this.lastError) return
    this.lastError = message
    this.dependencies.report(message)
  }
}
