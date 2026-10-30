// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { RenderSlide } from '@vantage/pptx-render'
import type { ActionCtx } from '../src/renderer/action-context'
import type { SlidesApi } from '../src/shared/ipc'
import { exportImages, exportPdf } from '../src/renderer/file-actions'
import { insertSlideZooms } from '../src/renderer/zoom-actions'
import { SlidesAuthoredRuntime, configureSlidesAuthored } from '../src/renderer/slides-authored'
import { captureSlidesHistoryBatches } from '../src/renderer/slides-history-batch'
import { renderSlidesToPngBase64 } from '../src/renderer/export-render'
import { renderSlidesToPdfPages } from '../src/renderer/export-pages'
vi.mock('../src/renderer/export-render', () => ({ renderSlidesToPngBase64: vi.fn() }))
vi.mock('../src/renderer/export-pages', () => ({ renderSlidesToPdfPages: vi.fn() }))
vi.mock('../src/renderer/i18n/locale', () => ({ t: (key: string) => key }))
vi.mock('../src/renderer/components/toast-bus', () => ({ showToast: vi.fn() }))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const slide: RenderSlide = {
  widthPx: 1280,
  heightPx: 720,
  scale: 1,
  background: { kind: 'none' },
  nodes: [],
}
function fixture(methods: Partial<SlidesApi>) {
  const runtime = new SlidesAuthoredRuntime(
      { claimCloseLease: async () => false, cancelCloseLease: async () => {} },
      vi.fn(),
    ),
    scope = runtime.scope()
  configureSlidesAuthored(runtime)
  // This local fixture implements only requested action seams. Unexpected API
  // or context reads throw, rather than silently supplying successful defaults.
  const api = new Proxy(methods as SlidesApi, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (value === undefined) throw new Error(`Unexpected fixture API ${String(key)}`)
      return value
    },
  })
  const values: Pick<
    ActionCtx,
    | 'api'
    | 'closeScope'
    | 'historyBatches'
    | 'path'
    | 'slides'
    | 'slide'
    | 'current'
    | 'images'
    | 'sections'
    | 'layouts'
    | 'applySlide'
    | 'setSelectedIds'
    | 'setStatus'
  > = {
    api: runtime.bindApi(api, scope),
    closeScope: scope,
    historyBatches:
      methods.beginOwnedHistoryBatch && methods.finishOwnedHistoryBatch
        ? captureSlidesHistoryBatches(api, runtime, scope)
        : undefined,
    path: '/selected/deck.pptx',
    slides: [slide, { ...slide, partPath: 'ppt/slides/slide2.xml' }],
    slide,
    current: 0,
    images: new Map<string, HTMLImageElement>(),
    sections: [],
    layouts: [],
    applySlide: vi.fn(),
    setSelectedIds: vi.fn(),
    setStatus: vi.fn(),
  }
  const ctx = new Proxy(values as ActionCtx, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (value === undefined) throw new Error(`Unexpected fixture context ${String(key)}`)
      return value
    },
  })
  vi.stubGlobal('window', {
    slidesApi: new Proxy(
      {},
      {
        get() {
          throw new Error('Global API bypassed captured source ownership')
        },
      },
    ),
  })
  return { ctx, runtime, values }
}
afterEach(() => {
  configureSlidesAuthored(null)
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})
it('public image export uses the captured API and preserves the picker nonce through rendered publication', async () => {
  const pick = vi.fn<SlidesApi['pickExportDir']>(async () => ({
      path: '/chosen/images',
      selectionId: 'image-receipt',
    })),
    publish = vi.fn<SlidesApi['exportImages']>(async () => ({
      ok: true,
      paths: ['/chosen/images/deck-01.png', '/chosen/images/deck-02.png'],
    })),
    f = fixture({ pickExportDir: pick, exportImages: publish })
  vi.mocked(renderSlidesToPngBase64).mockResolvedValue(['png-one', 'png-two'])
  await exportImages(f.ctx)
  expect(pick).toHaveBeenCalledWith({ baseName: 'deck', count: 2 })
  expect(publish).toHaveBeenCalledWith({
    dir: '/chosen/images',
    baseName: 'deck',
    selectionId: 'image-receipt',
    pngsBase64: ['png-one', 'png-two'],
  })
  expect(f.values.setStatus).toHaveBeenLastCalledWith('appExportImagesDone')
  expect(f.runtime.busy).toBe(false)
})
it('public PDF export keeps the exact selected receipt through page rendering and link collection', async () => {
  const pick = vi.fn<SlidesApi['pickExportPdfPath']>(async () => ({
      path: '/chosen/deck.pdf',
      selectionId: 'pdf-receipt',
    })),
    publish = vi.fn<SlidesApi['exportPdf']>(async (op) => ({ ok: true, path: op.filePath })),
    f = fixture({
      pickExportPdfPath: pick,
      exportPdf: publish,
      getSlideLinks: async () => [],
      getRunLinks: async () => [],
    })
  vi.mocked(renderSlidesToPdfPages).mockResolvedValue({
    pages: [{ svg: '<svg/>' }, { png: 'fallback' }],
    fontCss: 'captured fonts',
  })
  expect(await exportPdf(f.ctx)).toBe(true)
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({
      filePath: '/chosen/deck.pdf',
      selectionId: 'pdf-receipt',
      pages: [{ svg: '<svg/>' }, { png: 'fallback' }],
      fontCss: 'captured fonts',
    }),
  )
  expect(f.runtime.busy).toBe(false)
})
it('a retired picker continuation never renders or publishes using a newer source', async () => {
  const picked = deferred<{ path: string; selectionId: string } | null>(),
    entered = deferred<void>(),
    publish = vi.fn<SlidesApi['exportImages']>(async () => ({ ok: true })),
    f = fixture({
      pickExportDir: () => {
        entered.resolve()
        return picked.promise
      },
      exportImages: publish,
    })
  const action = exportImages(f.ctx),
    failure = expect(action).rejects.toThrow('retired presentation')
  await entered.promise
  f.runtime.adopt()
  picked.resolve({ path: '/chosen/images', selectionId: 'old-receipt' })
  await failure
  expect(renderSlidesToPngBase64).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})
it('public Slide Zoom inserts and links its rendered target within one captured history batch', async () => {
  const begin = vi.fn<SlidesApi['beginOwnedHistoryBatch']>(async () => ({
      nonce: '12345678-1234-4234-8234-123456789abc',
    })),
    end = vi.fn<SlidesApi['finishOwnedHistoryBatch']>(async () => 1),
    add = vi.fn<SlidesApi['addImageBytes']>(async () => ({ slide, sourceId: 'zoom-picture' })),
    link = vi.fn<SlidesApi['setLink']>(async () => slide),
    f = fixture({
      beginOwnedHistoryBatch: begin,
      finishOwnedHistoryBatch: end,
      addImageBytes: add,
      setLink: link,
    })
  vi.mocked(renderSlidesToPngBase64).mockResolvedValue(['target-png'])
  await insertSlideZooms(f.ctx, [1])
  expect(begin).toHaveBeenCalledOnce()
  expect(renderSlidesToPngBase64).toHaveBeenCalledWith([f.values.slides[1]], f.values.images, 1)
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({ slideIndex: 0, base64: 'target-png', name: 'Slide Zoom 2' }),
  )
  expect(link).toHaveBeenCalledWith({
    slideIndex: 0,
    sourceId: 'zoom-picture',
    target: { kind: 'slide', slideIndex: 1 },
  })
  expect(end).toHaveBeenCalledOnce()
  expect(f.values.applySlide).toHaveBeenCalledWith(0, slide)
  expect(f.values.setSelectedIds).toHaveBeenCalledWith(['zoom-picture'])
  expect(f.runtime.busy).toBe(false)
})
it('a failed public Zoom render still closes the captured history batch and owns its rejection', async () => {
  const end = vi.fn<SlidesApi['finishOwnedHistoryBatch']>(async () => 1),
    add = vi.fn<SlidesApi['addImageBytes']>(async () => null),
    f = fixture({
      beginOwnedHistoryBatch: async () => ({ nonce: '12345678-1234-4234-8234-123456789abc' }),
      finishOwnedHistoryBatch: end,
      addImageBytes: add,
    })
  vi.mocked(renderSlidesToPngBase64).mockRejectedValue(new Error('actual bitmap failed'))
  await expect(insertSlideZooms(f.ctx, [1])).rejects.toThrow('actual bitmap failed')
  expect(end).toHaveBeenCalledOnce()
  expect(add).not.toHaveBeenCalled()
  expect(f.values.applySlide).not.toHaveBeenCalled()
  expect(f.runtime.busy).toBe(false)
})
it('a retired Zoom render cannot insert a tile or apply its late result to the replacement source', async () => {
  const rendered = deferred<string[]>(),
    entered = deferred<void>(),
    end = vi.fn<SlidesApi['finishOwnedHistoryBatch']>(async () => 1),
    add = vi.fn<SlidesApi['addImageBytes']>(async () => null),
    f = fixture({
      beginOwnedHistoryBatch: async () => ({ nonce: '12345678-1234-4234-8234-123456789abc' }),
      finishOwnedHistoryBatch: end,
      addImageBytes: add,
    })
  vi.mocked(renderSlidesToPngBase64).mockImplementation(() => {
    entered.resolve()
    return rendered.promise
  })
  const action = insertSlideZooms(f.ctx, [1]),
    failure = expect(action).rejects.toThrow('retired presentation')
  await entered.promise
  expect(f.runtime.busy).toBe(true)
  f.runtime.adopt()
  rendered.resolve(['old PNG'])
  await failure
  expect(end).toHaveBeenCalledWith({ nonce: '12345678-1234-4234-8234-123456789abc' })
  expect(add).not.toHaveBeenCalled()
  expect(f.values.applySlide).not.toHaveBeenCalled()
  expect(f.values.setSelectedIds).not.toHaveBeenCalled()
})
it('canceling pending callbacks on the same source still sends only the owned Zoom cleanup capability', async () => {
  const rendered = deferred<string[]>(),
    entered = deferred<void>(),
    end = vi.fn<SlidesApi['finishOwnedHistoryBatch']>(async () => 1),
    add = vi.fn<SlidesApi['addImageBytes']>(async () => null),
    f = fixture({
      beginOwnedHistoryBatch: async () => ({ nonce: '12345678-1234-4234-8234-123456789abc' }),
      finishOwnedHistoryBatch: end,
      addImageBytes: add,
    })
  vi.mocked(renderSlidesToPngBase64).mockImplementation(() => {
    entered.resolve()
    return rendered.promise
  })
  const source = f.runtime.source(),
    action = insertSlideZooms(f.ctx, [1]),
    failure = expect(action).rejects.toThrow('retired presentation')
  await entered.promise
  f.runtime.cancelPending()
  expect(f.runtime.source()).toBe(source)
  rendered.resolve(['canceled PNG'])
  await failure
  expect(end).toHaveBeenCalledOnce()
  expect(end).toHaveBeenCalledWith({ nonce: '12345678-1234-4234-8234-123456789abc' })
  expect(add).not.toHaveBeenCalled()
  expect(f.values.applySlide).not.toHaveBeenCalled()
})
it('heterogeneous canonical cells keep stable typed setters and exact once functional updates', () => {
  const f = fixture({}),
    count = f.runtime.cell('test-count', () => 1),
    name = f.runtime.cell('test-name', () => 'original'),
    update = vi.fn((prior: number) => prior + 1)
  count.set(update)
  name.set('changed')
  expect(update).toHaveBeenCalledOnce()
  expect(count.getSnapshot()).toBe(2)
  expect(f.runtime.read<number>('test-count')).toBe(2)
  expect(name.getSnapshot()).toBe('changed')
  expect(f.runtime.cell('test-count', () => 999)).toBe(count)
})
