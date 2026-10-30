import { afterEach, describe, expect, it, vi } from 'vitest'

// file-actions pulls export-render → pptx-render → konva → native `canvas`
// (missing in CI). Mock the UI-only modules so this unit test exercises
// only the save-serialization queue.
vi.mock('../src/renderer/export-render', () => ({ renderSlidesToPngBase64: vi.fn() }))
vi.mock('../src/renderer/components/toast-bus', () => ({ showToast: vi.fn() }))
vi.mock('../src/renderer/i18n/locale', () => ({ t: (k: string) => k }))

import { adoptSavedSlides, save, saveAs } from '../src/renderer/file-actions'
import type { ActionCtx } from '../src/renderer/action-context'
import {
  configureSlidesRecovery,
  SlidesRecoveryClient,
  type SlidesRecoveryApi,
} from '../src/renderer/slides-recovery'
import {
  registerSlidesPendingEditor,
  retireSlidesPendingEditor,
} from '../src/renderer/slides-pending-edit'
import type { SlidesPendingDraft } from '../src/shared/slides-draft'

afterEach(() => {
  configureSlidesRecovery(null)
  retireSlidesPendingEditor()
  vi.unstubAllGlobals()
})
function deferred<T>() {
  let done!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    done = resolve
  })
  return { promise, done }
}
function recoveryFixture() {
  let pending: SlidesPendingDraft = {}
  const api: SlidesRecoveryApi = {
    activateDraft: vi.fn(async () => ({ ok: true, token: '5e67ef5d-cdd5-416b-b839-a53b587955c1' })),
    writeDraft: vi.fn(async () => ({ ok: true })),
    acknowledgeDraftSave: vi.fn(async () => ({ ok: true })),
    draftState: vi.fn(async () => ({ revision: '1:0', dirty: true })),
    setPendingEditState: vi.fn(),
    onDraftDiscarded: () => () => {},
    onDraftWarning: () => () => {},
  }
  const client = new SlidesRecoveryClient({
    api,
    capturePending: () => ({ pending, composing: false }),
    reportError: vi.fn(),
  })
  client.activate('/test/deck.pptx')
  configureSlidesRecovery(client)
  return {
    client,
    api,
    setPending: (value: SlidesPendingDraft) => {
      pending = value
    },
  }
}

function ctx(): ActionCtx {
  return {
    flushActiveEditRef: { current: () => Promise.resolve() },
    editingActiveRef: { current: false },
    flushNotes: () => Promise.resolve(),
    slides: [],
    current: 0,
    setSlides: () => {},
    setSelectedIds: () => {},
    setEnteredGroupId: () => {},
    setEditing: () => {},
    setEditingCell: () => {},
    setDirty: () => {},
    setPath: () => {},
    setStatus: () => {},
    path: '/test/deck.pptx',
  } as unknown as ActionCtx
}

describe('slides save serialization', () => {
  it('refuses an active IME before blur can commit partial text', async () => {
    const blur = vi.fn(),
      commit = vi.fn(async () => {})
    const mockSave = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })
    registerSlidesPendingEditor({ capture: () => null, composing: () => true, commit })
    const active = vi
      .spyOn(document, 'activeElement', 'get')
      .mockReturnValue({ isContentEditable: true, blur } as unknown as HTMLElement)
    try {
      expect(await save(ctx)).toBe(false)
      expect(blur).not.toHaveBeenCalled()
      expect(commit).not.toHaveBeenCalled()
      expect(mockSave).not.toHaveBeenCalled()
    } finally {
      active.mockRestore()
    }
  })
  it('keeps text typed during an in-flight save dirty and does not replace its active editor', async () => {
    const f = recoveryFixture()
    const started = deferred<void>(),
      written = deferred<{ ok: boolean; path: string; slides: [] }>()
    const mockSave = vi.fn(() => {
      started.done()
      return written.promise
    })
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })
    const context = { ...ctx(), setDirty: vi.fn(), setSlides: vi.fn() }
    const saving = save(() => context)
    await started.promise
    f.setPending({
      text: {
        kind: 'text',
        slideIndex: 0,
        sourceId: 'new-typing',
        paragraphs: [{ runs: [{ text: 'typed after Save' }] }],
      },
    })
    written.done({ ok: true, path: '/test/deck.pptx', slides: [] })
    expect(await saving).toBe(false)
    expect(context.setDirty).toHaveBeenCalledWith(true)
    expect(context.setSlides).not.toHaveBeenCalled()
    expect(f.api.acknowledgeDraftSave).toHaveBeenCalledWith(
      expect.objectContaining({ clean: false }),
    )
  })
  it('a late save reply cannot acknowledge or redraw a replacement presentation', async () => {
    const f = recoveryFixture()
    const started = deferred<void>(),
      written = deferred<{ ok: boolean; path: string; slides: [] }>()
    vi.stubGlobal('window', {
      slidesApi: {
        save: vi.fn(() => {
          started.done()
          return written.promise
        }),
      },
    })
    const context = { ...ctx(), setDirty: vi.fn(), setSlides: vi.fn(), setPath: vi.fn() }
    const saving = save(() => context)
    await started.promise
    f.client.activate('/test/replacement.pptx')
    written.done({ ok: true, path: '/test/deck.pptx', slides: [] })
    expect(await saving).toBe(false)
    expect(context.setDirty).not.toHaveBeenCalled()
    expect(context.setSlides).not.toHaveBeenCalled()
    expect(context.setPath).not.toHaveBeenCalled()
    expect(f.api.acknowledgeDraftSave).not.toHaveBeenCalled()
  })
  it('a refused pending-text commit prevents a normal file write and remains recoverable', async () => {
    const mockSave = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })
    registerSlidesPendingEditor({
      capture: () => ({
        kind: 'text',
        slideIndex: 0,
        sourceId: 'e1',
        paragraphs: [{ runs: [{ text: 'kept' }] }],
      }),
      composing: () => false,
      commit: async () => {
        throw new Error('The pending edit was refused')
      },
    })
    const context = { ...ctx(), setStatus: vi.fn() }
    expect(await save(() => context)).toBe(false)
    expect(mockSave).not.toHaveBeenCalled()
    expect(context.setStatus).toHaveBeenCalled()
  })
  it('keeps the saved deck and clears stale selection when the current index is gone', () => {
    const slide = {
      widthPx: 960,
      heightPx: 540,
      scale: 1,
      background: { kind: 'solid', color: 'FFFFFF' },
      nodes: [],
    } as ActionCtx['slides'][number]
    for (const [slides, current, next] of [
      [[], 0, []],
      [[slide], 1, [slide]],
    ] as const) {
      const setSlides = vi.fn()
      const setSelectedIds = vi.fn()
      const setEditing = vi.fn()
      const setEditingCell = vi.fn()
      const context = {
        ...ctx(),
        slides,
        current,
        setSlides,
        setSelectedIds,
        setEnteredGroupId: vi.fn(),
        setEditing,
        setEditingCell,
      } as unknown as ActionCtx

      adoptSavedSlides(context, [...next])

      expect(setSlides).toHaveBeenCalledWith(next)
      expect(setSelectedIds.mock.calls[0]![0](['a', 'b'])).toEqual([])
      expect(setEditing.mock.calls[0]![0]({ sourceId: 'a' })).toBeNull()
      expect(setEditingCell.mock.calls[0]![0]({ sourceId: 'a', row: 0, col: 0 })).toBeNull()
    }
  })

  it('queues concurrent saves so only one IPC write runs at a time', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const mockSave = vi.fn(async () => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      // Simulate a slow write.
      await new Promise((resolve) => setTimeout(resolve, 50))
      inFlight -= 1
      return { ok: true }
    })
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })

    // Fire three saves simultaneously — they must queue, not overlap.
    const [a, b, c] = await Promise.all([save(ctx), save(ctx, true), save(ctx)])

    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(c).toBe(true)
    expect(mockSave).toHaveBeenCalledTimes(3)
    expect(maxConcurrent).toBe(1)

    vi.unstubAllGlobals()
  })

  it('serializes save against saveAs so their IPC writes never overlap', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const track = async () => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      // Simulate a slow write.
      await new Promise((resolve) => setTimeout(resolve, 50))
      inFlight -= 1
      return { ok: true }
    }
    const mockSave = vi.fn(track)
    const mockSaveAs = vi.fn(track)
    vi.stubGlobal('window', { slidesApi: { save: mockSave, saveAs: mockSaveAs } })

    // A manual save racing Save As (or close-save) must queue behind it.
    const [saved, _] = await Promise.all([save(ctx, true), saveAs(ctx)])

    expect(saved).toBe(true)
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSaveAs).toHaveBeenCalledTimes(1)
    expect(maxConcurrent).toBe(1)

    vi.unstubAllGlobals()
  })

  it('reports failure without blocking the queue for the next caller', async () => {
    let calls = 0
    const mockSave = vi.fn(async () => {
      calls += 1
      if (calls === 1) return { ok: false, error: 'disk full' }
      return { ok: true }
    })
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })

    const first = save(ctx, true)
    const second = save(ctx, true)
    const [r1, r2] = await Promise.all([first, second])

    expect(r1).toBe(false)
    expect(r2).toBe(true)
    expect(mockSave).toHaveBeenCalledTimes(2)

    vi.unstubAllGlobals()
  })

  it('resolves the context when a queued pass runs, not when it was queued', async () => {
    let saves = 0
    const mockSave = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      saves += 1
      return { ok: true }
    })
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })

    const seen: number[] = []
    const getCtx = () => {
      seen.push(saves)
      return ctx()
    }
    await Promise.all([save(getCtx, true), save(getCtx, true)])

    expect(seen[0]).toBe(0)
    expect(seen).toContain(1)
    expect(mockSave).toHaveBeenCalledTimes(2)
    expect(saves).toBe(2)

    vi.unstubAllGlobals()
  })
})
