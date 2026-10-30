// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetainedRecoveryPanel } from '../src/renderer/src/RetainedRecoveryPanel'
import type { RetainedRecoveryApi, RetainedRecoveryItem } from '../src/shared/retained-recovery'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const row = (): RetainedRecoveryItem => ({ id: 'docs:one', updatedAt: '2026-10-30T07:00:00.000Z', module: 'docs', fileName: 'Report.docx', originalPath: '/documents/Report.docx', state: 'needs-review', detail: 'This recovery copy is retained.', canRestore: true, canRemove: true, canRetry: false })
let root: Root | undefined
let container: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove() })
async function mount(overrides: Partial<RetainedRecoveryApi> = {}, items = [row()]) {
  const api = { retainedRecoveryList: vi.fn(async () => ({ items, truncated: false })), recoverRetainedCopy: vi.fn(async () => ({ path: '/physical/Copy.docx', module: 'docs' })), removeRetainedCopy: vi.fn(async () => {}), retryRetainedRecovery: vi.fn(async () => {}), keepRetainedOutput: vi.fn(async () => {}), ...overrides }
  const onOpenPath = vi.fn(async () => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<RetainedRecoveryPanel api={api} onOpenPath={onOpenPath} />))
  return { api, onOpenPath }
}
const button = (name: string) => [...container.querySelectorAll('button')].find(element => element.textContent === name)!

describe('retained recovery panel', () => {
  it('ignores stale StrictMode reads after selected removal and its new refresh', async () => {
    let resolveOlder!: (value: { items: RetainedRecoveryItem[]; truncated: boolean }) => void
    const oldRead = new Promise<{ items: RetainedRecoveryItem[]; truncated: boolean }>(resolve => { resolveOlder = resolve })
    const list = vi.fn().mockReturnValueOnce(oldRead).mockResolvedValueOnce({ items: [row()], truncated: false }).mockResolvedValue({ items: [], truncated: false })
    const api = { retainedRecoveryList: list, recoverRetainedCopy: vi.fn(), removeRetainedCopy: vi.fn(async () => {}), retryRetainedRecovery: vi.fn(), keepRetainedOutput: vi.fn() }
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<StrictMode><RetainedRecoveryPanel api={api} /></StrictMode>))
    expect(list).toHaveBeenCalledTimes(2)
    await act(async () => button('Remove copy').click())
    expect(container.textContent).toContain('No copies need review.')
    await act(async () => resolveOlder({ items: [row()], truncated: false }))
    expect(container.textContent).not.toContain('Report.docx')
    expect(container.textContent).toContain('Selected recovery copy removed.')
  })

  it('saves one selected copy despite two same-turn clicks and opens only on user action', async () => {
    let resolve!: (copy: { path: string; module: string }) => void
    const recover = vi.fn(() => new Promise<{ path: string; module: string }>(done => { resolve = done }))
    const { onOpenPath } = await mount({ recoverRetainedCopy: recover })
    const recoverButton = button('Save recovered copy')
    await act(async () => { recoverButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); recoverButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith({ id: 'docs:one', updatedAt: '2026-10-30T07:00:00.000Z' })
    expect(button('Remove copy').disabled).toBe(true)
    await act(async () => resolve({ path: '/physical/Copy.docx', module: 'docs' }))
    expect(container.textContent).toContain('Recovered copy created')
    expect(onOpenPath).not.toHaveBeenCalled()
    await act(async () => button('Open recovered copy').click())
    expect(onOpenPath).toHaveBeenCalledWith('/physical/Copy.docx')
  })

  it('shows a stale-selection failure without claiming removal succeeded and refreshes', async () => {
    const remove = vi.fn(async () => { throw new Error('This recovery item changed. Refresh the list and try again.') })
    const { api } = await mount({ removeRetainedCopy: remove })
    await act(async () => button('Remove copy').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('changed')
    expect(container.textContent).not.toContain('Selected recovery copy removed.')
    expect(api.retainedRecoveryList).toHaveBeenCalledTimes(2)
  })

  it('offers only acknowledgement for an uncertain output and sends its exact identifier', async () => {
    const item = { ...row(), canRestore: false, canRemove: false, pendingOutput: { id: 'output:one', path: '/user/Needs review.docx' } }
    const { api } = await mount({}, [item])
    expect(button('Save recovered copy')).toBeUndefined()
    expect(button('Remove copy')).toBeUndefined()
    expect(container.textContent).toContain('/user/Needs review.docx')
    await act(async () => button('Keep this file').click())
    expect(api.keepRetainedOutput).toHaveBeenCalledWith({ id: item.id, updatedAt: item.updatedAt }, 'output:one')
    expect(api.removeRetainedCopy).not.toHaveBeenCalled()
  })

  it('keeps controls closed when the main display response is malformed', async () => {
    await mount({ retainedRecoveryList: vi.fn(async () => ({ items: [{ ...row(), updatedAt: 'invalid' }], truncated: false })) })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be read')
    expect(button('Remove copy')).toBeUndefined()
    expect(button('Save recovered copy')).toBeUndefined()
  })
})
