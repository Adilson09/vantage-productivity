// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PdfDraftClient, type PdfDraftApi } from '../src/renderer/pdf-draft'
import { decodePdfWorkspaceState, type PdfSourceRead } from '../src/shared/pdf-workspace'
import { completeWorkspace } from './fixtures/pdf-workspace'

const token = 'd1157884-8ed7-4f8f-92cb-44467db408e0'
const nextToken = '0caf48ad-62cb-42c5-8eb4-8535259dba7e'
function fixture() {
  const state = completeWorkspace(),
    writes: Array<{ token: string; sequence: number; state: ArrayBuffer }> = [],
    notices: string[] = []
  let composing = false,
    retirement: Parameters<PdfDraftApi['onDraftRetired']>[0] = () => {}
  const api: PdfDraftApi = {
    activateDraft: vi.fn(async () => ({ token, sourceGeneration: 1, mode: 'native' })),
    writeDraft: vi.fn(async (request) => {
      writes.push(request)
      return { ok: true }
    }),
    discardDraft: async () => {},
    acknowledgeCopy: async () => {},
    onDraftRetired: (handler) => {
      retirement = handler
      return () => {}
    },
  }
  const client = new PdfDraftClient({
    api,
    capture: () => state,
    composing: () => composing,
    report: (message) => notices.push(message),
  })
  const read: PdfSourceRead = {
    readId: 'read-A',
    mode: 'native',
    displayPath: '/Original.pdf',
    helperPath: '/Original.pdf',
    baseSha256: '0'.repeat(64),
    data: new ArrayBuffer(0),
    draftCapability: { available: true },
  }
  client.start()
  return {
    client,
    api,
    read,
    state,
    writes,
    notices,
    retire: (reason: Parameters<typeof retirement>[0]['reason']) => retirement({ token, reason }),
    composing: (value: boolean) => {
      composing = value
    },
  }
}
afterEach(() => vi.useRealTimers())
describe('PDF complete-state journal client', () => {
  it('the 30 second timer includes child/new/reply/rewrite content and all 16 buckets', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.client.activate(f.read)
    await vi.advanceTimersByTimeAsync(29999)
    expect(f.writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.writes).toHaveLength(1)
    expect(decodePdfWorkspaceState(f.writes[0]!.state)).toEqual(f.state)
    f.client.stop()
  })
  it('never captures a half-composed gesture and keeps prior complete content on unsupported state', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.client.activate(f.read)
    expect(await f.client.snapshot()).toBe(true)
    f.composing(true)
    f.state.comments.newBody = 'still composing'
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.writes).toHaveLength(1)
    f.composing(false)
    Object.assign(f.state, { ignoredNewBucket: 'cannot be skipped' })
    expect(await f.client.snapshot()).toBe(false)
    expect(f.writes).toHaveLength(1)
    expect(f.notices.at(-1)).toMatch(/recovery/i)
    f.client.stop()
  })
  it('Root discard suppresses the unchanged pending editor, but records a later authored edit under a fresh token', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.client.activate(f.read)
    await f.client.snapshot()
    f.retire('discarded')
    expect(await f.client.snapshot()).toBe(false)
    expect(f.writes).toHaveLength(1)
    vi.mocked(f.api.activateDraft).mockResolvedValue({
      token: nextToken,
      sourceGeneration: 2,
      mode: 'native',
    })
    f.state.comments.replies[0]![1] = 'new authored reply after deletion'
    expect(await f.client.snapshot()).toBe(true)
    expect(f.writes[1]!.token).toBe(nextToken)
    expect(decodePdfWorkspaceState(f.writes[1]!.state).comments.replies[0]![1]).toBe(
      'new authored reply after deletion',
    )
    f.client.stop()
  })
  it('canceled Close resumes the same UUID strictly above its pre-await sequence floor', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.client.activate(f.read)
    await f.client.snapshot()
    const floor = f.client.pauseForClose()!
    expect(await f.client.snapshot()).toBe(false)
    f.state.comments.newBody = 'new current pending truth'
    f.client.resumeClose({ ...floor, throughSequence: floor.throughSequence + 20 })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.writes.at(-1)!.token).toBe(token)
    expect(f.writes.at(-1)!.sequence).toBeGreaterThan(floor.throughSequence + 20)
    expect(vi.mocked(f.api.activateDraft)).toHaveBeenCalledTimes(1)
    f.client.stop()
  })
  it('an explicit Root deletion during staged Close cannot revive its old activation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.client.activate(f.read)
    const floor = f.client.pauseForClose()!
    f.retire('discarded')
    f.client.resumeClose(floor)
    expect(f.client.available()).toBe(false)
    expect(await f.client.snapshot()).toBe(false)
    expect(f.writes).toHaveLength(0)
    f.client.stop()
  })
  it('protected viewing retires the former main source but sends no recovery write or password', async () => {
    vi.useFakeTimers()
    const f = fixture()
    vi.mocked(f.api.activateDraft).mockResolvedValue({
      token: '',
      sourceGeneration: 2,
      mode: 'native',
    })
    await f.client.activate({
      ...f.read,
      readId: '',
      helperPath: '/Protected.pdf',
      draftCapability: { available: false, reason: 'Protected PDF recovery is excluded.' },
    })
    expect(f.api.activateDraft).toHaveBeenCalledWith('', '/Protected.pdf')
    expect(f.client.available()).toBe(false)
    expect(await f.client.snapshot()).toBe(false)
    expect(f.api.writeDraft).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(f.api.activateDraft).mock.calls)).not.toContain('password')
    f.client.stop()
  })
})
