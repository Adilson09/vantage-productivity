// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFDocument } from 'pdf-lib'
import { PdfDraftController } from '../src/main/pdf-draft-controller'
import { PdfPrivateBases, decodePdfWorkspace, encodePdfWorkspace, pdfDigest } from '../src/main/pdf-workspace'
import { encodePdfWorkspaceState, type PdfDraftCloseFloor } from '../src/shared/pdf-workspace'
import { completeWorkspace, emptyWorkspace } from './fixtures/pdf-workspace'

const roots: string[] = []
const ownedBases: PdfPrivateBases[] = []
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-draft-controller-')); roots.push(root)
  const document = await PDFDocument.create(); document.addPage([200, 300])
  const base = Buffer.from(await document.save()), path = join(root, 'Original.pdf')
  await writeFile(path, base)
  const entries = new Map<string, Buffer>(), notices: unknown[] = [], live = new Set([1, 2])
  const hooks = { beforeWrite: async () => {}, failWrite: false, failDiscard: false }
  const bases = new PdfPrivateBases(join(root, 'private')); ownedBases.push(bases)
  const controller = new PdfDraftController({ alive: owner => live.has(owner), bases,
    write: async (id, documentPath, bytes) => { await hooks.beforeWrite(); if (hooks.failWrite) throw new Error('reserved storage failure'); entries.set(id, Buffer.from(bytes)); return { id, module: 'pdf', documentPath, sha256: pdfDigest(bytes) } },
    discard: async (id, expectedSha256) => { if (hooks.failDiscard) throw new Error('reserved cleanup failure'); const entry = entries.get(id); if (entry && expectedSha256 && pdfDigest(entry) !== expectedSha256) throw new Error('The earlier journal advanced'); entries.delete(id) },
    retireCustody: async () => {}, failure: () => {}, resolvedFailure: async () => {}, notify: (_owner, notice) => { notices.push(notice) },
  })
  const read = await controller.read(1, path), activation = controller.activate(1, read.readId)
  return { root, path, base, controller, read, activation, entries, notices, hooks, live }
}
afterEach(async () => { await Promise.allSettled(ownedBases.splice(0).map(bases => bases.drainOwnership())); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function ordinaryPublication(f: Awaited<ReturnType<typeof fixture>>, state = completeWorkspace()) {
  await f.controller.snapshot(1, { token: f.activation.token, sequence: 1, state: encodePdfWorkspaceState(state) })
  const capture = f.controller.captureCopy(1, { token: f.activation.token, sequence: 2, state: encodePdfWorkspaceState(state), renderedStampConfig: state.edits.stampCfg })
  const output = await PDFDocument.load(f.base); output.setTitle('Captured publication, deliberately distinct from immutable base')
  const bytes = Buffer.from(await output.save())
  await writeFile(f.path, bytes)
  const receipt = await f.controller.publication(1, capture, { bytes, outputPath: f.path, representedIds: [], pageMap: [[0, 0]], skipped: [], redacted: false })
  expect(receipt.representedComplete).toBe(true)
  return { receipt, bytes }
}

describe('PDF owner and complete-entry lifecycle', () => {
  it('retains the complete prior entry on unsupported/oversized or failed captures', async () => {
    const f = await fixture(), state = completeWorkspace()
    await f.controller.snapshot(1, { token: f.activation.token, sequence: 1, state: encodePdfWorkspaceState(state) })
    const previous = Buffer.from(f.entries.get(f.activation.token)!)
    f.hooks.failWrite = true
    state.comments.newBody = 'newer pending editor, still visible'
    await expect(f.controller.snapshot(1, { token: f.activation.token, sequence: 2, state: encodePdfWorkspaceState(state) })).rejects.toThrow(/storage/)
    expect(f.entries.get(f.activation.token)).toEqual(previous)
    const invalid = new TextEncoder().encode(JSON.stringify({ ...state, unknownContent: 'must not be skipped' })).buffer
    expect(() => f.controller.snapshot(1, { token: f.activation.token, sequence: 3, state: invalid })).toThrow()
    expect((await decodePdfWorkspace(previous)).envelope.state.comments.newBody).toBe('New card still typing')
  })
  it('refuses another owner, stale source token and late duplicate sequence', async () => {
    const f = await fixture(), state = encodePdfWorkspaceState(completeWorkspace())
    expect(() => f.controller.activate(2, f.read.readId)).toThrow(/belong/)
    await f.controller.snapshot(1, { token: f.activation.token, sequence: 5, state })
    expect(await f.controller.snapshot(1, { token: f.activation.token, sequence: 4, state })).toEqual({ ok: true, skipped: true })
    const other = join(f.root, 'Other.pdf'); await writeFile(other, f.base)
    f.controller.activate(1, (await f.controller.read(1, other)).readId)
    expect(() => f.controller.snapshot(1, { token: f.activation.token, sequence: 6, state })).toThrow(/source changed/)
    expect(f.entries.has(f.activation.token)).toBe(true)
  })
  it('stages synchronously, preserves durable bytes, and resumes the same UUID above its floor', async () => {
    const f = await fixture(), state = encodePdfWorkspaceState(completeWorkspace())
    await f.controller.snapshot(1, { token: f.activation.token, sequence: 1, state })
    const before = Buffer.from(f.entries.get(f.activation.token)!)
    const floor: PdfDraftCloseFloor = { token: f.activation.token, readId: f.read.readId, throughSequence: 30 }
    const staged = f.controller.stageClose(1, floor)
    expect(f.controller.source(1)?.token).toBe('')
    expect(f.entries.get(f.activation.token)).toEqual(before)
    await staged.drained
    expect(f.controller.resumeClose(1, floor)).toBe(true)
    expect(f.controller.source(1)?.token).toBe(f.activation.token)
    expect(await f.controller.snapshot(1, { token: floor.token, sequence: 30, state })).toEqual({ ok: true, skipped: true })
    await f.controller.snapshot(1, { token: floor.token, sequence: 31, state })
    expect(f.entries.get(f.activation.token)).toEqual(before)
  })
  it('rejects queued pre-decision captures even if Close was canceled before dequeue', async () => {
    const f = await fixture(), gate = defer(), entered = defer()
    const original = completeWorkspace(), later = completeWorkspace(); later.comments.newBody = 'queued obsolete capture'
    f.hooks.beforeWrite = async () => { entered.resolve(); await gate.promise }
    const first = f.controller.snapshot(1, { token: f.activation.token, sequence: 1, state: encodePdfWorkspaceState(original) }).catch(() => undefined)
    await entered.promise
    const second = f.controller.snapshot(1, { token: f.activation.token, sequence: 2, state: encodePdfWorkspaceState(later) })
    const floor = { token: f.activation.token, readId: f.read.readId, throughSequence: 2 }
    const staged = f.controller.stageClose(1, floor)
    expect(f.controller.resumeClose(1, floor)).toBe(true)
    gate.resolve(); await first; await staged.drained
    expect(await second).toEqual({ ok: true, skipped: true })
    expect((await decodePdfWorkspace(f.entries.get(f.activation.token)!)).envelope.state.comments.newBody).toBe(original.comments.newBody)
  })
  it('Root discard prevents resuming a staged producer and its old sequence', async () => {
    const f = await fixture(), state = encodePdfWorkspaceState(completeWorkspace())
    await f.controller.snapshot(1, { token: f.activation.token, sequence: 1, state })
    const floor = { token: f.activation.token, readId: f.read.readId, throughSequence: 1 }
    await f.controller.stageClose(1, floor).drained
    expect(await f.controller.discardEntry(f.activation.token)).toBe(true)
    expect(f.controller.resumeClose(1, floor)).toBe(false)
    expect(f.entries.has(f.activation.token)).toBe(false)
  })
  it('does not let an unjournaled/protected successor reuse an older source token', async () => {
    const f = await fixture()
    await f.controller.snapshot(1, { token: f.activation.token, sequence: 1, state: encodePdfWorkspaceState(completeWorkspace()) })
    f.controller.acceptUnjournaled(1, join(f.root, 'Protected.pdf'))
    expect(f.controller.source(1)?.token).toBe('')
    expect(() => f.controller.captureCopy(1, { token: f.activation.token, sequence: 2, state: encodePdfWorkspaceState(emptyWorkspace()), renderedStampConfig: null })).toThrow(/source changed/)
    expect(f.entries.has(f.activation.token)).toBe(true)
  })
  it('Root trusted origin is hash-bound and imported paths confer no cleanup grant', async () => {
    const f = await fixture(), workspacePath = join(f.root, 'Recovered.vpdfdraft')
    const bytes = encodePdfWorkspace(f.base, completeWorkspace(), { displayName: 'Original.pdf', originalPath: f.path })
    await writeFile(workspacePath, bytes)
    f.controller.grantRestoredOrigin(workspacePath, f.activation.token, '0'.repeat(64))
    await expect(f.controller.read(2, workspacePath)).rejects.toThrow(/changed/)
    f.controller.cancelRestoredOrigin(workspacePath, 'Replace reserved test grant with its correct attestation')
    f.controller.grantRestoredOrigin(workspacePath, f.activation.token, pdfDigest(bytes))
    const restored = await f.controller.read(2, workspacePath)
    f.controller.activate(2, restored.readId)
    expect(f.controller.source(2)?.path).toBe(workspacePath)
    expect(() => f.controller.assertWritableSource(2, restored.helperPath)).toThrow(/new PDF copy/)
    expect(() => f.controller.assertWritableSource(2, f.path)).not.toThrow() // permission remains the host's grant check, not imported originalPath
  })
})

describe('complete ordinary Save concurrency fallback', () => {
  it.each(['same-ID change', 'same-ID removal', 'Undo to empty'] as const)('keeps the original base and entire current state for %s', async kind => {
    const f = await fixture(), published = await ordinaryPublication(f)
    const current = kind === 'Undo to empty' ? emptyWorkspace() : completeWorkspace()
    if (kind === 'same-ID change') current.edits.textEdits[0]!.input.newText = 'Newer text with the SAME operation ID'
    if (kind === 'same-ID removal') current.edits.textEdits = []
    if (kind !== 'Undo to empty') { current.comments.newBody = 'Typed after publication'; current.pendingEditors[0]![1].value = { url: 'https://newer.example.test/', page: '' } }
    const result = await f.controller.forkAfterSave(1, { copyId: published.receipt.copyId, fromReadId: f.read.readId, state: encodePdfWorkspaceState(current) })
    expect(result.read.unpublishedBase).toBe(true)
    expect(result.read.mode).toBe('workspace')
    expect(Buffer.from(result.read.data)).toEqual(f.base)
    expect(result.read.baseSha256).not.toBe(pdfDigest(published.bytes))
    expect(result.read.savedPublication).toEqual({ path: f.path, sha256: pdfDigest(published.bytes) })
    const activation = f.controller.activate(1, result.read.readId)
    expect(activation.sequenceFloor).toBe(1)
    const restored = await decodePdfWorkspace(f.entries.get(activation.token)!)
    expect(restored.base).toEqual(f.base)
    expect(restored.envelope.state).toEqual(current) // all16 buckets and all UI content, never ID-filtered
    expect(f.entries.has(f.activation.token)).toBe(true)
    expect(f.controller.hasUnpublishedBase(1)).toBe(true) // even Undo-to-empty needs another publication
    expect(() => f.controller.assertWritableSource(1, result.read.helperPath)).toThrow(/new PDF copy/)
  })
  it('ordinary no-newer Save adopts its new base, becomes clean and retires the represented prior journal', async () => {
    const f = await fixture(), published = await ordinaryPublication(f, emptyWorkspace())
    expect(published.receipt.complete).toBe(true)
    expect(f.controller.hasUnpublishedBase(1)).toBe(true)
    const checkpoint = published.receipt.checkpoint!
    expect(Buffer.from(checkpoint.data)).toEqual(published.bytes)
    const activation = f.controller.activate(1, checkpoint.readId)
    expect(f.controller.hasUnpublishedBase(1)).toBe(true)
    await f.controller.acknowledgeCopy(1, { token: activation.token, copyId: published.receipt.copyId, sequence: 1, state: encodePdfWorkspaceState(emptyWorkspace()) })
    expect(f.controller.hasUnpublishedBase(1)).toBe(false)
    expect(f.entries.has(f.activation.token)).toBe(false)
    expect(f.entries.has(activation.token)).toBe(false)
  })
  it('retains prior complete recovery if the published destination is externally replaced before acknowledgment', async () => {
    const f = await fixture(), published = await ordinaryPublication(f, emptyWorkspace())
    const activation = f.controller.activate(1, published.receipt.checkpoint!.readId)
    await writeFile(f.path, Buffer.from('%PDF-1.7\nAn external replacement, not our captured publication\n'))
    await expect(f.controller.acknowledgeCopy(1, { token: activation.token, copyId: published.receipt.copyId, sequence: 1, state: encodePdfWorkspaceState(emptyWorkspace()) })).rejects.toThrow()
    expect(f.entries.has(f.activation.token)).toBe(true)
  })
  it('an adopted-checkpoint acknowledgment failure forks the NEW cached base with the whole current model', async () => {
    const f = await fixture(), published = await ordinaryPublication(f, emptyWorkspace())
    const checkpoint = published.receipt.checkpoint!, activation = f.controller.activate(1, checkpoint.readId)
    await writeFile(f.path, Buffer.from('%PDF-1.7\nIndependent replacement\n'))
    await expect(f.controller.acknowledgeCopy(1, { token: activation.token, copyId: published.receipt.copyId, sequence: 1, state: encodePdfWorkspaceState(emptyWorkspace()) })).rejects.toThrow()
    const current = emptyWorkspace(); current.comments.newBody = 'Typed on the adopted new base'
    const result = await f.controller.forkAfterSave(1, { copyId: published.receipt.copyId, fromReadId: checkpoint.readId, state: encodePdfWorkspaceState(current) })
    expect(Buffer.from(result.read.data)).toEqual(published.bytes)
    expect(Buffer.from(result.read.data)).not.toEqual(f.base)
    const recovered = f.controller.activate(1, result.read.readId)
    const journal = await decodePdfWorkspace(f.entries.get(recovered.token)!)
    expect(journal.base).toEqual(published.bytes); expect(journal.envelope.state).toEqual(current)
    expect(f.controller.hasUnpublishedBase(1)).toBe(true)
  })
  it('a failed newer accepted snapshot cannot be swallowed by the acknowledgment cleanup queue', async () => {
    const f = await fixture(), published = await ordinaryPublication(f, emptyWorkspace())
    const activation = f.controller.activate(1, published.receipt.checkpoint!.readId), gate = defer(), entered = defer()
    let writes = 0
    f.hooks.beforeWrite = async () => { if (++writes === 1) { entered.resolve(); await gate.promise } else throw new Error('Newer storage failure') }
    const ack = f.controller.acknowledgeCopy(1, { token: activation.token, copyId: published.receipt.copyId, sequence: 1, state: encodePdfWorkspaceState(completeWorkspace()) })
    await entered.promise
    const newer = f.controller.snapshot(1, { token: activation.token, sequence: 2, state: encodePdfWorkspaceState(completeWorkspace()) })
    const rejectedAck = expect(ack).rejects.toThrow(/Newer PDF recovery/), rejectedNewer = expect(newer).rejects.toThrow(/Newer storage failure/)
    gate.resolve(); await rejectedAck; await rejectedNewer
    expect(f.entries.has(f.activation.token)).toBe(true)
  })
  it('never installs source A fallback over a newly activated source B', async () => {
    const f = await fixture(), published = await ordinaryPublication(f), pathB = join(f.root, 'B.pdf')
    await writeFile(pathB, f.base)
    const readB = await f.controller.read(1, pathB), activeB = f.controller.activate(1, readB.readId)
    await expect(f.controller.forkAfterSave(1, { copyId: published.receipt.copyId, fromReadId: f.read.readId, state: encodePdfWorkspaceState(completeWorkspace()) })).rejects.toThrow(/source changed/)
    expect(f.controller.source(1)?.readId).toBe(readB.readId)
    expect(f.controller.source(1)?.token).toBe(activeB.token)
    expect(f.entries.has(f.activation.token)).toBe(true)
  })
  it('preserves the previous complete journal on failed complete fallback and supports an explicit exact-source retry', async () => {
    const f = await fixture(), published = await ordinaryPublication(f), before = Buffer.from(f.entries.get(f.activation.token)!)
    const current = completeWorkspace(); current.comments.newBody = 'Newest live value'
    f.hooks.failWrite = true
    await expect(f.controller.forkAfterSave(1, { copyId: published.receipt.copyId, fromReadId: f.read.readId, state: encodePdfWorkspaceState(current) })).rejects.toThrow(/storage/)
    expect(f.entries.get(f.activation.token)).toEqual(before)
    f.hooks.failWrite = false
    const retry = await f.controller.forkAfterSave(1, { copyId: published.receipt.copyId, fromReadId: f.read.readId, state: encodePdfWorkspaceState(current) })
    const active = f.controller.activate(1, retry.read.readId)
    expect((await decodePdfWorkspace(f.entries.get(active.token)!)).envelope.state).toEqual(current)
  })
  it('refuses old-unredacted-base fallback for an irreversible sanitized publication', async () => {
    const f = await fixture(), state = emptyWorkspace()
    const capture = f.controller.captureCopy(1, { token: f.activation.token, sequence: 1, state: encodePdfWorkspaceState(state), renderedStampConfig: null })
    const receipt = await f.controller.publication(1, capture, { bytes: f.base, outputPath: f.path, representedIds: [], pageMap: [[0, 0]], skipped: [], redacted: true })
    await expect(f.controller.forkAfterSave(1, { copyId: receipt.copyId, fromReadId: f.read.readId, state: encodePdfWorkspaceState(state) })).rejects.toThrow(/Sanitized output/)
  })
})
