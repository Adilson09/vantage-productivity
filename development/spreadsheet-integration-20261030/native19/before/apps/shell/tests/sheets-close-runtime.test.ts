import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { CloseCleanupQueue, type CloseCleanupStatus, type CloseCleanupTask } from '../../../packages/electron-utils/src/close-cleanup'
import type { CloseCustodyProvider } from '../../../packages/electron-utils/src/close-custody-providers'
import { beginSheetsMemoryClose } from '../../sheets/src/main/sheets-memory-close'
import type { NativeCloseCustodyProvider, NativeCustodyLineage } from '../../sheets/src/main/native-close-custody'
import type { CapturedNativeCloseAuthority } from '../../sheets/src/main/workbook-document-recovery'
import type { SheetsCloseRuntime } from '../../sheets/src/main/sheets-main'
import type { SheetsCloseState } from '../../sheets/src/shared/sheets-close'
import { createSheetsCloseRuntimeInstaller } from '../src/main/sheets-close-runtime'
import { SheetsCloseQuitLedger } from '../src/main/sheets-close-quit-ledger'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve() }
type Capture = Awaited<ReturnType<NativeCloseCustodyProvider['capture']>>
const capture: NonNullable<Capture> = { bytes: 64, binding: { module: 'sheets', documentPath: 'C:/synthetic/book.xlsx', sha256: 'b'.repeat(64) }, receipt: { format: 1 } }

function authority(encrypted = false) {
  const retire = vi.fn(async (_signal: AbortSignal) => undefined)
  const snapshot = vi.fn(async () => { throw new Error('The runtime installer must not reconstruct snapshots itself.') })
  const value: CapturedNativeCloseAuthority = {
    id: '10000000-0000-4000-8000-000000000001', producer: '10000000-0000-4000-8000-000000000001', generation: 7,
    ownerId: '21', sessionId: '20000000-0000-4000-8000-000000000001', originalPath: 'C:/synthetic/book.xlsx',
    encrypted, ready: Promise.resolve(), cancelled: false,
    attest: () => ({ documentId: value.id, revision: 9, sourceFingerprint: `sha256:${'a'.repeat(64)}`, payloadSha256: 'c'.repeat(64), pending: false }),
    snapshotProof: snapshot, retireCapturedOnly: retire, cancel: async () => undefined,
    resume: async () => undefined, settled: async () => undefined,
  }
  return { value, retire, snapshot }
}

function fixture() {
  const events: string[] = ['foundation']
  const ledger = new SheetsCloseQuitLedger(), opaque = Object.freeze({})
  let destroyed = false, unavailable = false, captureWork: Promise<Capture> | undefined
  let runWork: Promise<void> | undefined, registered: CloseCustodyProvider | undefined, runtime!: SheetsCloseRuntime
  let state: SheetsCloseState | null = { source: { lineage: 'source-lineage', sessionId: '20000000-0000-4000-8000-000000000001',
    openedSha256: 'a'.repeat(64), documentPath: 'C:/synthetic/book.xlsx' },
    stamp: { source: 'authored-generation', revision: '9' }, dirty: true, busy: false, protectedMemoryOnly: false }
  const owner = { id: 21, isDestroyed: () => destroyed } as WebContents
  const input = vi.fn((_authority: CapturedNativeCloseAuthority, _lineage?: NativeCustodyLineage) => opaque)
  const nativeCapture = vi.fn(async (_context: Parameters<NativeCloseCustodyProvider['capture']>[0]): Promise<Capture> => captureWork ? await captureWork : capture)
  const run = vi.fn((value: CapturedNativeCloseAuthority, signal: AbortSignal) => runWork ?? value.retireCapturedOnly(signal))
  const purge = vi.fn(async () => undefined)
  const provider: NativeCloseCustodyProvider = { id: 'sheets-native', limits: { maxEntryBytes: 1024, maxTotalBytes: 4096, maxEntries: 4 },
    captureInput: input, capture: nativeCapture, runCaptured: run, validateReceipt: () => true, purge,
    readCustody: async () => { throw new Error('The installer does not perform restoration.') } }
  const create = vi.fn(() => { events.push('provider-created'); return provider })
  const register = vi.fn((value: CloseCustodyProvider) => { events.push('provider-registered'); registered = value })
  const requireRecovery = vi.fn(() => { if (unavailable) throw new Error('Recovery unavailable') })
  const tasks: CloseCleanupTask[] = [], statuses: CloseCleanupStatus[] = []
  const queue = new CloseCleanupQueue({ persist: status => { statuses.push(status) }, warning: vi.fn(), purge: async () => undefined,
    timeoutMs: 20, preparationTimeoutMs: () => registered!.captureTimeoutMs!,
    prepare: async (task, signal) => {
      await task.ready
      const result = await registered!.capture({ task, signal, targetRoot: 'not-created-by-this-fixture', reserve: () => undefined })
      return result ? { capturedEntry: result.binding, provider: registered!.id, receipt: result.receipt } : false
    } })
  const begin = vi.fn((task: CloseCleanupTask) => { tasks.push(task); return queue.begin(task) })
  const memory = vi.fn(beginSheetsMemoryClose)
  const setRuntime = vi.fn((value: SheetsCloseRuntime) => { events.push('runtime-installed'); runtime = value })
  const closeState = vi.fn(() => state)
  const install = createSheetsCloseRuntimeInstaller({ createProvider: create, registerProvider: register,
    beginPersistent: begin, beginMemory: memory, requireRecovery, uuid: () => '30000000-0000-4000-8000-000000000001' })
  const options = { ledger, setRuntime, closeState }
  const installed = install(options)
  return { owner, ledger, provider, installed, install, options, events, input, nativeCapture, run, purge,
    create, register, requireRecovery, begin, memory, tasks, statuses, closeState, setRuntime,
    runtime: () => runtime, registration: () => registered!,
    unavailable: () => { unavailable = true }, noState: () => { state = null }, destroy: () => { destroyed = true },
    setCapture: (promise: Promise<Capture>) => { captureWork = promise }, setRun: (promise: Promise<void>) => { runWork = promise } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('actual Sheets close runtime installer (private successor sources)', () => {
  it('registers one provider and installs the actual setter between foundation and editor services', () => {
    const f = fixture()
    f.events.push('editors')
    expect(f.events).toEqual(['foundation', 'provider-created', 'provider-registered', 'runtime-installed', 'editors'])
    expect(f.install(f.options)).toBe(f.installed)
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.register).toHaveBeenCalledTimes(1); expect(f.setRuntime).toHaveBeenCalledTimes(1)
    expect(f.registration().captureTimeoutMs).toBe(120_000)
    expect(f.registration().capture).toBe(f.provider.capture)
    expect(f.requireRecovery).not.toHaveBeenCalled()
    expect(() => f.install({ ...f.options, ledger: new SheetsCloseQuitLedger() })).toThrow('another main host')
  })

  it('coverage uses local installation and exact live main state without querying persistent recovery or group predicates', () => {
    const f = fixture(); f.unavailable()
    expect(f.runtime().coverageComplete(f.owner)).toBe(true)
    expect(f.closeState).toHaveBeenCalledWith(f.owner)
    expect(f.requireRecovery).not.toHaveBeenCalled()
    f.noState(); expect(f.runtime().coverageComplete(f.owner)).toBe(false)
    f.destroy(); expect(f.runtime().coverageComplete(f.owner)).toBe(false)
  })

  it('binds the persistent task to the captured owner/lineage/generation/token/path and its exact drain', async () => {
    const f = fixture(), a = authority(), drain = deferred<void>()
    const captured = { ...a.value, ready: drain.promise }
    const admission = f.runtime().stagePersistent(f.owner, 'source-lineage', captured)
    const task = f.tasks[0]!
    expect(task).toMatchObject({ id: '30000000-0000-4000-8000-000000000001', module: 'sheets', ownerKey: '21',
      source: 'source-lineage', generation: 7, token: a.value.producer, documentPath: a.value.originalPath,
      custody: { provider: f.provider.id, input: f.input.mock.results[0]!.value } })
    expect(task.ready).toBe(drain.promise)
    expect(f.input).toHaveBeenCalledWith(captured, { id: task.id, module: task.module, ownerKey: task.ownerKey,
      source: task.source, generation: task.generation, token: task.token, documentPath: task.documentPath })
    await flush(); expect(f.nativeCapture).not.toHaveBeenCalled(); expect(f.ledger.hasPending()).toBe(true)
    drain.resolve(); const handle = await admission.ready
    expect(f.nativeCapture.mock.calls[0]![0].task).toMatchObject({ id: task.id, ownerKey: task.ownerKey,
      source: task.source, generation: task.generation, token: task.token, documentPath: task.documentPath,
      custody: { provider: f.provider.id, input: f.input.mock.results[0]!.value } })
    expect(f.nativeCapture.mock.calls[0]![0].task.ready).toBe(task.ready)
    expect(f.nativeCapture.mock.calls[0]![0].task.run).toBe(task.run)
    expect(f.run).not.toHaveBeenCalled(); expect(a.retire).not.toHaveBeenCalled()
    handle.cancel('test keeps the workbook open')
    await f.ledger.joinActual(); expect(f.ledger.hasPending()).toBe(false)
  })

  it('a preparation deadline never releases the actual provider capture finalizer', async () => {
    const f = fixture(), a = authority(), pending = deferred<Capture>()
    f.setCapture(pending.promise)
    const admission = f.runtime().stagePersistent(f.owner, 'source-lineage', a.value)
    await flush(); expect(f.nativeCapture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_001)
    await expect(admission.ready).rejects.toThrow('timed out')
    expect(f.ledger.hasPending()).toBe(true); expect(a.retire).not.toHaveBeenCalled()
    pending.resolve(capture)
    await f.ledger.joinActual(); expect(f.ledger.hasPending()).toBe(false)
  })

  it('tracks actual post-removal native retirement even after the shared bounded run outcome times out', async () => {
    const f = fixture(), a = authority(), pending = deferred<void>()
    f.setRun(pending.promise)
    const handle = await f.runtime().stagePersistent(f.owner, 'source-lineage', a.value).ready
    expect(f.run).not.toHaveBeenCalled()
    expect(handle.commitRemoval(() => true)).toBe(true)
    await flush(); expect(f.run.mock.calls[0]![0]).toBe(a.value)
    const signal = f.run.mock.calls[0]![1]
    expect(signal).toBeInstanceOf(AbortSignal)
    await vi.advanceTimersByTimeAsync(21)
    expect((await handle.outcome).phase).toBe('retained')
    expect(f.ledger.hasPending()).toBe(true)
    pending.resolve(); await f.ledger.joinActual()
    expect(f.ledger.hasPending()).toBe(false); expect(f.run).toHaveBeenCalledTimes(1)
  })

  it('protected staging and removal bypass persistent require/input/provider/queue even when recovery is unavailable', async () => {
    const f = fixture(), a = authority(true), pending = deferred<void>()
    f.unavailable(); a.retire.mockImplementation(() => pending.promise)
    const handle = await f.runtime().stageMemory(f.owner, 'source-lineage', a.value).ready
    expect(handle.status().custody).toBe(false)
    expect(handle.commitRemoval(() => { expect(f.ledger.hasPending()).toBe(true); return true })).toBe(true)
    await flush(); expect(a.retire).toHaveBeenCalledTimes(1); expect(f.ledger.hasPending()).toBe(true)
    for (const operation of [f.requireRecovery, f.begin, f.input, f.nativeCapture, f.run, f.purge, a.snapshot]) expect(operation).not.toHaveBeenCalled()
    pending.resolve(); await f.ledger.joinActual()
    expect(handle.status().phase).toBe('complete')
    expect(f.ledger.hasBlockedFailures()).toBe(false)
  })

  it('protected native retirement failure stays a RAM-only quit veto until an explicit exact retry settles', async () => {
    const f = fixture(), a = authority(true)
    a.retire.mockRejectedValueOnce(new Error('synthetic native failure')).mockResolvedValueOnce(undefined)
    const handle = await f.runtime().stageMemory(f.owner, 'source-lineage', a.value).ready
    expect(handle.commitRemoval(() => true)).toBe(true)
    await expect(f.ledger.joinActual()).rejects.toThrow('retirement remains incomplete')
    expect(f.ledger.hasPending()).toBe(false); expect(f.ledger.hasBlockedFailures()).toBe(true)
    expect(handle.status().phase).toBe('retained')
    const firstSignal = a.retire.mock.calls[0]![0]
    await f.ledger.retryFailed()
    expect(a.retire).toHaveBeenCalledTimes(2)
    expect(a.retire.mock.calls[1]![0]).not.toBe(firstSignal)
    expect(a.retire.mock.calls[1]![0].aborted).toBe(false)
    expect(f.ledger.hasBlockedFailures()).toBe(false)
    for (const operation of [f.requireRecovery, f.begin, f.input, f.nativeCapture, f.run, f.purge]) expect(operation).not.toHaveBeenCalled()
  })

  it('unavailable recovery refuses a persistent stage before minting an input but still allows protected preparation', async () => {
    const f = fixture(); f.unavailable()
    expect(() => f.runtime().stagePersistent(f.owner, 'source-lineage', authority().value)).toThrow('Recovery unavailable')
    expect(f.input).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled()
    const protectedAdmission = f.runtime().stageMemory(f.owner, 'source-lineage', authority(true).value)
    const handle = await protectedAdmission.ready
    handle.cancel('user keeps workbook open'); await f.ledger.joinActual()
    expect(f.requireRecovery).toHaveBeenCalledTimes(1)
  })

  it('wrong owner, protected-to-persistent, and plain-to-memory calls cannot enter provider admission', () => {
    const f = fixture(), foreign = { id: 22, isDestroyed: () => false } as WebContents
    expect(() => f.runtime().stagePersistent(foreign, 'source-lineage', authority().value)).toThrow('exact live Sheets owner')
    expect(() => f.runtime().stagePersistent(f.owner, 'source-lineage', authority(true).value)).toThrow('memory-only stage')
    expect(() => f.runtime().stageMemory(f.owner, 'source-lineage', authority().value)).toThrow('protected authority')
    expect(f.requireRecovery).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled()
  })

  it('holds actual non-provider native work in the same quit ledger', async () => {
    const f = fixture(), actual = deferred<void>()
    f.runtime().holdNativeUntilSettled(f.owner, actual.promise)
    expect(f.ledger.hasPending()).toBe(true)
    actual.resolve(); await f.ledger.joinActual()
    expect(f.ledger.hasPending()).toBe(false)
  })
})
