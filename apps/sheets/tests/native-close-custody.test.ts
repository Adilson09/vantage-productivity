import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DocumentNativeClient,
  NativeDocumentSnapshot,
} from '../src/main/document-native-contract'
import {
  createNativeCloseCustodyProvider,
  type NativeCloseCustodyProvider,
  type NativeCustodyTask,
} from '../src/main/native-close-custody'
import {
  WorkbookDocumentRecovery,
  type CapturedNativeCloseAuthority,
  type DocumentCheckpointInput,
} from '../src/main/workbook-document-recovery'

type Open = Parameters<DocumentNativeClient['openDocument']>[0]
type Checkpoint = Parameters<DocumentNativeClient['checkpointDocument']>[0]
interface Stored extends NativeDocumentSnapshot {
  storePath?: string
  receipts: Record<string, unknown>
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The SQLite stand-in is JSON only in these isolated mock-RPC tests. */
class Native implements DocumentNativeClient {
  readonly documents = new Map<string, Stored>()
  readonly commits: Checkpoint[] = []
  readonly closes: string[] = []
  beforeCommit?: (input: Checkpoint) => Promise<void>
  async openDocument(input: Open): Promise<unknown> {
    const sourceFingerprint = `sha256:${createHash('sha256')
      .update(await readFile(input.sourcePath))
      .digest('hex')}`
    let value: Stored | undefined
    let recovered = false
    if (input.storePath) {
      try {
        value = JSON.parse(await readFile(input.storePath, 'utf8')) as Stored
        recovered = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else value = this.documents.get(input.documentId)
    if (
      value &&
      (value.documentId !== input.documentId || value.sourceFingerprint !== sourceFingerprint)
    )
      throw new Error('source conflict')
    value ??= {
      apiVersion: 1,
      documentId: input.documentId,
      revision: 0,
      sourceFingerprint,
      sheets: clone(input.sheets),
      payload: {},
      receipts: {},
      ...(input.storePath ? { storePath: input.storePath } : {}),
    }
    this.documents.set(input.documentId, value)
    if (value.storePath) await writeFile(value.storePath, JSON.stringify(value))
    return {
      apiVersion: 1,
      documentId: input.documentId,
      revision: value.revision,
      sourceFingerprint,
      recovered,
      durable: !!input.storePath,
    }
  }
  async checkpointDocument(input: Checkpoint): Promise<unknown> {
    this.commits.push(clone(input))
    await this.beforeCommit?.(input)
    const old = this.documents.get(input.documentId)
    if (!old || old.revision !== input.expectedRevision) throw new Error('revision conflict')
    const value: Stored = {
      ...old,
      revision: old.revision + 1,
      payload: clone(input.payload),
      receipts: { ...old.receipts },
    }
    const receipt = {
      apiVersion: 1,
      documentId: input.documentId,
      commandId: input.commandId,
      revision: value.revision,
      durable: !!value.storePath,
    }
    value.receipts[input.commandId] = receipt
    this.documents.set(input.documentId, value)
    if (value.storePath) await writeFile(value.storePath, JSON.stringify(value))
    return receipt
  }
  async documentSnapshot(
    input: Parameters<DocumentNativeClient['documentSnapshot']>[0],
  ): Promise<unknown> {
    const value = this.documents.get(input.documentId)
    if (!value || (input.revision !== undefined && value.revision !== input.revision))
      throw new Error('stale snapshot')
    const { storePath: _storePath, receipts: _receipts, ...snapshot } = value
    return clone(snapshot)
  }
  async documentCommandResult(
    input: Parameters<DocumentNativeClient['documentCommandResult']>[0],
  ): Promise<unknown> {
    return clone(this.documents.get(input.documentId)?.receipts[input.commandId] ?? null)
  }
  async closeDocument(
    input: Parameters<DocumentNativeClient['closeDocument']>[0],
  ): Promise<unknown> {
    this.closes.push(input.documentId)
    this.documents.delete(input.documentId)
    return { closed: true }
  }
}

describe('native close custody provider (private proposal, mock RPC only)', () => {
  let directory: string
  let native: Native
  let recovery: WorkbookDocumentRecovery
  let provider: NativeCloseCustodyProvider
  let input: DocumentCheckpointInput
  beforeEach(async () => {
    // Windows may expose TEMP through an 8.3 alias. Trust the actual newly
    // created physical fixture root before constructing any custody targets.
    directory = await realpath(await mkdtemp(join(tmpdir(), 'native-close-custody-')))
    await mkdir(join(directory, 'custody'))
    const source = join(directory, 'source.xlsx')
    await writeFile(
      source,
      Buffer.from('fixture unknown OOXML parts + opaque binary\0\u00e1\u{1f4be}'),
    )
    native = new Native()
    recovery = new WorkbookDocumentRecovery({
      privateRoot: join(directory, 'recovery'),
      nativeClient: native,
    })
    provider = createNativeCloseCustodyProvider({ nativeClient: native })
    input = {
      ownerId: 9,
      sessionId: 'session',
      originalPath: source,
      sourcePath: source,
      sheets: [{ id: 'sheet-1', name: 'Budget' }],
      payload: { edits: [{ value: 10 }] },
    }
  })
  afterEach(async () => {
    await recovery.forgetOwner(9)
    await rm(directory, { recursive: true, force: true })
  })

  function task(authority: CapturedNativeCloseAuthority): NativeCustodyTask {
    return {
      id: randomUUID(),
      module: 'sheets',
      ownerKey: authority.ownerId,
      source: 'main-document-lineage',
      generation: authority.generation,
      token: authority.producer,
      documentPath: authority.originalPath,
      custody: { provider: provider.id, input: provider.captureInput(authority) },
    }
  }
  function target(): string {
    return join(directory, 'custody', randomUUID())
  }
  async function capture(
    authority: CapturedNativeCloseAuthority,
    destination = target(),
    signal = new AbortController().signal,
  ) {
    const reserve = vi.fn((bytes: number) => {
      expect(bytes).toBeGreaterThan(0)
      expect(existsSync(destination)).toBe(false)
    })
    const result = await provider.capture({
      task: task(authority),
      targetRoot: destination,
      signal,
      reserve,
    })
    return { destination, reserve, result }
  }

  it('preserves exact source snapshot/base bytes and types without copying history or writing a new native store', async () => {
    await recovery.checkpoint(input)
    const payload = {
      edits: [{ value: '12' }, { value: false }, { value: null }, { formula: '=A1*2' }],
      sheetOps: [{ kind: 'rename-sheet', sheetId: 'sheet-1', name: 'Renamed' }],
      noteStates: [{ text: 'multiline\n\u00e1' }],
    }
    const old = await recovery.checkpoint({ ...input, payload })
    const authority = recovery.captureNativeCloseAuthority(9, 'session')!
    await expect(provider.runCaptured(authority, new AbortController().signal)).rejects.toThrow(
      'before verified',
    )
    const { destination, reserve, result } = await capture(authority)
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(result).not.toBeNull()
    const receipt = result!.receipt
    expect(receipt.sourceRevision).toBe(2)
    expect(receipt.sourceDocumentId).toBe(old.documentId)
    expect(receipt).not.toHaveProperty('custodyDocumentId')
    expect(receipt.commandHistory).toBe('not-cloned-current-snapshot-only')
    expect(receipt.permissions).toBe('none-imported')
    expect(native.commits).toHaveLength(2)
    expect((await readdir(destination)).sort()).toEqual([
      'base.xlsx',
      'custody.json',
      'source-snapshot.json',
    ])
    const inventoryBytes = await Promise.all(
      (await readdir(destination)).map(
        async (name) => (await readFile(join(destination, name))).length,
      ),
    )
    expect(result!.bytes).toBe(inventoryBytes.reduce((sum, size) => sum + size, 0))
    expect(result!.bytes).toBeLessThanOrEqual(reserve.mock.calls[0]![0])
    expect(await readFile(join(destination, 'base.xlsx'))).toEqual(await readFile(input.sourcePath))
    const restartedProvider = createNativeCloseCustodyProvider()
    const readback = await restartedProvider.readCustody(
      destination,
      receipt,
      new AbortController().signal,
    )
    expect(readback.snapshot.payload).toEqual(payload)
    expect(readback.snapshot.documentId).toBe(old.documentId)
    expect(readback.snapshot.revision).toBe(2)
    expect(authority.attest()?.payloadSha256).toBe(readback.payloadSha256)
    const resumed = await recovery.checkpoint({ ...input, payload: { edits: [{ value: 88 }] } })
    await provider.runCaptured(authority, new AbortController().signal)
    await expect(access(join(directory, 'recovery', old.documentId))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      access(join(directory, 'recovery', resumed.documentId, 'document.sqlite')),
    ).resolves.toBeUndefined()
    expect(recovery.candidateFor(9, 'session')).toBe(resumed.documentId)
    expect(native.documents.get(resumed.documentId)?.payload).toEqual({ edits: [{ value: 88 }] })
    expect(await readFile(join(destination, 'base.xlsx'))).toEqual(await readFile(input.sourcePath))
  })

  it('refuses reconstructed capture objects or changed lineage before quota/files', async () => {
    await recovery.checkpoint(input)
    const authority = recovery.captureNativeCloseAuthority(9, 'session')!
    expect(() => provider.captureInput({ ...authority })).toThrow('main-owned')
    const invalid = task(authority)
    invalid.custody.input = {}
    const reserve = vi.fn(),
      destination = target()
    await expect(
      provider.capture({
        task: invalid,
        targetRoot: destination,
        signal: new AbortController().signal,
        reserve,
      }),
    ).rejects.toThrow('not owned')
    expect(reserve).not.toHaveBeenCalled()
    expect(existsSync(destination)).toBe(false)
    const changed = task(authority)
    changed.token = randomUUID()
    await expect(
      provider.capture({
        task: changed,
        targetRoot: destination,
        signal: new AbortController().signal,
        reserve,
      }),
    ).rejects.toThrow('lineage')
    expect(reserve).not.toHaveBeenCalled()
  })

  it('rejects divergent native snapshot payload before any custody reservation or files', async () => {
    const receipt = await recovery.checkpoint(input)
    const authority = recovery.captureNativeCloseAuthority(9, 'session')!
    const originalSnapshot = native.documentSnapshot.bind(native)
    native.documentSnapshot = async (request) => ({
      ...((await originalSnapshot(request)) as NativeDocumentSnapshot),
      payload: { edits: [{ value: 777 }] },
    })
    const destination = target(),
      reserve = vi.fn()
    await expect(
      provider.capture({
        task: task(authority),
        targetRoot: destination,
        signal: new AbortController().signal,
        reserve,
      }),
    ).rejects.toThrow('known final acknowledged payload')
    expect(reserve).not.toHaveBeenCalled()
    expect(existsSync(destination)).toBe(false)
    await expect(
      access(join(directory, 'recovery', receipt.documentId, 'document.sqlite')),
    ).resolves.toBeUndefined()
  })

  it('protected memory-only capture returns null before reserve/native/files and closes only its captured ID after removal', async () => {
    const protectedRecovery = new WorkbookDocumentRecovery({
      privateRoot: join(directory, 'must-not-exist'),
      nativeClient: native,
    })
    const protectedInput = { ...input, encrypted: true }
    const old = await protectedRecovery.checkpoint(protectedInput)
    const authority = protectedRecovery.captureNativeCloseAuthority(9, 'session')!
    const reserve = vi.fn()
    const before = native.commits.length
    const destination = join(directory, 'also-missing', 'custody')
    expect(
      await provider.capture({
        task: task(authority),
        targetRoot: destination,
        signal: new AbortController().signal,
        reserve,
      }),
    ).toBeNull()
    expect(reserve).not.toHaveBeenCalled()
    expect(native.commits).toHaveLength(before)
    expect(existsSync(join(directory, 'must-not-exist'))).toBe(false)
    expect(existsSync(join(directory, 'also-missing'))).toBe(false)
    const resumed = await protectedRecovery.checkpoint({
      ...protectedInput,
      payload: { edits: [{ value: 'new epoch' }] },
    })
    await provider.runCaptured(authority, new AbortController().signal)
    expect(native.closes).toContain(old.documentId)
    expect(native.documents.has(resumed.documentId)).toBe(true)
    expect(existsSync(join(directory, 'must-not-exist'))).toBe(false)
    await protectedRecovery.forgetOwner(9)
  })

  it('reserves a conservative bound before creating target files and retains the source when quota admission fails', async () => {
    const old = await recovery.checkpoint(input)
    const authority = recovery.captureNativeCloseAuthority(9, 'session')!
    const destination = target()
    const reserve = vi.fn(() => {
      expect(existsSync(destination)).toBe(false)
      throw new Error('quota full')
    })
    await expect(
      provider.capture({
        task: task(authority),
        targetRoot: destination,
        signal: new AbortController().signal,
        reserve,
      }),
    ).rejects.toThrow('quota full')
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(existsSync(destination)).toBe(false)
    await expect(
      access(join(directory, 'recovery', old.documentId, 'document.sqlite')),
    ).resolves.toBeUndefined()
  })

  it('fails closed before reservation or target files when the immutable base exceeds its byte budget', async () => {
    const old = await recovery.checkpoint(input)
    const authority = recovery.captureNativeCloseAuthority(9, 'session')!
    const withoutBudget = createNativeCloseCustodyProvider({ limits: { maxBaseBytes: 1 } })
    const selected = task(authority)
    selected.custody.input = withoutBudget.captureInput(authority)
    const destination = target(),
      reserve = vi.fn()
    await expect(
      withoutBudget.capture({
        task: selected,
        targetRoot: destination,
        signal: new AbortController().signal,
        reserve,
      }),
    ).rejects.toThrow('configured byte budget')
    expect(reserve).not.toHaveBeenCalled()
    expect(existsSync(destination)).toBe(false)
    await expect(
      access(join(directory, 'recovery', old.documentId, 'document.sqlite')),
    ).resolves.toBeUndefined()
  })

  it('rejects every unaccounted SHM/WAL/extra file instead of understating immutable capture bytes', async () => {
    const old = await recovery.checkpoint(input)
    const authority = recovery.captureNativeCloseAuthority(9, 'session')!
    const destination = target()
    const captured = await capture(authority, destination)
    await writeFile(join(destination, 'document.sqlite-shm'), 'unaccounted sidecar')
    await expect(
      provider.readCustody(destination, captured.result!.receipt, new AbortController().signal),
    ).rejects.toThrow('sidecar')
    await expect(
      access(join(directory, 'recovery', old.documentId, 'document.sqlite')),
    ).resolves.toBeUndefined()
    expect(await readdir(destination)).toContain('document.sqlite-shm')
    await expect(provider.runCaptured(authority, new AbortController().signal)).rejects.toThrow(
      'sidecar',
    )
  })

  it('an aborted native source snapshot waits for actual settlement and cannot retire the original', async () => {
    const old = await recovery.checkpoint(input)
    const authority = recovery.captureNativeCloseAuthority(9, 'session')!
    const entered = deferred(),
      release = deferred()
    const originalSnapshot = native.documentSnapshot.bind(native)
    native.documentSnapshot = async (command) => {
      if (command.documentId === old.documentId) {
        entered.resolve()
        await release.promise
      }
      return originalSnapshot(command)
    }
    const controller = new AbortController()
    const pending = capture(authority, target(), controller.signal)
    let settled = false
    const outcome = pending.then(
      () => {
        settled = true
        return null
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await entered.promise
    controller.abort(new Error('close canceled'))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(native.closes.filter((id) => id !== old.documentId)).toHaveLength(0)
    release.resolve()
    expect(await outcome).toBeInstanceOf(Error)
    expect(native.closes.filter((id) => id !== old.documentId)).toHaveLength(0)
    await expect(
      access(join(directory, 'recovery', old.documentId, 'document.sqlite')),
    ).resolves.toBeUndefined()
    await expect(provider.runCaptured(authority, new AbortController().signal)).rejects.toThrow(
      'before verified',
    )
  })

  it('tampered custody or canceled removal preserves both authorities and does not unlink replacement bytes', async () => {
    const old = await recovery.checkpoint(input)
    const authority = recovery.captureNativeCloseAuthority(9, 'session')!
    const { destination, result } = await capture(authority)
    await writeFile(join(destination, 'base.xlsx'), 'replacement bytes')
    await expect(provider.runCaptured(authority, new AbortController().signal)).rejects.toThrow(
      'hash/size',
    )
    await expect(
      access(join(directory, 'recovery', old.documentId, 'document.sqlite')),
    ).resolves.toBeUndefined()
    await expect(
      provider.purge({
        status: { capturedEntry: result!.binding },
        targetRoot: destination,
        receipt: result!.receipt,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('hash/size')
    expect(await readFile(join(destination, 'base.xlsx'), 'utf8')).toBe('replacement bytes')
    expect(await readdir(destination)).toContain('source-snapshot.json')
    await authority.cancel()
    await expect(authority.retireCapturedOnly(new AbortController().signal)).rejects.toThrow(
      'no longer grants',
    )
  })
})
