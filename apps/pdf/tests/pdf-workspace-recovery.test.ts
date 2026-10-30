// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFDocument } from 'pdf-lib'
import { completeWorkspace, emptyWorkspace } from './fixtures/pdf-workspace'
import { decodePdfWorkspaceState, encodePdfWorkspaceState, deserializePdfEdits, serializePdfEdits, PDF_WORKSPACE_MAGIC, PDF_WORKSPACE_LIMITS } from '../src/shared/pdf-workspace'
import { classifyPdfWorkspaceBase, decodePdfWorkspace, encodePdfWorkspace, pdfDigest, pdfRepresentation, PdfPrivateBases } from '../src/main/pdf-workspace'

const directories: string[] = []
async function directory() { const path = await mkdtemp(join(tmpdir(), 'pdf-workspace-')); directories.push(path); return path }
async function base() { const document = await PDFDocument.create(); document.addPage([200, 300]); return Buffer.from(await document.save()) }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('complete PDF workspace representation', () => {
  it('round-trips every EditSnapshot bucket and all active authoring surfaces', async () => {
    const original = await base(), state = completeWorkspace()
    const bytes = encodePdfWorkspace(original, state, { displayName: 'Draft.pdf', originalPath: 'missing-original.pdf' })
    expect(bytes.subarray(0, PDF_WORKSPACE_MAGIC.length).toString()).toBe(PDF_WORKSPACE_MAGIC)
    const decoded = await decodePdfWorkspace(bytes)
    expect(decoded.base).toEqual(original)
    expect(decoded.envelope.state).toEqual(state)
    expect(Object.values(decoded.envelope.state.edits).every(value => value !== null && (Array.isArray(value) ? value.length > 0 : true))).toBe(true)
    expect(serializePdfEdits(deserializePdfEdits(decoded.envelope.state.edits))).toEqual(state.edits)
    expect(decoded.envelope.state.redactions).toEqual(state.redactions)
    expect(JSON.stringify(decoded.envelope.state)).not.toContain('redactionApplyConfirmed')
  })
  it('is independent of an original file that was removed or replaced', async () => {
    const path = await directory(), original = await base()
    const old = join(path, 'original.pdf'), workspace = join(path, 'Recovered.vpdfdraft')
    await writeFile(old, original)
    await writeFile(workspace, encodePdfWorkspace(original, completeWorkspace(), { displayName: 'Original.pdf', originalPath: old }))
    await writeFile(old, Buffer.from('external replacement, never read as a recovery base'))
    const decoded = await decodePdfWorkspace(await readFile(workspace))
    expect(pdfDigest(decoded.base)).toBe(pdfDigest(original))
    await rm(old)
    expect((await decodePdfWorkspace(await readFile(workspace))).base).toEqual(original)
  })
  it('classifies exact encrypted bytes before creating any private base', async () => {
    // Genuine AESv2/R4 PDF, independently checked by pinned qpdf12.4.2. The
    // fixture's plaintext password is test material, never requested or used by
    // recovery. pdf-lib1.17.1 throws an ordinary Error with name='Error'.
    const bytes = await readFile(new URL('./fixtures/genuine-encrypted.pdf', import.meta.url))
    expect(pdfDigest(bytes)).toBe('ba01bcbdc121c9b28ab34c7d1a015f05db732665b1f67cf53508cf1b462b5d6c')
    await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/)
    expect((await classifyPdfWorkspaceBase(bytes)).kind).toBe('protected')
    const path = await directory(), bases = new PdfPrivateBases(join(path, 'private'))
    await expect(bases.create(1, bytes)).rejects.toThrow(/protect/i)
    await expect(readFile(join(path, 'private', 'base.pdf'))).rejects.toThrow()
    const envelope = Buffer.from(PDF_WORKSPACE_MAGIC + JSON.stringify({ format: 'vantage.pdf-workspace', version: 1, source: { displayName: 'Forged.pdf', originalPath: null, sha256: pdfDigest(bytes), bytes: bytes.toString('base64'), protection: 'unencrypted' }, state: emptyWorkspace() }))
    await expect(decodePdfWorkspace(envelope)).rejects.toThrow(/protect/i)
  })
  it('refuses unknown, oversized and tampered bases without trusting envelope metadata', async () => {
    expect((await classifyPdfWorkspaceBase(Buffer.from('not a PDF'))).kind).toBe('unknown')
    const malformed = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF')
    expect((await classifyPdfWorkspaceBase(malformed)).kind).toBe('unknown')
    const bases = new PdfPrivateBases(join(await directory(), 'malformed-private'))
    await expect(bases.create(1, malformed)).rejects.toThrow(/classified|pages/)
    expect((await classifyPdfWorkspaceBase(Buffer.alloc(PDF_WORKSPACE_LIMITS.sourceBytes + 1))).kind).toBe('unknown')
    const bytes = encodePdfWorkspace(await base(), emptyWorkspace(), { displayName: 'Draft.pdf', originalPath: null })
    const json = JSON.parse(bytes.subarray(PDF_WORKSPACE_MAGIC.length).toString())
    json.source.sha256 = '0'.repeat(64)
    await expect(decodePdfWorkspace(Buffer.from(PDF_WORKSPACE_MAGIC + JSON.stringify(json)))).rejects.toThrow(/integrity/i)
    json.source.sha256 = pdfDigest(Buffer.from(json.source.bytes, 'base64')); json.source.bytes += '='
    await expect(decodePdfWorkspace(Buffer.from(PDF_WORKSPACE_MAGIC + JSON.stringify(json)))).rejects.toThrow(/encoding/i)
  })
  it.each([
    ['unknown bucket', (state: ReturnType<typeof completeWorkspace>) => Object.assign(state.edits, { futureEngineBucket: [] })],
    ['unknown nested model', (state: ReturnType<typeof completeWorkspace>) => Object.assign(state.edits.drawings[0]!.input, { ignoredNewContent: 'must not be dropped' })],
    ['secret authorization', (state: ReturnType<typeof completeWorkspace>) => Object.assign(state, { password: 'reserved-test-value' })],
    ['duplicate map key', (state: ReturnType<typeof completeWorkspace>) => state.edits.formEdits.push(state.edits.formEdits[0]!)],
    ['invalid pending font', (state: ReturnType<typeof completeWorkspace>) => { state.pendingEditors = state.pendingEditors.map(([id, editor]) => [id, id === 'signature-font' ? { ...editor, value: 100000 } : editor]) }],
    ['unsupported child editor', (state: ReturnType<typeof completeWorkspace>) => state.pendingEditors.push(['unknown', { kind: 'future-editor', value: 'unrepresented' }])],
    ['invalid paragraph style', (state: ReturnType<typeof completeWorkspace>) => { state.text.draft!.charStyles = ['too-short'] }],
  ] as const)('refuses %s as a complete capture', (_name, mutate) => { const state = completeWorkspace(); mutate(state); expect(() => encodePdfWorkspaceState(state)).toThrow() })
  it('bounds graph allocations before parsing a deeply nested imported state', () => {
    const text = '['.repeat(10000) + 'null' + ']'.repeat(10000)
    expect(() => decodePdfWorkspaceState(new TextEncoder().encode(text).buffer)).toThrow(/nesting/i)
    const state = emptyWorkspace(); state.comments.newBody = 'x'.repeat(PDF_WORKSPACE_LIMITS.textBytes + 1)
    expect(() => encodePdfWorkspaceState(state)).toThrow(/4 MiB/i)
  })
  it('publishes an exclusive actual PDF and preserves the workspace/source on collision', async () => {
    const path = await directory(), bytes = await base(), source = join(path, 'keep.vpdfdraft')
    const envelope = encodePdfWorkspace(bytes, completeWorkspace(), { displayName: 'Keep.pdf', originalPath: null })
    await writeFile(source, envelope)
    const target = join(path, 'New.pdf'), bases = new PdfPrivateBases(join(path, 'private'))
    await bases.publishNew(bytes, target, 1)
    expect((await readFile(target)).subarray(0, 5).toString()).toBe('%PDF-')
    expect((await PDFDocument.load(await readFile(target))).getPageCount()).toBe(1)
    await expect(bases.publishNew(Buffer.from(await (async () => { const doc = await PDFDocument.create(); doc.addPage([10, 10]); return doc.save() })()), target, 1)).rejects.toThrow()
    expect(await readFile(target)).toEqual(bytes)
    expect(await readFile(source)).toEqual(envelope)
    await expect(bases.publishNew(bytes, source, 1)).rejects.toThrow(/\.pdf/i)
  })
  it('does not acknowledge a watermark when rasterization emitted no stamp', () => {
    const state = emptyWorkspace(); state.edits.stampCfg = { wm: { text: 'Confidential', angle: 35, opacity: 0.2, color: '#000000', sizeRatio: 0.1 }, hf: null }
    const request = { path: 'unused.pdf', markups: [], drawings: [], formValues: [], stamps: [] }
    expect(pdfRepresentation(state, request, 2, state.edits.stampCfg).skipped).toContain('stampCfg')
    const complete = { ...request, stamps: [0, 1].map(pageIndex => ({ pageIndex, image: 'actual rendered PNG', rect: [0, 0, 200, 300] as [number, number, number, number] })) }
    expect(pdfRepresentation(state, complete, 2, state.edits.stampCfg).representedIds).toContain('stampCfg')
  })
})
