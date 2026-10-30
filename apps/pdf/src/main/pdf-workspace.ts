import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { PDFDocument, EncryptedPDFError } from 'pdf-lib'
import { publishExclusiveCopy } from '@vantage/electron-utils/publish-exclusive'
import {
  PDF_WORKSPACE_MAGIC,
  PDF_WORKSPACE_LIMITS,
  validatePdfWorkspaceState,
  preflightPdfWorkspaceJson,
  type PdfWorkspaceEnvelopeV1,
  type PdfWorkspaceStateV1,
} from '../shared/pdf-workspace'
import type { SavePdfRequest } from '../shared/ipc'
import {
  PdfPrivateBaseRegistry,
  type PdfPrivateLineage,
  type PdfPrivateRecord,
} from './pdf-private-bases'

export const pdfDigest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
export type PdfProtection =
  { kind: 'unencrypted'; pageCount: number } | { kind: 'protected' | 'unknown'; reason: string }
/** Classifies exact raw bytes, without a password or an ignoreEncryption fallback. */
export async function classifyPdfWorkspaceBase(
  bytes: Uint8Array,
  maximum = PDF_WORKSPACE_LIMITS.sourceBytes,
): Promise<PdfProtection> {
  if (!bytes.byteLength || bytes.byteLength > maximum)
    return { kind: 'unknown', reason: 'The complete PDF base exceeds the recovery limit.' }
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-')))
    return { kind: 'unknown', reason: 'The exact base is not a recognized PDF.' }
  try {
    const document = await PDFDocument.load(Uint8Array.from(bytes), { updateMetadata: false })
    if (document.isEncrypted)
      return {
        kind: 'protected',
        reason:
          'Protected PDFs can be viewed separately, but recovery will not retain decrypted copies.',
      }
    if (document.getPageCount() < 1)
      return { kind: 'unknown', reason: 'The exact PDF base has no readable pages.' }
    return { kind: 'unencrypted', pageCount: document.getPageCount() }
  } catch (error) {
    // pdf-lib's ES5 Error subclass may return a plain Error with name='Error'.
    // Match only that library's exact encrypted exception; other parse failures
    // remain unknown and are refused without creating a private base.
    return error instanceof Error &&
      (error instanceof EncryptedPDFError ||
        error.name === 'EncryptedPDFError' ||
        error.message === new EncryptedPDFError().message)
      ? { kind: 'protected', reason: 'Protected PDFs cannot be captured in PDF recovery.' }
      : {
          kind: 'unknown',
          reason: 'The exact PDF base could not be safely classified for recovery.',
        }
  }
}
export async function readPdfWorkspaceFile(
  path: string,
  maximum = PDF_WORKSPACE_LIMITS.entryBytes,
): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum)
      throw new Error('The PDF recovery file exceeds its complete-entry limit.')
    const data = Buffer.alloc(before.size)
    let offset = 0
    while (offset < data.length) {
      const chunk = await handle.read(data, offset, data.length - offset, offset)
      if (!chunk.bytesRead) throw new Error('The PDF source changed while reading.')
      offset += chunk.bytesRead
    }
    const after = await handle.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino
    )
      throw new Error('The PDF source changed while reading.')
    return data
  } finally {
    await handle.close()
  }
}
function canonicalBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(PDF_WORKSPACE_LIMITS.sourceBytes / 3) * 4 ||
    value.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error('The PDF base encoding is invalid or oversized.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > PDF_WORKSPACE_LIMITS.sourceBytes || bytes.toString('base64') !== value)
    throw new Error('The PDF base encoding is not canonical.')
  return bytes
}
function exactKeys(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === allowed.length &&
    allowed.every((key) => Object.hasOwn(value, key))
  )
}
export async function decodePdfWorkspace(
  bytes: Buffer,
): Promise<{ envelope: PdfWorkspaceEnvelopeV1; base: Buffer; pageCount: number }> {
  if (
    bytes.length > PDF_WORKSPACE_LIMITS.entryBytes ||
    !bytes.subarray(0, PDF_WORKSPACE_MAGIC.length).equals(Buffer.from(PDF_WORKSPACE_MAGIC))
  )
    throw new Error('This is not a supported Vantage PDF workspace.')
  const json = new TextDecoder('utf-8', { fatal: true }).decode(
    bytes.subarray(PDF_WORKSPACE_MAGIC.length),
  )
  preflightPdfWorkspaceJson(json, true)
  const raw: unknown = JSON.parse(json)
  if (
    !exactKeys(raw, ['format', 'version', 'source', 'state']) ||
    raw.format !== 'vantage.pdf-workspace' ||
    raw.version !== 1 ||
    !exactKeys(raw.source, ['displayName', 'originalPath', 'sha256', 'bytes', 'protection'])
  )
    throw new Error('Unsupported PDF workspace schema.')
  const source = raw.source
  if (
    typeof source.displayName !== 'string' ||
    source.displayName.length > 1024 ||
    source.displayName.includes('\0') ||
    (source.originalPath !== null &&
      (typeof source.originalPath !== 'string' ||
        source.originalPath.length > 32768 ||
        source.originalPath.includes('\0'))) ||
    typeof source.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    source.protection !== 'unencrypted'
  )
    throw new Error('Invalid PDF workspace source metadata.')
  validatePdfWorkspaceState(raw.state)
  const base = canonicalBase64(source.bytes)
  if (pdfDigest(base) !== source.sha256)
    throw new Error('The embedded PDF failed its integrity check.')
  const protection = await classifyPdfWorkspaceBase(base)
  if (protection.kind !== 'unencrypted') throw new Error(protection.reason)
  validatePdfWorkspacePageBounds(raw.state, protection.pageCount)
  return {
    envelope: raw as unknown as PdfWorkspaceEnvelopeV1,
    base,
    pageCount: protection.pageCount,
  }
}
export function encodePdfWorkspace(
  base: Buffer,
  state: PdfWorkspaceStateV1,
  metadata: { displayName: string; originalPath: string | null },
): Buffer {
  validatePdfWorkspaceState(state)
  if (
    base.length > PDF_WORKSPACE_LIMITS.sourceBytes ||
    metadata.displayName.length > 1024 ||
    (metadata.originalPath?.length ?? 0) > 32768
  )
    throw new Error('The complete PDF recovery entry exceeds its source limits.')
  const envelope: PdfWorkspaceEnvelopeV1 = {
    format: 'vantage.pdf-workspace',
    version: 1,
    source: {
      ...metadata,
      sha256: pdfDigest(base),
      bytes: base.toString('base64'),
      protection: 'unencrypted',
    },
    state,
  }
  const bytes = Buffer.from(PDF_WORKSPACE_MAGIC + JSON.stringify(envelope), 'utf8')
  if (bytes.length > PDF_WORKSPACE_LIMITS.entryBytes)
    throw new Error(
      'The complete PDF base and edits exceed the 16 MiB recovery limit; the previous recovery copy was kept.',
    )
  return bytes
}

/** Owns only generated files. Never deletes an imported workspace or original PDF. */
export class PdfPrivateBases {
  private readonly owned = new Set<string>()
  private readonly publications = new Map<string, number>()
  private readonly completed = new Map<string, string>()
  private readonly registry: PdfPrivateBaseRegistry
  private preparing = 0
  private preparingBytes = 0
  constructor(
    root: string,
    private readonly dependencies: {
      inUse?(path: string): boolean
      retained?(record: PdfPrivateRecord): void
      resolved?(id: string): Promise<void>
    } = {},
  ) {
    this.registry = new PdfPrivateBaseRegistry(root, {
      digest: pdfDigest,
      read: readPdfWorkspaceFile,
      inUse: (path) => dependencies.inUse?.(path) ?? false,
      retained: (record) => dependencies.retained?.(record),
    })
  }
  async create(owner: number, bytes: Buffer): Promise<string> {
    return this.createBounded(owner, bytes, PDF_WORKSPACE_LIMITS.sourceBytes)
  }
  private async createBounded(owner: number, bytes: Buffer, maximum: number): Promise<string> {
    if (bytes.length > maximum)
      throw new Error('The complete private PDF exceeds its bounded source limit.')
    if (
      this.preparing >= 2 ||
      this.preparingBytes + bytes.length > PDF_WORKSPACE_LIMITS.outputBytes
    )
      throw new Error(
        'Another complete private PDF is still being prepared. Its prior recovery entry was kept; retry after it finishes.',
      )
    this.preparing++
    this.preparingBytes += bytes.length
    try {
      const pinned = Buffer.from(bytes)
      const protection = await classifyPdfWorkspaceBase(pinned, maximum)
      if (protection.kind !== 'unencrypted') throw new Error(protection.reason)
      return await this.writeVerified(owner, pinned, maximum)
    } finally {
      this.preparing--
      this.preparingBytes -= bytes.length
    }
  }
  private async writeVerified(owner: number, bytes: Buffer, maximum: number): Promise<string> {
    if (this.owned.size >= 128)
      throw new Error(
        'Private PDF checkpoints still need cleanup. Close a view or retry cleanup before creating another.',
      )
    const { path } = await this.registry.reserve(owner, bytes)
    this.owned.add(path)
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (pdfDigest(await readPdfWorkspaceFile(path, maximum)) !== pdfDigest(bytes))
        throw new Error('The private PDF base failed verification.')
      await this.registry.ready(path)
      return path
    } catch (error) {
      try {
        if (this.owned.has(path)) await this.remove(path)
      } catch {
        throw new Error(
          'The private PDF checkpoint could not be prepared, and its owned temporary data needs cleanup.',
          { cause: error },
        )
      }
      throw error
    }
  }
  async remove(path: string): Promise<void> {
    const already = [...this.completed].find(([, completedPath]) => completedPath === path)
    if (already) {
      await this.dependencies.resolved?.(already[0])
      return
    }
    if (!this.owned.has(path))
      throw new Error('Refusing cleanup of a PDF base not owned by this process.')
    const id = this.registry.record(path).id
    await this.registry.remove(path)
    this.owned.delete(path)
    this.completed.set(id, path)
    while (this.completed.size > 256) this.completed.delete(this.completed.keys().next().value!)
    await this.dependencies.resolved?.(id)
  }
  async publishNew(
    bytes: Buffer,
    destination: string,
    owner = 0,
  ): Promise<{ cleanupWarning?: string }> {
    if (!/\.pdf$/i.test(destination))
      throw new Error('Choose a new .pdf file for the real PDF copy.')
    if (bytes.length > PDF_WORKSPACE_LIMITS.outputBytes)
      throw new Error('The complete PDF copy exceeds its bounded output limit.')
    if (
      this.preparing >= 2 ||
      this.preparingBytes + bytes.length > PDF_WORKSPACE_LIMITS.outputBytes
    )
      throw new Error('Another complete PDF copy is still being prepared. Retry after it finishes.')
    this.preparing++
    this.preparingBytes += bytes.length
    try {
      const pinned = Buffer.from(bytes)
      const protection = await classifyPdfWorkspaceBase(pinned, PDF_WORKSPACE_LIMITS.outputBytes)
      if (protection.kind !== 'unencrypted')
        throw new Error('The serialized PDF copy could not be verified.')
      const temporary = await this.writeVerified(owner, pinned, PDF_WORKSPACE_LIMITS.outputBytes)
      try {
        await publishExclusiveCopy(temporary, destination, {
          bytes: pinned.length,
          sha256: pdfDigest(pinned),
        })
      } catch (error) {
        try {
          await this.remove(temporary)
        } catch {
          this.publications.set(temporary, owner)
          throw new Error(
            'The PDF copy did not finish publication and its owned temporary data needs cleanup.',
            { cause: error },
          )
        }
        throw error
      }
      try {
        await this.remove(temporary)
        return {}
      } catch {
        this.publications.set(temporary, owner)
        return {
          cleanupWarning:
            'The new PDF copy was verified and saved, but its owned temporary checkpoint still needs cleanup.',
        }
      }
    } finally {
      this.preparing--
      this.preparingBytes -= bytes.length
    }
  }
  async retryPublicationCleanup(owner: number): Promise<void> {
    for (const [path, fileOwner] of this.publications)
      if (fileOwner === owner) {
        await this.remove(path)
        this.publications.delete(path)
      }
  }
  bind(path: string, lineage: PdfPrivateLineage): void {
    if (this.owned.has(path)) this.registry.bind(path, lineage)
  }
  drainOwnership(path?: string): Promise<void> {
    return path && !this.owned.has(path) ? Promise.resolve() : this.registry.drain(path)
  }
  inspectRetained(): Promise<PdfPrivateRecord[]> {
    return this.registry.discoverRetained()
  }
  async retryRetained(id: string): Promise<void> {
    if (this.completed.has(id)) {
      await this.dependencies.resolved?.(id)
      return
    }
    const path = this.registry.pathForId(id)
    await this.registry.retry(id)
    if (path) {
      this.owned.delete(path)
      this.completed.set(id, path)
    }
    await this.dependencies.resolved?.(id)
  }
  hasRetainedFor(owner: number): boolean {
    return this.registry.hasRetainedFor(owner)
  }
  owns(path: string): boolean {
    return this.owned.has(path)
  }
}

/** The receipt describes serialized content, not a renderer-provided clean boolean. */
export function pdfRepresentation(
  state: PdfWorkspaceStateV1,
  request: SavePdfRequest,
  pageCount: number,
  renderedStampConfig: PdfWorkspaceStateV1['edits']['stampCfg'],
): { representedIds: string[]; skipped: string[]; pageMap: Array<[number, number]> } {
  const representedIds: string[] = [],
    skipped: string[] = []
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const match = (
    bucket: string,
    values: Array<{ id: string }>,
    outputs: unknown[],
    input: (value: any) => unknown,
  ) => {
    const unused = [...outputs]
    for (const value of values) {
      const index = unused.findIndex((output) => equal(output, input(value)))
      if (index < 0) skipped.push(`${bucket}:${value.id}`)
      else {
        unused.splice(index, 1)
        representedIds.push(`${bucket}:${value.id}`)
      }
    }
  }
  const edits = state.edits
  match('markups', edits.markups, request.markups, ({ id: _id, ...rest }) => rest)
  match('drawings', edits.drawings, request.drawings, (value) => value.input)
  match('textEdits', edits.textEdits, request.textEdits ?? [], (value) => value.input)
  match('textInserts', edits.textInserts, request.textInserts ?? [], (value) => value.input)
  match('imageEdits', edits.imageEdits, request.imageEdits ?? [], (value) => value.input)
  match('formFields', edits.formFields, request.formFields ?? [], (value) => value.input)
  match('blankPages', edits.blankPages, request.blankPages ?? [], (value) => value.input)
  match('annotDeletes', edits.annotDeletes, request.annotDeletes ?? [], (value) => ({
    pageIndex: value.annot.pageIndex,
    objNum: value.annot.objNum,
    subtype: value.annot.type,
    rect: value.annot.rect,
    ...(value.annot.type === 'note' ? { contents: value.annot.contents } : {}),
  }))
  match('noteEdits', edits.noteEdits, request.noteEdits ?? [], (value) => ({
    pageIndex: value.annot.pageIndex,
    objNum: value.annot.objNum,
    rect: value.annot.rect,
    oldContents: value.annot.contents,
    contents: value.contents,
  }))
  for (const [key, value] of edits.formEdits) {
    if ((request.formValues ?? []).some((candidate) => equal(candidate, value)))
      representedIds.push(`formEdits:${key}`)
    else skipped.push(`formEdits:${key}`)
  }
  for (const [key, value] of edits.formWidgetEdits) {
    if ((request.formWidgetEdits ?? []).some((candidate) => equal(candidate, value)))
      representedIds.push(`formWidgetEdits:${key}`)
    else skipped.push(`formWidgetEdits:${key}`)
  }
  for (const [pageIndex, delta] of edits.rotations) {
    if (
      (request.rotations ?? []).some(
        (value) => value.pageIndex === pageIndex && value.delta === delta,
      )
    )
      representedIds.push(`rotations:${pageIndex}`)
    else skipped.push(`rotations:${pageIndex}`)
  }
  for (const index of edits.deleted) {
    if (request.deletedPages?.includes(index)) representedIds.push(`deleted:${index}`)
    else skipped.push(`deleted:${index}`)
  }
  if (edits.metadata !== null)
    (equal(edits.metadata, request.metadata) ? representedIds : skipped).push('metadata')
  if (edits.order !== null)
    (equal(
      edits.order.filter((page) => !edits.deleted.includes(page)),
      request.pageOrder,
    )
      ? representedIds
      : skipped
    ).push('order')
  if (edits.stampCfg !== null) {
    const config = edits.stampCfg
    const count =
      (config.wm?.text.trim() ? 1 : 0) +
      (config.hf &&
      [config.hf.headerLeft, config.hf.headerCenter, config.hf.headerRight].some((value) =>
        value.trim(),
      )
        ? 1
        : 0) +
      (config.hf &&
      (config.hf.pageNumber ||
        [config.hf.footerLeft, config.hf.footerCenter, config.hf.footerRight].some((value) =>
          value.trim(),
        ))
        ? 1
        : 0)
    const pages = (
      request.pageOrder ??
      Array.from({ length: pageCount + edits.blankPages.length }, (_, index) => index)
    ).filter((page) => !edits.deleted.includes(page))
    const countsMatch =
      request.stamps.length === pages.length * count &&
      pages.every(
        (page) =>
          request.stamps.filter((stamp) => stamp.pageIndex === page && stamp.image.length > 0)
            .length === count,
      )
    ;(equal(config, renderedStampConfig) && countsMatch ? representedIds : skipped).push('stampCfg')
  }
  if (state.outline.pending?.edited)
    (equal(state.outline.pending.tree, request.outline) ? representedIds : skipped).push('outline')
  if (state.text.draft || state.text.pendingInsert || state.text.staticEditor.open)
    skipped.push('unsubmitted text editor')
  if (
    state.comments.placement ||
    state.comments.newBody ||
    state.comments.replies.some(([, body]) => body) ||
    state.comments.rewrite
  )
    skipped.push('unsubmitted comment content')
  if (
    state.annotations.pendingLink ||
    state.annotations.pendingSign ||
    state.annotations.imagePick ||
    state.annotations.pendingStaticFill
  )
    skipped.push('unplaced content')
  if (state.pendingEditors.length) skipped.push('unsubmitted editor content')
  if (state.redactions.regions.length) {
    const regions = state.redactions.regions.map(({ id: _id, ...region }) => region)
    if (equal(regions, request.redactions))
      representedIds.push(...state.redactions.regions.map((region) => `redactions:${region.id}`))
    else skipped.push('redaction selections remain unapplied or differ from the authorized request')
  }
  if (
    request.staticFormFills !== undefined &&
    !equal(state.annotations.staticFormFills, request.staticFormFills)
  )
    skipped.push('static form content changed during capture')
  const pageOrder = request.pageOrder ?? edits.order
  const highest = Math.max(
    pageCount - 1,
    ...(pageOrder ?? []),
    ...edits.blankPages.map((value) => value.input.pageIndex),
    ...edits.rotations.map(([index]) => index),
    ...edits.deleted,
  )
  const originalOrder = pageOrder ?? Array.from({ length: highest + 1 }, (_, index) => index)
  const pageMap: Array<[number, number]> = originalOrder
    .filter((index) => !edits.deleted.includes(index))
    .map((index, output) => [index, output])
  return { representedIds, skipped, pageMap }
}
export function validatePdfWorkspacePageBounds(
  state: PdfWorkspaceStateV1,
  basePages: number,
): void {
  const blanks = state.edits.blankPages.map((value) => value.input.pageIndex).sort((a, b) => a - b)
  if (blanks.some((page, index) => page !== basePages + index))
    throw new Error('PDF recovery blank-page identities do not follow its embedded base.')
  const total = basePages + blanks.length
  const page = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < total
  const check = (value: unknown) => {
    if (!page(value))
      throw new Error('PDF recovery content refers to a page outside its embedded base.')
  }
  for (const name of [
    'markups',
    'drawings',
    'textEdits',
    'textInserts',
    'imageEdits',
    'formFields',
  ] as const)
    for (const value of state.edits[name])
      check('input' in value ? value.input.pageIndex : value.pageIndex)
  for (const value of state.edits.annotDeletes) check(value.annot.pageIndex)
  for (const value of state.edits.noteEdits) check(value.annot.pageIndex)
  for (const [index] of state.edits.rotations) check(index)
  for (const index of state.edits.deleted) check(index)
  if (state.edits.order) for (const index of state.edits.order) check(index)
  if (state.text.draft) check(state.text.draft.origIdx)
  if (state.text.insertPointer) check(state.text.insertPointer.pageIndex)
  for (const value of [state.comments.placement, state.comments.rewrite, state.comments.active])
    if (value) check(value.origIdx)
  if (state.annotations.pendingLink) check(state.annotations.pendingLink.pageIndex)
  for (const region of state.redactions.regions) check(region.pageIndex)
  if (state.forms.signatureTarget) check(state.forms.signatureTarget.pageIndex)
  for (const fill of state.annotations.staticFormFills) check(fill.pageIndex)
  const selected = state.annotations.selected
  if (selected?.kind === 'savedMarkup') check(selected.annot.pageIndex)
  if (selected?.kind === 'pageImage') check(selected.ref.pageIndex)
}
