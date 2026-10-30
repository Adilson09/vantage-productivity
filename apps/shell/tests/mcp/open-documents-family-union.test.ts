// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { OpenDocumentTab } from '../../src/shared/tabs-api'
import { rootQuitIntent } from '../../src/main/root-quit-intent'
import { createOpenDocumentsControl, type OpenDocumentsBridgeDeps } from '../../src/main/mcp/open-documents-bridge'
import { createOpenDocumentTools, type OpenDocumentCleanup } from '../../src/main/mcp/tools/open-documents-tools'

vi.mock('../../../../packages/electron-utils/src/close-cleanup-runtime', () => ({ awaitCloseCleanup: vi.fn(async () => undefined) }))
const releases: Array<() => void> = []
afterEach(() => { for (const release of releases.splice(0)) release(); vi.restoreAllMocks() })
const kinds = ['docs', 'sheets', 'slides', 'markdown', 'html', 'pdf'] as const
function fixture(kind: typeof kinds[number]) {
  const document = { id: 'open-A', kind, title: 'A', filePath: 'C:/files/A.' + kind, dirty: true, active: true } as OpenDocumentTab
  const owner = { id: 7, isDestroyed: () => false } as WebContents
  let current = owner
  const remove = vi.fn(() => true)
  const deps: OpenDocumentsBridgeDeps = { list: async () => [document], webContentsFor: () => current, closeTab: remove, defaultSaveDir: () => 'C:/files' }
  return { document, owner, remove, deps, replace() { current = { id: 8, isDestroyed: () => false } as WebContents } }
}
function lateClose(f: ReturnType<typeof fixture>, during: () => void) {
  const cancel = vi.fn(async () => {})
  const receipt = { phase: 'ready', requestId: 'held-A', published: false, current: true, clean: true } as never
  if (f.document.kind === 'docs') f.deps.docs = {
    prepareDiscardClose: async () => { during(); return receipt },
    completeSaveClose: (_id, _receipt, remove) => remove(), cancelSaveClose: cancel,
  } as OpenDocumentsBridgeDeps['docs']
  else if (f.document.kind === 'slides') f.deps.slides = {
    prepareClose: async () => { during(); return receipt },
    completeClose: (_id, _receipt, remove) => remove(), cancelClose: cancel,
  } as OpenDocumentsBridgeDeps['slides']
  else if (f.document.kind === 'pdf') f.deps.pdf = {
    prepareClose: async () => { during(); return receipt },
    completeClose: (_owner, _receipt, remove) => remove(), cancelClose: cancel,
    cleanup: vi.fn(async () => undefined),
  }
  else if (f.document.kind === 'markdown' || f.document.kind === 'html') f.deps[f.document.kind] = {
    read: async () => '', save: vi.fn(async () => {}), discard: vi.fn(async () => {}),
    prepareClose: async () => { during(); return receipt },
    completeClose: (_owner, _receipt, remove) => remove(), cancelClose: cancel,
  }
  return cancel
}

describe('all-family close integration', () => {
  it.each(kinds)('keeps %s open when its family close authority is missing', async kind => {
    const f = fixture(kind)
    await expect(createOpenDocumentsControl(f.deps).close(f.document, { unsaved: 'discard' })).rejects.toThrow(/unavailable/)
    expect(f.remove).not.toHaveBeenCalled()
  })
  it.each(['docs', 'slides', 'markdown', 'html', 'pdf'] as const)('never removes a replacement %s owner after preparation', async kind => {
    const f = fixture(kind), cancel = lateClose(f, () => f.replace())
    await expect(createOpenDocumentsControl(f.deps).close(f.document, { unsaved: 'discard' })).rejects.toThrow(/removal|permission|changed|lease/)
    expect(f.remove).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(['docs', 'slides', 'markdown', 'html', 'pdf'] as const)('keeps %s open when a physical move starts before actual removal', async kind => {
    const f = fixture(kind), cancel = lateClose(f, () => { releases.push(rootQuitIntent.beginMutation('physical move')) })
    await expect(createOpenDocumentsControl(f.deps).close(f.document, { unsaved: 'discard' })).rejects.toThrow(/file move/)
    expect(f.remove).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('defers both Save and Close if a file move starts while the live list is being read', async () => {
    const f = fixture('sheets'), sheetsClose = vi.fn(async () => ({}))
    f.deps.sheetsClose = sheetsClose
    f.deps.list = async () => { releases.push(rootQuitIntent.beginMutation('physical move')); return [f.document] }
    await expect(createOpenDocumentsControl(f.deps).close(f.document, { unsaved: 'save' })).rejects.toThrow(/file move/)
    expect(sheetsClose).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled()
    for (const release of releases.splice(0)) release()
    await expect(createOpenDocumentsControl(f.deps).save(f.document)).rejects.toThrow(/file move/)
  })
  it('preserves the exact Sheets target and its actual cleanup status', async () => {
    const f = fixture('sheets'), status = { id: 'native-custody', phase: 'retained', custody: true }
    const sheetsClose = vi.fn(async () => ({ savedPath: f.document.filePath, cleanup: status }))
    f.deps.sheetsClose = sheetsClose
    await expect(createOpenDocumentsControl(f.deps).close(f.document, { unsaved: 'save' })).resolves.toEqual({ savedPath: f.document.filePath, cleanup: status })
    expect(sheetsClose).toHaveBeenCalledWith('open-A', { unsaved: 'save', path: f.document.filePath, overwrite: true })
    expect(f.remove).not.toHaveBeenCalled() // the injected adapter owns exact removal
  })
  it('uses the complete PDF close authority even when the badge says clean', async () => {
    const f = fixture('pdf'); f.document.dirty = false
    const cancel = lateClose(f, () => {})
    const control = createOpenDocumentsControl(f.deps)
    await expect(control.close(f.document, { unsaved: 'save' })).resolves.toEqual({})
    expect(f.remove).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
  })
  it.each([
    { id: 'native', phase: 'retained', custody: true },
    { journal: 'retained', assets: 'retained', retainedAssets: 2 },
  ] satisfies OpenDocumentCleanup[])('keeps family cleanup details in the tool response', async cleanup => {
    const f = fixture('sheets')
    const [tool] = createOpenDocumentTools({ defaultSaveDir: () => 'C:/files', control: {
      list: async () => [f.document], read: async () => ({}), save: async () => ({ savedPath: f.document.filePath! }),
      close: async () => ({ cleanupId: 'retained-copy', cleanup, assetCleanup: { assets: 'retained' }, warnings: ['Recovery copy retained.'] }),
    } })
    await expect(tool!.handler({ action: 'close', target: f.document.id, unsaved: 'discard' })).resolves.toMatchObject({
      closed: true, cleanupId: 'retained-copy', cleanup, cleanupIncomplete: true,
      assetCleanup: { assets: 'retained' }, warnings: ['Recovery copy retained.'],
    })
  })
})
