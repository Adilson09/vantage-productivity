/** Private source-only regressions: no browser/app/test execution has been performed. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditJournal } from '../src/renderer/edit-journal'
import { handleImportCsv, type DataToolsContext } from '../src/renderer/data-tools-actions'
import {
  handleInsertPicture,
  handleInsertPictureFile,
  startShapeDraw,
  type VisualActionContext,
} from '../src/renderer/visual-actions'
import { startSheetShapeDraw } from '../src/renderer/shape-draw'
import { drainWorkbookWork } from '../src/renderer/workbook-mutation-queue'

vi.mock('../src/renderer/shape-draw', () => ({ startSheetShapeDraw: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

class PickerInput {
  type = ''
  accept = ''
  files: readonly File[] = []
  onchange: (() => void) | null = null
  readonly click = vi.fn()
  private cancel: (() => void) | null = null
  addEventListener(name: string, listener: () => void) {
    if (name === 'cancel') this.cancel = listener
  }
  removeEventListener(name: string, listener: () => void) {
    if (name === 'cancel' && this.cancel === listener) this.cancel = null
  }
  choose(file: File) {
    this.files = [file]
    this.onchange?.()
  }
  dismiss() {
    this.cancel?.()
  }
}

function fixture() {
  vi.mocked(startSheetShapeDraw).mockClear()
  const inputs: PickerInput[] = []
  vi.stubGlobal('document', {
    createElement: () => {
      const input = new PickerInput()
      inputs.push(input)
      return input
    },
  })
  let selectedRow = 3
  let selectedColumn = 4
  const setValues = vi.fn()
  const getRange = vi.fn(() => ({ setValues }))
  const sheet = { getSheetId: () => 'sheet-1', getRange }
  const workbook = {
    getId: () => 'workbook-1',
    getActiveSheet: () => sheet,
    getActiveRange: () => ({ getRow: () => selectedRow, getColumn: () => selectedColumn }),
  }
  const runtime = { univerAPI: { getActiveWorkbook: () => workbook } }
  const state = { editJournal: createEditJournal(), file: { sessionId: 'reader-1', visuals: [] } }
  const stateRef = { current: state }
  const ctx = {
    univerRef: { current: runtime },
    lazyWorkbookRef: stateRef,
    setMessage: vi.fn(),
    setPendingEdits: vi.fn(),
  }
  return {
    inputs,
    stateRef,
    state,
    getRange,
    setValues,
    ctx,
    data: ctx as unknown as DataToolsContext,
    visual: ctx as unknown as VisualActionContext,
    moveSelection: () => {
      selectedRow = 99
      selectedColumn = 20
    },
    replaceSource: () => {
      stateRef.current = { ...state, editJournal: createEditJournal() }
    },
  }
}

afterEach(async () => {
  await drainWorkbookWork()
  vi.unstubAllGlobals()
})

describe('real picker callback producer lifetime', () => {
  it('keeps CSV import pending until a real cancel event and writes nothing', async () => {
    const f = fixture()
    let settled = false
    const work = handleImportCsv(f.data).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.inputs[0]?.click).toHaveBeenCalledOnce()
    f.inputs[0]!.dismiss()
    await work
    expect(f.setValues).not.toHaveBeenCalled()
  })

  it('keeps picture selection pending until a real cancel event', async () => {
    const f = fixture()
    let settled = false
    const work = handleInsertPicture(f.visual).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.inputs[0]!.dismiss()
    await work
    expect(f.state.editJournal.visualAdds).toEqual([])
  })

  it('refuses a picture chosen for a source that was replaced while its picker was open', async () => {
    const f = fixture()
    const work = handleInsertPicture(f.visual)
    f.replaceSource()
    f.inputs[0]!.choose({ name: 'chosen.png', type: 'image/png', size: 10 } as File)
    await expect(work).rejects.toThrow(/picture target changed/)
    expect(f.state.editJournal.visualAdds).toEqual([])
  })

  it('refuses a CSV source replacement during the actual file read', async () => {
    const f = fixture()
    const bytes = deferred<ArrayBuffer>()
    const reading = deferred<void>()
    const work = handleImportCsv(f.data)
    f.inputs[0]!.choose({
      size: 10,
      arrayBuffer: () => {
        reading.resolve()
        return bytes.promise
      },
    } as File)
    await reading.promise
    f.replaceSource()
    bytes.resolve(new TextEncoder().encode('1,2').buffer)
    await expect(work).rejects.toThrow(/CSV target changed/)
    expect(f.setValues).not.toHaveBeenCalled()
  })

  it('uses the accepted CSV anchor rather than a later programmatic selection', async () => {
    const f = fixture()
    const bytes = deferred<ArrayBuffer>()
    const reading = deferred<void>()
    const work = handleImportCsv(f.data)
    f.inputs[0]!.choose({
      size: 10,
      arrayBuffer: () => {
        reading.resolve()
        return bytes.promise
      },
    } as File)
    await reading.promise
    f.moveSelection()
    bytes.resolve(new TextEncoder().encode('1,2').buffer)
    await work
    expect(f.getRange).toHaveBeenCalledWith(3, 4, 1, 2)
    expect(f.setValues).toHaveBeenCalledWith([[{ v: 1 }, { v: 2 }]])
  })

  it('retains paste/drop picture work and checks its source after FileReader completion', async () => {
    const f = fixture()
    const reading = deferred<void>()
    let activeReader!: { result: string; onload: (() => void) | null }
    vi.stubGlobal(
      'FileReader',
      class {
        result = ''
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        onabort: (() => void) | null = null
        readAsDataURL() {
          activeReader = this
          reading.resolve()
        }
      },
    )
    const work = handleInsertPictureFile(f.visual, {
      name: 'paste.png',
      type: 'image/png',
      size: 10,
    } as File)
    await reading.promise
    f.replaceSource()
    activeReader.result = 'data:image/png;base64,AAAA'
    activeReader.onload?.()
    await expect(work).rejects.toThrow(/picture target changed/)
    expect(f.state.editJournal.visualAdds).toEqual([])
    expect(f.ctx.setMessage).toHaveBeenCalledWith(expect.stringMatching(/picture target changed/))
  })

  it('refuses a shape mouseup captured for a replaced source', () => {
    const f = fixture()
    startShapeDraw(f.visual, 'rect')
    const commit = vi.mocked(startSheetShapeDraw).mock.calls[0]![2]
    f.replaceSource()
    commit({
      fromRow: 1,
      toRow: 3,
      fromColumn: 1,
      toColumn: 4,
      fromRowOffset: 0,
      toRowOffset: 0,
      fromColumnOffset: 0,
      toColumnOffset: 0,
    })
    expect(f.state.editJournal.visualAdds).toEqual([])
    expect(f.ctx.setMessage).toHaveBeenCalledWith(
      expect.stringMatching(/shape-drawing target changed/),
    )
  })

  it('rechecks the shape source inside its admitted action after a close hold', async () => {
    const f = fixture()
    const hold = deferred<void>()
    let completion!: Promise<unknown>
    f.visual.runAuthored = (action) => {
      const work = hold.promise.then(action)
      completion = work
      return work
    }
    startShapeDraw(f.visual, 'rect')
    const commit = vi.mocked(startSheetShapeDraw).mock.calls[0]![2]
    commit({
      fromRow: 1,
      toRow: 3,
      fromColumn: 1,
      toColumn: 4,
      fromRowOffset: 0,
      toRowOffset: 0,
      fromColumnOffset: 0,
      toColumnOffset: 0,
    })
    f.replaceSource()
    hold.resolve()
    await expect(completion).rejects.toThrow(/shape-drawing target changed/)
    expect(f.state.editJournal.visualAdds).toEqual([])
    expect(f.ctx.setMessage).toHaveBeenCalledWith(
      expect.stringMatching(/shape-drawing target changed/),
    )
  })
})
