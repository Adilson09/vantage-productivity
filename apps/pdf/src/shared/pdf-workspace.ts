import type { EditSnapshot, AnnotSelection } from '../renderer/edit-state'
import type { TextDraft } from '../renderer/text-edit-preview'
import type { FormWidget } from '../renderer/form-catalog'
import type { SignatureData } from '../renderer/SignatureDialog'
import type { LocalRedaction } from '../renderer/RedactionLayer'
import type { LinkDraft } from '../renderer/LinkDialog'
import type { OutlineEntryInput, TextInsertInput, StaticFormFillRecord } from './ipc'
import type { CloseLeaseStamp, CloseLeaseTicket } from '@vantage/electron-utils/close-lease'
import { validatePdfWorkspaceNested } from './pdf-workspace-schema'

export const PDF_WORKSPACE_MAGIC = 'VANTAGE-PDF-WORKSPACE-1\n'
export const PDF_WORKSPACE_EXTENSION = '.vpdfdraft'
export const PDF_WORKSPACE_LIMITS = Object.freeze({
  entryBytes: 16 * 1024 * 1024,
  sourceBytes: 12 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  graphDepth: 32,
  graphNodes: 100000,
  textBytes: 4 * 1024 * 1024,
  ownedViews: 64,
  queuedSnapshots: 16,
  queuedBytes: 32 * 1024 * 1024,
  imagePixels: 16 * 1024 * 1024,
  aggregateImagePixels: 32 * 1024 * 1024,
})

/** Every undo bucket is explicit: JSON never silently turns Maps/Sets into {}. */
export type PdfWorkspaceEdits = Omit<
  EditSnapshot,
  'formEdits' | 'formWidgetEdits' | 'rotations' | 'deleted'
> & {
  formEdits: Array<[string, EditSnapshot['formEdits'] extends Map<string, infer T> ? T : never]>
  formWidgetEdits: Array<
    [string, EditSnapshot['formWidgetEdits'] extends Map<string, infer T> ? T : never]
  >
  rotations: Array<[number, number]>
  deleted: number[]
}
export type PdfPendingJson =
  null | boolean | number | string | PdfPendingJson[] | { [key: string]: PdfPendingJson }
export interface PdfWorkspaceStateV1 {
  version: 1
  edits: PdfWorkspaceEdits
  outline: {
    pending: {
      tree: OutlineEntryInput[] | null
      unresolvable: boolean
      edited: boolean
      editing: boolean
    } | null
    selected: number[] | null
  }
  text: {
    draft: TextDraft | null
    caret: [number, number] | null
    pendingInsert: Omit<TextInsertInput, 'pageIndex' | 'origin'> | null
    insertPointer: { pageIndex: number; x: number; y: number } | null
    insertEditId: string | null
    staticEditor: {
      open: boolean
      purpose: 'form' | 'insert'
      value: string
      size: number
      color: string
      align: 'left' | 'center' | 'right'
      target: PdfPendingJson
    }
  }
  comments: {
    placement: { origIdx: number; at: [number, number] } | null
    newBody: string
    createdMs: number | null
    replies: Array<[string, string]>
    rewrite: { origIdx: number; rootKey: string; itemKey: string; text: string } | null
    active: { origIdx: number; rootKey: string } | null
    author: string
  }
  forms: {
    activeWidgetId: string | null
    selectedFieldIds: string[]
    freshFieldId: string | null
    heldFieldId: string | null
    tool: string | null
    preview: boolean
    signatureTarget: Omit<FormWidget, 'password'> | null
  }
  annotations: {
    selected: AnnotSelection | null
    pendingLink: LinkDraft | null
    pendingSign: SignatureData | null
    imagePick: Extract<SignatureData, { kind: 'image' }> | null
    pendingStaticFill: string | null
    staticFormFills: StaticFormFillRecord[]
  }
  /** Selection only. No confirmation, password, signer or in-flight authorization. */
  redactions: { regions: LocalRedaction[]; selectedId: string | null }
  pendingEditors: Array<[string, { kind: string; value: PdfPendingJson }]>
  view: {
    page: number
    scale: number
    sidebar: string | null
    ribbon: string
    dialogs: { properties: boolean; stamp: boolean; bates: boolean; signature: boolean }
  }
}

export interface PdfWorkspaceEnvelopeV1 {
  format: 'vantage.pdf-workspace'
  version: 1
  source: {
    displayName: string
    originalPath: string | null
    sha256: string
    bytes: string
    protection: 'unencrypted'
  }
  state: PdfWorkspaceStateV1
}
export interface PdfSourceRead {
  readId: string
  mode: 'native' | 'workspace'
  displayPath: string
  /** Exact main-owned read helper path; never inferred from imported metadata. */
  helperPath: string
  baseSha256: string
  data: ArrayBuffer
  recoveredState?: PdfWorkspaceStateV1
  draftCapability: { available: boolean; reason?: string }
  /** Main-owned fallback: the whole old base is still an unpublished desired state. */
  unpublishedBase?: boolean
  savedPublication?: { path: string; sha256: string }
}
export interface PdfDraftActivation {
  token: string
  sourceGeneration: number
  mode: 'native' | 'workspace'
  sequenceFloor?: number
}
export interface PdfDraftSnapshotRequest {
  token: string
  sequence: number
  state: ArrayBuffer
}
export interface PdfDraftCloseFloor {
  token: string
  readId: string
  throughSequence: number
}
export interface PdfCopyReceipt {
  copyId: string
  token: string
  throughSequence: number
  requestedStateSha256: string
  pdfSha256: string
  representedIds: string[]
  pageMap: Array<[number, number]>
  complete: boolean
  skipped: string[]
  outputPath: string
  representedComplete?: boolean
  adopted: boolean
  checkpoint?: PdfSourceRead
  cleanupWarning?: string
}
export interface PdfWorkspaceSaveProof {
  token: string
  sequence: number
  state: ArrayBuffer
  renderedStampConfig: EditSnapshot['stampCfg']
}
export interface PdfSaveFallbackRequest {
  copyId: string
  fromReadId: string
  state: ArrayBuffer
}
export interface PdfSaveFallbackResult {
  read: PdfSourceRead
  recordedStateSha256: string
}
export type PdfCloseIntent = 'save' | 'discard' | 'clean'
export interface PdfCloseState {
  stamp: CloseLeaseStamp
  pending: boolean
  busy: boolean
}
export interface PdfCloseRequest {
  ticket: CloseLeaseTicket
  intent: PdfCloseIntent
  approvedStamp?: CloseLeaseStamp
  restoreRecoveryOnCancel: boolean
}
export interface PdfCloseReceipt {
  phase: 'prepared' | 'ready'
  ticket: CloseLeaseTicket
  stamp: CloseLeaseStamp
  intent: PdfCloseIntent
  cleanupId?: string
}
export interface PdfClosePrepared {
  ticket: CloseLeaseTicket
  ok: boolean
  stamp?: CloseLeaseStamp
  state?: ArrayBuffer
  draftFloor?: PdfDraftCloseFloor | null
  error?: string
}
export interface PdfCloseRelease {
  ticket: CloseLeaseTicket
  closed: boolean
  resumeRecovery: boolean
}

const rootKeys = [
  'version',
  'edits',
  'outline',
  'text',
  'comments',
  'forms',
  'annotations',
  'redactions',
  'pendingEditors',
  'view',
]
const editKeys = [
  'markups',
  'annotDeletes',
  'noteEdits',
  'drawings',
  'textEdits',
  'textInserts',
  'imageEdits',
  'stampCfg',
  'formEdits',
  'formFields',
  'blankPages',
  'formWidgetEdits',
  'rotations',
  'deleted',
  'order',
  'metadata',
]
const forbidden = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'password',
  'redactionApplyConfirmed',
  'redactionRequestInFlight',
  'privateKey',
  'p12',
  'signer',
])
const pendingEditorKinds = new Set([
  'link',
  'bookmark-title',
  'form-field',
  'date-field',
  'properties',
  'stamp',
  'bates',
  'signature',
])
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
function keys(
  value: unknown,
  expected: string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !plain(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(`Unsupported ${label}; the previous recovery copy was kept.`)
}
export function validatePdfWorkspaceGraph(value: unknown): void {
  let nodes = 0
  let encodedBytes = 0
  const charge = (bytes: number) => {
    encodedBytes += bytes
    if (encodedBytes > PDF_WORKSPACE_LIMITS.entryBytes)
      throw new Error('Complete PDF pending content exceeds its encoded-entry budget.')
  }
  const stringBytes = (text: string): number => {
    let raw = 0,
      encoded = 2
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code < 0x80) {
        raw++
        encoded += code < 0x20 ? 6 : code === 34 || code === 92 ? 2 : 1
      } else if (code < 0x800) {
        raw += 2
        encoded += 2
      } else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
      ) {
        raw += 4
        encoded += 4
        index++
      } else if (code >= 0xd800 && code <= 0xdfff) {
        raw += 3
        encoded += 6
      } else {
        raw += 3
        encoded += 3
      }
      if (raw > PDF_WORKSPACE_LIMITS.textBytes)
        throw new Error('PDF recovery contains text larger than 4 MiB.')
    }
    return encoded
  }
  const seen = new Set<object>()
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > PDF_WORKSPACE_LIMITS.graphNodes || depth > PDF_WORKSPACE_LIMITS.graphDepth)
      throw new Error('PDF recovery state exceeds its graph limit.')
    if (node === null || typeof node === 'boolean') {
      charge(5)
      return
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error('PDF recovery contains an invalid number.')
      charge(String(node).length)
      return
    }
    if (typeof node === 'string') {
      charge(stringBytes(node))
      return
    }
    if (typeof node !== 'object' || seen.has(node))
      throw new Error('PDF recovery contains unsupported or circular data.')
    seen.add(node)
    charge(2)
    if (Array.isArray(node))
      for (const child of node) {
        charge(1)
        visit(child, depth + 1)
      }
    else {
      if (!plain(node)) throw new Error('PDF recovery accepts plain data only.')
      for (const [key, child] of Object.entries(node)) {
        if (forbidden.has(key))
          throw new Error('PDF recovery refuses secrets or restored action authorization.')
        charge(stringBytes(key) + 2)
        visit(child, depth + 1)
      }
    }
    seen.delete(node)
  }
  visit(value, 0)
}
function entries(value: unknown, kind: 'string' | 'number', label: string): void {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  const seen = new Set<string | number>()
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== kind || seen.has(item[0]))
      throw new Error(`Invalid or duplicate ${label} entry.`)
    seen.add(item[0])
  }
}
export function validatePdfWorkspaceState(value: unknown): asserts value is PdfWorkspaceStateV1 {
  validatePdfWorkspaceGraph(value)
  keys(value, rootKeys, 'PDF recovery state')
  if (value.version !== 1) throw new Error('Unsupported PDF recovery version.')
  keys(value.edits, editKeys, 'PDF edit buckets')
  const edits = value.edits
  for (const name of [
    'markups',
    'annotDeletes',
    'noteEdits',
    'drawings',
    'textEdits',
    'textInserts',
    'imageEdits',
    'formFields',
    'blankPages',
  ]) {
    if (!Array.isArray(edits[name])) throw new Error(`Invalid PDF ${name} bucket.`)
    const ids = new Set<string>()
    for (const item of edits[name] as unknown[]) {
      if (
        !plain(item) ||
        typeof item.id !== 'string' ||
        !item.id ||
        item.id.length > 1024 ||
        ids.has(item.id)
      )
        throw new Error(`Invalid or duplicate PDF ${name} identity.`)
      ids.add(item.id)
    }
  }
  entries(edits.formEdits, 'string', 'form edits')
  entries(edits.formWidgetEdits, 'string', 'widget edits')
  entries(edits.rotations, 'number', 'rotations')
  if (
    !Array.isArray(edits.deleted) ||
    !edits.deleted.every((n) => Number.isSafeInteger(n) && n >= 0) ||
    new Set(edits.deleted).size !== edits.deleted.length
  )
    throw new Error('Invalid PDF deleted pages.')
  if (
    edits.order !== null &&
    (!Array.isArray(edits.order) ||
      !edits.order.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      new Set(edits.order).size !== edits.order.length)
  )
    throw new Error('Invalid PDF page order.')
  keys(value.outline, ['pending', 'selected'], 'outline state')
  keys(
    value.text,
    ['draft', 'caret', 'pendingInsert', 'insertPointer', 'insertEditId', 'staticEditor'],
    'text state',
  )
  keys(
    value.comments,
    ['placement', 'newBody', 'createdMs', 'replies', 'rewrite', 'active', 'author'],
    'comment state',
  )
  keys(
    value.forms,
    [
      'activeWidgetId',
      'selectedFieldIds',
      'freshFieldId',
      'heldFieldId',
      'tool',
      'preview',
      'signatureTarget',
    ],
    'form state',
  )
  keys(
    value.annotations,
    ['selected', 'pendingLink', 'pendingSign', 'imagePick', 'pendingStaticFill', 'staticFormFills'],
    'annotation state',
  )
  keys(value.redactions, ['regions', 'selectedId'], 'redaction selection')
  keys(value.view, ['page', 'scale', 'sidebar', 'ribbon', 'dialogs'], 'view state')
  keys(value.view.dialogs, ['properties', 'stamp', 'bates', 'signature'], 'open PDF dialogs')
  if (Object.values(value.view.dialogs).some((item) => typeof item !== 'boolean'))
    throw new Error('Invalid PDF dialog state.')
  entries(value.comments.replies, 'string', 'comment replies')
  entries(value.pendingEditors, 'string', 'pending editors')
  if (
    typeof value.comments.newBody !== 'string' ||
    typeof value.comments.author !== 'string' ||
    !Array.isArray(value.redactions.regions) ||
    !Array.isArray(value.forms.selectedFieldIds) ||
    !Array.isArray(value.annotations.staticFormFills)
  )
    throw new Error('Invalid PDF pending content.')
  const integer = (item: unknown): item is number =>
    Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= 1000000
  const string = (item: unknown, maximum = 1024): item is string =>
    typeof item === 'string' && item.length <= maximum && !item.includes('\0')
  const identity = (item: unknown): boolean => item === null || string(item)
  const vector = (item: unknown, count: number): boolean =>
    Array.isArray(item) &&
    item.length === count &&
    item.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e9)
  const pageObject = (item: unknown): boolean => plain(item) && integer(item.pageIndex)
  const rectangle = (item: unknown): boolean =>
    vector(item, 4) &&
    (item as number[])[2]! >= (item as number[])[0]! &&
    (item as number[])[3]! >= (item as number[])[1]!
  const nullable = (item: unknown, test: (candidate: unknown) => boolean, label: string): void => {
    if (item !== null && !test(item)) throw new Error(`Invalid PDF ${label}.`)
  }
  if (
    !value.forms.selectedFieldIds.every((item) => string(item)) ||
    new Set(value.forms.selectedFieldIds).size !== value.forms.selectedFieldIds.length ||
    !identity(value.forms.activeWidgetId) ||
    !identity(value.forms.freshFieldId) ||
    !identity(value.forms.heldFieldId) ||
    typeof value.forms.preview !== 'boolean' ||
    !identity(value.forms.tool)
  )
    throw new Error('Invalid PDF form selection.')
  if (
    !integer(value.view.page) ||
    value.view.page < 1 ||
    typeof value.view.scale !== 'number' ||
    value.view.scale < 0.01 ||
    value.view.scale > 100 ||
    !identity(value.view.sidebar) ||
    !string(value.view.ribbon)
  )
    throw new Error('Invalid PDF reading position.')
  nullable(
    value.outline.selected,
    (item) => Array.isArray(item) && item.every(integer),
    'outline target',
  )
  nullable(
    value.outline.pending,
    (item) => {
      if (!plain(item)) return false
      keys(item, ['tree', 'unresolvable', 'edited', 'editing'], 'outline draft')
      return (
        (item.tree === null || Array.isArray(item.tree)) &&
        typeof item.unresolvable === 'boolean' &&
        typeof item.edited === 'boolean' &&
        typeof item.editing === 'boolean'
      )
    },
    'outline draft',
  )
  nullable(
    value.text.caret,
    (item) =>
      vector(item, 2) &&
      (item as number[]).every(integer) &&
      (item as number[])[0]! <= (item as number[])[1]!,
    'text selection',
  )
  nullable(
    value.text.draft,
    (item) =>
      plain(item) &&
      integer(item.origIdx) &&
      typeof item.value === 'string' &&
      rectangle(item.rect),
    'active text draft',
  )
  nullable(
    value.text.insertPointer,
    (item) =>
      pageObject(item) &&
      typeof (item as Record<string, unknown>).x === 'number' &&
      typeof (item as Record<string, unknown>).y === 'number',
    'text insertion pointer',
  )
  if (!identity(value.text.insertEditId)) throw new Error('Invalid PDF inserted text identity.')
  keys(
    value.text.staticEditor,
    ['open', 'purpose', 'value', 'size', 'color', 'align', 'target'],
    'static text editor',
  )
  if (
    typeof value.text.staticEditor.open !== 'boolean' ||
    !['form', 'insert'].includes(value.text.staticEditor.purpose as string) ||
    typeof value.text.staticEditor.value !== 'string' ||
    typeof value.text.staticEditor.size !== 'number' ||
    value.text.staticEditor.size <= 0 ||
    value.text.staticEditor.size > 10000 ||
    !string(value.text.staticEditor.color, 128) ||
    !['left', 'center', 'right'].includes(value.text.staticEditor.align as string)
  )
    throw new Error('Invalid PDF static text editor.')
  nullable(
    value.comments.placement,
    (item) => plain(item) && integer(item.origIdx) && vector(item.at, 2),
    'new comment placement',
  )
  nullable(
    value.comments.active,
    (item) => plain(item) && integer(item.origIdx) && string(item.rootKey),
    'active comment',
  )
  nullable(
    value.comments.rewrite,
    (item) =>
      plain(item) &&
      integer(item.origIdx) &&
      string(item.rootKey) &&
      string(item.itemKey) &&
      typeof item.text === 'string',
    'comment rewrite',
  )
  if (
    value.comments.createdMs !== null &&
    (typeof value.comments.createdMs !== 'number' ||
      value.comments.createdMs < 0 ||
      value.comments.createdMs > 8640000000000000)
  )
    throw new Error('Invalid PDF comment timestamp.')
  for (const [id, body] of value.comments.replies as unknown[][])
    if (!string(id) || typeof body !== 'string') throw new Error('Invalid PDF comment reply.')
  for (const [id, editor] of value.pendingEditors as unknown[][]) {
    if (!string(id)) throw new Error('Invalid pending editor identity.')
    keys(editor, ['kind', 'value'], 'pending editor')
    if (!pendingEditorKinds.has(editor.kind as string))
      throw new Error('Unsupported PDF pending editor; the complete workspace was refused.')
    if (id === 'signature-image' && editor.value !== null) {
      keys(editor.value, ['image', 'width', 'height'], 'signature image')
      if (
        typeof editor.value.image !== 'string' ||
        !integer(editor.value.width) ||
        !integer(editor.value.height) ||
        editor.value.width < 1 ||
        editor.value.height < 1 ||
        editor.value.width > 1600 ||
        editor.value.height > 1600
      )
        throw new Error('Invalid PDF signature image dimensions.')
    }
  }
  const regionIds = new Set<string>()
  for (const region of value.redactions.regions) {
    if (
      !plain(region) ||
      !string(region.id) ||
      regionIds.has(region.id) ||
      !pageObject(region) ||
      !rectangle(region.rect)
    )
      throw new Error('Invalid PDF redaction selection.')
    regionIds.add(region.id)
  }
  if (
    !identity(value.redactions.selectedId) ||
    (value.redactions.selectedId !== null && !regionIds.has(value.redactions.selectedId as string))
  )
    throw new Error('Unknown selected redaction region.')
  nullable(
    value.annotations.pendingLink,
    (item) => pageObject(item) && rectangle((item as Record<string, unknown>).rect),
    'pending link rectangle',
  )
  for (const [index, delta] of edits.rotations as unknown[][])
    if (!integer(index) || typeof delta !== 'number' || !Number.isInteger(delta) || delta % 90)
      throw new Error('Invalid PDF page rotation.')
  for (const name of ['formEdits', 'formWidgetEdits'] as const)
    for (const [id, input] of edits[name] as unknown[][])
      if (!string(id) || !plain(input)) throw new Error(`Invalid ${name} entry.`)
  for (const name of ['stampCfg', 'metadata'] as const) nullable(edits[name], plain, name)
  let imagePixels = 0
  const seenImages = new Set<string>()
  const binary = (item: unknown): void => {
    if (
      typeof item !== 'string' ||
      item.length > PDF_WORKSPACE_LIMITS.textBytes ||
      item.length % 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item)
    )
      throw new Error('PDF authored image data is not bounded canonical base64.')
    if (
      item.endsWith('==') &&
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
        item[item.length - 3]!,
      ) %
        16 !==
        0
    )
      throw new Error('PDF image base64 has noncanonical padding bits.')
    if (
      item.endsWith('=') &&
      !item.endsWith('==') &&
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
        item[item.length - 2]!,
      ) %
        4 !==
        0
    )
      throw new Error('PDF image base64 has noncanonical padding bits.')
    if (seenImages.has(item)) return
    seenImages.add(item)
    // Header inspection does not allocate/decompress the authored image.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const header: number[] = []
    let accumulator = 0,
      bits = 0
    for (const character of item.slice(0, 44)) {
      const value = alphabet.indexOf(character)
      if (value < 0) break
      accumulator = (accumulator << 6) | value
      bits += 6
      if (bits >= 8) {
        bits -= 8
        header.push((accumulator >>> bits) & 255)
      }
    }
    if (
      header.length < 24 ||
      [137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => header[index] !== byte) ||
      header[12] !== 73 ||
      header[13] !== 72 ||
      header[14] !== 68 ||
      header[15] !== 82
    )
      throw new Error('PDF authored images must be PNG data with a valid bounded header.')
    const uint32 = (offset: number) =>
      header[offset]! * 16777216 +
      header[offset + 1]! * 65536 +
      header[offset + 2]! * 256 +
      header[offset + 3]!
    const width = uint32(16),
      height = uint32(20),
      pixels = width * height
    if (
      width < 1 ||
      height < 1 ||
      width > 16384 ||
      height > 16384 ||
      pixels > PDF_WORKSPACE_LIMITS.imagePixels
    )
      throw new Error('A PDF authored image exceeds its recovery pixel budget.')
    imagePixels += pixels
    if (imagePixels > PDF_WORKSPACE_LIMITS.aggregateImagePixels)
      throw new Error('PDF authored images exceed their aggregate recovery pixel budget.')
  }
  const inspectImages = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) inspectImages(child)
      return
    }
    if (!plain(item)) return
    for (const [key, child] of Object.entries(item)) {
      if (['image', 'png', 'opacityBase'].includes(key) && typeof child === 'string') binary(child)
      else inspectImages(child)
    }
  }
  inspectImages(value)
  const outlineTree = (tree: unknown): void => {
    if (!Array.isArray(tree)) throw new Error('Invalid PDF outline tree.')
    for (const node of tree) {
      if (
        !plain(node) ||
        !string(node.title, PDF_WORKSPACE_LIMITS.textBytes) ||
        !integer(node.pageIndex) ||
        Object.keys(node).some((key) => !['title', 'pageIndex', 'top', 'children'].includes(key)) ||
        (node.top !== undefined && node.top !== null && typeof node.top !== 'number')
      )
        throw new Error('Unsupported PDF outline node.')
      if (node.children !== undefined) outlineTree(node.children)
    }
  }
  const pendingOutline = value.outline.pending
  if (pendingOutline !== null) {
    if (!plain(pendingOutline)) throw new Error('Invalid PDF outline draft.')
    if (pendingOutline.tree !== null) outlineTree(pendingOutline.tree)
  }
  validatePdfWorkspaceNested(value as unknown as PdfWorkspaceStateV1)
}
/** Bound nesting/token allocation before JSON.parse allocates the imported graph.
 * Syntax remains the native parser's responsibility; this scan never executes it. */
export function preflightPdfWorkspaceJson(source: string, envelope = false): void {
  let depth = 0,
    nodes = 0,
    quoted = false,
    escaped = false,
    primitive = false
  const maximum = PDF_WORKSPACE_LIMITS.graphDepth + 1 + (envelope ? 3 : 0)
  const charge = () => {
    if (++nodes > PDF_WORKSPACE_LIMITS.graphNodes * 2 + (envelope ? 32 : 0))
      throw new Error('The complete PDF recovery graph exceeds its token budget.')
  }
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      primitive = false
      charge()
    } else if (character === '{' || character === '[') {
      if (++depth > maximum)
        throw new Error('PDF recovery nesting exceeds its complete-graph limit.')
      primitive = false
      charge()
    } else if (character === '}' || character === ']') {
      depth--
      primitive = false
    } else if (
      character === ':' ||
      character === ',' ||
      character === ' ' ||
      character === '\n' ||
      character === '\r' ||
      character === '\t'
    )
      primitive = false
    else if (!primitive) {
      primitive = true
      charge()
    }
  }
}
export function encodePdfWorkspaceState(state: PdfWorkspaceStateV1): ArrayBuffer {
  validatePdfWorkspaceState(state)
  const bytes = new TextEncoder().encode(JSON.stringify(state))
  if (bytes.byteLength > PDF_WORKSPACE_LIMITS.entryBytes)
    throw new Error('Complete PDF recovery state exceeds 16 MiB.')
  return bytes.buffer as ArrayBuffer
}
export function decodePdfWorkspaceState(buffer: ArrayBuffer): PdfWorkspaceStateV1 {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > PDF_WORKSPACE_LIMITS.entryBytes)
    throw new Error('Invalid or oversized PDF recovery request.')
  const json = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer))
  preflightPdfWorkspaceJson(json)
  const result: unknown = JSON.parse(json)
  validatePdfWorkspaceState(result)
  return result
}
export function serializePdfEdits(edits: EditSnapshot): PdfWorkspaceEdits {
  return {
    ...edits,
    formEdits: [...edits.formEdits],
    formWidgetEdits: [...edits.formWidgetEdits],
    rotations: [...edits.rotations],
    deleted: [...edits.deleted],
  }
}
export function deserializePdfEdits(edits: PdfWorkspaceEdits): EditSnapshot {
  return {
    ...edits,
    formEdits: new Map(edits.formEdits),
    formWidgetEdits: new Map(edits.formWidgetEdits),
    rotations: new Map(edits.rotations),
    deleted: new Set(edits.deleted),
  }
}
export function pdfWorkspacePendingReasons(state: PdfWorkspaceStateV1): string[] {
  const reasons: string[] = []
  for (const [bucket, value] of Object.entries(state.edits))
    if (Array.isArray(value) ? value.length > 0 : value !== null) reasons.push(`edits:${bucket}`)
  if (state.outline.pending?.edited) reasons.push('outline')
  if (state.text.draft) reasons.push('active text')
  if (state.text.pendingInsert || state.text.staticEditor.open) reasons.push('unplaced text')
  if (
    state.comments.placement ||
    state.comments.newBody ||
    state.comments.replies.some(([, text]) => text.length > 0) ||
    state.comments.rewrite
  )
    reasons.push('pending comments')
  if (
    state.annotations.pendingLink ||
    state.annotations.pendingSign ||
    state.annotations.imagePick ||
    state.annotations.pendingStaticFill
  )
    reasons.push('unplaced content')
  if (state.redactions.regions.length) reasons.push('redaction selections have not been applied')
  if (state.pendingEditors.length) reasons.push('open editor content')
  return reasons
}
/** Optional model properties with undefined mean absence, never content. Arrays cannot
 * contain absent slots, functions, proxies or DOM objects; those captures fail visibly. */
export function plainPdfWorkspaceData<T>(value: T): T {
  let nodes = 0
  const ancestors = new Set<object>()
  const copy = (node: unknown, depth: number): unknown => {
    if (++nodes > PDF_WORKSPACE_LIMITS.graphNodes || depth > PDF_WORKSPACE_LIMITS.graphDepth)
      throw new Error('PDF pending content exceeds its graph limit.')
    if (
      node === null ||
      typeof node === 'string' ||
      typeof node === 'boolean' ||
      (typeof node === 'number' && Number.isFinite(node))
    )
      return node
    if (!node || typeof node !== 'object' || ancestors.has(node))
      throw new Error('PDF pending content contains unsupported data.')
    ancestors.add(node)
    let result: unknown
    if (Array.isArray(node)) result = node.map((item) => copy(item, depth + 1))
    else {
      if (!plain(node)) throw new Error('PDF pending content must contain plain objects only.')
      const object: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node)) {
        if (forbidden.has(key))
          throw new Error('PDF pending content includes a secret or action authorization.')
        if (child !== undefined) object[key] = copy(child, depth + 1)
      }
      result = object
    }
    ancestors.delete(node)
    return result
  }
  return copy(value, 0) as T
}
