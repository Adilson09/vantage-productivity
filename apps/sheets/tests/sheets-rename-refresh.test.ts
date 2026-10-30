import { describe, expect, it } from 'vitest'
import { SheetsRenameRefreshTransport } from '../src/main/sheets-rename-refresh'
import type { WorkbookRenamedMetadata, WorkbookRenameRefreshResult } from '../src/shared/desktop-api'

function deferred<T>() { let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fixture() {
  const owner = {}, foreign = {}, tail = deferred<void>()
  const source = { lineage: 'lineage', sessionId: '20000000-0000-4000-8000-000000000001', openedSha256: 'a'.repeat(64), documentPath: 'C:/synthetic/named.xlsx' }
  const metadata: WorkbookRenamedMetadata = { sessionId: source.sessionId, path: source.documentPath, closeSource: source, requiresCheckpoint: true }
  const sent: WorkbookRenamedMetadata[] = []
  let current = true
  const transport = new SheetsRenameRefreshTransport<object>({ send: (_owner, _name, value) => { sent.push(value) },
    publicationTail: () => tail.promise, validate: (_owner, value, result) => current && result.ok &&
      result.sessionId === value.sessionId && result.payloadSha256 === 'b'.repeat(64) && result.documentId === 'native-exact-producer' && result.revision === 4,
  })
  const admission = transport.begin(owner, 'named.xlsx', metadata), id = sent[0]!.refreshId!
  const success: WorkbookRenameRefreshResult = { ok: true, sessionId: source.sessionId, source,
    documentId: 'native-exact-producer', revision: 4, payloadSha256: 'b'.repeat(64) }
  return { owner, foreign, tail, transport, admission, id, success, metadata, sent, changeSource: () => { current = false } }
}

describe('correlated actual rename refresh (private successor sources)', () => {
  it('a full checkpoint result alone cannot release the distinct callback/native-publication finalizers', async () => {
    const f = fixture(); let done = false
    void f.admission.actualSettled.then(() => { done = true })
    expect(f.transport.receiveResult(f.owner, f.id, f.success)).toBe(true)
    await flush(); expect(done).toBe(false)
    expect(f.transport.receiveActualSettled(f.owner, f.id)).toBe(true)
    await flush(); expect(done).toBe(false)
    f.tail.resolve(); expect(await f.admission.completion).toEqual(f.success)
    await f.admission.actualSettled; expect(done).toBe(true)
  })

  it('wrong owners and stale request IDs cannot report a checkpoint or finalize another rename', async () => {
    const f = fixture()
    expect(f.transport.receiveResult(f.foreign, f.id, f.success)).toBe(false)
    expect(f.transport.receiveResult(f.owner, 'old-request', f.success)).toBe(false)
    expect(f.transport.receiveActualSettled(f.foreign, f.id)).toBe(false)
    expect(f.transport.receiveActualSettled(f.owner, 'old-request')).toBe(false)
    f.transport.receiveResult(f.owner, f.id, f.success); f.transport.receiveActualSettled(f.owner, f.id); f.tail.resolve()
    await f.admission.completion
  })

  it('a changed current source or stale native receipt refuses success after actual callback settlement', async () => {
    const f = fixture(); f.changeSource()
    f.transport.receiveResult(f.owner, f.id, f.success); f.transport.receiveActualSettled(f.owner, f.id)
    f.tail.resolve()
    await expect(f.admission.completion).rejects.toThrow('complete current checkpoint')
    await f.admission.actualSettled
  })

  it('an explicit callback failure still waits the real finalizer and leaves failure truthful', async () => {
    const f = fixture(); let done = false
    void f.admission.actualSettled.then(() => { done = true })
    f.transport.receiveResult(f.owner, f.id, { ok: false, error: 'full checkpoint failed after the move' })
    await flush(); expect(done).toBe(false)
    f.transport.receiveActualSettled(f.owner, f.id); f.tail.resolve()
    await expect(f.admission.completion).rejects.toThrow('after the move')
    await f.admission.actualSettled
  })

  it('owner destruction cannot borrow an earlier pending finalizer instead of its actual teardown', async () => {
    const f = fixture(), cleanup = deferred<void>(); let done = false
    void f.admission.actualSettled.then(() => { done = true })
    f.transport.receiveResult(f.owner, f.id, f.success); f.transport.receiveActualSettled(f.owner, f.id)
    f.transport.destroy(f.owner, cleanup.promise)
    f.tail.resolve(); await flush(); expect(done).toBe(false)
    cleanup.resolve()
    await expect(f.admission.completion).rejects.toThrow('destroyed')
    await f.admission.actualSettled
  })

  it('delivery failure remains unsettled until verified owner teardown, without a timeout grant', async () => {
    const owner = {}, cleanup = deferred<void>()
    const transport = new SheetsRenameRefreshTransport<object>({ send: () => { throw new Error('uncertain delivery') },
      publicationTail: async () => undefined, validate: () => true })
    const metadata = fixture().metadata
    const admission = transport.begin(owner, 'named.xlsx', metadata); let done = false
    void admission.actualSettled.then(() => { done = true })
    await flush(); expect(done).toBe(false)
    transport.destroy(owner, cleanup.promise); await flush(); expect(done).toBe(false)
    cleanup.resolve(); await expect(admission.completion).rejects.toThrow('destroyed')
    await admission.actualSettled
  })
})
