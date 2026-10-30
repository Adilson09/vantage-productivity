import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { WebContents } from 'electron'
import type { OpenDocumentTab } from '../../src/shared/tabs-api'
import { createOpenDocumentsControl } from '../../src/main/mcp/open-documents-bridge'
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(save: () => Promise<void>, discard: () => Promise<void> = async () => {}) {
  const doc = {
    id: 'html',
    kind: 'html',
    title: 'page.html',
    filePath: resolve('page.html'),
    active: true,
    dirty: false,
  } as OpenDocumentTab
  const closeTab = vi.fn(() => true),
    contents = { id: 7, isDestroyed: () => false } as WebContents
  const control = createOpenDocumentsControl({
    list: async () => [doc],
    webContentsFor: () => contents,
    closeTab,
    defaultSaveDir: () => resolve('.'),
    html: { read:async()=>'',save,discard,
      prepareClose:async(_contents,_path,intent)=>{if(intent==='discard')await discard();else await save();return {requestId:'fixture',published:intent==='save',current:true,clean:true}},
      completeClose:(_contents,_receipt,remove)=>remove(),cancelClose:async()=>{},
    },
  })
  return { doc, control, closeTab }
}
describe('HTML MCP close waits for current renderer source', () => {
  it('checks the renderer even when the mirrored list says clean and waits for final success', async () => {
    const ack = deferred<void>(),
      entered = deferred<void>(),
      save = vi.fn(() => {
        entered.resolve()
        return ack.promise
      }),
      f = fixture(save)
    const closing = f.control.close(f.doc, { unsaved: 'save' })
    await entered.promise
    expect(save).toHaveBeenCalledOnce()
    expect(f.closeTab).not.toHaveBeenCalled()
    ack.resolve()
    await closing
    expect(f.closeTab).toHaveBeenCalledExactlyOnceWith('html')
  })
  it.each(['new typing during acknowledgment', 'pending style edit', 'obsolete source activation'])(
    'refuses close after %s',
    async (reason) => {
      const ack = deferred<void>(),
        entered = deferred<void>(),
        f = fixture(() => {
          entered.resolve()
          return ack.promise
        })
      const closing = f.control.close(f.doc, { unsaved: 'save' })
      await entered.promise
      ack.reject(new Error(reason))
      await expect(closing).rejects.toThrow(reason)
      expect(f.closeTab).not.toHaveBeenCalled()
    },
  )
  it('awaits untitled HTML discard and refuses a failed recovery invalidation', async () => {
    const ack = deferred<void>(),
      entered = deferred<void>(),
      f = fixture(
        async () => {},
        () => {
          entered.resolve()
          return ack.promise
        },
      )
    delete f.doc.filePath
    const closing = f.control.close(f.doc, { unsaved: 'discard' })
    await entered.promise
    expect(f.closeTab).not.toHaveBeenCalled()
    ack.reject(new Error('recovery storage refused'))
    await expect(closing).rejects.toThrow('recovery storage refused')
    expect(f.closeTab).not.toHaveBeenCalled()
  })
})
