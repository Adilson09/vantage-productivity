import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('../../../packages/electron-utils/src/close-cleanup-runtime', () => ({
  awaitCloseCleanup: vi.fn(async (id: string) => ({
    id,
    phase: 'retained',
    error: 'cleanup needs review',
  })),
}))
import { createOpenDocumentsControl } from '../src/main/mcp/open-documents-bridge'
import type { OpenDocumentTab } from '../src/shared/tabs-api'
import type {
  SlidesToolSaveCompletion,
  SlidesCloseIntent,
} from '../../slides/src/shared/slides-tool-save'
function fixture(dirty = false) {
  const owner = { id: 7, isDestroyed: () => false }
  let currentOwner = owner
  const path = join(tmpdir(), 'slides-close.pptx'),
    tab: OpenDocumentTab = {
      id: 't7',
      kind: 'slides',
      title: 'Slides',
      filePath: path,
      active: true,
      dirty,
    },
    remove = vi.fn(() => true),
    cancel = vi.fn(async () => {}),
    receipt: SlidesToolSaveCompletion = {
      path,
      requestId: 'request',
      sourceToken: 'token',
      published: false,
      current: true,
      clean: true,
      revision: 'main:1',
      cleanupId: 'cleanup',
      closeLease: { id: 'request', sequence: 1, source: 'A' },
    }
  const prepare = vi.fn(
      async (_owner: number, _path: string | undefined, intent: SlidesCloseIntent) => ({
        ...receipt,
        intent,
      }),
    ),
    complete = vi.fn((_owner: number, _receipt: SlidesToolSaveCompletion, actual: () => boolean) =>
      actual(),
    ),
    legacyDiscard = vi.fn()
  const control = createOpenDocumentsControl({
    list: async () => [tab],
    webContentsFor: () => currentOwner as never,
    closeTab: remove,
    defaultSaveDir: () => tmpdir(),
    slidesDiscard: legacyDiscard,
    slides: {
      openBlankTab: async () => 7,
      runTxn: async () => ({}),
      readDeck: async () => ({}),
      saveDeck: async () => receipt,
      prepareClose: prepare,
      completeClose: complete,
      cancelClose: cancel,
    },
  })
  return {
    control,
    tab,
    path,
    receipt,
    prepare,
    complete,
    cancel,
    remove,
    legacyDiscard,
    replaceOwner: () => {
      currentOwner = { id: 8, isDestroyed: () => false }
    },
  }
}
describe('actual common MCP Slides family composition', () => {
  it('consults renderer protection even when main list dirty=false', async () => {
    const f = fixture()
    await f.control.close(f.tab, { unsaved: 'save' })
    expect(f.prepare).toHaveBeenCalledWith(7, f.path, 'save')
    expect(f.complete).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ requestId: 'request' }),
      expect.any(Function),
    )
    expect(f.remove).toHaveBeenCalledOnce()
    expect(f.cancel).toHaveBeenCalledOnce()
  })
  it('Discard uses captured two-phase cleanup and never the eager legacy delete hook', async () => {
    const f = fixture(true)
    const result = await f.control.close(f.tab, { unsaved: 'discard' })
    expect(f.prepare).toHaveBeenCalledWith(7, f.path, 'discard')
    expect(f.legacyDiscard).not.toHaveBeenCalled()
    expect(result).toMatchObject({ cleanupId: 'cleanup', cleanup: { phase: 'retained' } })
  })
  it('physical save alone cannot authorize removal before the final renderer permission', async () => {
    const f = fixture(true)
    let ready!: (value: SlidesToolSaveCompletion) => void
    const pending = new Promise<SlidesToolSaveCompletion>((resolve) => {
      ready = resolve
    })
    f.prepare.mockImplementation(() => pending)
    const closing = f.control.close(f.tab, { unsaved: 'save' })
    await Promise.resolve()
    await Promise.resolve()
    expect(f.remove).not.toHaveBeenCalled()
    ready({ ...f.receipt, published: true })
    await expect(closing).resolves.toMatchObject({ savedPath: f.path })
    expect(f.remove).toHaveBeenCalledOnce()
  })
  it('a replacement WebContents after preparation cannot be removed through the old close receipt', async () => {
    const f = fixture()
    f.prepare.mockImplementation(async (_owner, _path, intent) => {
      f.replaceOwner()
      return { ...f.receipt, intent }
    })
    await expect(f.control.close(f.tab, { unsaved: 'discard' })).rejects.toThrow(
      'changed before actual removal',
    )
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.cancel).toHaveBeenCalledOnce()
  })
  it('a refused final source/revision commit leaves the actual tab intact and cancels custody', async () => {
    const f = fixture()
    f.complete.mockImplementation(() => false)
    await expect(f.control.close(f.tab, { unsaved: 'save' })).rejects.toThrow(
      'changed before actual removal',
    )
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.cancel).toHaveBeenCalledOnce()
  })
})
