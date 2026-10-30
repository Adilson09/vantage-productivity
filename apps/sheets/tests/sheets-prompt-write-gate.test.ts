import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SheetsPromptWriteGate,
  parseWorkbookWriteContext,
} from '../src/main/sheets-prompt-write-gate'
import { SheetsCloseCoordinator } from '../src/main/sheets-close-coordinator'
import { SheetsCloseTransport } from '../src/main/sheets-close-transport'
import { installAutomaticWorkbookWriteLoop } from '../src/renderer/automatic-workbook-write-loop'
import type { WorkbookWriteContext } from '../src/shared/desktop-api'
import type { SheetsCloseSource, SheetsPrepareCloseRequest } from '../src/shared/sheets-close'
import type { CloseLeaseTicket } from '../../../packages/electron-utils/src/close-lease'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
interface Owner {
  id: string
  alive: boolean
  source: SheetsCloseSource
}

/** Real prompt broker + real transport, with only native I/O and dialog pixels replaced. */
function fixture() {
  const owner: Owner = {
    id: 'one',
    alive: true,
    source: {
      lineage: '10000000-0000-4000-8000-000000000001',
      sessionId: '20000000-0000-4000-8000-000000000001',
      openedSha256: 'a'.repeat(64),
      documentPath: 'C:/synthetic/source.xlsx',
    },
  }
  let writes = 0,
    tail: Promise<void> = Promise.resolve(),
    coor!: SheetsCloseCoordinator<Owner>
  const publications = new Set<Promise<void>>(),
    actuals = new Set<Promise<void>>()
  const requests: SheetsPrepareCloseRequest[] = [],
    releases: CloseLeaseTicket[] = []
  const transport = new SheetsCloseTransport<Owner>({
    alive: (value) => value.alive,
    send: (_owner, request) => {
      requests.push(request)
    },
    publicationTail: () => tail,
    report: vi.fn(),
  })
  const gate = new SheetsPromptWriteGate<Owner>({
    alive: (value) => value.alive,
    currentClose: (value) => transport.current(value)?.ticket,
    acceptsClose: (value, ticket) => transport.accepts(value, ticket),
    assertTransportWriter: (value, ticket) => transport.assertWriter(value, ticket),
    cancelExactClose: (value, ticket, reason) => coor.cancel(value, ticket, reason),
    actualSettled: () => Promise.all([tail, ...actuals]).then(() => undefined),
  })
  coor = new SheetsCloseCoordinator<Owner>({
    alive: (value) => value.alive,
    current: (value) => value.source,
    coverageComplete: () => true,
    sourceBusy: () => publications.size > 0,
    prepareRenderer: (value, request) => transport.prepare(value, request),
    releaseRenderer: (value, ticket, reason) => {
      gate.releasePrompt(value, ticket)
      releases.push(ticket)
      transport.release(value, ticket, reason)
    },
    capture: () => {
      throw new Error('This prompt-admission test never reaches native capture.')
    },
    verifyCapturedRevision: () => false,
    stagePersistent: () => {
      throw new Error('No custody files are created in this harness.')
    },
    stageMemory: () => {
      throw new Error('No protected custody is created in this harness.')
    },
    holdNativeUntilSettled: (_value, actual) => {
      actuals.add(actual)
      void actual.then(
        () => actuals.delete(actual),
        () => actuals.delete(actual),
      )
    },
    report: vi.fn(),
  })

  async function publish(
    context: WorkbookWriteContext | undefined,
    ticket?: CloseLeaseTicket,
    queued: Promise<void> = Promise.resolve(),
  ) {
    const admission = gate.admit(owner, context, ticket)
    // This is intentionally BEFORE registration, matching the actual IPC seams.
    await admission.ready
    const pending = tail.then(async () => {
      await queued
      gate.assert(owner, admission)
      writes++
    })
    const settled = pending.then(
      () => undefined,
      () => undefined,
    )
    publications.add(settled)
    tail = settled
    void settled.then(() => publications.delete(settled))
    return pending
  }
  function prompt() {
    const handle = coor.beginPrompt(owner)
    gate.beginPrompt(owner, handle.ticket)
    const answer = deferred<number>()
    const finished = (async () => {
      try {
        const response = await answer.promise
        // A delayed old Save answer must never start a fresh renderer request.
        if (!coor.isPromptCurrent(owner, handle) || response === 2) return false
        await coor.prepareReserved(owner, handle, 'save')
        return true
      } finally {
        gate.releasePrompt(owner, handle.ticket)
        coor.endPrompt(owner, handle, false)
      }
    })()
    return { handle, answer, finished }
  }
  function closeWriter() {
    const handle = coor.beginPrompt(owner)
    gate.beginPrompt(owner, handle.ticket)
    const prepared = coor.prepareReserved(owner, handle, 'save')
    void prepared.catch(() => undefined)
    const claim = () => coor.claim(owner, handle.ticket) && transport.claim(owner, handle.ticket)
    const finish = async () => {
      coor.cancel(owner, handle.ticket, 'test ends this close reservation')
      transport.receiveActualSettled(owner, handle.ticket.id)
      await prepared.catch(() => undefined)
      await flush()
      gate.releasePrompt(owner, handle.ticket)
      coor.endPrompt(owner, handle, false)
    }
    return { handle, prepared, claim, finish }
  }
  return {
    owner,
    gate,
    coor,
    transport,
    requests,
    releases,
    publish,
    prompt,
    closeWriter,
    writes: () => writes,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('native Sheets prompt writer admission (successor source regressions)', () => {
  it('the installed blur/timer loop makes no publication while the native question owns its ticket, then resumes on Cancel', async () => {
    const f = fixture(),
      question = f.prompt(),
      target = new EventTarget(),
      report = vi.fn()
    const dispose = installAutomaticWorkbookWriteLoop({
      intervalMs: 1000,
      target,
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
      write: (context) => f.publish(context),
      report,
    })
    target.dispatchEvent(new Event('blur'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.writes()).toBe(0)
    expect(report).toHaveBeenCalledTimes(3)
    expect(f.releases).toHaveLength(0)
    expect(f.coor.isPromptCurrent(f.owner, question.handle)).toBe(true)
    question.answer.resolve(2)
    await question.finished
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.writes()).toBe(1)
    dispose()
    target.dispatchEvent(new Event('blur'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.writes()).toBe(1)
  })

  it('unclassified work cannot cancel the dialog or use its visible ticket as close authorization', async () => {
    const f = fixture(),
      question = f.prompt()
    await expect(f.publish(undefined)).rejects.toThrow('paused')
    await expect(f.publish({ origin: 'close' }, question.handle.ticket)).rejects.toThrow(
      'does not own',
    )
    expect(f.writes()).toBe(0)
    expect(f.releases).toHaveLength(0)
    expect(f.coor.isPromptCurrent(f.owner, question.handle)).toBe(true)
    question.answer.resolve(2)
    await question.finished
  })

  it('a manual save cancels only the current prompt synchronously and does not await a late dialog response', async () => {
    const f = fixture(),
      question = f.prompt()
    const write = f.publish({ origin: 'manual' })
    expect(f.releases).toHaveLength(1)
    expect(f.coor.isPromptCurrent(f.owner, question.handle)).toBe(false)
    await write
    expect(f.writes()).toBe(1)
    question.answer.resolve(0)
    expect(await question.finished).toBe(false)
    expect(f.requests).toHaveLength(0)
  })

  it('releasing an old dialog before it answers never unlocks or cancels a successor prompt', async () => {
    const f = fixture(),
      old = f.prompt()
    f.coor.cancel(f.owner, old.handle.ticket, 'user changed action')
    const next = f.prompt()
    old.answer.resolve(0)
    expect(await old.finished).toBe(false)
    expect(f.coor.isPromptCurrent(f.owner, next.handle)).toBe(true)
    await expect(f.publish({ origin: 'automatic' })).rejects.toThrow('paused')
    expect(f.writes()).toBe(0)
    expect(f.requests).toHaveLength(0)
    next.answer.resolve(2)
    await next.finished
    await f.publish({ origin: 'automatic' })
    expect(f.writes()).toBe(1)
  })

  it('a pre-prompt automatic admission is rejected when the native prompt starts before its queue continuation', async () => {
    const f = fixture(),
      pending = f.publish({ origin: 'automatic' }),
      question = f.prompt()
    await expect(pending).rejects.toThrow('newer close question')
    expect(f.writes()).toBe(0)
    question.answer.resolve(2)
    await question.finished
    await f.publish({ origin: 'automatic' })
    expect(f.writes()).toBe(1)
  })

  it('cancel does not resurrect an old queued admission and copied/foreign-owner admissions cannot write', async () => {
    const f = fixture(),
      admission = f.gate.admit(f.owner, { origin: 'automatic' })
    await admission.ready
    const question = f.prompt()
    question.answer.resolve(2)
    await question.finished
    expect(() => f.gate.assert(f.owner, admission)).toThrow('newer close question')
    expect(() => f.gate.assert(f.owner, { ...admission })).toThrow('newer close question')
    const fresh = f.gate.admit(f.owner, { origin: 'automatic' })
    await fresh.ready
    expect(() => f.gate.assert({ ...f.owner }, fresh)).toThrow('newer close question')
    f.owner.alive = false
    expect(() => f.gate.assert(f.owner, fresh)).toThrow('newer close question')
    expect(() => f.gate.admit(f.owner, { origin: 'manual' })).toThrow('no longer available')
  })

  it('only an explicitly close-origin writer with the claimed exact transport ticket can publish', async () => {
    const f = fixture(),
      close = f.closeWriter(),
      ticket = close.handle.ticket
    await expect(f.publish({ origin: 'close' }, ticket)).rejects.toThrow('does not own')
    expect(close.claim()).toBe(true)
    await expect(f.publish({ origin: 'automatic' }, ticket)).rejects.toThrow('Only a close writer')
    await expect(f.publish({ origin: 'manual' }, ticket)).rejects.toThrow('Only a close writer')
    await expect(
      f.publish({ origin: 'close' }, { ...ticket, id: 'other-request' }),
    ).rejects.toThrow('does not own')
    await expect(f.publish({ origin: 'close' })).rejects.toThrow('does not own')
    await f.publish({ origin: 'close' }, ticket)
    expect(f.writes()).toBe(1)
    await close.finish()
  })

  it('manual cancellation waits for both the existing native publication and the distinct renderer finalizer', async () => {
    const f = fixture(),
      close = f.closeWriter(),
      block = deferred<void>()
    expect(close.claim()).toBe(true)
    const oldWrite = f.publish({ origin: 'close' }, close.handle.ticket, block.promise)
    await flush()
    let completed = false
    const manual = f.publish({ origin: 'manual' }).then(() => {
      completed = true
    })
    await flush()
    expect(completed).toBe(false)
    expect(f.writes()).toBe(0)
    block.resolve()
    await expect(oldWrite).rejects.toThrow('no longer owns')
    await flush()
    expect(completed).toBe(false)
    // Rejecting the prepare result and releasing the dialog were insufficient.
    expect(f.transport.receiveActualSettled(f.owner, close.handle.ticket.id)).toBe(true)
    await manual
    expect(completed).toBe(true)
    expect(f.writes()).toBe(1)
    await close.finish()
  })

  it('the original prompt deadline releases the latch before a delayed Save answer without starting a fresh close writer', async () => {
    const f = fixture(),
      question = f.prompt()
    await vi.advanceTimersByTimeAsync(120_001)
    await f.publish({ origin: 'automatic' })
    expect(f.writes()).toBe(1)
    question.answer.resolve(0)
    expect(await question.finished).toBe(false)
    expect(f.requests).toHaveLength(0)
  })

  it('rejects malformed provenance instead of treating it as a manual cancellation request', () => {
    for (const value of [
      null,
      [],
      'manual',
      { origin: 'unexpected' },
      { origin: 'manual', ticket: 'ambient' },
    ])
      expect(() => parseWorkbookWriteContext(value)).toThrow('Invalid workbook write')
    expect(parseWorkbookWriteContext(undefined)).toBeUndefined()
    expect(parseWorkbookWriteContext(Object.freeze({ origin: 'automatic' }))).toEqual({
      origin: 'automatic',
    })
  })
})
