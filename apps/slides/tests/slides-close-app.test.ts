import {StrictMode} from 'react'
import {slidesAuthored} from '../src/renderer/slides-authored'
import type {SlidesToolSaveRequest,SlidesToolSaveResult} from '../src/shared/slides-tool-save'
// Actual App close/recovery regressions; harness copied from accepted stage-refit-follow baseline.
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
  await act(async () => root!.render(createElement(StrictMode,null,createElement(App))))
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

function closeFixture(){let request:(value:SlidesToolSaveRequest)=>void=()=>{},release:(ticket:NonNullable<SlidesToolSaveRequest['closeLease']>)=>void=()=>{},opened:(value:any)=>void=()=>{};const results:SlidesToolSaveResult[]=[];const saveToolToPath=vi.fn(async()=>({ok:true,path:'/deck.pptx',dirty:false,slides:[blankSlide()]}));return{results,saveToolToPath,overrides:{onToolSaveRequest:(value:typeof request)=>{request=value;return()=>{}},onCloseRelease:(value:typeof release)=>{release=value;return()=>{}},onOpened:(value:typeof opened)=>{opened=value;return()=>{}},claimCloseLease:async()=>true,cancelCloseLease:vi.fn(async()=>{}),probeToolSave:async()=>({current:true,revision:'main:1',dirty:false}),saveToolToPath,reportToolSaveResult:(value:SlidesToolSaveResult)=>results.push(value)},send:(intent:'save'|'discard'='save',id='close-1',sequence=1)=>{const runtime=slidesAuthored()!,sourceIdentity=runtime.source(),value:SlidesToolSaveRequest={requestId:id,path:'/deck.pptx',requireClean:true,sourceToken:'1a477be0-1331-478f-aed8-a21258709ca4',intent,sourceIdentity,closeLease:{id,source:sourceIdentity,sequence}};request(value);return value},release:(ticket:NonNullable<SlidesToolSaveRequest['closeLease']>)=>release(ticket),opened:(value:any)=>opened(value)}}
describe('held close protection in the actual Slides App',()=>{
 it('a clean renderer acquires the mutation barrier without publishing another file',async()=>{const f=closeFixture();await bootApp(f.overrides);f.send();await settle();expect(f.results.at(-1)).toMatchObject({clean:true,current:true,published:false});expect(f.results.at(-1)?.stamp?.source).toBe(slidesAuthored()!.source());expect(slidesAuthored()!.barrier.locked).toBe(true);expect(f.saveToolToPath).not.toHaveBeenCalled()})
 it('main release is correlated and an old release cannot unlock a newer ready close',async()=>{const f=closeFixture();await bootApp(f.overrides);const first=f.send();await settle();f.release(first.closeLease!);await settle();const next=f.send('save','close-2',2);await settle();expect(slidesAuthored()!.barrier.ticket?.id).toBe(next.requestId);f.release(first.closeLease!);expect(slidesAuthored()!.barrier.ticket?.id).toBe(next.requestId);f.release(next.closeLease!);expect(slidesAuthored()!.barrier.locked).toBe(false)})
 it('queues one source-switch approval until actual AI/pending participants settle without retrying mutation',async()=>{const f=closeFixture(),confirm=vi.fn(async()=>false);await bootApp({...f.overrides,confirmSourceAdoption:confirm});let busy=true;const off=slidesAuthored()!.registerParticipant(()=>busy?'AI run still finishing':null);act(()=>f.opened({path:'/candidate.pptx',sourceCandidateId:'candidate-1',slides:[blankSlide()]}));await settle();expect(confirm).not.toHaveBeenCalled();busy=false;slidesAuthored()!.notifyReady();await settle();expect(confirm).toHaveBeenCalledTimes(1);expect(confirm).toHaveBeenCalledWith('candidate-1');slidesAuthored()!.notifyReady();await settle();expect(confirm).toHaveBeenCalledTimes(1);off()})
 it('IME composition prevents Save+Close before the active text is representable',async()=>{const f=closeFixture();await bootApp(f.overrides);const notes=container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!;act(()=>notes.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));f.send();await settle();expect(f.results.at(-1)?.clean).toBe(false);expect(f.results.at(-1)?.error).toMatch(/finishing|composing/);expect(f.saveToolToPath).not.toHaveBeenCalled();act(()=>notes.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})))})
 it('typing during the final journal acknowledgment stays dirty and cannot authorize close',async()=>{const f=closeFixture(),ack=deferred<{ok:boolean}>(),entered=deferred<void>();let probes=0;await bootApp({...f.overrides,probeToolSave:async()=>({current:true,revision:'main:1',dirty:++probes===1}),acknowledgeDraftSave:()=>{entered.done();return ack.promise}});f.send();await entered.promise;const notes=container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!;typeNotes(notes,'typed during acknowledgment');ack.done({ok:true});await settle();expect(f.results.at(-1)).toMatchObject({published:true,clean:false});expect(slidesRecoveryClient()!.hasPending()).toBe(true);expect(slidesAuthored()!.barrier.locked).toBe(false)})
 it('a new source retires old save acknowledgments rather than cleaning its newer notes',async()=>{const f=closeFixture(),write=deferred<{ok:boolean;path:string;dirty:boolean}>(),entered=deferred<void>();await bootApp({...f.overrides,probeToolSave:async()=>({current:true,revision:'main:1',dirty:true}),saveToolToPath:()=>{entered.done();return write.promise}});f.send();await entered.promise;act(()=>f.opened({path:'/replacement.pptx',slides:[blankSlide()],defaultFont:'Arial'}));await settle();const notes=container!.querySelector<HTMLTextAreaElement>('.notes-pane textarea')!;typeNotes(notes,'replacement draft');write.done({ok:true,path:'/old.pptx',dirty:false});await settle();expect(f.results.at(-1)?.clean).toBe(false);expect(slidesRecoveryClient()!.hasPending()).toBe(true);expect(notes.value).toBe('replacement draft')})
})

describe('actual Slides automatic timer and blur during close',()=>{
 it('does not publish a delayed automatic dirty response behind a newly held close, then retries after cancel',async()=>{
  const f=closeFixture(),dirty=deferred<boolean>(),save=vi.fn(async()=>({ok:true,path:'/deck.pptx',dirty:false,slides:[blankSlide()]}));let automatic=false,delayed=true
  const interval=vi.spyOn(window,'setInterval')
  try{
   await bootApp({...f.overrides,newBlank:async()=>({path:'/deck.pptx',slides:[blankSlide()],defaultFont:'Arial'}),getAutoSaveDefault:async()=>({on:true,updatedAt:7}),save,isDirty:()=>automatic?(delayed?dirty.promise:Promise.resolve(true)):Promise.resolve(false)})
   automatic=true;act(()=>window.dispatchEvent(new Event('blur')));const request=f.send();await settle();expect(slidesAuthored()!.barrier.locked).toBe(true)
   dirty.done(true);await settle();expect(save).not.toHaveBeenCalled();expect(f.overrides.cancelCloseLease).not.toHaveBeenCalled()
   const callback=interval.mock.calls.filter(call=>call[1]===30_000).at(-1)?.[0];expect(callback).toBeTypeOf('function');act(()=>{(callback as ()=>void)();window.dispatchEvent(new Event('blur'))});await settle();expect(save).not.toHaveBeenCalled();expect(slidesAuthored()!.barrier.locked).toBe(true)
   f.release(request.closeLease!);await settle();delayed=false;act(()=>window.dispatchEvent(new Event('blur')));await settle();expect(save).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledWith(true)
  }finally{interval.mockRestore()}
 })
})
