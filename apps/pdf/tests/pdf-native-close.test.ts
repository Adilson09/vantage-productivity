// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { NativeCloseAdmission } from '@vantage/electron-utils/native-close-admission'
import { preparePdfNativeCloseFlow } from '../src/main/pdf-native-close'
import type { PdfCloseOptions } from '../src/main/pdf-close'
import type { PdfCloseReceipt, PdfCloseState } from '../src/shared/pdf-workspace'

const deferred = <Value,>() => { let resolve!: (value: Value) => void; const promise = new Promise<Value>(done => { resolve = done }); return { promise, resolve } }
const stamp = { source: 'renderer-A', revision: '3' }
function fixture() {
  let source = 'main-A', current = true, alive = true
  const admission = new NativeCloseAdmission<string>()
  const prepared: PdfCloseReceipt = { phase: 'prepared', ticket: { id: 'native-test', source: 'main-A', sequence: 1 }, stamp, intent: 'save' }
  const query = vi.fn(async (_options: PdfCloseOptions): Promise<PdfCloseState> => ({ stamp, pending: true, busy: false }))
  const prompt = vi.fn(async () => 0), prepare = vi.fn(async (intent: PdfCloseReceipt['intent'], _stamp: PdfCloseState['stamp'], options: PdfCloseOptions): Promise<PdfCloseReceipt> => ({ ...prepared, intent, phase: options.deferSeal ? 'prepared' : 'ready' })), cancel = vi.fn()
  return { dependencies: { alive: () => alive, source: () => source, hold: () => admission.hold(1, 'source-A'), query, prompt, prepare, cancel }, prepared, admission,
    current: () => current, obsolete: () => { current = false }, replace: () => { source = 'main-B' }, destroy: () => { alive = false } }
}
describe('actual PDF native query/prompt orchestration', () => {
  it('blocks automatic publication through a real unresolved dialog, then allows later retries', async () => {
    const f = fixture(), entered = deferred<void>(), choice = deferred<number>()
    f.dependencies.prompt.mockImplementation(async () => { entered.resolve(); return choice.promise })
    const closing = preparePdfNativeCloseFlow(f.dependencies)
    await entered.promise
    expect(f.admission.write('source-A', true)).toBeNull()
    choice.resolve(2); expect(await closing).toBeNull()
    const release = f.admission.write('source-A', true)
    expect(release).not.toBeNull(); release!()
  })
  it('an explicit manual Save invalidates an old prompt without waiting for that OS dialog', async () => {
    const f = fixture(), entered = deferred<void>(), choice = deferred<number>()
    f.dependencies.prompt.mockImplementation(async () => { entered.resolve(); return choice.promise })
    const closing = preparePdfNativeCloseFlow(f.dependencies), rejected = expect(closing).rejects.toThrow(/No late Save/)
    await entered.promise
    const release = f.admission.write('source-A', false)
    expect(release).not.toBeNull(); release!()
    expect(f.admission.write('source-A', true)).toBeNull() // unresolved stale dialog still owned
    choice.resolve(0); await rejected
    expect(f.dependencies.prepare).not.toHaveBeenCalled()
    const retry = f.admission.write('source-A', true); expect(retry).not.toBeNull(); retry!()
  })
  it('the exact correlated close Save can settle while holding its own prompt admission', async () => {
    const f = fixture()
    f.dependencies.prepare.mockImplementation(async (intent, _stamp, options) => {
      const release = f.admission.write('source-A', false, 1)
      expect(release).not.toBeNull(); expect(options.isCurrent?.()).toBe(true)
      release!()
      return { ...f.prepared, intent, phase: 'prepared' }
    })
    const receipt = await preparePdfNativeCloseFlow(f.dependencies, { deferSeal: true })
    expect(receipt?.phase).toBe('prepared')
    const retainedOptions = f.dependencies.prepare.mock.calls[0]?.[2]
    expect(retainedOptions?.isCurrent?.()).toBe(true) // transfer survives finally-release
  })
  it('does not query or prompt while an actual writer remains unsettled', async () => {
    const f = fixture(), release = f.admission.write('source-A', false)!
    await expect(preparePdfNativeCloseFlow(f.dependencies)).rejects.toThrow(/writer or close prompt/)
    expect(f.dependencies.query).not.toHaveBeenCalled(); expect(f.dependencies.prompt).not.toHaveBeenCalled()
    release()
    expect((await preparePdfNativeCloseFlow(f.dependencies))?.phase).toBe('ready')
  })
  it.each(['group cancellation', 'source replacement', 'signal abort'])('late Save choice after %s cannot dispatch Save/discard/custody', async change => {
    const f = fixture(), entered = deferred<void>(), choice = deferred<number>(), signal = new AbortController()
    f.dependencies.prompt.mockImplementation(async () => { entered.resolve(); return choice.promise })
    const closing = preparePdfNativeCloseFlow(f.dependencies, { deferSeal: true, signal: signal.signal, isCurrent: f.current })
    const rejected = expect(closing).rejects.toThrow(/No late Save or Discard/)
    await entered.promise
    if (change === 'group cancellation') f.obsolete()
    if (change === 'source replacement') f.replace()
    if (change === 'signal abort') signal.abort()
    choice.resolve(0); await rejected
    expect(f.dependencies.prepare).not.toHaveBeenCalled()
  })
  it('a canceled query never opens a prompt or starts a Save', async () => {
    const f = fixture(), response = deferred<PdfCloseState>()
    f.dependencies.query.mockImplementation(() => response.promise)
    const closing = preparePdfNativeCloseFlow(f.dependencies, { isCurrent: f.current }), rejected = expect(closing).rejects.toThrow(/No late Save/)
    f.obsolete(); response.resolve({ stamp, pending: true, busy: false }); await rejected
    expect(f.dependencies.prompt).not.toHaveBeenCalled(); expect(f.dependencies.prepare).not.toHaveBeenCalled()
  })
  it('a late Discard choice also refuses before admission when the source changes', async () => {
    const f = fixture(), entered = deferred<void>(), choice = deferred<number>()
    f.dependencies.prompt.mockImplementation(async () => { entered.resolve(); return choice.promise })
    const closing = preparePdfNativeCloseFlow(f.dependencies), rejected = expect(closing).rejects.toThrow(/No late Save or Discard/)
    await entered.promise; f.replace(); choice.resolve(1); await rejected
    expect(f.dependencies.prepare).not.toHaveBeenCalled()
  })
  it('supports clean/default-ready and explicit deferred preparations without widening authority', async () => {
    const clean = fixture(); clean.dependencies.query.mockResolvedValue({ stamp, pending: false, busy: false })
    expect((await preparePdfNativeCloseFlow(clean.dependencies))?.phase).toBe('ready')
    expect(clean.dependencies.prompt).not.toHaveBeenCalled()
    expect(clean.dependencies.prepare.mock.calls[0]?.[0]).toBe('clean')
    const group = fixture(), result = await preparePdfNativeCloseFlow(group.dependencies, { deferSeal: true, isCurrent: group.current })
    expect(result?.phase).toBe('prepared')
    expect(group.dependencies.prepare.mock.calls[0]?.[2].deferSeal).toBe(true)
  })
  it('cancels its own returned receipt if the group changes during actual preparation', async () => {
    const f = fixture(), entered = deferred<void>(), result = deferred<PdfCloseReceipt>()
    f.dependencies.prepare.mockImplementation(async () => { entered.resolve(); return result.promise })
    const closing = preparePdfNativeCloseFlow(f.dependencies, { deferSeal: true, isCurrent: f.current }), rejected = expect(closing).rejects.toThrow(/no longer current/)
    await entered.promise; f.obsolete(); result.resolve(f.prepared); await rejected
    expect(f.dependencies.cancel).toHaveBeenCalledWith(f.prepared, expect.any(String))
  })
  it('refuses a ready receipt returned to a deferred preparation without widening its phase', async () => {
    const f = fixture(), ready: PdfCloseReceipt = { ...f.prepared, phase: 'ready' }
    f.dependencies.prepare.mockResolvedValue(ready)
    await expect(preparePdfNativeCloseFlow(f.dependencies, { deferSeal: true })).rejects.toThrow(/phase was invalid/)
    expect(f.dependencies.cancel).toHaveBeenCalledWith(ready, expect.any(String))
  })
})
