import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlidesRecoveryClient, type SlidesRecoveryApi } from '../src/renderer/slides-recovery'
import type {
  SlidesDraftActivation,
  SlidesDraftDiscarded,
  SlidesDraftState,
  SlidesPendingDraft,
} from '../src/shared/slides-draft'

const clients: SlidesRecoveryClient[] = []
function deferred<T>() {
  let done!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    done = resolve
  })
  return { promise, done }
}
const text = (value: string): SlidesPendingDraft => ({
  text: { kind: 'text', slideIndex: 0, sourceId: 'e_1', paragraphs: [{ runs: [{ text: value }] }] },
})
function fixture() {
  let pending = text('still typing')
  let composing = false
  let revision = '1:0'
  let dirty = false
  let discard: (notice: SlidesDraftDiscarded) => void = () => {}
  const tokens: string[] = []
  const errors = vi.fn()
  const api: SlidesRecoveryApi = {
    activateDraft: vi.fn(async () => {
      const token = randomUUID()
      tokens.push(token)
      return { ok: true, token }
    }),
    writeDraft: vi.fn(async () => ({ ok: true })),
    acknowledgeDraftSave: vi.fn(async () => ({ ok: true })),
    draftState: vi.fn(async () => ({ revision, dirty })),
    setPendingEditState: vi.fn(),
    onDraftDiscarded: (handler) => {
      discard = handler
      return () => {
        discard = () => {}
      }
    },
    onDraftWarning: () => () => {},
  }
  const client = new SlidesRecoveryClient({
    api,
    capturePending: () => ({ pending, composing }),
    reportError: errors,
  })
  clients.push(client)
  client.start()
  client.activate(null)
  return {
    api,
    client,
    tokens,
    errors,
    setPending: (value: SlidesPendingDraft) => {
      pending = value
    },
    setComposing: (value: boolean) => {
      composing = value
    },
    setRevision: (value: string) => {
      revision = value
    },
    setDirty: (value: boolean) => {
      dirty = value
    },
    discard: () => discard({ token: tokens.at(-1)!, revision }),
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
  vi.useRealTimers()
})

describe('presentation recovery timer and renderer epochs', () => {
  it('reports an invalid activation response without an unhandled callback rejection or a file write', async () => {
    const f = fixture()
    vi.mocked(f.api.activateDraft).mockResolvedValueOnce(null as unknown as SlidesDraftActivation)
    f.client.activate('/invalid-response.pptx')
    await Promise.resolve()
    expect(await f.client.snapshot()).toBe(false)
    expect(f.errors).toHaveBeenCalledTimes(1)
    expect(String(f.errors.mock.calls[0]![0])).toContain('invalid activation')
    expect(f.api.writeDraft).not.toHaveBeenCalled()
  })
  it('captures pending content after the awaited source revision, so a slow status reply cannot replay an older overlay', async () => {
    const f = fixture()
    const status = deferred<SlidesDraftState>()
    vi.mocked(f.api.draftState).mockReturnValueOnce(status.promise)
    const snapshot = f.client.snapshot()
    f.setPending(text('new visible words while status was waiting'))
    status.done({ revision: '2:1', dirty: true })
    expect(await snapshot).toBe(true)
    expect(f.api.writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: '2:1',
        pending: text('new visible words while status was waiting'),
      }),
    )
  })
  it('captures still-focused text every 30 seconds without requiring a normal save or a main dirty flag', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(29999)
    expect(f.api.writeDraft).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(1)
    expect(f.api.writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1, documentPath: null, pending: text('still typing') }),
    )
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(1)
    f.setPending(text('newer visible content'))
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(2)
  })
  it('reserves the save watermark before asynchronous status/activation work', async () => {
    const f = fixture()
    const status = deferred<SlidesDraftState>()
    vi.mocked(f.api.draftState).mockReturnValueOnce(status.promise)
    const snapshot = f.client.snapshot()
    const ticket = f.client.beginSave()
    expect(ticket.throughSequence).toBe(1)
    status.done({ revision: '1:0', dirty: true })
    await snapshot
    f.setPending(text('after save started'))
    await f.client.snapshot()
    await f.client.acknowledgeSaved(ticket, '/saved/presentation.pptx', false)
    expect(f.api.acknowledgeDraftSave).toHaveBeenCalledWith(
      expect.objectContaining({ throughSequence: 1, clean: false }),
    )
  })
  it('Root Recovery discard suppresses the actual unchanged overlay for longer than one timer tick', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(30000)
    f.discard()
    await vi.advanceTimersByTimeAsync(65000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(1)
    expect(f.api.activateDraft).toHaveBeenCalledTimes(1)
    f.setPending(text('typed after explicit discard'))
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(2)
    expect(f.api.activateDraft).toHaveBeenCalledTimes(2)
    const written = vi.mocked(f.api.writeDraft).mock.calls
    expect(written[1]![0].token).not.toBe(written[0]![0].token)
  })
  it('new main notes/master/layout revisions also rearm a discarded view without a pending overlay', async () => {
    const f = fixture()
    f.setPending({})
    f.setDirty(true)
    await f.client.snapshot()
    f.discard()
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(1)
    f.setRevision('2:1')
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(2)
  })
  it('a replaced document can record immediately while an old status response is still in flight', async () => {
    const f = fixture()
    const status = deferred<SlidesDraftState>()
    vi.mocked(f.api.draftState).mockReturnValueOnce(status.promise)
    const old = f.client.snapshot()
    const ticket = f.client.beginSave()
    f.client.activate('/other/presentation.pptx')
    expect(f.client.isCurrent(ticket)).toBe(false)
    f.setPending(text('replacement view'))
    await f.client.snapshot()
    status.done({ revision: '1:0', dirty: true })
    expect(await old).toBe(false)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(1)
    expect(f.api.writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        documentPath: '/other/presentation.pptx',
        pending: text('replacement view'),
      }),
    )
    await f.client.acknowledgeSaved(ticket, '/old/presentation.pptx', true)
    expect(f.api.acknowledgeDraftSave).not.toHaveBeenCalled()
  })
  it('composition preserves the last good snapshot until input is complete', async () => {
    const f = fixture()
    f.setComposing(true)
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.writeDraft).not.toHaveBeenCalled()
    f.setComposing(false)
    f.setPending(text('completed composition'))
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(1)
  })
  it('surfaces bounded capture/storage failures once and retries after the content changes', async () => {
    const f = fixture()
    vi.mocked(f.api.writeDraft).mockResolvedValue({
      ok: false,
      error: 'The complete presentation exceeds its recovery limit.',
    })
    await f.client.snapshot()
    await f.client.snapshot()
    expect(f.errors).toHaveBeenCalledTimes(1)
    vi.mocked(f.api.writeDraft).mockResolvedValue({ ok: true })
    f.setPending(text('smaller next edit'))
    expect(await f.client.snapshot()).toBe(true)
  })
  it('stops timers and re-subscribes safely across a repeated React mount lifecycle', async () => {
    const f = fixture()
    f.client.start()
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(1)
    f.client.stop()
    f.setPending(text('after unmount'))
    await vi.advanceTimersByTimeAsync(90000)
    expect(f.api.writeDraft).toHaveBeenCalledTimes(1)
  })
})
