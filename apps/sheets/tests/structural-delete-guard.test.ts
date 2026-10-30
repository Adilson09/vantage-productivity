import { afterEach, describe, expect, it } from 'vitest'

import {
  structuralDeleteFormulaError,
  structuralDeleteFormulaErrorSync,
} from '../src/renderer/plan-operations'
import type { WorkbookSharedFormulaGroup } from '../src/shared/desktop-api'
import type { LazyWorkbookState } from '../src/renderer/univer-state'

/// The apply-time precheck shares the writer's A1 reference policy: deleted
/// references become #REF! and unsupported range forms still fail safely.

function state(overrides: Record<string, unknown> = {}): LazyWorkbookState {
  return {
    file: {
      sessionId: 'session-1',
      sheets: [
        { id: 'sh1', name: 'Data', rowCount: 100, columnCount: 26, pivotRanges: [] },
        { id: 'sh2', name: 'Other', rowCount: 100, columnCount: 26, pivotRanges: [] },
      ],
      visuals: [],
    },
    editJournal: {
      cells: new Map(),
      structuralOps: new Map(),
      sheets: { added: new Set(), removed: new Set() },
    },
    ...overrides,
  } as unknown as LazyWorkbookState
}

const workbook = {
  getSheets: () => [
    { getSheetId: () => 'sh1', getSheetName: () => 'Data' },
    { getSheetId: () => 'sh2', getSheetName: () => 'Other' },
  ],
}

function stubFormulas(
  bySheet: Record<string, string[]>,
  sharedGroups: Record<string, WorkbookSharedFormulaGroup[]> = {},
): void {
  ;(globalThis as { window?: unknown }).window = {
    desktopApi: {
      readWorkbookFormulas: async ({ sheetId }: { sheetId: string }) => ({
        cells: (bySheet[sheetId] ?? []).map((formula, i) => ({
          row: 6 + i,
          column: 0,
          formula,
        })),
        sharedGroups: sharedGroups[sheetId] ?? [],
        truncated: false,
        indexingComplete: true,
      }),
    },
  }
}

const delD = { op: 'delete_cols', sheetId: 'sh1', column: 'D', count: 1 } as const

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('structuralDeleteFormulaError', () => {
  it('allows a formula referencing only the deleted column', async () => {
    stubFormulas({ sh1: ['=SUM($D$7:$D$9)'] })
    expect(await structuralDeleteFormulaError(state(), workbook, delD)).toBeNull()
  })

  it('allows a shared-formula follower whose shifted refs sit in the deleted column', async () => {
    // master B1 =SUM(C7:C9) is fine; the follower in C1 reads SUM(D7:D9)
    stubFormulas(
      { sh1: [] },
      {
        sh1: [
          {
            si: 0,
            row: 0,
            column: 1,
            formula: '=SUM(C7:C9)',
            range: { startRow: 0, endRow: 0, startColumn: 1, endColumn: 2 },
          },
        ],
      },
    )
    expect(await structuralDeleteFormulaError(state(), workbook, delD)).toBeNull()
  })

  it('passes formulas that merely shift or shrink', async () => {
    stubFormulas({ sh1: ['=SUM(E7:E9)', '=SUM(C7:F9)'] })
    expect(await structuralDeleteFormulaError(state(), workbook, delD)).toBeNull()
  })

  it('allows fully deleted row references too', async () => {
    stubFormulas({ sh1: ['=SUM($A$7:$C$7)'] })
    const error = await structuralDeleteFormulaError(state(), workbook, {
      op: 'delete_rows',
      sheetId: 'sh1',
      row: 7,
      count: 1,
    })
    expect(error).toBeNull()
  })

  it('only considers qualified references on other sheets', async () => {
    stubFormulas({ sh1: [], sh2: ['=SUM(D7:D9)'] })
    expect(await structuralDeleteFormulaError(state(), workbook, delD)).toBeNull()
    stubFormulas({ sh1: [], sh2: ['=SUM(Data!$D$7:$D$9)'] })
    expect(await structuralDeleteFormulaError(state(), workbook, delD)).toBeNull()
  })

  it.each(['=SUM(D7:OFFSET(D9,0,0))', '=SUM(Table1[Q1]:D9)', '=Data!D7#', '=Data:Other!D7'])(
    'still refuses a formula that the writer cannot safely transform: %s',
    async (formula) => {
      stubFormulas({ sh1: [formula] })
      const error = await structuralDeleteFormulaError(state(), workbook, delD)
      expect(error).toContain('cannot be updated safely')
      expect(error).toContain(formula)
    },
  )

  it('preserves string literals, external references, and table headers', async () => {
    stubFormulas({ sh1: ['=SUM(Table1[D7])+[Book]Data!D7+"Data!D7"'] })
    expect(await structuralDeleteFormulaError(state(), workbook, delD)).toBeNull()
  })

  it('a style-only journal entry does not hide the file formula', async () => {
    stubFormulas({ sh1: ['=SUM($D$7:OFFSET($D$9,0,0))'] })
    const styled = state({
      editJournal: {
        cells: new Map([
          [
            'sh1',
            new Map([['6:0', { row: 6, column: 0, hasValue: false, style: { bold: true } }]]),
          ],
        ]),
        structuralOps: new Map(),
        sheets: { added: new Set(), removed: new Set() },
      },
    })
    expect(await structuralDeleteFormulaError(styled, workbook, delD)).not.toBeNull()
    // a content overwrite at the same cell DOES supersede it
    const overwritten = state({
      editJournal: {
        cells: new Map([
          ['sh1', new Map([['6:0', { row: 6, column: 0, hasValue: true, value: 1 }]])],
        ]),
        structuralOps: new Map(),
        sheets: { added: new Set(), removed: new Set() },
      },
    })
    expect(await structuralDeleteFormulaError(overwritten, workbook, delD)).toBeNull()
  })

  it('checks session-written journal formulas too', async () => {
    stubFormulas({ sh1: [] })
    const journaled = state({
      editJournal: {
        cells: new Map([
          [
            'sh1',
            new Map([['1:1', { row: 1, column: 1, formula: '=SUM($D$7:OFFSET($D$9,0,0))' }]]),
          ],
        ]),
        structuralOps: new Map(),
        sheets: { added: new Set(), removed: new Set() },
      },
    })
    expect(await structuralDeleteFormulaError(journaled, workbook, delD)).not.toBeNull()
  })

  it('falls back to the save-time guard when texts are unreliable', async () => {
    stubFormulas({ sh1: ['=SUM($D$7:$D$9)'] })
    const shifted = state({
      editJournal: {
        cells: new Map(),
        structuralOps: new Map([['sh1', [{ kind: 'insert-rows', index: 0, count: 1 }]]]),
        sheets: { added: new Set(), removed: new Set() },
      },
    })
    expect(await structuralDeleteFormulaError(shifted, workbook, delD)).toBeNull()
    ;(globalThis as { window?: { desktopApi: { readWorkbookFormulas: unknown } } }).window = {
      desktopApi: {
        readWorkbookFormulas: async () => ({
          cells: [],
          sharedGroups: [],
          truncated: true,
          indexingComplete: true,
        }),
      },
    }
    expect(await structuralDeleteFormulaError(state(), workbook, delD)).toBeNull()
  })
})

describe('structuralDeleteFormulaErrorSync (UI gate)', () => {
  function syncWorkbook(formulasBySheet: Record<string, string[][]>) {
    return {
      getSheets: () =>
        Object.keys(formulasBySheet).map((sheetId) => ({
          getSheetId: () => sheetId,
          getSheetName: () => (sheetId === 'sh1' ? 'Data' : 'Other'),
          getMaxRows: () => 20,
          getMaxColumns: () => 8,
          getRange: () => ({ getFormulas: () => formulasBySheet[sheetId] ?? [[]] }),
        })),
    }
  }

  it('scans the live model in full-load mode', () => {
    const wb = syncWorkbook({ sh1: [['', '=SUM($D$7:OFFSET($D$9,0,0))']], sh2: [[]] })
    const full = state({ formulaMode: true })
    expect(structuralDeleteFormulaErrorSync(full, wb, delD)).toContain('cannot be updated safely')
    const wbOk = syncWorkbook({ sh1: [['', '=SUM(E7:E9)']], sh2: [[]] })
    expect(structuralDeleteFormulaErrorSync(full, wbOk, delD)).toBeNull()
    const wbDeleted = syncWorkbook({ sh1: [['', '=SUM($D$7:$D$9)']], sh2: [[]] })
    expect(structuralDeleteFormulaErrorSync(full, wbDeleted, delD)).toBeNull()
  })

  it('keeps checking in full-load mode after session structural edits', () => {
    // the live model already reflects the shift — only the streamed
    // harvested-index path must fall back to the save-time guard
    const wb = syncWorkbook({ sh1: [['', '=SUM($D$7:OFFSET($D$9,0,0))']], sh2: [[]] })
    const shifted = state({
      formulaMode: true,
      editJournal: {
        cells: new Map(),
        structuralOps: new Map([['sh1', [{ kind: 'insert-rows', index: 0, count: 1 }]]]),
        sheets: { added: new Set(), removed: new Set() },
      },
    })
    expect(structuralDeleteFormulaErrorSync(shifted, wb, delD)).toContain(
      'cannot be updated safely',
    )
    const streamedShifted = state({
      formulaMode: false,
      formulaText: new Map([['sh1', new Map([['6:0', '=SUM($D$7:OFFSET($D$9,0,0))']])]]),
      sharedFormulaGroups: new Map(),
      editJournal: {
        cells: new Map(),
        structuralOps: new Map([['sh1', [{ kind: 'insert-rows', index: 0, count: 1 }]]]),
        sheets: { added: new Set(), removed: new Set() },
      },
    })
    expect(structuralDeleteFormulaErrorSync(streamedShifted, wb, delD)).toBeNull()
  })

  it('uses the harvested formula index on streamed workbooks', () => {
    const wb = syncWorkbook({ sh1: [[]], sh2: [[]] })
    const streamed = state({
      formulaMode: false,
      formulaText: new Map([['sh1', new Map([['6:0', '=SUM($D$7:OFFSET($D$9,0,0))']])]]),
      sharedFormulaGroups: new Map(),
    })
    expect(structuralDeleteFormulaErrorSync(streamed, wb, delD)).toContain(
      'cannot be updated safely',
    )
    // a content overwrite at that cell supersedes the harvested text
    const overwritten = state({
      formulaMode: false,
      formulaText: new Map([['sh1', new Map([['6:0', '=SUM($D$7:OFFSET($D$9,0,0))']])]]),
      sharedFormulaGroups: new Map(),
      editJournal: {
        cells: new Map([
          ['sh1', new Map([['6:0', { row: 6, column: 0, hasValue: true, value: 1 }]])],
        ]),
        structuralOps: new Map(),
        sheets: { added: new Set(), removed: new Set() },
      },
    })
    expect(structuralDeleteFormulaErrorSync(overwritten, wb, delD)).toBeNull()
  })
})
