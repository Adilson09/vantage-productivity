/** Real Node streams + mock ChildProcess only; this is not a native-binary acceptance test. */
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  subscribeNativeActualWork,
  XlsxSidecarClient,
  type NativeRequestAdmission,
} from '../src/main/xlsx-sidecar-client'

const spawnMock = vi.hoisted(() => vi.fn())
const removeMock = vi.hoisted(() =>
  vi.fn(async (_path: string, _options?: { force?: boolean }) => {}),
)
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs/promises', () => ({ rm: removeMock }))

interface WireCommand {
  requestId: string
  command: string
  version: number
  [key: string]: unknown
}

class Child extends EventEmitter {
  pid: number | undefined = 100
  killed = false
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly commands: WireCommand[] = []
  failWrite = false
  beforeWrite?: () => void
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.beforeWrite?.()
      this.commands.push(JSON.parse(chunk.toString('utf8')) as WireCommand)
      callback(this.failWrite ? new Error('mock stdin write failed') : undefined)
    },
  })
  kill() {
    this.killed = true
    return true
  }
  reply(requestId: string, result: unknown = { acknowledged: true }) {
    this.stdout.write(`${JSON.stringify({ version: 1, requestId, ok: true, result })}\n`)
  }
  fail(requestId: string) {
    this.stdout.write(
      `${JSON.stringify({
        version: 1,
        requestId,
        ok: false,
        error: { code: 'cancelled', message: 'definitive native cancellation' },
      })}\n`,
    )
  }
  exited() {
    this.emit('exit', 0, null)
    this.stdout.end()
    this.stderr.end()
    this.emit('close', 0, null)
  }
}

const children: Child[] = []
const clients: XlsxSidecarClient[] = []
const unsubscribers: (() => void)[] = []
function client(limits?: ConstructorParameters<typeof XlsxSidecarClient>[1]) {
  const value = new XlsxSidecarClient('/synthetic/xlsx-sidecar', limits)
  clients.push(value)
  return value
}
function observeWork() {
  const work: Promise<void>[] = []
  unsubscribers.push(subscribeNativeActualWork((actual) => work.push(actual)))
  return work
}
function actualFlag(admission: NativeRequestAdmission) {
  let settled = false
  void admission.actualSettled.then(() => {
    settled = true
  })
  return () => settled
}
function original(child = children[0]!) {
  return child.commands.find((item) => item.command !== 'cancel')!
}

beforeEach(() => {
  vi.useFakeTimers()
  spawnMock.mockReset()
  removeMock.mockClear()
  spawnMock.mockImplementation(() => {
    const value = new Child()
    value.pid = 100 + children.length
    children.push(value)
    return value as unknown as ChildProcessWithoutNullStreams
  })
})
afterEach(async () => {
  for (const value of clients.splice(0)) value.stop()
  for (const child of children.splice(0)) child.exited()
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  await Promise.resolve()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('native RPC result versus definitive actual settlement', () => {
  it('announces the identical actual promise before stdin dispatch, including legacy methods', async () => {
    const admitted: Promise<void>[] = []
    unsubscribers.push(
      subscribeNativeActualWork((actual) => {
        expect(children[0]!.commands).toEqual([])
        admitted.push(actual)
      }),
    )
    const value = client()
    const request = value.requestAttested({ command: 'document_snapshot', documentId: 'synthetic' })
    expect(admitted).toEqual([request.actualSettled])
    children[0]!.reply(original().requestId, { revision: 2 })
    await expect(request.result).resolves.toEqual({ revision: 2 })
    await expect(request.completion).resolves.toEqual({ revision: 2 })
    await request.actualSettled
  })

  it('retains timeout ownership and accepts the late matching response instead of a cancel ACK', async () => {
    const work = observeWork(),
      value = client()
    const request = value.requestAttested(
      { command: 'save_archive', targetPath: '/synthetic/only' },
      5,
    )
    const settled = actualFlag(request)
    const rejected = expect(request.result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(6)
    await rejected
    const cancel = children[0]!.commands.find((item) => item.command === 'cancel')!
    expect(cancel.targetRequestId).toBe(original().requestId)
    children[0]!.reply(cancel.requestId, { cancelled: true })
    await Promise.resolve()
    expect(settled()).toBe(false)
    expect(work).toEqual([request.actualSettled])
    children[0]!.reply(original().requestId, { bytesWritten: 42 })
    await expect(request.completion).resolves.toEqual({ bytesWritten: 42 })
    await request.actualSettled
    expect(settled()).toBe(true)
    await expect(request.result).rejects.toThrow('timed out')
  })

  it('replays bounded live actual ownership to a later main subscriber without metadata', async () => {
    const value = client()
    const request = value.requestAttested({
      command: 'document_snapshot',
      documentId: 'private-id',
    })
    const replayed = observeWork()
    expect(replayed).toEqual([request.actualSettled])
    children[0]!.reply(original().requestId)
    await request.result
    await request.actualSettled
    const later = observeWork()
    expect(later).toEqual([])
  })

  it.each(['checkpoint_document', 'close_document'])(
    'keeps required %s work queued after caller timeout and consumes its late ACK',
    async (command) => {
      const value = client(),
        request = value.requestAttested({ command, documentId: 'synthetic' }, 5)
      const settled = actualFlag(request)
      const rejected = expect(request.result).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(6)
      await rejected
      expect(children[0]!.commands.map((item) => item.command)).toEqual([command])
      expect(settled()).toBe(false)
      children[0]!.reply(original().requestId, { acknowledged: true })
      await expect(request.completion).resolves.toEqual({ acknowledged: true })
      await request.actualSettled
      expect(settled()).toBe(true)
      await expect(request.result).rejects.toThrow('timed out')
    },
  )

  it('keeps actual work alive after a stdin failure and still consumes a late reply', async () => {
    const value = client()
    value.start()
    children[0]!.failWrite = true
    const request = value.requestAttested({
      command: 'checkpoint_document',
      documentId: 'synthetic',
    })
    const settled = actualFlag(request)
    await expect(request.result).rejects.toThrow(/stdin/)
    await Promise.resolve()
    expect(settled()).toBe(false)
    children[0]!.reply(original().requestId, { revision: 9 })
    await expect(request.completion).resolves.toEqual({ revision: 9 })
    await request.actualSettled
    expect(settled()).toBe(true)
    await expect(value.requestAttested({ command: 'document_snapshot' }).result).rejects.toThrow(
      'pipe failed',
    )
  })

  it('a kill request rejects callers but cannot settle actual ownership before confirmed exit', async () => {
    const value = client(),
      exit = vi.fn()
    value.onProcessExit(exit)
    const request = value.requestAttested({ command: 'save_archive' })
    const settled = actualFlag(request)
    value.stop()
    await expect(request.result).rejects.toThrow('stopped')
    await Promise.resolve()
    expect(children[0]!.killed).toBe(true)
    expect(settled()).toBe(false)
    children[0]!.exited()
    await expect(request.completion).rejects.toThrow(/exited|closed/)
    await request.actualSettled
    expect(settled()).toBe(true)
    expect(exit).not.toHaveBeenCalled()
  })

  it('confirmed unexpected exit releases only that process and emits one crash notification', async () => {
    const value = client(),
      exit = vi.fn()
    value.onProcessExit(exit)
    const request = value.requestAttested({ command: 'save_archive' })
    const rejected = expect(request.result).rejects.toThrow('exited')
    children[0]!.exited()
    await rejected
    await expect(request.completion).rejects.toThrow('exited')
    await request.actualSettled
    expect(exit).toHaveBeenCalledOnce()
  })

  it('an existing-pid error is not termination, while a pid-undefined spawn failure is definitive', async () => {
    const first = client(),
      active = first.requestAttested({ command: 'save_archive' })
    const settled = actualFlag(active)
    children[0]!.emit('error', new Error('existing process failed'))
    await expect(active.result).rejects.toThrow('existing process failed')
    await Promise.resolve()
    expect(settled()).toBe(false)
    children[0]!.exited()
    await active.actualSettled
    const second = client(),
      missing = second.requestAttested({ command: 'save_archive' })
    children[1]!.pid = undefined
    children[1]!.emit('error', new Error('spawn ENOENT'))
    await expect(missing.result).rejects.toThrow('spawn ENOENT')
    await expect(missing.completion).rejects.toThrow('spawn ENOENT')
    await missing.actualSettled
  })

  it('rejects native failure on both channels while independently settling actual work', async () => {
    const value = client(),
      request = value.requestAttested({ command: 'document_snapshot' })
    children[0]!.fail(original().requestId)
    await expect(request.result).rejects.toMatchObject({ code: 'cancelled' })
    await expect(request.completion).rejects.toMatchObject({ code: 'cancelled' })
    await request.actualSettled
  })

  it('never lets an old process stdout response settle the new generation', async () => {
    const value = client(),
      old = value.requestAttested({ command: 'save_archive' })
    const oldId = original().requestId
    value.stop()
    await expect(old.result).rejects.toThrow('stopped')
    const next = value.requestAttested({ command: 'save_archive' })
    const nextId = original(children[1]!).requestId,
      settled = actualFlag(next)
    children[0]!.reply(nextId, { forgedOldGeneration: true })
    await Promise.resolve()
    expect(settled()).toBe(false)
    children[0]!.reply(oldId, { oldCompletion: true })
    await expect(old.completion).resolves.toEqual({ oldCompletion: true })
    children[0]!.exited()
    expect(settled()).toBe(false)
    children[1]!.reply(nextId, { newCompletion: true })
    await expect(next.result).resolves.toEqual({ newCompletion: true })
    await expect(next.completion).resolves.toEqual({ newCompletion: true })
  })

  it('retains the pending-count charge after timeout and frees it only on definitive reply', async () => {
    const value = client({ maxPendingRequests: 1 })
    const request = value.requestAttested({ command: 'document_snapshot' }, 5)
    const rejected = expect(request.result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(6)
    await rejected
    await expect(value.requestAttested({ command: 'document_snapshot' }).result).rejects.toThrow(
      'quota',
    )
    expect(children[0]!.commands.filter((item) => item.command !== 'cancel')).toHaveLength(1)
    children[0]!.reply(original().requestId)
    await request.actualSettled
    const next = value.requestAttested({ command: 'document_snapshot' })
    children[0]!.reply(children[0]!.commands.at(-1)!.requestId)
    await next.completion
    await next.result
  })

  it('charges serialized pending bytes until reply and rejects an oversized request before spawn', async () => {
    const value = client({ maxPendingBytes: 384, maxRequestBytes: 384 })
    const first = value.requestAttested({ command: 'document_snapshot', data: 'x'.repeat(200) })
    await expect(
      value.requestAttested({ command: 'document_snapshot', data: 'x'.repeat(200) }).result,
    ).rejects.toThrow('quota')
    expect(children[0]!.commands).toHaveLength(1)
    children[0]!.reply(original().requestId)
    await first.result
    await first.actualSettled
    const before = spawnMock.mock.calls.length
    const other = client({ maxPendingBytes: 128, maxRequestBytes: 128 })
    const oversized = other.requestAttested({ command: 'save_archive', data: 'x'.repeat(1000) })
    await expect(oversized.result).rejects.toThrow('quota')
    await oversized.actualSettled
    expect(spawnMock).toHaveBeenCalledTimes(before)
  })

  it('refuses dispatch when an actual-work owner cannot admit the request', async () => {
    const refuse = subscribeNativeActualWork(() => {
      throw new Error('owner quota refused')
    })
    unsubscribers.push(refuse)
    const value = client(),
      request = value.requestAttested({ command: 'save_archive' })
    await expect(request.result).rejects.toThrow('owner quota refused')
    await expect(request.completion).rejects.toThrow('owner quota refused')
    await request.actualSettled
    expect(children[0]!.commands).toEqual([])
    refuse()
    const next = value.requestAttested({ command: 'save_archive' })
    children[0]!.reply(original().requestId)
    await next.result
  })

  it('enforces aggregate serialized ownership across clients and releases it on definitive replies', async () => {
    const realByteLength = Buffer.byteLength
    // Model large serialized admission charges without allocating gigabytes;
    // real streams still carry the exact small mock command and reply bytes.
    const measured = vi
      .spyOn(Buffer, 'byteLength')
      .mockImplementation((input, encoding) =>
        typeof input === 'string' && input.includes('"globalQuotaFixture":true')
          ? 256 * 1024 * 1024
          : realByteLength(input, encoding),
      )
    try {
      const admissions = [client(), client(), client()].map((value) =>
        value.requestAttested({ command: 'document_snapshot', globalQuotaFixture: true }),
      )
      const fourth = client()
      const denied = fourth.requestAttested({
        command: 'document_snapshot',
        globalQuotaFixture: true,
      })
      await expect(denied.result).rejects.toThrow('quota')
      expect(spawnMock).toHaveBeenCalledTimes(3)
      children[0]!.reply(original(children[0]!).requestId)
      await admissions[0]!.result
      await admissions[0]!.actualSettled
      const allowed = fourth.requestAttested({
        command: 'document_snapshot',
        globalQuotaFixture: true,
      })
      expect(spawnMock).toHaveBeenCalledTimes(4)
      for (const [index, request] of [
        [1, admissions[1]!],
        [2, admissions[2]!],
        [3, allowed],
      ] as const) {
        children[index]!.reply(original(children[index]!).requestId)
        await request.result
        await request.actualSettled
      }
    } finally {
      measured.mockRestore()
    }
  })

  it('closeSettled waits for both late native close ACKs before unlinking binding files', async () => {
    const value = client()
    await value.bindEditSession('session-1', {
      apiVersion: 1,
      workbookId: 'edit-1',
      sourcePath: '/synthetic/source.xlsx',
      sheets: [{ id: 'sheet-1', name: 'Budget' }],
      storePath: '/synthetic/edit.sqlite',
    })
    const closing = value.closeSettled('session-1')
    let settled = false
    void closing.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(settled).toBe(false)
    expect(children[0]!.commands.map((item) => item.command)).toEqual(['close'])
    children[0]!.reply(original().requestId, { closed: true })
    await Promise.resolve()
    await Promise.resolve()
    const editClose = children[0]!.commands.find((item) => item.command === 'close_edit_session')!
    expect(editClose.workbookId).toBe('edit-1')
    expect(removeMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_001)
    expect(settled).toBe(false)
    expect(children[0]!.commands.map((item) => item.command)).toEqual([
      'close',
      'close_edit_session',
    ])
    children[0]!.reply(editClose.requestId, { closed: true })
    await closing
    expect(settled).toBe(true)
    expect(removeMock.mock.calls.map((call) => call[0])).toEqual([
      '/synthetic/edit.sqlite',
      '/synthetic/edit.sqlite-wal',
      '/synthetic/edit.sqlite-shm',
    ])
  })

  it('closeSettled preserves binding files when the definitive edit close fails', async () => {
    const value = client()
    await value.bindEditSession('session-1', {
      apiVersion: 1,
      workbookId: 'edit-1',
      sourcePath: '/synthetic/source.xlsx',
      sheets: [],
      storePath: '/synthetic/edit.sqlite',
    })
    const closing = value.closeSettled('session-1')
    children[0]!.reply(original().requestId, { closed: true })
    await Promise.resolve()
    await Promise.resolve()
    const editClose = children[0]!.commands.find((item) => item.command === 'close_edit_session')!
    children[0]!.fail(editClose.requestId)
    await expect(closing).rejects.toMatchObject({ code: 'cancelled' })
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('legacy close keeps its bounded result while the native work remains owned', async () => {
    const value = client(),
      owned = observeWork()
    const closing = value.close('session-1')
    const rejected = expect(closing).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30_001)
    await rejected
    expect(owned).toHaveLength(1)
    let settled = false
    void owned[0]!.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    children[0]!.reply(original().requestId, { closed: true })
    await owned[0]
    expect(settled).toBe(true)
  })

  it('keeps existing result-returning document APIs on their bounded contract', async () => {
    const value = client(),
      work = observeWork()
    const result = value.closeDocument({ apiVersion: 1, documentId: 'synthetic' })
    expect(work).toHaveLength(1)
    expect(original().command).toBe('close_document')
    children[0]!.reply(original().requestId, { closed: true })
    await expect(result).resolves.toEqual({ closed: true })
    await work[0]
  })

  it('refuses an asynchronous ownership subscriber before any native dispatch', async () => {
    unsubscribers.push(subscribeNativeActualWork(async () => {}))
    const value = client(),
      request = value.requestAttested({ command: 'save_archive' })
    await expect(request.result).rejects.toThrow('registered synchronously')
    await request.actualSettled
    expect(children[0]!.commands).toEqual([])
  })

  it('owns transport identity instead of trusting overridden fields on the generic command', async () => {
    const value = client(),
      request = value.requestAttested({
        command: 'save_archive',
        version: 900,
        requestId: 'caller-controlled',
      })
    expect(original().version).toBe(1)
    expect(original().requestId).not.toBe('caller-controlled')
    children[0]!.reply(original().requestId)
    await request.result
  })
})
