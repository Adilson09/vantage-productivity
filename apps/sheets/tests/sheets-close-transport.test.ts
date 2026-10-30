import { afterEach, describe, expect, it, vi } from 'vitest'
import { SheetsCloseTransport, isSheetsPrepareCloseResult } from '../src/main/sheets-close-transport'
import type { SheetsPrepareCloseRequest, SheetsPrepareCloseResult } from '../src/shared/sheets-close'

interface Owner { id: number; alive: boolean }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function request(sequence = 1): SheetsPrepareCloseRequest {
  const lineage = '10000000-0000-4000-8000-000000000001'
  return { ticket: { id: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, sequence, source: lineage }, intent: 'save',
    expectedSource: { lineage, sessionId: '30000000-0000-4000-8000-000000000001', openedSha256: 'a'.repeat(64), documentPath: 'synthetic.xlsx' } }
}
function resultFor(value: SheetsPrepareCloseRequest): SheetsPrepareCloseResult {
  return { current: true, published: true, clean: true, intent: value.intent,
    closeLease: { ticket: value.ticket, source: value.expectedSource, stamp: { source: 'renderer-generation', revision: '7' }, payloadSha256: 'b'.repeat(64) } }
}
function fixture() {
  const owner: Owner = { id: 1, alive: true }, other: Owner = { id: 2, alive: true }, native = deferred()
  const sent = vi.fn(), report = vi.fn(), tail = vi.fn(() => native.promise)
  const transport = new SheetsCloseTransport<Owner>({ send: sent, publicationTail: tail, alive: value => value.alive, report, timeoutMs: 10 })
  return { owner, other, native, sent, report, tail, transport }
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('sender-bound Sheets close transport (source-only regression proposal)', () => {
  it('a caller timeout rejects the result without settling or releasing the actual writer', async () => {
    vi.useFakeTimers()
    const f = fixture(), req = request(), admitted = f.transport.prepare(f.owner, req)
    f.transport.claim(f.owner, req.ticket)
    let actuallySettled = false
    void admitted.actualSettled.then(() => { actuallySettled = true })
    await vi.advanceTimersByTimeAsync(10)
    await expect(admitted.result).rejects.toThrow('actual writer remains reserved')
    expect(actuallySettled).toBe(false)
    expect(f.tail).not.toHaveBeenCalled()
    f.transport.release(f.owner, req.ticket, 'expired close permission')
    expect(() => f.transport.prepare(f.owner, request(2))).toThrow('still reserved')
    expect(f.transport.receiveActualSettled(f.owner, req.ticket.id)).toBe(true)
    expect(actuallySettled).toBe(false)
    f.native.resolve(); await admitted.actualSettled
    expect(actuallySettled).toBe(true)
  })

  it('an early successful result still waits for a distinct finalizer and the captured native publication tail', async () => {
    const f = fixture(), req = request(), admitted = f.transport.prepare(f.owner, req)
    expect(f.sent).toHaveBeenCalledWith(f.owner, { ...req, requestId: req.ticket.id })
    expect(f.transport.claim(f.owner, req.ticket)).toBe(true)
    expect(f.transport.claim(f.owner, req.ticket)).toBe(true)
    expect(f.transport.receiveResult(f.owner, req.ticket.id, resultFor(req))).toBe(true)
    expect((await admitted.result).current).toBe(true)
    let settled = false
    void admitted.actualSettled.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.tail).not.toHaveBeenCalled()
    f.transport.receiveActualSettled(f.owner, req.ticket.id)
    expect(f.tail).toHaveBeenCalledTimes(1)
    await Promise.resolve(); expect(settled).toBe(false)
    f.native.resolve(); await admitted.actualSettled
    expect(settled).toBe(true)
    f.transport.release(f.owner, req.ticket, 'complete')
  })

  it('another owner or request ID cannot reply to or finalize the admitted writer', async () => {
    const f = fixture(), req = request(), admitted = f.transport.prepare(f.owner, req)
    f.transport.claim(f.owner, req.ticket)
    expect(f.transport.receiveResult(f.other, req.ticket.id, resultFor(req))).toBe(false)
    expect(f.transport.receiveResult(f.owner, request(2).ticket.id, resultFor(req))).toBe(false)
    expect(f.transport.receiveActualSettled(f.other, req.ticket.id)).toBe(false)
    expect(f.transport.receiveActualSettled(f.owner, request(2).ticket.id)).toBe(false)
    expect(f.tail).not.toHaveBeenCalled()
    f.transport.release(f.owner, req.ticket, 'test canceled')
    f.transport.receiveActualSettled(f.owner, req.ticket.id)
    f.native.resolve(); await admitted.actualSettled
  })

  it('accepts a truthful current:true refusal with an error and no close envelope as a result, never as authority', async () => {
    const f = fixture(), req = request(), admitted = f.transport.prepare(f.owner, req)
    f.transport.claim(f.owner, req.ticket)
    const refusal: SheetsPrepareCloseResult = { current: true, published: false, clean: false, intent: 'save', error: 'The editor could not finish its checkpoint.' }
    expect(isSheetsPrepareCloseResult(refusal)).toBe(true)
    expect(f.transport.receiveResult(f.owner, req.ticket.id, refusal)).toBe(true)
    expect(await admitted.result).toEqual(refusal)
    expect((await admitted.result).closeLease).toBeUndefined()
    f.transport.release(f.owner, req.ticket, 'refusal kept the document open')
    f.transport.receiveActualSettled(f.owner, req.ticket.id)
    f.native.resolve(); await admitted.actualSettled
  })

  it('release invalidates the old ticket while only its own finalizer can discharge that old writer', async () => {
    const f = fixture(), old = request(), admitted = f.transport.prepare(f.owner, old)
    f.transport.claim(f.owner, old.ticket)
    f.transport.release(f.owner, old.ticket, 'cancel acknowledged')
    await expect(admitted.result).rejects.toThrow('cancel acknowledged')
    expect(f.transport.accepts(f.owner, old.ticket)).toBe(false)
    expect(() => f.transport.prepare(f.owner, request(2))).toThrow('still reserved')
    expect(f.transport.receiveActualSettled(f.owner, request(2).ticket.id)).toBe(false)
    f.transport.receiveActualSettled(f.owner, old.ticket.id)
    f.native.resolve(); await admitted.actualSettled
    const next = request(2), nextAdmission = f.transport.prepare(f.owner, next)
    expect(f.transport.receiveActualSettled(f.owner, old.ticket.id)).toBe(false)
    expect(f.transport.receiveResult(f.owner, old.ticket.id, resultFor(old))).toBe(false)
    f.transport.release(f.owner, next.ticket, 'finish test')
    f.transport.receiveActualSettled(f.owner, next.ticket.id)
    await nextAdmission.actualSettled
  })

  it('owner destruction requires verified destruction and still awaits the real admitted native publication tail', async () => {
    const f = fixture(), req = request(), admitted = f.transport.prepare(f.owner, req)
    expect(() => f.transport.destroy(f.owner)).toThrow('live renderer')
    f.owner.alive = false
    const actual = f.transport.destroy(f.owner)
    expect(actual).toBe(admitted.actualSettled)
    await expect(admitted.result).rejects.toThrow('destroyed')
    let settled = false
    void actual.then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    expect(f.tail).toHaveBeenCalledWith(f.owner)
    f.native.resolve(); await actual
    expect(settled).toBe(true)
  })

  it('admits only claimed close-owned writers and refuses new admission after finalization until actual release', async () => {
    const f = fixture(), req = request(), admitted = f.transport.prepare(f.owner, req)
    expect(() => f.transport.assertWriter(f.owner)).toThrow('not admitted')
    expect(() => f.transport.assertWriter(f.owner, req.ticket)).toThrow('not admitted')
    f.transport.claim(f.owner, req.ticket)
    expect(() => f.transport.assertWriter(f.owner, req.ticket)).not.toThrow()
    f.transport.receiveActualSettled(f.owner, req.ticket.id)
    expect(() => f.transport.assertWriter(f.owner, req.ticket)).toThrow('not admitted')
    f.transport.release(f.owner, req.ticket, 'permission consumed')
    expect(() => f.transport.assertWriter(f.owner)).toThrow('not admitted')
    f.native.resolve(); await admitted.actualSettled
    expect(() => f.transport.assertWriter(f.owner)).not.toThrow()
  })

  it('a correlated finalizer can settle a refused unclaimed request without inventing a claim or grant', async () => {
    const f = fixture(), req = request(), admitted = f.transport.prepare(f.owner, req)
    f.transport.release(f.owner, req.ticket, 'prepare never claimed')
    expect(f.transport.claim(f.owner, req.ticket)).toBe(false)
    expect(f.transport.receiveActualSettled(f.owner, req.ticket.id)).toBe(true)
    f.native.resolve(); await admitted.actualSettled
    expect(f.transport.accepts(f.owner, req.ticket)).toBe(false)
  })
})
