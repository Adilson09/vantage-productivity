// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { rootCloseAdapter, type NativeCloseReceipt } from '../src/main/root-close-adapters'

type Receipt = { phase: 'prepared' | 'ready'; nonce: symbol }
const owner = {} as WebContents,
  parent = {} as BrowserWindow
function fixture() {
  const prepared: Receipt = { phase: 'prepared', nonce: Symbol('leaf grant') }
  const sealed: Receipt = { phase: 'ready', nonce: prepared.nonce }
  const leaf = {
    prepare: vi.fn(async (): Promise<Receipt | null> => prepared),
    isPrepared: vi.fn((_owner: WebContents, receipt: Receipt) => receipt === prepared),
    seal: vi.fn((_owner: WebContents, receipt: Receipt): Receipt | null =>
      receipt === prepared ? sealed : null,
    ),
    complete: vi.fn(
      (_owner: WebContents, receipt: Receipt, remove: () => boolean) =>
        receipt === sealed && remove(),
    ),
    cancel: vi.fn((_owner: WebContents, _receipt: Receipt, _reason: string) => {}),
  }
  return { prepared, sealed, leaf, adapter: rootCloseAdapter(leaf) }
}

describe('Root typed leaf receipt routing', () => {
  it('passes the exact prepared and fresh sealed objects back to their issuing leaf', async () => {
    const f = fixture(),
      receipt = await f.adapter.prepare(owner, parent, { deferSeal: true })
    expect(receipt).toBe(f.prepared)
    expect(f.adapter.isPrepared(owner, receipt!)).toBe(true)
    const sealed = f.adapter.seal(owner, receipt!)
    expect(sealed).toBe(f.sealed)
    const remove = vi.fn(() => true)
    expect(f.adapter.complete(owner, sealed!, remove)).toBe(true)
    expect(f.leaf.complete).toHaveBeenCalledWith(owner, f.sealed, remove)
    expect(remove).toHaveBeenCalledOnce()
  })
  it('refuses copied phase data without invoking leaf authority or removal', async () => {
    const f = fixture()
    await f.adapter.prepare(owner, parent, {})
    const copy: NativeCloseReceipt = { ...f.prepared },
      remove = vi.fn(() => true)
    expect(f.adapter.isPrepared(owner, copy)).toBe(false)
    expect(f.adapter.seal(owner, copy)).toBeNull()
    expect(f.adapter.complete(owner, copy, remove)).toBe(false)
    f.adapter.cancel(owner, copy, 'copied receipt')
    expect(f.leaf.isPrepared).not.toHaveBeenCalled()
    expect(f.leaf.seal).not.toHaveBeenCalled()
    expect(f.leaf.complete).not.toHaveBeenCalled()
    expect(f.leaf.cancel).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
  it('keeps identical phase shapes from another editor outside the receiving adapter', async () => {
    const a = fixture(),
      b = fixture()
    const receipt = await a.adapter.prepare(owner, parent, {})
    await b.adapter.prepare(owner, parent, {})
    expect(b.adapter.isPrepared(owner, receipt!)).toBe(false)
    expect(b.adapter.seal(owner, receipt!)).toBeNull()
    expect(b.leaf.isPrepared).not.toHaveBeenCalled()
    expect(b.leaf.seal).not.toHaveBeenCalled()
  })
  it('retains cancellation of the original object after a ready successor was issued', async () => {
    const f = fixture(),
      receipt = await f.adapter.prepare(owner, parent, {})
    f.adapter.seal(owner, receipt!)
    f.adapter.cancel(owner, receipt!, 'group veto')
    expect(f.leaf.cancel).toHaveBeenCalledWith(owner, f.prepared, 'group veto')
  })
})
