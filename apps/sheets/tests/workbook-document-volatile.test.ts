/** Actual host authority with a fake native boundary; no native-binary acceptance claim. */
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  DocumentNativeClient,
  NativeDocumentReceipt,
  NativeDocumentSnapshot,
} from '../src/main/document-native-contract'
import {
  WorkbookDocumentRecovery,
  isCapturedNativeCloseAuthority,
  type DocumentCheckpointInput,
} from '../src/main/workbook-document-recovery'

type Open = Parameters<DocumentNativeClient['openDocument']>[0]
type Checkpoint = Parameters<DocumentNativeClient['checkpointDocument']>[0]
interface Document extends NativeDocumentSnapshot {
  storePath?: string
  receipts: Map<string, NativeDocumentReceipt>
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function clone<T>(value: T): T {
  return structuredClone(value)
}

class Native implements DocumentNativeClient {
  readonly documents = new Map<string, Document>()
  readonly opens: Open[] = []
  readonly commits: Checkpoint[] = []
  readonly queries: string[] = []
  readonly closes: string[] = []
  openDurable?: boolean
  openFingerprint?: string
  receiptOverride?: (value: NativeDocumentReceipt) => unknown
  loseAcknowledgement = false
  closeGate?: { entered: () => void; actual: Promise<void> }

  async openDocument(input: Open): Promise<unknown> {
    this.opens.push(clone(input))
    const fingerprint = `sha256:${createHash('sha256')
      .update(await readFile(input.sourcePath))
      .digest('hex')}`
    let state = this.documents.get(input.documentId)
    if (state && state.sourceFingerprint !== fingerprint) throw new Error('source conflict')
    state ??= {
      apiVersion: 1,
      documentId: input.documentId,
      revision: 0,
      sourceFingerprint: fingerprint,
      sheets: clone(input.sheets),
      payload: {},
      receipts: new Map(),
      ...(input.storePath ? { storePath: input.storePath } : {}),
    }
    this.documents.set(input.documentId, state)
    if (input.storePath) await writeFile(input.storePath, 'fake native store fixture')
    return {
      apiVersion: 1,
      documentId: state.documentId,
      revision: state.revision,
      sourceFingerprint: this.openFingerprint ?? fingerprint,
      recovered: state.revision > 0,
      durable: this.openDurable ?? input.storePath !== undefined,
    }
  }
  async checkpointDocument(input: Checkpoint): Promise<unknown> {
    this.commits.push(clone(input))
    const state = this.documents.get(input.documentId)
    if (!state || state.revision !== input.expectedRevision) throw new Error('revision conflict')
    const receipt: NativeDocumentReceipt = {
      apiVersion: 1,
      documentId: input.documentId,
      commandId: input.commandId,
      revision: input.expectedRevision + 1,
      durable: state.storePath !== undefined,
    }
    const next: Document = { ...state, revision: receipt.revision, payload: clone(input.payload) }
    next.receipts.set(input.commandId, receipt)
    this.documents.set(input.documentId, next)
    if (this.loseAcknowledgement) {
      this.loseAcknowledgement = false
      throw new Error('committed without caller ACK')
    }
    return this.receiptOverride?.(clone(receipt)) ?? clone(receipt)
  }
  async documentSnapshot(
    input: Parameters<DocumentNativeClient['documentSnapshot']>[0],
  ): Promise<unknown> {
    const state = this.documents.get(input.documentId)
    if (!state || (input.revision !== undefined && input.revision !== state.revision))
      throw new Error('stale snapshot')
    const { storePath: _storePath, receipts: _receipts, ...snapshot } = state
    return clone(snapshot)
  }
  async documentCommandResult(
    input: Parameters<DocumentNativeClient['documentCommandResult']>[0],
  ): Promise<unknown> {
    this.queries.push(input.commandId)
    return clone(this.documents.get(input.documentId)?.receipts.get(input.commandId) ?? null)
  }
  async closeDocument(
    input: Parameters<DocumentNativeClient['closeDocument']>[0],
  ): Promise<unknown> {
    this.closes.push(input.documentId)
    this.closeGate?.entered()
    await this.closeGate?.actual
    return { closed: this.documents.delete(input.documentId) }
  }
}

let directory: string, privateRoot: string, sourcePath: string, native: Native
const services: WorkbookDocumentRecovery[] = []
function service(storage?: 'durable' | 'volatile') {
  const value = new WorkbookDocumentRecovery({
    privateRoot,
    nativeClient: native,
    ...(storage ? { storage } : {}),
  })
  services.push(value)
  return value
}
function input(extra: Partial<DocumentCheckpointInput> = {}): DocumentCheckpointInput {
  return {
    ownerId: 'headless',
    sessionId: 'reader-1',
    originalPath: sourcePath,
    sourcePath,
    sheets: [{ id: 'sheet-1', name: 'Budget' }],
    payload: { edits: [{ value: '12' }] },
    ...extra,
  }
}
async function absent() {
  await expect(access(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'vantage-volatile-document-')))
  privateRoot = join(directory, 'must-not-be-created')
  sourcePath = join(directory, 'source.xlsx')
  await writeFile(sourcePath, 'isolated immutable workbook source fixture')
  native = new Native()
})
afterEach(async () => {
  native.closeGate = undefined
  for (const value of services.splice(0)) await value.forgetOwner('headless')
  await rm(directory, { recursive: true, force: true })
})

describe('volatile complete-document authority storage', () => {
  it('retains real typed checkpoint ACKs without storePath, manifests or candidates', async () => {
    const value = service('volatile')
    const payload = {
      edits: [
        { value: '12' },
        { value: 12 },
        { value: true },
        { value: null },
        { value: '', rich: [{ text: 'á\n💾', bold: true }] },
        { formula: '=A1*2' },
      ],
      noteStates: [{ text: 'retained metadata' }],
      themeState: { font: 'Aptos' },
    }
    const receipt = await value.checkpoint(input({ payload }))
    expect(receipt).toMatchObject({ revision: 1, durable: false, candidateId: null })
    expect(native.commits[0]!.payload).toEqual(payload)
    expect(native.opens[0]).not.toHaveProperty('storePath')
    expect(value.candidateFor('headless', 'reader-1')).toBeNull()
    expect(await value.listCandidates(sourcePath)).toEqual([])
    expect(await value.listAllCandidates()).toEqual([])
    await absent()
    await value.releaseDocument('headless', 'reader-1')
    expect(native.closes).toEqual([receipt.documentId])
    expect(await readFile(sourcePath, 'utf8')).toBe('isolated immutable workbook source fixture')
    await absent()
  })

  it('opens revision zero in RAM and never grants a GUI close capability or detaches its producer', async () => {
    const value = service('volatile'),
      first = input()
    const opened = await value.openDocument(first)
    expect(opened).toMatchObject({ revision: 0, durable: false, candidateId: null })
    expect(opened.sourceFingerprint).toBe(
      `sha256:${createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex')}`,
    )
    expect(value.captureNativeCloseAuthority('headless', 'reader-1')).toBeNull()
    expect(value.isCurrentProducer('headless', 'reader-1', opened.documentId)).toBe(true)
    const receipt = await value.checkpoint(first)
    expect(receipt.documentId).toBe(opened.documentId)
    expect(receipt.revision).toBe(1)
    expect(value.captureNativeCloseAuthority('headless', 'reader-1')).toBeNull()
    await absent()
  })

  it('does not inspect or mutate even a preexisting non-directory at the private-root path', async () => {
    await writeFile(privateRoot, 'sentinel: volatile recovery must not inspect this as a store')
    const value = service('volatile'),
      receipt = await value.checkpoint(input())
    expect(await value.listAllCandidates()).toEqual([])
    expect(await value.listCandidates(sourcePath)).toEqual([])
    await expect(value.readCandidate(receipt.documentId)).rejects.toMatchObject({
      code: 'missing_candidate',
    })
    await value.retire(receipt.documentId)
    await value.retire(randomUUID())
    await value.releaseDocument('headless', 'reader-1')
    expect(native.closes).toEqual([receipt.documentId])
    expect(await readFile(privateRoot, 'utf8')).toBe(
      'sentinel: volatile recovery must not inspect this as a store',
    )
  })

  it('release waits for the actual native close completion without creating recovery storage', async () => {
    const value = service('volatile'),
      receipt = await value.checkpoint(input())
    const entered = deferred<void>(),
      actual = deferred<void>()
    native.closeGate = { entered: () => entered.resolve(undefined), actual: actual.promise }
    const closing = value.releaseDocument('headless', 'reader-1')
    let settled = false
    void closing.then(() => {
      settled = true
    })
    await entered.promise
    expect(settled).toBe(false)
    expect(native.documents.has(receipt.documentId)).toBe(true)
    await absent()
    actual.resolve(undefined)
    await closing
    expect(settled).toBe(true)
    expect(native.documents.has(receipt.documentId)).toBe(false)
    await absent()
  })

  it('rejects a native durable-store response for an explicitly volatile authority', async () => {
    native.openDurable = true
    const value = service('volatile')
    await expect(value.checkpoint(input())).rejects.toMatchObject({ code: 'source_conflict' })
    expect(native.opens[0]).not.toHaveProperty('storePath')
    expect(native.commits).toEqual([])
    await absent()
  })

  it('validates the native source fingerprint against the actual unencrypted source bytes', async () => {
    native.openFingerprint = `sha256:${'f'.repeat(64)}`
    await expect(service('volatile').checkpoint(input())).rejects.toMatchObject({
      code: 'source_conflict',
    })
    expect(native.commits).toEqual([])
    await absent()
  })

  it.each(['durable', 'revision', 'document', 'command', 'api'] as const)(
    'rejects a mismatched %s ACK, then reconciles only the real native receipt',
    async (field) => {
      const value = service('volatile')
      native.receiptOverride = (receipt) => ({
        ...receipt,
        ...(field === 'durable' ? { durable: true } : {}),
        ...(field === 'revision' ? { revision: receipt.revision + 1 } : {}),
        ...(field === 'document' ? { documentId: randomUUID() } : {}),
        ...(field === 'command' ? { commandId: 'wrong-command' } : {}),
        ...(field === 'api' ? { apiVersion: 2 } : {}),
      })
      const request = input({ commandId: 'exact-command' })
      await expect(value.checkpoint(request)).rejects.toMatchObject({
        code: 'invalid_native_response',
      })
      expect(value.candidateFor('headless', 'reader-1')).toBeNull()
      native.receiptOverride = undefined
      const recovered = await value.checkpoint(request)
      expect(recovered).toMatchObject({
        commandId: 'exact-command',
        revision: 1,
        durable: false,
        candidateId: null,
      })
      expect(native.commits).toHaveLength(1)
      expect(native.queries).toEqual(['exact-command'])
      await absent()
    },
  )

  it('preserves pending payload/hash identity through a lost ACK without inventing a second commit', async () => {
    const value = service('volatile'),
      request = input({ commandId: 'lost-ack', payload: { edits: [{ value: '12' }] } })
    native.loseAcknowledgement = true
    await expect(value.checkpoint(request)).rejects.toThrow('without caller ACK')
    const recovered = await value.checkpoint(request)
    expect(recovered.revision).toBe(1)
    expect(native.commits).toHaveLength(1)
    const changed = await value.checkpoint(input({ payload: { edits: [{ value: 12 }] } }))
    expect(changed.revision).toBe(2)
    expect(native.commits[1]!.payload).toEqual({ edits: [{ value: 12 }] })
    await absent()
  })

  it('refuses changed source bytes before another checkpoint can be submitted', async () => {
    const value = service('volatile')
    await value.checkpoint(input())
    await writeFile(sourcePath, 'external source replacement')
    await expect(
      value.checkpoint(input({ payload: { edits: [{ value: 99 }] } })),
    ).rejects.toMatchObject({ code: 'source_conflict' })
    expect(native.commits).toHaveLength(1)
    await absent()
  })

  it('does not conflate volatile storage with the protected-document identity flag', async () => {
    const value = service('volatile')
    await value.checkpoint(input())
    await expect(value.checkpoint(input({ encrypted: true }))).rejects.toMatchObject({
      code: 'source_conflict',
    })
    expect(value.captureNativeCloseAuthority('headless', 'reader-1')).toBeNull()
    expect(native.commits).toHaveLength(1)
    await absent()
  })

  it('keeps default GUI storage durable with its existing private manifest and native store', async () => {
    const value = service(),
      receipt = await value.checkpoint(input())
    expect(receipt.durable).toBe(true)
    expect(receipt.candidateId).toBe(receipt.documentId)
    expect(native.opens[0]!.storePath).toBe(
      join(privateRoot, receipt.documentId, 'document.sqlite'),
    )
    await access(join(privateRoot, receipt.documentId, 'manifest.json'))
    await access(join(privateRoot, receipt.documentId, 'document.sqlite'))
  })

  it('keeps default protected GUI state memory-only while retaining its real protected close capability', async () => {
    const value = service(),
      receipt = await value.checkpoint(input({ encrypted: true }))
    expect(receipt).toMatchObject({ durable: false, candidateId: null })
    const authority = value.captureNativeCloseAuthority('headless', 'reader-1')!
    expect(isCapturedNativeCloseAuthority(authority)).toBe(true)
    expect(authority.encrypted).toBe(true)
    await authority.ready
    expect(authority.attest()).toMatchObject({ documentId: receipt.documentId, pending: false })
    await authority.resume()
    await absent()
  })
})
