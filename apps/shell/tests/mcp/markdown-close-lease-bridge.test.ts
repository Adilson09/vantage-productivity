import { afterEach, describe, it, expect, vi } from 'vitest'
import { resolve } from 'node:path'
import type { WebContents } from 'electron'
import type { OpenDocumentTab } from '../../src/shared/tabs-api'
import { createOpenDocumentsControl } from '../../src/main/mcp/open-documents-bridge'
import { MarkdownCloseCoordinator } from '../../../markdown/src/main/markdown-close-lease'
import type { MarkdownSaveTicket } from '../../../markdown/src/shared/ipc'
import type { MarkdownSourceState } from '../../../markdown/src/shared/markdown-close-lease'
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})
function fixture() {
  let start!: () => void
  const started = new Promise<void>((done) => {
    start = done
  })
  let request!: MarkdownSaveTicket
  const contents = { id: 7, isDestroyed: () => false } as WebContents,
    doc = {
      id: 'held',
      kind: 'markdown',
      title: 'note.ext',
      filePath: resolve('note.ext'),
      active: true,
      dirty: false,
    } as OpenDocumentTab
  const state: MarkdownSourceState = {
    stamp: { source: 'renderer:1', revision: '1' },
    path: doc.filePath!,
    ready: true,
    dirty: false,
    pending: false,
    busy: false,
    composing: false,
  }
  const coordinator = new MarkdownCloseCoordinator({
    alive: (owner) => owner === 7,
    pathAllowed: () => true,
    send: (_owner, _mode, value) => {
      request = value
      start()
    },
    release: () => {},
  })
  coordinator.open(7)
  coordinator.observe(7, state)
  cleanup.push(() => coordinator.destroy(7))
  const save = vi.fn(async () => {}),
    closeTab = vi.fn(() => true)
  const control = createOpenDocumentsControl({
    list: async () => [doc],
    webContentsFor: () => contents,
    closeTab,
    defaultSaveDir: () => resolve('.'),
    markdown: {
      read: async () => '',
      save,
      discard: async () => {},
      prepareClose: async (_contents, path, intent) => {
        const result = await coordinator.request(
          7,
          'save',
          path,
          true,
          intent,
          intent === 'discard' ? { ...state.stamp } : undefined,
        )
        if (!result.closeLease) throw new Error(result.error ?? 'not ready')
        return result
      },
      completeClose: (_contents, receipt, remove) => coordinator.complete(7, receipt, remove),
      cancelClose: async (_contents, receipt) => coordinator.cancel(7, receipt.closeLease?.ticket),
    },
  })
  const reply = (clean = true) =>
    coordinator.receive(7, {
      requestId: request.requestId,
      published: false,
      current: true,
      clean,
      closeLease: { ticket: request.closeLease!, stamp: { ...state.stamp } },
    })
  return {
    coordinator,
    contents,
    doc,
    state,
    save,
    closeTab,
    control,
    started,
    reply,
    get request() {
      return request
    },
  }
}
describe('Markdown dispatcher consumes actual main-owned close permission', () => {
  it('refuses typing after ready but before the asynchronous caller reaches actual removal', async () => {
    const f = fixture(),
      closing = f.control.close(f.doc, { unsaved: 'save' })
    await f.started
    f.reply()
    f.coordinator.observe(7, {
      ...f.state,
      dirty: true,
      stamp: { ...f.state.stamp, revision: '2' },
    })
    await expect(closing).rejects.toThrow(/remains open/i)
    expect(f.closeTab).not.toHaveBeenCalled()
  })
  it('contacts the real coordinator even for a clean mirror and closes without normal Save publication', async () => {
    const f = fixture(),
      closing = f.control.close(f.doc, { unsaved: 'save' })
    await f.started
    expect(f.closeTab).not.toHaveBeenCalled()
    f.reply()
    await expect(closing).resolves.toEqual({})
    expect(f.closeTab).toHaveBeenCalledExactlyOnceWith('held')
    expect(f.save).not.toHaveBeenCalled()
  })
  it('does not authorize a different request from an obsolete final receipt', async () => {
    const f = fixture(),
      closing = f.control.close(f.doc, { unsaved: 'save' })
    await f.started
    f.coordinator.receive(7, { requestId: 'obsolete', published: true, current: true, clean: true })
    await Promise.resolve()
    expect(f.closeTab).not.toHaveBeenCalled()
    f.reply()
    await closing
    expect(f.closeTab).toHaveBeenCalledOnce()
  })
})
