// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { pdfAuthoredFingerprint } from '../src/renderer/pdf-draft'
import { PdfSaveAuthoringChanged, preparePdfSaveAdoption } from '../src/renderer/pdf-save-coherence'
import { completeWorkspace, emptyWorkspace } from './fixtures/pdf-workspace'

const defer = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('full authored-state fence used by staged PDF.js readback', () => {
  it('the positive no-newer Save stages and adopts its actual new base', async () => {
    const state = completeWorkspace(),
      candidate = { base: 'new captured PDF' },
      dispose = vi.fn()
    const result = await preparePdfSaveAdoption({
      expected: pdfAuthoredFingerprint(state),
      capture: () => state,
      current: () => true,
      prepare: async () => candidate,
      dispose,
    })
    expect(result).toBe(candidate)
    expect(dispose).not.toHaveBeenCalled()
  })
  it.each(['same-ID modify', 'same-ID remove', 'Undo', 'new reply', 'pending dialog'] as const)(
    'retains the entire old-base model when %s occurs during deferred readback',
    async (change) => {
      let state = completeWorkspace()
      const original = structuredClone(state),
        expected = pdfAuthoredFingerprint(state),
        gate = defer(),
        entered = defer()
      const candidate = { base: 'already published new PDF' },
        dispose = vi.fn(),
        install = vi.fn()
      const adoption = preparePdfSaveAdoption({
        expected,
        capture: () => state,
        current: () => true,
        prepare: async () => {
          entered.resolve()
          await gate.promise
          return candidate
        },
        dispose,
      }).then((value) => {
        install(value)
      })
      await entered.promise
      if (change === 'same-ID modify')
        state.edits.textEdits[0]!.input.newText = 'Later same-ID text'
      if (change === 'same-ID remove') state.edits.textEdits = []
      if (change === 'Undo') state = emptyWorkspace()
      if (change === 'new reply')
        state.comments.replies.push(['Snewer-thread', 'Later unsubmitted reply'])
      if (change === 'pending dialog')
        state.pendingEditors[0]![1].value = { url: 'https://later.example.test/', page: '' }
      const latest = structuredClone(state),
        rejected = expect(adoption).rejects.toBeInstanceOf(PdfSaveAuthoringChanged)
      gate.resolve()
      await rejected
      expect(dispose).toHaveBeenCalledExactlyOnceWith(candidate)
      expect(install).not.toHaveBeenCalled()
      expect(state).toEqual(latest) // no subtraction, ID filtering, remap or partial rebase
      expect(state).not.toEqual(original)
    },
  )
  it('reading position and status-free view changes do not keep every ordinary Save dirty', async () => {
    const state = completeWorkspace(),
      expected = pdfAuthoredFingerprint(state),
      gate = defer(),
      entered = defer()
    const adoption = preparePdfSaveAdoption({
      expected,
      capture: () => state,
      current: () => true,
      prepare: async () => {
        entered.resolve()
        await gate.promise
        return 'new base'
      },
      dispose: vi.fn(),
    })
    await entered.promise
    state.view.page = 2
    state.view.scale = 1.25
    state.view.sidebar = 'outline'
    state.text.caret = [0, 0]
    state.annotations.selected = null
    state.comments.active = null
    gate.resolve()
    expect(await adoption).toBe('new base')
  })
  it('never adopts source A candidate or fallback state over source B after delayed readback', async () => {
    const stateA = completeWorkspace(),
      stateB = emptyWorkspace(),
      gate = defer(),
      entered = defer(),
      dispose = vi.fn(),
      install = vi.fn()
    let source = 'A',
      currentState = stateA
    const adoption = preparePdfSaveAdoption({
      expected: pdfAuthoredFingerprint(stateA),
      capture: () => currentState,
      current: () => source === 'A',
      prepare: async () => {
        entered.resolve()
        await gate.promise
        return 'A candidate'
      },
      dispose,
    }).then(install)
    await entered.promise
    source = 'B'
    currentState = stateB
    const rejected = expect(adoption).rejects.toThrow(/newer PDF source/)
    gate.resolve()
    await rejected
    expect(install).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledExactlyOnceWith('A candidate')
    expect(currentState).toBe(stateB)
    expect(stateB).toEqual(emptyWorkspace())
  })
})
