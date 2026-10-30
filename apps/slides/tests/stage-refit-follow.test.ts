// Regression: the stage's fit-to-window follow (ResizeObserver on .stage-wrap)
// must survive an editor remount — switching to reading/sorter view and back
// replaces the .stage-wrap element, and the observer has to re-bind to the new
// node or window resizes stop re-fitting the canvas (slide overflows the pane).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
const deckBridge = vi.hoisted(() => ({
  applyDeck: null as null | ((slides: unknown[], goTo?: number) => void),
}))
// Exercise App's real batch-result callback without invoking an AI provider.
vi.mock('../src/renderer/ai/AiPanel', () => ({
  AiPanel: (props: { applyDeck: (slides: unknown[], goTo?: number) => void }) => {
    deckBridge.applyDeck = props.applyDeck
    return null
  },
}))

// react-konva's node entry requires the native 'canvas' package; nothing here draws
vi.mock('react-konva', () => {
  const stub = () => null
  return {
    Stage: stub,
    Layer: stub,
    Rect: stub,
    Group: stub,
    Transformer: stub,
    Line: stub,
    Arrow: stub,
    Text: stub,
    Ellipse: stub,
    Image: stub,
    Path: stub,
    Circle: stub,
    Arc: stub,
  }
})

import { App } from '../src/renderer/App'
import { slidesRecoveryClient } from '../src/renderer/slides-recovery'

/** Recording ResizeObserver: lets the test fire size changes for a target. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  targets = new Set<Element>()
  constructor(private cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element) {
    this.targets.add(el)
    // Real ResizeObserver delivers an initial entry on observe; the stage
    // follow relies on it to baseline the container's border-box size.
    this.cb([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
  static fire(el: Element) {
    for (const inst of FakeResizeObserver.instances) {
      if (inst.targets.has(el)) {
        inst.cb([{ target: el } as ResizeObserverEntry], inst as unknown as ResizeObserver)
      }
    }
  }
}

/** The size fitZoom() sees (content box); fitZoom subtracts 56px (w) / 72px (h) padding. */
let stageSize = { w: 1336, h: 800 } // avail 1280x728 → fit zoom 1 for the blank 1280x720 deck
/** Border box of .stage-wrap: unlike the content box, scrollbars never shrink it. */
let outerSize = { w: 1336, h: 800 }

/** A real window/pane resize: content box and border box change together. */
function resizeStage(w: number, h: number) {
  stageSize = { w, h }
  outerSize = { w, h }
}

const blankSlide = () => ({
  partPath: 'ppt/slides/slide1.xml',
  widthPx: 1280,
  heightPx: 720,
  scale: 1,
  nodes: [],
  background: { kind: 'color', color: '#ffffff' },
})

/** Minimal slidesApi: enough for App to boot into the editor on a blank deck. */
function makeSlidesApi(overrides: Record<string, unknown> = {}) {
  const explicit: Record<string, unknown> = {
    activateDraft: () =>
      Promise.resolve({ ok: true, token: '1a477be0-1331-478f-aed8-a21258709ca4' }),
    draftState: () => Promise.resolve({ revision: '1:0', dirty: false }),
    writeDraft: () => Promise.resolve({ ok: true }),
    acknowledgeDraftSave: () => Promise.resolve({ ok: true }),
    setPendingEditState: () => {},
    consumePendingOpen: () => Promise.resolve(null),
    newBlank: () => Promise.resolve({ path: '', slides: [blankSlide()], defaultFont: 'Arial' }),
    isDirty: () => Promise.resolve(false),
    getRecentFiles: () => Promise.resolve([]),
    getAiSettings: () => Promise.resolve(null),
    getSections: () => Promise.resolve([]),
    getComments: () => Promise.resolve([]),
    getNotes: () => Promise.resolve(''),
    getAnimations: () => Promise.resolve([]),
    getTransition: () => Promise.resolve(null),
    listFonts: () => Promise.resolve([]),
    ...overrides,
  }
  const fallbacks = new Map<string, unknown>()
  return new Proxy(explicit, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (!fallbacks.has(prop)) {
        fallbacks.set(
          prop,
          prop.startsWith('on')
            ? () => () => {} // event subscription → unsubscribe
            : () => Promise.resolve(null),
        )
      }
      return fallbacks.get(prop)
    },
  })
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** Zoom buttons go through the shared preview path: the CSS transform lands on the next
 * rAF and the React commit after a 150ms debounce — flush both before asserting. */
async function flushZoomPreview() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => setTimeout(r, 180))
  })
}

function stageZoom(container: HTMLElement): number {
  const el = container.querySelector<HTMLElement>('.stage-scale')
  expect(el, 'stage-scale should be mounted').not.toBeNull()
  const m = /scale\(([\d.]+)\)/.exec(el!.style.transform)
  expect(m, `transform should carry a scale(): ${el!.style.transform}`).not.toBeNull()
  return Number(m![1])
}

function clickByText(container: HTMLElement, selector: string, re: RegExp): void {
  const btn = [...container.querySelectorAll<HTMLButtonElement>(selector)].find((b) =>
    re.test(b.textContent ?? ''),
  )
  expect(btn, `button ${selector} matching ${re} should exist`).not.toBeNull()
  act(() => btn!.click())
}

let root: Root | null = null
let container: HTMLElement | null = null

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as MediaQueryList
  Element.prototype.scrollTo ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  // fitZoom measures the stage container; jsdom has no layout, so feed it a
  // controllable size (all elements share it — only the stage wrap is measured)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => stageSize.w,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => stageSize.h,
  })
  // Border-box size, mocked only for the stage wrap (other elements keep jsdom's
  // 0 so the zoom-preview transform math stays on its offsetWidth-less path)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('stage-wrap') ? outerSize.w : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('stage-wrap') ? outerSize.h : 0
    },
  })
  ;(window as unknown as { slidesApi: unknown }).slidesApi = makeSlidesApi()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  FakeResizeObserver.instances.length = 0
  deckBridge.applyDeck = null
})

/** Mount the App and boot into a blank deck at fit zoom 1 (1336x800 container). */
async function bootApp(overrides: Record<string, unknown> = {}): Promise<HTMLElement> {
  ;(window as unknown as { slidesApi: unknown }).slidesApi = makeSlidesApi(overrides)
  resizeStage(1336, 800)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(App)))
  await settle()
  const wrap = container.querySelector<HTMLElement>('.stage-wrap')
  expect(wrap, 'editor should boot into a blank deck').not.toBeNull()
  expect(stageZoom(container!)).toBeCloseTo(1, 5)
  return wrap!
}

function deferred<T>() {
  let done!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, fail) => {
    done = resolve
    reject = fail
  })
  return { promise, done, reject }
}
function typeNotes(element: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    element.focus()
    setter.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('speaker notes read receipts in the real App', () => {
  it.each([
    ['false', false],
    ['reject', false],
    ['readback', false],
    ['readback', true],
  ] as const)(
    'fences pre-Undo %s completion and queued work (newer post-Undo notes: %s)',
    async (mode, newer) => {
      const oldSet = deferred<boolean>(),
        oldRead = deferred<string>()
      let reads = 0,
        stored = 'original baseline'
      let menu: (command: string) => void = () => {}
      const setNotes = vi.fn(() => oldSet.promise)
      const undo = vi.fn(async () => {
        stored = 'after Undo baseline'
        return [blankSlide()]
      })
      const writeDraft = vi.fn(async () => ({ ok: true }))
      await bootApp({
        setNotes,
        undo,
        writeDraft,
        getNotes: () =>
          ++reads === 2 && mode === 'readback' ? oldRead.promise : Promise.resolve(stored),
        onMenuCommand: (handler: typeof menu) => {
          menu = handler
          return () => {}
        },
      })
      try {
        const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
        typeNotes(notes, 'old submitted notes')
        act(() => notes.blur())
        await settle()
        expect(setNotes).toHaveBeenCalledTimes(1)
        if (mode === 'readback') {
          await act(async () => oldSet.done(true))
          await settle()
        }
        if (newer) {
          typeNotes(notes, 'queued pre-Undo notes')
          act(() => notes.blur())
          await settle()
          expect(setNotes).toHaveBeenCalledTimes(1)
        }
        act(() => menu('undo'))
        await settle()
        expect(undo).toHaveBeenCalledTimes(1)
        expect(notes.disabled).toBe(false)
        expect(notes.value).toBe('after Undo baseline')
        expect(slidesRecoveryClient()!.hasPending()).toBe(false)
        if (newer) typeNotes(notes, 'newer post-Undo notes')
        await act(async () => {
          if (mode === 'readback') oldRead.done('old submitted notes')
          else if (mode === 'reject') oldSet.reject(new Error('obsolete pre-Undo failure'))
          else oldSet.done(false)
        })
        await settle()
        expect(setNotes).toHaveBeenCalledTimes(1)
        if (!newer) {
          expect(slidesRecoveryClient()!.hasPending()).toBe(false)
          expect(notes.value).toBe('after Undo baseline')
          typeNotes(notes, 'newer post-Undo notes')
        } else expect(notes.value).toBe('newer post-Undo notes')
        await act(async () => {
          expect(await slidesRecoveryClient()!.snapshot()).toBe(true)
        })
        expect(writeDraft).toHaveBeenCalledWith(
          expect.objectContaining({
            pending: {
              notes: {
                slideIndex: 0,
                partPath: 'ppt/slides/slide1.xml',
                text: 'newer post-Undo notes',
                baseline: 'after Undo baseline',
              },
            },
          }),
        )
      } finally {
        oldSet.done(false)
        oldRead.done('old submitted notes')
        await settle()
      }
    },
  )
  it('does not write a net-unchanged pending object over a newer stored baseline', async () => {
    const comparison = deferred<string>()
    let reads = 0,
      stored = 'original baseline'
    const setNotes = vi.fn(async () => true)
    await bootApp({
      getAiSettings: async () => ({}),
      setNotes,
      getNotes: () => (++reads === 2 ? comparison.promise : Promise.resolve(stored)),
    })
    try {
      const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
      typeNotes(notes, 'temporary edit')
      act(() => deckBridge.applyDeck!([blankSlide()]))
      await settle()
      typeNotes(notes, 'original baseline')
      stored = 'new stored baseline'
      await act(async () => comparison.done(stored))
      await settle()
      expect(setNotes).not.toHaveBeenCalled()
      expect(notes.value).toBe('new stored baseline')
      expect(slidesRecoveryClient()!.hasPending()).toBe(false)
    } finally {
      comparison.done(stored)
      await settle()
    }
  })
  it('a second Save retries a rejected comparison and cannot overwrite changed notes until the baseline is compatible', async () => {
    const firstRead = deferred<string>(),
      retryRead = deferred<string>()
    let reads = 0,
      stored = 'original baseline',
      saved = ''
    let menu: (command: string) => void = () => {}
    const setNotes = vi.fn(async (op: { text: string }) => {
      stored = op.text
      return true
    })
    const save = vi.fn(async () => {
      saved = stored
      return { ok: true, path: '/test/after-retry.pptx' }
    })
    await bootApp({
      getAiSettings: async () => ({}),
      setNotes,
      save,
      getNotes: () =>
        ++reads === 2
          ? firstRead.promise
          : reads === 3
            ? retryRead.promise
            : Promise.resolve(stored),
      onMenuCommand: (handler: typeof menu) => {
        menu = handler
        return () => {}
      },
    })
    try {
      const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
      typeNotes(notes, 'pending text must survive failed and conflicting reads')
      act(() => deckBridge.applyDeck!([blankSlide()]))
      await settle()
      act(() => menu('save'))
      await settle()
      stored = 'peer changed these notes'
      await act(async () => firstRead.reject(new Error('first comparison was unavailable')))
      await settle()
      expect(save).not.toHaveBeenCalled()
      expect(setNotes).not.toHaveBeenCalled()
      act(() => menu('save'))
      await settle()
      expect(reads).toBe(3)
      expect(setNotes).not.toHaveBeenCalled()
      await act(async () => retryRead.done(stored))
      await settle()
      expect(setNotes).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(stored).toBe('peer changed these notes')
      expect(notes.value).toBe('pending text must survive failed and conflicting reads')
      expect(slidesRecoveryClient()!.hasPending()).toBe(true)
      // Once a fresh read confirms a compatible baseline, a later explicit
      // Save may commit the still-preserved pending text.
      stored = 'original baseline'
      act(() => menu('save'))
      await settle()
      expect(setNotes).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledTimes(1)
      expect(saved).toBe('pending text must survive failed and conflicting reads')
    } finally {
      firstRead.done(stored)
      retryRead.done(stored)
      await settle()
    }
  })
  it('keeps pending notes visible to recovery and waits for a deferred batch comparison before Save', async () => {
    const comparison = deferred<string>()
    let reads = 0,
      stored = 'original baseline',
      saved = ''
    let menu: (command: string) => void = () => {}
    const setNotes = vi.fn(async (op: { text: string }) => {
      stored = op.text
      return true
    })
    const save = vi.fn(async () => {
      saved = stored
      return { ok: true, path: '/test/saved.pptx', slides: [blankSlide()] }
    })
    const writeDraft = vi.fn(async () => ({ ok: true }))
    await bootApp({
      getAiSettings: async () => ({}),
      getNotes: () => (++reads === 2 ? comparison.promise : Promise.resolve(stored)),
      setNotes,
      save,
      writeDraft,
      onMenuCommand: (handler: typeof menu) => {
        menu = handler
        return () => {}
      },
    })
    const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
    try {
      typeNotes(notes, 'pending before batch result')
      expect(deckBridge.applyDeck).toBeTypeOf('function')
      act(() => deckBridge.applyDeck!([blankSlide()]))
      await settle()
      typeNotes(notes, 'newer same-part typing while comparison waited')
      await act(async () => {
        expect(await slidesRecoveryClient()!.snapshot()).toBe(true)
      })
      expect(writeDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          pending: {
            notes: {
              slideIndex: 0,
              partPath: 'ppt/slides/slide1.xml',
              text: 'newer same-part typing while comparison waited',
              baseline: 'original baseline',
            },
          },
        }),
      )
      act(() => menu('save'))
      await settle()
      expect(save).not.toHaveBeenCalled()
      expect(setNotes).not.toHaveBeenCalled()
      await act(async () => comparison.done('original baseline'))
      await settle()
      expect(save).toHaveBeenCalledTimes(1)
      expect(saved).toBe('newer same-part typing while comparison waited')
      expect(setNotes).toHaveBeenCalledTimes(1)
    } finally {
      comparison.done('original baseline')
      await settle()
    }
  })
  it('an old batch comparison cannot restore notes into a newly opened deck sharing its part path', async () => {
    const comparison = deferred<string>()
    let reads = 0
    let opened: (value: unknown) => void = () => {}
    const setNotes = vi.fn(async () => true)
    await bootApp({
      getAiSettings: async () => ({}),
      getNotes: () =>
        ++reads === 1
          ? Promise.resolve('deck A baseline')
          : reads === 2
            ? comparison.promise
            : Promise.resolve('deck B baseline'),
      setNotes,
      onOpened: (handler: typeof opened) => {
        opened = handler
        return () => {}
      },
    })
    try {
      const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
      typeNotes(notes, 'deck A must never be written into B')
      act(() => deckBridge.applyDeck!([blankSlide()]))
      await settle()
      act(() => opened({ path: '/test/deck-B.pptx', slides: [blankSlide()] }))
      await settle()
      expect(container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!.value).toBe(
        'deck B baseline',
      )
      await act(async () => comparison.done('deck A baseline'))
      await settle()
      expect(container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!.value).toBe(
        'deck B baseline',
      )
      expect(setNotes).not.toHaveBeenCalled()
      expect(slidesRecoveryClient()!.hasPending()).toBe(false)
    } finally {
      comparison.done('deck A baseline')
      await settle()
    }
  })
  it('a rejected same-source batch read leaves the latest pending notes available and reports failure', async () => {
    const comparison = deferred<string>()
    let reads = 0
    const writeDraft = vi.fn(async () => ({ ok: true }))
    const setNotes = vi.fn(async () => true)
    await bootApp({
      getAiSettings: async () => ({}),
      writeDraft,
      setNotes,
      getNotes: () => (++reads === 2 ? comparison.promise : Promise.resolve('original baseline')),
    })
    try {
      const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
      typeNotes(notes, 'first pending words')
      act(() => deckBridge.applyDeck!([blankSlide()]))
      await settle()
      typeNotes(notes, 'latest pending words survive the read failure')
      await act(async () =>
        comparison.reject(new Error('notes comparison read failed for this test')),
      )
      await settle()
      expect(notes.value).toBe('latest pending words survive the read failure')
      expect(container!.textContent).toContain('notes comparison read failed for this test')
      expect(setNotes).not.toHaveBeenCalled()
      await act(async () => {
        expect(await slidesRecoveryClient()!.snapshot()).toBe(true)
      })
      expect(writeDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          pending: {
            notes: {
              slideIndex: 0,
              partPath: 'ppt/slides/slide1.xml',
              text: 'latest pending words survive the read failure',
              baseline: 'original baseline',
            },
          },
        }),
      )
    } finally {
      comparison.done('original baseline')
      await settle()
    }
  })
  it('waits for the previous-part flush and preserves its pending text when that write fails', async () => {
    const saving = deferred<boolean>()
    let changed: (value: unknown) => void = () => {}
    const getNotes = vi.fn(async () => 'original baseline')
    const setNotes = vi.fn(() => saving.promise)
    const writeDraft = vi.fn(async () => ({ ok: true }))
    await bootApp({
      getNotes,
      setNotes,
      writeDraft,
      onDeckChanged: (handler: typeof changed) => {
        changed = handler
        return () => {}
      },
    })
    const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
    typeNotes(notes, 'keep these earlier-part pending notes')
    act(() => notes.blur())
    await settle()
    expect(setNotes).toHaveBeenCalledTimes(1)
    expect(setNotes).toHaveBeenCalledWith({
      slideIndex: 0,
      partPath: 'ppt/slides/slide1.xml',
      text: 'keep these earlier-part pending notes',
    })
    act(() =>
      changed({ slides: [{ ...blankSlide(), partPath: 'ppt/slides/slide2.xml' }, blankSlide()] }),
    )
    await settle()
    expect(notes.disabled).toBe(true)
    expect(getNotes).toHaveBeenCalledTimes(1)
    await act(async () => saving.done(false))
    await settle()
    expect(notes.disabled).toBe(true)
    expect(notes.placeholder).toContain('could not be loaded')
    expect(getNotes).toHaveBeenCalledTimes(1)
    await act(async () => {
      expect(await slidesRecoveryClient()!.snapshot()).toBe(true)
    })
    expect(writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        pending: {
          notes: {
            slideIndex: 0,
            partPath: 'ppt/slides/slide1.xml',
            text: 'keep these earlier-part pending notes',
            baseline: 'original baseline',
          },
        },
      }),
    )
    act(() =>
      changed({ slides: [blankSlide(), { ...blankSlide(), partPath: 'ppt/slides/slide2.xml' }] }),
    )
    await settle()
    expect(notes.disabled).toBe(false)
    expect(notes.value).toBe('keep these earlier-part pending notes')
  })
  it('keeps current-part typing and its original baseline when a same-part reload replies late', async () => {
    const late = deferred<string>()
    let reads = 0
    let renamed: (path: string) => void = () => {}
    const writeDraft = vi.fn(async () => ({ ok: true }))
    await bootApp({
      getNotes: () => (++reads === 1 ? Promise.resolve('original baseline') : late.promise),
      onRenamed: (handler: typeof renamed) => {
        renamed = handler
        return () => {}
      },
      writeDraft,
    })
    const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
    expect(notes.disabled).toBe(false)
    expect(notes.value).toBe('original baseline')
    act(() => renamed('/test/renamed.pptx'))
    await settle()
    expect(reads).toBe(2)
    expect(notes.disabled).toBe(false)
    expect(notes.getAttribute('aria-busy')).toBe('true')
    typeNotes(notes, 'newly typed notes while that read waited')
    await act(async () => late.done('late peer replacement'))
    await settle()
    expect(notes.value).toBe('newly typed notes while that read waited')
    await act(async () => {
      expect(await slidesRecoveryClient()!.snapshot()).toBe(true)
    })
    expect(writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        pending: {
          notes: {
            slideIndex: 0,
            partPath: 'ppt/slides/slide1.xml',
            text: 'newly typed notes while that read waited',
            baseline: 'original baseline',
          },
        },
      }),
    )
  })
  it.each(['part', 'source'] as const)(
    'ignores a deferred read from an obsolete %s and waits for the new initial baseline',
    async (change) => {
      const old = deferred<string>()
      let reads = 0
      let changed: (value: unknown) => void = () => {}
      let opened: (value: unknown) => void = () => {}
      await bootApp({
        getNotes: () => (++reads === 1 ? old.promise : Promise.resolve('new active baseline')),
        onDeckChanged: (handler: typeof changed) => {
          changed = handler
          return () => {}
        },
        onOpened: (handler: typeof opened) => {
          opened = handler
          return () => {}
        },
      })
      const notes = container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!
      expect(notes.disabled).toBe(true)
      expect(notes.getAttribute('aria-busy')).toBe('true')
      expect(notes.placeholder).toContain('Loading speaker notes')
      act(() => {
        if (change === 'part')
          changed({ slides: [{ ...blankSlide(), partPath: 'ppt/slides/slide2.xml' }] })
        else opened({ path: '/test/replacement.pptx', slides: [blankSlide()] })
      })
      await settle()
      expect(reads).toBe(2)
      expect(notes.disabled).toBe(false)
      expect(notes.value).toBe('new active baseline')
      await act(async () => old.done('obsolete notes must not replace the active view'))
      await settle()
      expect(notes.value).toBe('new active baseline')
      expect(notes.disabled).toBe(false)
    },
  )
})

describe('stage fit-to-window follow', () => {
  it('hides bleed-only scrollbars until the nominal slide overflows', async () => {
    const wrap = await bootApp()
    expect(wrap.classList.contains('stage-fits-viewport')).toBe(true)

    // A zoom above the geometric fit needs normal canvas panning.
    const plus = [...container!.querySelectorAll<HTMLButtonElement>('.zoom-btn')].at(-1)!
    act(() => plus.click())
    await flushZoomPreview()
    expect(stageZoom(container!)).toBeCloseTo(1.1, 5)
    expect(wrap.classList.contains('stage-fits-viewport')).toBe(false)

    // Growing the viewport makes the unchanged manual zoom fit again. The
    // ResizeObserver must refresh the class even though it does not change zoom.
    resizeStage(1500, 900)
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(1.1, 5)
    expect(wrap.classList.contains('stage-fits-viewport')).toBe(true)
  })

  it('re-fits on container resize after a reading-view round trip', async () => {
    const wrap = await bootApp()

    // sanity: the follow works before any view-mode round trip
    resizeStage(696, 800) // avail 640 → fit 0.5
    await act(async () => FakeResizeObserver.fire(wrap!))
    expect(stageZoom(container!)).toBeCloseTo(0.5, 5)

    // reading view unmounts the editor; returning remounts a fresh .stage-wrap
    clickByText(container!, '.ribbon-tabs button', /^(View|视图)$/)
    clickByText(container!, 'button.rb-big', /Reading|阅读/)
    await settle()
    expect(container!.querySelector('.stage-wrap')).toBeNull()
    clickByText(container!, 'button.reading-exit', /./)
    await settle()

    const wrap2 = container!.querySelector<HTMLElement>('.stage-wrap')
    expect(wrap2, 'editor should be back').not.toBeNull()
    expect(wrap2).not.toBe(wrap)

    // shrink again: the observer must follow the NEW stage-wrap
    resizeStage(376, 800) // avail 320 → fit 0.25
    await act(async () => FakeResizeObserver.fire(wrap2!))
    expect(stageZoom(container!)).toBeCloseTo(0.25, 5)
  })

  it('clamps a manual zoom back to fit when the container shrinks', async () => {
    const wrap = await bootApp()

    // "+" bottom-bar button: manual zoom, exits fit mode
    const plus = [...container!.querySelectorAll<HTMLButtonElement>('.zoom-btn')].at(-1)!
    act(() => plus.click())
    await flushZoomPreview()
    expect(stageZoom(container!)).toBeCloseTo(1.1, 5)

    // container shrinks: 1.1 no longer fits → clamp down to the new fit
    resizeStage(696, 800) // avail 640 → fit 0.5
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(0.5, 5)

    // and fit mode is re-entered: the next resize follows again
    resizeStage(376, 800) // avail 320 → fit 0.25
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(0.25, 5)
  })

  it('leaves a manual zoom smaller than fit alone on container resize', async () => {
    const wrap = await bootApp()

    // "−" bottom-bar button: manual zoom out below fit
    const minus = container!.querySelector<HTMLButtonElement>('.zoom-btn')!
    act(() => minus.click())
    await flushZoomPreview()
    expect(stageZoom(container!)).toBeCloseTo(0.9, 5)

    // resize with fit still 1: 0.9 fits already → the user's choice is kept
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(0.9, 5)
  })

  it('keeps a zoom above the 1.5 fit cap while it still fits the container', async () => {
    const wrap = await bootApp()

    // container big enough for 200%: uncapped fit ≈ 2.07, fitZoom caps at 1.5
    resizeStage(2700, 1600)
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(1.5, 5) // fit-mode follow, capped

    // manual zoom to 2.0 — still fits geometrically
    const plus = [...container!.querySelectorAll<HTMLButtonElement>('.zoom-btn')].at(-1)!
    for (let i = 0; i < 5; i++) act(() => plus.click())
    await flushZoomPreview()
    expect(stageZoom(container!)).toBeCloseTo(2.0, 5)

    // a resize that still fits 200% must NOT wipe the manual zoom down to 1.5
    resizeStage(2680, 1590)
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(2.0, 5)

    // but a real overflow still clamps back to fit
    resizeStage(1336, 800) // uncapped fit 1
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(1, 5)
  })

  it('keeps a manual zoom when scrollbars appear without a real container resize', async () => {
    const wrap = await bootApp()

    // zoom above fit: the slide overflows and classic scrollbars appear
    const plus = [...container!.querySelectorAll<HTMLButtonElement>('.zoom-btn')].at(-1)!
    act(() => plus.click())
    await flushZoomPreview()
    expect(stageZoom(container!)).toBeCloseTo(1.1, 5)

    // The scrollbars shrink the observed content box, but the border box is
    // unchanged — no real window/pane resize happened, so the manual zoom
    // must NOT snap back to fit (regression: zooming past fit bounced back).
    stageSize = { w: 1321, h: 785 }
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(1.1, 5)
    expect(wrap.classList.contains('stage-fits-viewport')).toBe(false)

    // A real shrink afterwards still clamps back down to the fit value
    resizeStage(696, 800) // avail 640 → fit 0.5
    await act(async () => FakeResizeObserver.fire(wrap))
    expect(stageZoom(container!)).toBeCloseTo(0.5, 5)
  })
})
