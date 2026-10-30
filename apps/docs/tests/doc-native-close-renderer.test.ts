import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileActionContext } from '../src/renderer/file-actions'
const controls = vi.hoisted(() => ({
  generation: 1,
  clean: false,
  canDiscard: true,
  save: vi.fn(),
  resume: vi.fn(async () => {}),
}))
vi.mock('../src/renderer/file-actions', () => ({
  currentDocGeneration: () => controls.generation,
  currentRecoverySequence: () => 17,
  canCloseSavedDocument: () => controls.clean,
  canDiscardCurrentDocument: () => controls.canDiscard,
  save: controls.save,
  resumeRecoveryAfterCanceledClose: controls.resume,
}))
import { prepareDocRendererClose } from '../src/renderer/native-close'
import { docCloseBarrier, setDocCloseSourceReader } from '../src/renderer/doc-close-lease'
let sequence = 50000
const ctx = {
  doc: { filePath: '/a.docx' },
  editor: {},
  saveIncompleteRef: { current: false },
} as unknown as FileActionContext
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const request = (intent: 'save' | 'discard') => ({
  ticket: { id: `native-${++sequence}`, sequence, source: 'main-A' },
  intent,
  sourcePath: '/a.docx',
  approvedStamp: docCloseBarrier.snapshot(),
})
beforeEach(() => {
  const held = docCloseBarrier.ticket
  if (held) docCloseBarrier.release(held)
  controls.generation++
  controls.clean = false
  controls.canDiscard = true
  controls.save.mockReset()
  controls.resume.mockClear()
  setDocCloseSourceReader(() => `renderer-${controls.generation}`)
  window.desktop = {
    claimDocCloseLease: vi.fn(async () => true),
    cancelDocCloseLease: vi.fn(async () => {}),
  } as unknown as typeof window.desktop
})
afterEach(() => {
  const held = docCloseBarrier.ticket
  if (held) docCloseBarrier.release(held)
})
describe('native Docs final renderer preparation', () => {
  it('holds a clean unnamed/current source without inventing a file publication', async () => {
    controls.clean = true
    const result = await prepareDocRendererClose(() => ctx, request('save'))
    expect(result).toMatchObject({ published: false, current: true, clean: true })
    expect(result.closeLease).toBeDefined()
    expect(docCloseBarrier.locked).toBe(true)
    expect(controls.save).not.toHaveBeenCalled()
  })
  it('blocks physical close-save publication while an earlier async author is unfinished', async () => {
    const gate = deferred(),
      writer = docCloseBarrier.runMutationWork(() => gate.promise)
    const result = await prepareDocRendererClose(() => ctx, request('save'))
    expect(result.closeLease).toBeUndefined()
    expect(result.published).toBe(false)
    expect(controls.save).not.toHaveBeenCalled()
    gate.resolve()
    await writer
  })
  it('refuses an explicit discard if a newer accepted revision arrives during main claim', async () => {
    const gate = deferred()
    vi.mocked(window.desktop.claimDocCloseLease).mockImplementation(async () => {
      await gate.promise
      return true
    })
    const work = prepareDocRendererClose(() => ctx, request('discard'))
    await vi.waitFor(() => expect(window.desktop.claimDocCloseLease).toHaveBeenCalled())
    docCloseBarrier.mutate(() => {})
    gate.resolve()
    const result = await work
    expect(result.closeLease).toBeUndefined()
    expect(docCloseBarrier.locked).toBe(false)
    expect(controls.save).not.toHaveBeenCalled()
  })
  it('holds the captured recovery watermark without rotating the renderer producer', async () => {
    const result = await prepareDocRendererClose(() => ctx, request('discard'))
    expect(result).toMatchObject({
      published: false,
      current: true,
      clean: false,
      intent: 'discard',
    })
    expect(controls.resume).not.toHaveBeenCalled()
    docCloseBarrier.release(result.closeLease!.ticket)
    expect(controls.resume).not.toHaveBeenCalled()
    expect(result.throughSequence).toBe(17)
  })
  it('preserves truthful publication when pending authored input never becomes representable', async () => {
    controls.save.mockResolvedValue(true)
    const result = await prepareDocRendererClose(() => ctx, request('save'))
    expect(result).toMatchObject({ published: true, current: true, clean: false })
    expect(result.closeLease).toBeUndefined()
    expect(controls.save).toHaveBeenCalledTimes(3)
    expect(docCloseBarrier.locked).toBe(false)
  })
})

it('the real native renderer preparation forwards only its exact main ticket through owned Save', async () => {
  const req = request('save')
  controls.save.mockImplementation(async (...args: unknown[]) => {
    expect(args[5]).toBe(req.ticket)
    controls.clean = true
    return true
  })
  const result = await prepareDocRendererClose(() => ctx, req)
  expect(result).toMatchObject({ published: true, current: true, clean: true })
  expect(result.closeLease?.ticket).toBe(req.ticket)
  expect(controls.save).toHaveBeenCalledOnce()
})
