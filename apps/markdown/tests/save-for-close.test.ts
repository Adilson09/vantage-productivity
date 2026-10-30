import { describe, expect, it, vi } from 'vitest'
import { saveMarkdownForClose } from '../src/renderer/save-for-close'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Markdown Close with Save', () => {
  it(
    'persists newer typing after an older revision was successfully published',
    async () => {
      const written: string[] = []
      const gate = deferred(), entered = deferred()
      let text = 'revision A', dirty = true
      const save = vi.fn(async () => {
        const snapshot = text
        if (save.mock.calls.length === 1) { entered.resolve(); await gate.promise }
        written.push(snapshot)
        dirty = text !== snapshot
        return true
      })
      const close = saveMarkdownForClose({
        waitUntilIdle: async () => {},
        isCurrent: () => true,
        flushPending: () => {},
        canClose: () => !dirty,
        save,
      })
      await entered.promise
      text = 'revision B'
      gate.resolve()
      await expect(close).resolves.toBe(true)
      expect(written).toEqual(['revision A', 'revision B'])
      expect(dirty).toBe(false)
    },
  )

  it('keeps the document open when typing never converges, despite successful publications', async () => {
    const save = vi.fn(async () => true)
    await expect(saveMarkdownForClose({
      waitUntilIdle: async () => {}, isCurrent: () => true,
      flushPending: () => {}, canClose: () => false, save,
    })).resolves.toBe(false)
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('flushes a raw-source draft arriving during the write before deciding to close', async () => {
    let pending: string | null = null, dirty = true, text = 'original'
    const written: string[] = []
    const save = vi.fn(async () => {
      written.push(text)
      dirty = false
      if (save.mock.calls.length === 1) pending = 'new raw syntax with an equal visual projection'
      return true
    })
    await expect(saveMarkdownForClose({
      waitUntilIdle: async () => {}, isCurrent: () => true,
      flushPending: () => {
        if (pending === null) return
        text = pending; pending = null; dirty = true
      },
      canClose: () => !dirty && pending === null, save,
    })).resolves.toBe(true)
    expect(written).toEqual(['original', 'new raw syntax with an equal visual projection'])
  })

  it('waits for autosave, then rechecks dirty state without starting an overlapping write', async () => {
    const gate = deferred(), save = vi.fn(async () => true)
    let dirty = true
    const close = saveMarkdownForClose({
      waitUntilIdle: () => gate.promise, isCurrent: () => true,
      flushPending: () => {}, canClose: () => !dirty, save,
    })
    expect(save).not.toHaveBeenCalled()
    dirty = false; gate.resolve()
    await expect(close).resolves.toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('does not close or save a replacement source after an obsolete publication succeeds', async () => {
    const gate = deferred(), entered = deferred()
    let current = true
    const save = vi.fn(async () => { entered.resolve(); await gate.promise; return true })
    const close = saveMarkdownForClose({
      waitUntilIdle: async () => {}, isCurrent: () => current,
      flushPending: () => {}, canClose: () => false, save,
    })
    await entered.promise
    current = false; gate.resolve()
    await expect(close).resolves.toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps the document open on an actual write failure', async () => {
    const save = vi.fn(async () => false)
    await expect(saveMarkdownForClose({
      waitUntilIdle: async () => {}, isCurrent: () => true,
      flushPending: () => {}, canClose: () => false, save,
    })).resolves.toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
