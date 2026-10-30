import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseMutationBarrier } from '../../../packages/electron-utils/src/renderer-close-barrier'
import { createWorkbookAuthoredAdmission } from '../src/renderer/workbook-authored-admission'
import { createSheetTabActions } from '../src/renderer/sheet-tab-actions'
import { handleInsertNotePicture } from '../src/renderer/note-picture-actions'
import {
  handleTableDesignCommand,
  type TableDesignContext,
} from '../src/renderer/table-design-actions'
import { createEditJournal } from '../src/renderer/edit-journal'
import type { RibbonCommandContext } from '../src/renderer/ribbon-actions'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('actual UI producer promises are retained through their final mutation', () => {
  it('sheet rename stays authored-busy through its real command Promise', async () => {
    const command = deferred<boolean>()
    const barrier = new CloseMutationBarrier({
      source: () => 'same-source',
      claim: async () => true,
      cancel: async () => {},
      report: vi.fn(),
    })
    const admission = createWorkbookAuthoredAdmission({
      barrier,
      source: () => 'same-source',
      isDerived: () => false,
      report: vi.fn(),
    })
    const actions = createSheetTabActions({
      admission,
      notify: () => {},
      lazyWorkbookRef: { current: null },
      univerRef: {
        current: { univerAPI: { executeCommand: vi.fn(() => command.promise) } } as never,
      },
    })
    const actual = actions.rename('sheet-1')
    expect(admission.busy).toBe(true)
    await expect(
      barrier.acquire({ id: 'close', sequence: 1, source: 'main-source' }, () => true),
    ).resolves.toBeNull()
    command.resolve(true)
    await actual
    expect(admission.busy).toBe(false)
  })

  it('note-picture picking completes only on a real selection/cancel event', async () => {
    let canceled!: () => void
    const input = {
      type: '',
      accept: '',
      onchange: null as (() => void) | null,
      files: [] as File[],
      addEventListener: (name: string, callback: () => void) => {
        if (name === 'cancel') canceled = callback
      },
      click: vi.fn(),
    }
    vi.stubGlobal('document', { createElement: () => input })
    const worksheet = { getSheetId: () => 'sheet-1' }
    const workbook = {
      getId: () => 'model-1',
      getActiveSheet: () => worksheet,
      getActiveRange: () => ({ getRow: () => 0, getColumn: () => 0 }),
    }
    const runtime = { univerAPI: { getActiveWorkbook: () => workbook } }
    const context = {
      univerRef: { current: runtime },
      lazyWorkbookRef: { current: {} },
      setMessage: vi.fn(),
    } as unknown as RibbonCommandContext
    let settled = false
    const actual = handleInsertNotePicture(context, runtime as never).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    canceled()
    await actual
    expect(settled).toBe(true)
  })

  it('table design does not report completion before the native table facade settles', async () => {
    const rename = deferred<boolean>(),
      renamed = vi.fn(() => rename.promise)
    const journal = createEditJournal()
    const state = {
      file: {
        sheets: [
          {
            id: 'sheet-1',
            name: 'Data',
            tables: [
              {
                name: 'Sales',
                headerRowCount: 1,
                range: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 },
              },
            ],
          },
        ],
      },
      editJournal: journal,
    }
    const worksheet = { getSheetId: () => 'sheet-1', setTableName: renamed }
    const runtime = {
      univerAPI: {
        getActiveWorkbook: () => ({
          getActiveSheet: () => worksheet,
          getActiveRange: () => ({ getRow: () => 1, getColumn: () => 0 }),
        }),
      },
    }
    const context = {
      univerRef: { current: runtime },
      lazyWorkbookRef: { current: state },
      setMessage: vi.fn(),
      setPendingEdits: vi.fn(),
      refreshSelection: vi.fn(),
    } as unknown as TableDesignContext
    let settled = false
    const actual = handleTableDesignCommand(context, 'table-rename:RenamedSales').then((value) => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(renamed).toHaveBeenCalled())
    expect(settled).toBe(false)
    rename.resolve(true)
    await expect(actual).resolves.toBe(true)
    expect(settled).toBe(true)
  })
})
