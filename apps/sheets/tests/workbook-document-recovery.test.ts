import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  DocumentNativeClient,
  DocumentPayload,
  DocumentSheet,
  NativeDocumentReceipt,
} from '../src/main/document-native-contract'
import {
  WorkbookDocumentRecovery,
  type DocumentCheckpointInput,
} from '../src/main/workbook-document-recovery'

type Checkpoint = Parameters<DocumentNativeClient['checkpointDocument']>[0]
type OpenDocument = Parameters<DocumentNativeClient['openDocument']>[0]

interface MockDocument {
  documentId: string
  sourceFingerprint: string
  sheets: readonly DocumentSheet[]
  revision: number
  payload: DocumentPayload
  receipts: Record<string, { hash: string; result: NativeDocumentReceipt }>
  storePath?: string
}

function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Disk-backed fake of the native contract, using only this test's own files. */
class MockNative implements DocumentNativeClient {
  private documents = new Map<string, MockDocument>()
  readonly opens: OpenDocument[] = []
  readonly checkpoints: Checkpoint[] = []
  readonly queries: string[] = []
  readonly closes: string[] = []
  failBeforeCommit = false
  loseNextAcknowledgement = false
  beforeCommit?: (input: Checkpoint) => Promise<void>

  restart(): void {
    this.documents.clear()
  }

  private async persist(document: MockDocument): Promise<void> {
    if (document.storePath)
      await writeFile(document.storePath, JSON.stringify(document), { mode: 0o600 })
  }

  async openDocument(input: OpenDocument): Promise<unknown> {
    this.opens.push(detached(input))
    const sourceFingerprint = `sha256:${createHash('sha256')
      .update(await readFile(input.sourcePath))
      .digest('hex')}`
    let document: MockDocument | undefined
    let recovered = false
    if (input.storePath) {
      try {
        document = JSON.parse(await readFile(input.storePath, 'utf8')) as MockDocument
        recovered = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else document = this.documents.get(input.documentId)
    if (document && document.sourceFingerprint !== sourceFingerprint)
      throw new Error('Native source conflict')
    document ??= {
      documentId: input.documentId,
      sourceFingerprint,
      sheets: detached(input.sheets),
      revision: 0,
      payload: {},
      receipts: {},
      ...(input.storePath === undefined ? {} : { storePath: input.storePath }),
    }
    this.documents.set(input.documentId, document)
    await this.persist(document)
    return {
      apiVersion: 1,
      documentId: input.documentId,
      revision: document.revision,
      sourceFingerprint,
      recovered,
      durable: input.storePath !== undefined,
    }
  }

  async checkpointDocument(input: Checkpoint): Promise<unknown> {
    this.checkpoints.push(detached(input))
    await this.beforeCommit?.(input)
    const document = this.documents.get(input.documentId)
    if (!document) throw new Error('Helper restarted')
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          actor: input.actor,
          expectedRevision: input.expectedRevision,
          payload: input.payload,
        }),
      )
      .digest('hex')
    const previous = document.receipts[input.commandId]
    if (previous) {
      if (previous.hash !== hash) throw new Error('Idempotency conflict')
      return detached(previous.result)
    }
    if (document.revision !== input.expectedRevision) throw new Error('Revision conflict')
    if (this.failBeforeCommit) {
      this.failBeforeCommit = false
      throw new Error('Simulated failed commit')
    }
    const result: NativeDocumentReceipt = {
      apiVersion: 1,
      documentId: input.documentId,
      commandId: input.commandId,
      revision: input.expectedRevision + 1,
      durable: document.storePath !== undefined,
    }
    document.revision = result.revision
    document.payload = detached(input.payload)
    document.receipts[input.commandId] = { hash, result }
    await this.persist(document)
    if (this.loseNextAcknowledgement) {
      this.loseNextAcknowledgement = false
      throw new Error('Committed, then lost acknowledgement')
    }
    return detached(result)
  }

  async documentSnapshot(
    input: Parameters<DocumentNativeClient['documentSnapshot']>[0],
  ): Promise<unknown> {
    const document = this.documents.get(input.documentId)
    if (!document) throw new Error('Document is closed')
    return detached({
      apiVersion: 1,
      documentId: input.documentId,
      revision: document.revision,
      sourceFingerprint: document.sourceFingerprint,
      sheets: document.sheets,
      payload: document.payload,
    })
  }

  async documentCommandResult(
    input: Parameters<DocumentNativeClient['documentCommandResult']>[0],
  ): Promise<unknown> {
    this.queries.push(input.commandId)
    return detached(this.documents.get(input.documentId)?.receipts[input.commandId]?.result ?? null)
  }

  async closeDocument(
    input: Parameters<DocumentNativeClient['closeDocument']>[0],
  ): Promise<unknown> {
    this.closes.push(input.documentId)
    return { closed: this.documents.delete(input.documentId) }
  }
}

let directory: string
let root: string
let source: string
let native: MockNative
let recovery: WorkbookDocumentRecovery

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vantage-document-recovery-'))
  root = join(directory, 'private-recovery')
  source = join(directory, 'original.xlsx')
  await writeFile(source, 'immutable test workbook base')
  native = new MockNative()
  recovery = new WorkbookDocumentRecovery({ privateRoot: root, nativeClient: native })
})

afterEach(async () => {
  const checked = resolve(directory)
  if (
    !basename(checked).startsWith('vantage-document-recovery-') ||
    relative(resolve(tmpdir()), checked).startsWith('..')
  ) {
    throw new Error('Unexpected recovery test directory')
  }
  await rm(checked, { recursive: true, force: true })
})

function input(
  payload: DocumentPayload,
  changes: Partial<DocumentCheckpointInput> = {},
): DocumentCheckpointInput {
  return {
    ownerId: 'window-a',
    sessionId: 'session-a',
    originalPath: source,
    sourcePath: source,
    sheets: [{ id: 'sheet-1', name: 'Budget' }],
    payload,
    ...changes,
  }
}

function fullPayload(value: string): DocumentPayload {
  return {
    edits: [
      {
        sheetName: 'Budget',
        row: 0,
        column: 0,
        input: value,
        style: { bold: true, numberFormat: '0.00', fill: '#123456' },
      },
    ],
    structuralOps: [{ sheetName: 'Budget', ops: [{ kind: 'insert-rows', index: 2, count: 3 }] }],
    sheetPlan: {
      renames: [{ sheetName: 'Budget', newName: 'Annual Budget' }],
      additions: [],
      removals: [],
    },
    tableAdditions: [
      {
        sheetName: 'Budget',
        name: 'Sales',
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 3 },
      },
    ],
    chartEdits: [{ sheetName: 'Budget', chartId: 'chart-1', title: 'Quarterly sales' }],
    definedNamesState: { names: [{ name: 'Total', formula: "'Budget'!$A$1" }] },
    pageSetupStates: [{ sheetName: 'Budget', orientation: 'landscape' }],
    sheetProtections: [{ sheetName: 'Budget', enabled: true }],
    themeState: { name: 'Aster', colors: ['#102030', '#abcdef'] },
    visualAdditions: [{ sheetName: 'Budget', image: { contentBase64: 'YWJjAA==' } }],
  }
}

describe('complete workbook document recovery', () => {
  it('pins the base before acknowledgement and recovers every payload field after a new coordinator', async () => {
    const payload = fullPayload('=SUM(B1:B4)')
    native.beforeCommit = async (request) => {
      const manifest = JSON.parse(
        await readFile(join(root, request.documentId, 'manifest.json'), 'utf8'),
      ) as { sourceFingerprint: string }
      const files = await readdir(join(root, request.documentId))
      expect(files).toContain(`base-${manifest.sourceFingerprint.slice(7)}.xlsx`)
      expect(
        await readFile(
          join(root, request.documentId, `base-${manifest.sourceFingerprint.slice(7)}.xlsx`),
          'utf8',
        ),
      ).toBe('immutable test workbook base')
    }
    const result = await recovery.checkpoint(
      input({
        ...payload,
        sessionId: 'omit',
        mode: 'save-as',
        targetPath: 'omit',
        overwrite: true,
        restoreWriteBack: true,
        quiet: true,
        defaultName: 'omit',
        csvContent: 'omit',
        editsTransferId: 'omit',
      }),
    )
    expect(result.durable).toBe(true)
    expect(await recovery.listCandidates(source)).toEqual([])
    await recovery.forgetOwner('window-a')
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    const candidates = await restarted.listCandidates(source)
    expect(candidates).toMatchObject([
      { id: result.candidateId, sourceConflict: false, originalState: 'current' },
    ])
    const restored = await restarted.readCandidate(candidates[0]!.id)
    expect(restored.snapshot.payload).toEqual(payload)
    expect(restored.snapshot.revision).toBe(1)
    expect(restored.revision).toBe(1)
    expect(await readFile(restored.pinnedBasePath, 'utf8')).toBe('immutable test workbook base')
    expect(await readFile(source, 'utf8')).toBe('immutable test workbook base')
  })

  it('serializes repeated edits to the same cell and captures caller data before queuing', async () => {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolveStarted) => {
      entered = resolveStarted
    })
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    native.beforeCommit = async () => {
      if (native.checkpoints.length === 1) {
        entered()
        await gate
      }
    }
    const first = recovery.checkpoint(input(fullPayload('first')))
    await started
    const next = fullPayload('second')
    const second = recovery.checkpoint(input(next))
    next.edits = []
    expect(native.checkpoints).toHaveLength(1)
    release()
    const [one, two] = await Promise.all([first, second])
    expect(one.candidateId).toBe(two.candidateId)
    expect(one.revision).toBe(1)
    expect(two.revision).toBe(2)
    const snapshot = await recovery.readCandidate(two.candidateId!, source)
    expect(snapshot.snapshot.payload).toEqual(fullPayload('second'))
    expect(native.checkpoints.map((command) => command.expectedRevision)).toEqual([0, 1])
  })

  it('isolates two windows using the same session name and original workbook', async () => {
    const one = await recovery.checkpoint(input(fullPayload('window one')))
    const two = await recovery.checkpoint(input(fullPayload('window two'), { ownerId: 'window-b' }))
    expect(one.candidateId).not.toBe(two.candidateId)
    expect([one.revision, two.revision]).toEqual([1, 1])
    await recovery.forgetOwner('window-a')
    expect(await recovery.listCandidates(source)).toHaveLength(1)
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    const candidates = await restarted.listCandidates(source)
    expect(candidates).toHaveLength(2)
    expect((await restarted.readCandidate(one.candidateId!)).snapshot.payload).toEqual(
      fullPayload('window one'),
    )
    expect((await restarted.readCandidate(two.candidateId!)).snapshot.payload).toEqual(
      fullPayload('window two'),
    )
  })

  it('preserves the previous durable checkpoint after a failed commit and retries the same command ID', async () => {
    const first = await recovery.checkpoint(input(fullPayload('acknowledged')))
    native.failBeforeCommit = true
    await expect(recovery.checkpoint(input(fullPayload('retry me')))).rejects.toThrow(
      'Simulated failed commit',
    )
    const failedId = native.checkpoints[1]!.commandId
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    expect((await restarted.readCandidate(first.candidateId!, source)).snapshot.payload).toEqual(
      fullPayload('acknowledged'),
    )
    const retried = await recovery.checkpoint(input(fullPayload('retry me')))
    expect(retried.revision).toBe(2)
    expect(native.queries).toContain(failedId)
    expect(native.checkpoints[2]!.commandId).toBe(failedId)
  })

  it('discovers a committed database despite stale manifest revision and reconciles an unknown outcome by receipt', async () => {
    native.loseNextAcknowledgement = true
    await expect(
      recovery.checkpoint(input(fullPayload('committed before disconnect'))),
    ).rejects.toThrow('lost acknowledgement')
    const submitted = native.checkpoints[0]!
    const manifest = JSON.parse(
      await readFile(join(root, submitted.documentId, 'manifest.json'), 'utf8'),
    ) as {
      revision: number
      pending: { commandId: string }
    }
    expect(manifest.revision).toBe(0)
    expect(manifest.pending.commandId).toBe(submitted.commandId)
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    const candidates = await restarted.listCandidates(source)
    expect(candidates).toHaveLength(1)
    const latest = await restarted.readCandidate(candidates[0]!.id)
    expect(latest.revision).toBe(1)
    expect(latest.snapshot.payload).toEqual(fullPayload('committed before disconnect'))
    native.restart()
    const result = await recovery.checkpoint(input(fullPayload('committed before disconnect')))
    expect(result.commandId).toBe(submitted.commandId)
    expect(result.revision).toBe(1)
    expect(native.checkpoints).toHaveLength(1)
    expect(native.queries).toEqual([submitted.commandId])
    expect(native.opens).toHaveLength(2)
  })

  it('rejects a changed source for live commits and exposes a recoverable copy with an explicit source conflict', async () => {
    const first = await recovery.checkpoint(input(fullPayload('preserved edit')))
    await writeFile(source, 'external replacement')
    await expect(recovery.checkpoint(input(fullPayload('unsafe new base')))).rejects.toMatchObject({
      code: 'source_conflict',
    })
    expect(native.checkpoints).toHaveLength(1)
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    const candidates = await restarted.listCandidates(source)
    expect(candidates).toMatchObject([
      { id: first.candidateId, sourceConflict: true, originalState: 'changed' },
    ])
    const copy = await restarted.readCandidate(first.candidateId!)
    expect(copy.sourceConflict).toBe(true)
    expect(copy.snapshot.payload).toEqual(fullPayload('preserved edit'))
    expect(await readFile(copy.pinnedBasePath, 'utf8')).toBe('immutable test workbook base')
    expect(await readFile(source, 'utf8')).toBe('external replacement')
  })

  it('binds a converted XLSX base separately from the original CSV digest', async () => {
    await writeFile(source, 'Category,Amount\nA,42\n')
    const originalFingerprint = `sha256:${createHash('sha256')
      .update(await readFile(source))
      .digest('hex')}`
    const converted = join(directory, 'converted-private-session.xlsx')
    await writeFile(converted, 'converted XLSX snapshot bytes differ from CSV')
    const result = await recovery.checkpoint(
      input(fullPayload('converted edit'), {
        sourcePath: converted,
        originalFingerprint,
      }),
    )
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    const candidates = await restarted.listCandidates(source)
    expect(candidates).toMatchObject([{ sourceConflict: false, originalState: 'current' }])
    const restored = await restarted.readCandidate(result.candidateId!)
    expect(restored.sourceFingerprint).not.toBe(originalFingerprint)
    expect(await readFile(restored.pinnedBasePath, 'utf8')).toBe(
      'converted XLSX snapshot bytes differ from CSV',
    )
    expect(restored.snapshot.payload).toEqual(fullPayload('converted edit'))
  })

  it('reports an original changed before the first checkpoint using its opening-time digest', async () => {
    const openingBytes = await readFile(source)
    const originalFingerprint = `sha256:${createHash('sha256').update(openingBytes).digest('hex')}`
    const immutableSnapshot = join(directory, 'opening-snapshot.xlsx')
    await writeFile(immutableSnapshot, openingBytes)
    await writeFile(source, 'changed after open, before first checkpoint')
    const result = await recovery.checkpoint(
      input(fullPayload('edit to original opening snapshot'), {
        sourcePath: immutableSnapshot,
        originalFingerprint,
      }),
    )
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    expect(await restarted.listCandidates(source)).toMatchObject([
      { sourceConflict: true, originalState: 'changed' },
    ])
    const copy = await restarted.readCandidate(result.candidateId!)
    expect(copy.sourceConflict).toBe(true)
    expect(await readFile(copy.pinnedBasePath)).toEqual(openingBytes)
    expect(copy.snapshot.payload).toEqual(fullPayload('edit to original opening snapshot'))
  })

  it('discovers unsaved originals at startup without creating or probing their missing destinations', async () => {
    const suggested = join(directory, 'never-created-original.xlsx')
    const result = await recovery.checkpoint(
      input(fullPayload('unsaved new document'), {
        originalPath: suggested,
        originalFingerprint: null,
      }),
    )
    expect(await recovery.listAllCandidates()).toEqual([])
    await recovery.forgetOwner('window-a')
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    expect(await restarted.listAllCandidates()).toMatchObject([
      {
        id: result.candidateId,
        originalPath: suggested,
        originalState: 'unchecked',
      },
    ])
    expect(
      (await restarted.readCandidate(result.candidateId!, suggested)).snapshot.payload,
    ).toEqual(fullPayload('unsaved new document'))
    await expect(access(suggested)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps encrypted checkpoints in memory and never creates its private recovery root', async () => {
    const decrypted = join(directory, 'decrypted-session-snapshot.xlsx')
    await writeFile(decrypted, 'plaintext owned by the existing session, never copied for recovery')
    const result = await recovery.checkpoint(
      input(fullPayload('sensitive edit'), {
        encrypted: true,
        sourcePath: decrypted,
      }),
    )
    expect(result.durable).toBe(false)
    expect(result.candidateId).toBeNull()
    expect(native.opens[0]!.sourcePath).toBe(decrypted)
    expect(native.opens[0]!.storePath).toBeUndefined()
    await recovery.forgetOwner('window-a')
    expect(await recovery.listCandidates(source)).toEqual([])
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retires only the explicitly selected UUID candidate', async () => {
    const one = await recovery.checkpoint(input(fullPayload('one')))
    const two = await recovery.checkpoint(input(fullPayload('two'), { ownerId: 'window-b' }))
    await expect(recovery.retire('../original.xlsx')).rejects.toMatchObject({
      code: 'invalid_candidate',
    })
    await recovery.retire(one.candidateId!)
    await expect(access(join(root, one.candidateId!))).rejects.toMatchObject({ code: 'ENOENT' })
    await access(join(root, two.candidateId!, 'manifest.json'))
    expect(await readFile(source, 'utf8')).toBe('immutable test workbook base')
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    expect(await restarted.listCandidates(source)).toMatchObject([{ id: two.candidateId }])
  })

  it('retires an encrypted authority by document ID and starts a clean same-session authority without recovery files', async () => {
    const first = await recovery.checkpoint(
      input(fullPayload('sensitive first edit'), { encrypted: true }),
    )
    const other = await recovery.checkpoint(
      input(fullPayload('other protected owner'), { encrypted: true, ownerId: 'window-b' }),
    )
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolveStarted) => {
      entered = resolveStarted
    })
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    native.beforeCommit = async () => {
      entered()
      await gate
    }
    const pending = recovery.checkpoint(
      input(fullPayload('last acknowledged sensitive edit'), { encrypted: true }),
    )
    await started
    const retiring = recovery.retire(first.documentId)
    expect(native.closes).toEqual([])
    release()
    expect((await pending).revision).toBe(2)
    await retiring
    expect(native.closes).toEqual([first.documentId])
    await expect(
      native.documentSnapshot({ apiVersion: 1, documentId: first.documentId }),
    ).rejects.toThrow('Document is closed')
    expect(
      (
        (await native.documentSnapshot({ apiVersion: 1, documentId: other.documentId })) as {
          revision: number
        }
      ).revision,
    ).toBe(1)
    const fresh = await recovery.checkpoint(
      input(fullPayload('fresh protected state'), { encrypted: true }),
    )
    expect(fresh.documentId).not.toBe(first.documentId)
    expect(fresh.revision).toBe(1)
    expect(fresh.candidateId).toBeNull()
    expect(native.checkpoints.at(-1)!.expectedRevision).toBe(0)
    expect(native.opens.every((opened) => opened.storePath === undefined)).toBe(true)
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves an active durable authority when its manifest is unexpectedly missing', async () => {
    const receipt = await recovery.checkpoint(input(fullPayload('must remain recoverable')))
    await rm(join(root, receipt.documentId, 'manifest.json'))
    await expect(recovery.retire(receipt.documentId)).rejects.toMatchObject({
      code: 'missing_checkpoint',
    })
    expect(native.closes).toEqual([])
    expect(
      (
        (await native.documentSnapshot({ apiVersion: 1, documentId: receipt.documentId })) as {
          revision: number
        }
      ).revision,
    ).toBe(1)
    await access(join(root, receipt.documentId, 'document.sqlite'))
  })

  it('waits for in-flight checkpoint acknowledgement before retiring its files', async () => {
    const first = await recovery.checkpoint(input(fullPayload('one')))
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolveStarted) => {
      entered = resolveStarted
    })
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    native.beforeCommit = async () => {
      entered()
      await gate
    }
    const second = recovery.checkpoint(input(fullPayload('two')))
    await started
    const retiring = recovery.retire(first.candidateId!)
    await access(join(root, first.candidateId!, 'manifest.json'))
    expect(native.closes).toEqual([])
    release()
    expect((await second).revision).toBe(2)
    await retiring
    await expect(access(join(root, first.candidateId!))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('flushes immediately queued owner work on unexpected close and leaves it discoverable', async () => {
    const pending = recovery.checkpoint(input(fullPayload('last window edit')))
    const closing = recovery.forgetOwner('window-a')
    const result = await pending
    await closing
    expect(native.closes).toContain(result.documentId)
    expect(await recovery.listCandidates(source)).toMatchObject([{ id: result.candidateId }])
  })

  it('rejects malformed manifests and tampered pinned bases without deleting their files', async () => {
    const result = await recovery.checkpoint(input(fullPayload('retain me')))
    const manifestPath = join(root, result.candidateId!, 'manifest.json')
    const originalManifest = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, '{"version":1,"id":"../../outside"}')
    const restarted = new WorkbookDocumentRecovery({
      privateRoot: root,
      nativeClient: new MockNative(),
    })
    expect(await restarted.listCandidates(source)).toEqual([])
    await expect(restarted.readCandidate(result.candidateId!)).rejects.toMatchObject({
      code: 'invalid_manifest',
    })
    await expect(restarted.retire(result.candidateId!)).rejects.toMatchObject({
      code: 'invalid_manifest',
    })
    await access(manifestPath)
    await writeFile(manifestPath, originalManifest)
    const manifest = JSON.parse(originalManifest) as { sourceFingerprint: string }
    const basePath = join(
      root,
      result.candidateId!,
      `base-${manifest.sourceFingerprint.slice(7)}.xlsx`,
    )
    await writeFile(basePath, 'tampered base')
    await expect(restarted.readCandidate(result.candidateId!)).rejects.toMatchObject({
      code: 'source_conflict',
    })
    expect(await readFile(basePath, 'utf8')).toBe('tampered base')
    expect(await readFile(source, 'utf8')).toBe('immutable test workbook base')
  })
})
