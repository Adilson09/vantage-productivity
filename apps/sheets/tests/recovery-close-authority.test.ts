import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DocumentNativeClient, DocumentPayload, NativeDocumentSnapshot } from '../src/main/document-native-contract'
import { WorkbookDocumentRecovery, type DocumentCheckpointInput } from '../src/main/workbook-document-recovery'

type Open = Parameters<DocumentNativeClient['openDocument']>[0]
type Checkpoint = Parameters<DocumentNativeClient['checkpointDocument']>[0]
interface Stored extends NativeDocumentSnapshot { storePath?: string; receipts: Record<string, unknown> }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }

/** Tiny disk-backed RPC fixture. It reads/writes this test's own files only. */
class Native implements DocumentNativeClient {
  readonly documents = new Map<string, Stored>()
  readonly commits: Checkpoint[] = []
  readonly closes: string[] = []
  beforeCommit?: (input: Checkpoint) => Promise<void>
  loseAck = false
  async openDocument(input: Open): Promise<unknown> {
    const sourceFingerprint = `sha256:${createHash('sha256').update(await readFile(input.sourcePath)).digest('hex')}`
    let value: Stored | undefined
    let recovered = false
    if (input.storePath) {
      try { value = JSON.parse(await readFile(input.storePath, 'utf8')) as Stored; recovered = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    } else value = this.documents.get(input.documentId)
    if (value && (value.documentId !== input.documentId || value.sourceFingerprint !== sourceFingerprint)) throw new Error('source conflict')
    value ??= { apiVersion: 1, documentId: input.documentId, revision: 0, sourceFingerprint,
      sheets: clone(input.sheets), payload: {}, receipts: {}, ...(input.storePath ? { storePath: input.storePath } : {}) }
    this.documents.set(input.documentId, value)
    if (value.storePath) await writeFile(value.storePath, JSON.stringify(value))
    return { apiVersion: 1, documentId: input.documentId, revision: value.revision, sourceFingerprint, recovered, durable: !!input.storePath }
  }
  async checkpointDocument(input: Checkpoint): Promise<unknown> {
    this.commits.push(clone(input))
    await this.beforeCommit?.(input)
    const old = this.documents.get(input.documentId)
    if (!old || old.revision !== input.expectedRevision) throw new Error('revision conflict')
    const value: Stored = { ...old, revision: old.revision + 1, payload: clone(input.payload), receipts: { ...old.receipts } }
    const receipt = { apiVersion: 1, documentId: input.documentId, commandId: input.commandId, revision: value.revision, durable: !!value.storePath }
    value.receipts[input.commandId] = receipt
    this.documents.set(input.documentId, value)
    if (value.storePath) await writeFile(value.storePath, JSON.stringify(value))
    if (this.loseAck) { this.loseAck = false; throw new Error('unknown acknowledgement') }
    return receipt
  }
  async documentSnapshot(input: Parameters<DocumentNativeClient['documentSnapshot']>[0]): Promise<unknown> {
    const value = this.documents.get(input.documentId)
    if (!value || input.revision !== undefined && value.revision !== input.revision) throw new Error('stale snapshot')
    const { storePath: _storePath, receipts: _receipts, ...snapshot } = value
    return clone(snapshot)
  }
  async documentCommandResult(input: Parameters<DocumentNativeClient['documentCommandResult']>[0]): Promise<unknown> {
    return clone(this.documents.get(input.documentId)?.receipts[input.commandId] ?? null)
  }
  async closeDocument(input: Parameters<DocumentNativeClient['closeDocument']>[0]): Promise<unknown> {
    this.closes.push(input.documentId); this.documents.delete(input.documentId); return { closed: true }
  }
}

describe('captured native close admission epochs (private proposal)', () => {
  let directory: string
  let native: Native
  let recovery: WorkbookDocumentRecovery
  let input: DocumentCheckpointInput
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-close-authority-'))
    const source = join(directory, 'source.xlsx')
    await writeFile(source, Buffer.from('synthetic opaque package bytes, including unknown parts\0'))
    native = new Native()
    recovery = new WorkbookDocumentRecovery({ privateRoot: join(directory, 'recovery'), nativeClient: native })
    input = { ownerId: 7, sessionId: 'session', originalPath: source, sourcePath: source,
      sheets: [{ id: 'sheet-1', name: 'Budget' }], payload: { edits: [{ sheetId: 'sheet-1', row: 0, column: 0, value: 10 }] } }
  })
  afterEach(async () => { await recovery.forgetOwner(7); await rm(directory, { recursive: true, force: true }) })

  it('captures the producer before the first queued edit starts and never redirects an old acknowledgement', async () => {
    const entered = deferred(), release = deferred()
    let first = true
    native.beforeCommit = async () => { if (first) { first = false; entered.resolve(); await release.promise } }
    const one = recovery.checkpoint(input)
    const two = recovery.checkpoint({ ...input, payload: { edits: [{ value: '12' }], notes: [true, null] } })
    const capture = recovery.captureNativeCloseAuthority(7, 'session')!
    expect(capture).not.toBeNull()
    expect(recovery.candidateFor(7, 'session')).toBeNull()
    const later = recovery.checkpoint({ ...input, payload: { edits: [{ value: 99 }] } })
    await entered.promise
    let drained = false
    void capture.ready.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    const [firstReceipt, secondReceipt, newReceipt] = await Promise.all([one, two, later])
    expect(firstReceipt.documentId).toBe(capture.id)
    expect(secondReceipt.documentId).toBe(capture.id)
    expect(secondReceipt.revision).toBe(2)
    expect(newReceipt.documentId).not.toBe(capture.id)
    expect(newReceipt.revision).toBe(1)
    expect(recovery.candidateFor(7, 'session')).toBe(newReceipt.documentId)
    const proof = await capture.snapshotProof()
    expect(proof.snapshot.revision).toBe(2)
    expect(proof.snapshot.payload).toEqual({ edits: [{ value: '12' }], notes: [true, null] })
    expect(proof.producer).toBe(capture.id)
    await capture.resume()
    await expect(capture.retireCapturedOnly(new AbortController().signal)).rejects.toThrow('no longer grants')
    await expect(access(join(directory, 'recovery', capture.id, 'document.sqlite'))).resolves.toBeUndefined()
    expect(recovery.candidateFor(7, 'session')).toBe(newReceipt.documentId)
    expect(recovery.isCurrentProducer(7, 'session', secondReceipt.documentId)).toBe(false)
    expect(recovery.isCurrentProducer(7, 'session', newReceipt.documentId)).toBe(true)
  })

  it('generic reader release preserves an acknowledged checkpoint and the next admission gets a clean authority', async () => {
    const saved = await recovery.checkpoint(input)
    await recovery.releaseDocument(7, 'session')
    await expect(access(join(directory, 'recovery', saved.documentId, 'document.sqlite'))).resolves.toBeUndefined()
    expect((await recovery.listCandidates(input.originalPath)).map((entry) => entry.id)).toContain(saved.documentId)
    const next = await recovery.checkpoint({ ...input, payload: { edits: [{ value: false }] } })
    expect(next.documentId).not.toBe(saved.documentId)
    expect(next.revision).toBe(1)
    await recovery.forgetOwner(7)
    expect(await readdir(join(directory, 'recovery'))).toEqual(expect.arrayContaining([saved.documentId, next.documentId]))
  })

  it('unknown pending acknowledgement prevents close proof and retains the original native store', async () => {
    native.loseAck = true
    await expect(recovery.checkpoint(input)).rejects.toThrow('unknown acknowledgement')
    const capture = recovery.captureNativeCloseAuthority(7, 'session')!
    await capture.ready
    expect(capture.attest()?.pending).toBe(true)
    await expect(capture.snapshotProof()).rejects.toMatchObject({ code: 'uncertain_checkpoint' })
    await expect(capture.retireCapturedOnly(new AbortController().signal)).rejects.toMatchObject({ code: 'uncertain_checkpoint' })
    await expect(access(join(directory, 'recovery', capture.id, 'document.sqlite'))).resolves.toBeUndefined()
  })

  it('refuses a native snapshot whose payload diverges from the known final acknowledged hash', async () => {
    const receipt = await recovery.checkpoint(input)
    const captured = recovery.captureNativeCloseAuthority(7, 'session')!
    await captured.ready
    const acknowledgedHash = captured.attest()?.payloadSha256
    expect(acknowledgedHash).toMatch(/^[0-9a-f]{64}$/)
    const originalSnapshot = native.documentSnapshot.bind(native)
    native.documentSnapshot = async (request) => ({ ...(await originalSnapshot(request) as NativeDocumentSnapshot), payload: { edits: [{ value: 'wrong late data' }] } })
    await expect(captured.snapshotProof()).rejects.toMatchObject({ code: 'persistence_conflict' })
    expect(captured.attest()?.payloadSha256).toBe(acknowledgedHash)
    await expect(access(join(directory, 'recovery', receipt.documentId, 'document.sqlite'))).resolves.toBeUndefined()
    await captured.cancel()
  })

  it('captured retirement deletes only the drained UUID while a resumed producer keeps its latest edits', async () => {
    const original = await recovery.checkpoint(input)
    const capture = recovery.captureNativeCloseAuthority(7, 'session')!
    const resumed = await recovery.checkpoint({ ...input, payload: { edits: [{ value: 22 }] } })
    await capture.snapshotProof()
    await capture.retireCapturedOnly(new AbortController().signal)
    await expect(access(join(directory, 'recovery', original.documentId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(directory, 'recovery', resumed.documentId, 'document.sqlite'))).resolves.toBeUndefined()
    expect(recovery.candidateFor(7, 'session')).toBe(resumed.documentId)
    expect(native.documents.get(resumed.documentId)?.payload).toEqual({ edits: [{ value: 22 }] })
  })

  it('legacy retirement cannot bypass a captured epoch, including capture after retirement was queued', async () => {
    const entered = deferred(), release = deferred()
    native.beforeCommit = async () => { entered.resolve(); await release.promise }
    const pending = recovery.checkpoint(input)
    await entered.promise
    const firstCapture = recovery.captureNativeCloseAuthority(7, 'session')!
    await expect(recovery.retire(firstCapture.id)).rejects.toMatchObject({ code: 'captured_authority' })
    release.resolve()
    await pending
    await firstCapture.cancel()
    native.beforeCommit = undefined
    await recovery.checkpoint(input)
    const current = recovery.candidateFor(7, 'session')!
    const retirement = recovery.retire(current)
    const captured = recovery.captureNativeCloseAuthority(7, 'session')!
    await expect(retirement).rejects.toMatchObject({ code: 'captured_authority' })
    await captured.ready
    await expect(access(join(directory, 'recovery', current, 'document.sqlite'))).resolves.toBeUndefined()
    await captured.cancel()
  })

  it('a checkpoint admitted after legacy retirement never targets the UUID queued for deletion', async () => {
    const entered = deferred(), release = deferred()
    native.beforeCommit = async () => { entered.resolve(); await release.promise }
    const first = recovery.checkpoint(input)
    await entered.promise
    // Admission already allocated the exact first producer, even before its ACK.
    const firstId = native.commits[0]!.documentId
    const retirement = recovery.retire(firstId)
    const second = recovery.checkpoint({ ...input, payload: { edits: [{ value: 'fresh after retire' }] } })
    release.resolve()
    const old = await first
    await retirement
    const fresh = await second
    expect(fresh.documentId).not.toBe(old.documentId)
    expect(fresh.revision).toBe(1)
    await expect(access(join(directory, 'recovery', old.documentId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(directory, 'recovery', fresh.documentId, 'document.sqlite'))).resolves.toBeUndefined()
  })

  it('cancellation exposes actual close settlement and retains state/files when that close fails', async () => {
    await recovery.checkpoint(input)
    const captured = recovery.captureNativeCloseAuthority(7, 'session')!
    await captured.ready
    const entered = deferred(), finish = deferred()
    const originalClose = native.closeDocument.bind(native)
    native.closeDocument = async (request) => {
      if (request.documentId === captured.id) { entered.resolve(); await finish.promise; throw new Error('close outcome unknown') }
      return originalClose(request)
    }
    const canceled = captured.cancel()
    expect(captured.cancel()).toBe(canceled)
    await entered.promise
    let settled = false
    void captured.settled().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish.resolve()
    await expect(canceled).rejects.toThrow('close outcome unknown')
    await captured.settled()
    await expect(access(join(directory, 'recovery', captured.id, 'document.sqlite'))).resolves.toBeUndefined()
    expect((await recovery.listCandidates(input.originalPath)).map((entry) => entry.id)).not.toContain(captured.id)
  })
})
