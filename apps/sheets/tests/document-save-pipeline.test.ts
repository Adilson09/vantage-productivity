import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import { workbookSaveRequestSchema, type WorkbookSaveRequest } from '../src/shared/desktop-api'
import { writeDocumentSavePipeline } from '../src/main/document-save-pipeline'

const ORIGINAL_ID = '10000000-0000-4000-8000-000000000001'
const PHASE_ID = '10000000-0000-4000-8000-000000000002'
const AREA = { startRow: 0, endRow: 4, startColumn: 0, endColumn: 1 }

function request(changes: Partial<WorkbookSaveRequest> = {}): WorkbookSaveRequest {
  return workbookSaveRequestSchema.parse({
    sessionId: ORIGINAL_ID,
    mode: 'save-as',
    edits: [],
    bulkConstantFills: [],
    structuralOps: [],
    chartEdits: [],
    visualEdits: [],
    visualAdditions: [],
    cellImageAdditions: [],
    tableAdditions: [],
    tableEdits: [],
    pivotAdditions: [],
    sheetOps: [],
    sheetOrder: [],
    filterStates: [],
    hyperlinkEdits: [],
    cfStates: [],
    dvStates: [],
    pageSetupStates: [],
    noteStates: [],
    formulaValues: [],
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    sheetProtections: [],
    sparklineAdditions: [],
    definedNamesState: null,
    themeState: null,
    workbookProtectionState: null,
    protectedRangeStates: [],
    redactionStates: null,
    ...changes,
  })
}

function table(sheetId = 'sheet-1'): WorkbookSaveRequest['tableAdditions'][number] {
  return {
    sheetId,
    area: AREA,
    name: 'Sales',
    columnNames: ['Category', 'Amount'],
    bandedRows: true,
  }
}

function pivot(
  sheetId = 'sheet-1',
  sourceSheetId = 'sheet-1',
): WorkbookSaveRequest['pivotAdditions'][number] {
  return {
    sheetId,
    sourceSheetId,
    sourceArea: AREA,
    location: AREA,
    name: 'SalesPivot',
    fieldNames: ['Category', 'Amount'],
    rowFieldIndices: [0],
    rowItems: ['A'],
    values: [{ fieldIndex: 1, agg: 'sum' }],
  }
}

function structuralRequest(): WorkbookSaveRequest {
  return request({
    structuralOps: [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 1, count: 2 }],
    tableAdditions: [table()],
  })
}

interface Session {
  sessionId: string
  layout: 'original' | 'reopened'
}
interface Result {
  touchedEntries: string[]
  phase: string
}

function harness(saveRequest: WorkbookSaveRequest) {
  const events: string[] = []
  const writes: { session: Session; request: WorkbookSaveRequest; target: string }[] = []
  const targetPath = join(tmpdir(), 'document-pipeline-test-final.xlsx')
  const phasePath = join(tmpdir(), 'document-pipeline-test-private-phase.xlsx')
  const original: Session = { sessionId: ORIGINAL_ID, layout: 'original' }
  const reopened: Session = { sessionId: PHASE_ID, layout: 'reopened' }
  const cleanup = vi.fn(async () => {
    events.push('cleanup')
  })
  const closePhase = vi.fn(async (_session: Session) => {
    events.push('close')
  })
  const write = vi.fn(
    async (session: Session, payload: WorkbookSaveRequest, target: string): Promise<Result> => {
      const phase = target === phasePath ? 'private' : 'final'
      events.push(phase)
      writes.push({ session, request: payload, target })
      return {
        phase,
        touchedEntries:
          phase === 'private'
            ? ['xl/workbook.xml', 'xl/worksheets/sheet1.xml']
            : ['xl/workbook.xml', 'xl/pivotTables/pivotTable1.xml'],
      }
    },
  )
  const options = {
    session: original,
    request: saveRequest,
    targetPath,
    write,
    allocatePhase: vi.fn(async () => {
      events.push('allocate')
      return { path: phasePath, cleanup }
    }),
    openPhase: vi.fn(async (_path: string) => {
      events.push('open')
      return reopened
    }),
    closePhase,
    beforePublish: vi.fn(async () => {
      events.push('guard')
    }),
    phaseSessionId: (session: Session) => session.sessionId,
  }
  return { events, writes, targetPath, phasePath, original, reopened, cleanup, options }
}

describe('whole-document save pipeline', () => {
  it('writes structure privately, reopens its real layout, and publishes held families once', async () => {
    const saveRequest = request({
      structuralOps: [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 1, count: 2 }],
      sheetOps: [{ kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'Annual Budget' }],
      sheetOrder: ['sheet-1'],
      tableAdditions: [table()],
      pivotAdditions: [pivot()],
      tableEdits: [
        { sheetId: 'sheet-1', tableName: 'KeepInFirst', name: 'RenamedInFirst', bandedRows: false },
        { sheetId: 'sheet-1', tableName: 'ResizeInSecond', area: AREA, columnNames: ['A', 'B'] },
      ],
      definedNamesState: {
        names: [{ name: 'Total', formula: "'Annual Budget'!$A$1" }],
        preserveNames: ['OpaqueName'],
      },
      formulaValues: [{ sheetId: 'sheet-1', row: 0, column: 0, value: 42 }],
      themeState: { fonts: { name: 'Office', major: 'Arial', minor: 'Arial' } },
      workbookProtectionState: { lockStructure: true },
      protectedRangeStates: [
        { sheetId: 'sheet-1', ranges: [{ name: 'Editable', sqref: 'A1:B2' }] },
      ],
      redactionStates: [{ sheetName: 'Budget', marks: [{ ...AREA, label: 'Withheld' }] }],
      targetPath: join(tmpdir(), 'original-dialog-target.xlsx'),
      overwrite: false,
      quiet: true,
      defaultName: 'Budget',
      csvContent: 'a,b\n',
    })
    const before = structuredClone(saveRequest)
    const test = harness(saveRequest)
    const result = await writeDocumentSavePipeline({
      ...test.options,
      combineResults: (first, last) => ({
        ...last,
        touchedEntries: [...new Set([...first.touchedEntries, ...last.touchedEntries])],
      }),
    })
    expect(test.events).toEqual([
      'allocate',
      'private',
      'open',
      'guard',
      'final',
      'close',
      'cleanup',
    ])
    expect(test.writes.map((write) => write.target)).toEqual([test.phasePath, test.targetPath])
    expect(test.writes[1]!.session).toBe(test.reopened)
    const first = test.writes[0]!.request
    expect(first.structuralOps).toEqual(saveRequest.structuralOps)
    expect(first.sheetOps).toEqual(saveRequest.sheetOps)
    expect(first.formulaValues).toEqual(saveRequest.formulaValues)
    expect(first.themeState).toEqual(saveRequest.themeState)
    expect(first.redactionStates).toEqual(saveRequest.redactionStates)
    expect(first.tableAdditions).toEqual([])
    expect(first.pivotAdditions).toEqual([])
    expect(first.tableEdits).toEqual([saveRequest.tableEdits![0]])
    expect(first.definedNamesState).toBeNull()
    expect(first.targetPath).toBe(test.phasePath)
    expect(first.csvContent).toBeUndefined()
    expect(first.defaultName).toBeUndefined()
    const second = test.writes[1]!.request
    expect(second.sessionId).toBe(PHASE_ID)
    expect(second.targetPath).toBe(test.targetPath)
    expect(second.overwrite).toBe(false)
    expect(second.tableAdditions).toEqual(saveRequest.tableAdditions)
    expect(second.tableEdits).toEqual([saveRequest.tableEdits![1]])
    expect(second.pivotAdditions).toEqual(saveRequest.pivotAdditions)
    expect(second.definedNamesState).toEqual(saveRequest.definedNamesState)
    for (const family of [
      'edits',
      'bulkConstantFills',
      'structuralOps',
      'chartEdits',
      'visualEdits',
      'visualAdditions',
      'cellImageAdditions',
      'sheetOps',
      'sheetOrder',
      'filterStates',
      'hyperlinkEdits',
      'cfStates',
      'dvStates',
      'pageSetupStates',
      'noteStates',
      'pivotCacheRefreshPaths',
      'pivotRefreshUpdates',
      'sheetProtections',
      'sparklineAdditions',
      'formulaValues',
      'protectedRangeStates',
    ] as const)
      expect(second[family]).toEqual([])
    expect(second.themeState).toBeNull()
    expect(second.workbookProtectionState).toBeNull()
    expect(second.redactionStates).toBeNull()
    expect(workbookSaveRequestSchema.safeParse(first).success).toBe(true)
    expect(workbookSaveRequestSchema.safeParse(second).success).toBe(true)
    expect(saveRequest).toEqual(before)
    expect(result).toEqual({
      phase: 'final',
      touchedEntries: [
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
        'xl/pivotTables/pivotTable1.xml',
      ],
    })
  })

  it('uses one guarded write for tab colors with pivots and for table additions without structure', async () => {
    for (const saveRequest of [
      request({
        sheetOps: [{ kind: 'set-sheet-tab-color', sheetId: 'sheet-1', color: '#112233' }],
        sheetOrder: ['sheet-1'],
        pivotAdditions: [pivot()],
      }),
      request({ tableAdditions: [table()] }),
      request({ structuralOps: [{ sheetId: 'sheet-1', kind: 'insert-cols', index: 0, count: 1 }] }),
    ]) {
      const test = harness(saveRequest)
      const result = await writeDocumentSavePipeline(test.options)
      expect(test.events).toEqual(['guard', 'final'])
      expect(test.writes[0]!.session).toBe(test.original)
      expect(test.writes[0]!.request).toEqual(saveRequest)
      expect(result.phase).toBe('final')
      expect(test.options.allocatePhase).not.toHaveBeenCalled()
    }
  })

  it('holds defined names for sheet changes even without any table or pivot additions', async () => {
    const saveRequest = request({
      sheetOps: [{ kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'Renamed' }],
      sheetOrder: ['sheet-1'],
      definedNamesState: {
        names: [{ name: 'Amount', formula: 'Renamed!$A$1' }],
        preserveNames: [],
      },
    })
    const test = harness(saveRequest)
    await writeDocumentSavePipeline(test.options)
    expect(test.writes).toHaveLength(2)
    expect(test.writes[0]!.request.definedNamesState).toBeNull()
    expect(test.writes[1]!.request.definedNamesState).toEqual(saveRequest.definedNamesState)
  })

  it.each(['phase-one', 'reopen', 'source-guard'] as const)(
    'leaves the final target untouched when %s fails',
    async (stage) => {
      const test = harness(structuralRequest())
      const primary = new Error(`${stage} failure`)
      await expect(
        writeDocumentSavePipeline({
          ...test.options,
          write: async (session, payload, target) => {
            if (stage === 'phase-one') throw primary
            return test.options.write(session, payload, target)
          },
          openPhase: async (path) => {
            if (stage === 'reopen') throw primary
            return test.options.openPhase(path)
          },
          beforePublish: async () => {
            if (stage === 'source-guard') throw primary
          },
        }),
      ).rejects.toBe(primary)
      expect(test.writes.every((write) => write.target !== test.targetPath)).toBe(true)
      expect(test.cleanup).toHaveBeenCalledTimes(1)
      expect(test.options.closePhase).toHaveBeenCalledTimes(stage === 'source-guard' ? 1 : 0)
    },
  )

  it('preserves the final writer error while attempting both close and cleanup', async () => {
    const test = harness(structuralRequest())
    const primary = new Error('Final serialization failed before atomic publication')
    const closeError = new Error('Close failed')
    const cleanupError = new Error('Cleanup failed')
    const reported: unknown[] = []
    let finalContents = 'original final contents'
    await expect(
      writeDocumentSavePipeline({
        ...test.options,
        write: async (session, payload, target) => {
          if (target === test.targetPath) throw primary
          const result = await test.options.write(session, payload, target)
          if (target === test.targetPath) finalContents = 'published'
          return result
        },
        closePhase: async () => {
          test.events.push('close-failed')
          throw closeError
        },
        allocatePhase: async () => ({
          path: test.phasePath,
          cleanup: async () => {
            test.events.push('cleanup-failed')
            throw cleanupError
          },
        }),
        onCleanupError: (error) => {
          reported.push(error)
        },
      }),
    ).rejects.toBe(primary)
    expect(finalContents).toBe('original final contents')
    expect(test.events.slice(-2)).toEqual(['close-failed', 'cleanup-failed'])
    expect(reported).toEqual([closeError, cleanupError])
  })

  it('retains successful publication when cleanup or its reporting fails', async () => {
    const test = harness(structuralRequest())
    const result = await writeDocumentSavePipeline({
      ...test.options,
      closePhase: async () => {
        throw new Error('Close failed after publication')
      },
      allocatePhase: async () => ({
        path: test.phasePath,
        cleanup: async () => {
          throw new Error('Cleanup failed after publication')
        },
      }),
      onCleanupError: () => {
        throw new Error('Log handler failed')
      },
    })
    expect(result.phase).toBe('final')
  })

  it.each(['table', 'table-resize', 'pivot-output', 'pivot-source', 'duplicate-pivot'] as const)(
    'fails closed for a held %s that refers to an unassigned new worksheet ID',
    async (kind) => {
      const newId = 'unassigned-univer-sheet'
      const saveRequest = structuralRequest()
      saveRequest.sheetOps = [
        kind === 'duplicate-pivot'
          ? { kind: 'duplicate-sheet', sheetId: newId, name: 'Copied', sourceSheetId: 'sheet-1' }
          : { kind: 'add-sheet', sheetId: newId, name: 'Added' },
      ]
      saveRequest.sheetOrder = ['sheet-1', newId]
      if (kind === 'table') saveRequest.tableAdditions = [table(newId)]
      else if (kind === 'table-resize')
        saveRequest.tableEdits = [{ sheetId: newId, tableName: 'NewTable', area: AREA }]
      else
        saveRequest.pivotAdditions = [
          pivot(
            kind === 'pivot-source' ? 'sheet-1' : newId,
            kind === 'pivot-source' ? newId : 'sheet-1',
          ),
        ]
      const test = harness(saveRequest)
      await expect(writeDocumentSavePipeline(test.options)).rejects.toThrow('newly added worksheet')
      expect(test.options.allocatePhase).not.toHaveBeenCalled()
      expect(test.options.write).not.toHaveBeenCalled()
    },
  )

  it('rebinds added and renamed worksheets for tables, resized tables, both pivot directions, and scoped names', async () => {
    const newId = 'new-sheet-client-id'
    const saveRequest = request({
      structuralOps: [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 1, count: 2 }],
      sheetOps: [
        { kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'Annual Budget' },
        { kind: 'add-sheet', sheetId: newId, name: 'Output' },
        { kind: 'remove-sheet', sheetId: 'removed-sheet' },
      ],
      sheetOrder: [newId, 'sheet-1'],
      tableAdditions: [table(newId)],
      tableEdits: [
        {
          sheetId: 'sheet-1',
          tableName: 'Existing',
          area: AREA,
          columnNames: ['Category', 'Amount'],
        },
      ],
      pivotAdditions: [
        pivot(newId, 'sheet-1'),
        { ...pivot('sheet-1', newId), name: 'OutputSourcePivot' },
      ],
      definedNamesState: {
        names: [
          { name: 'Global', formula: "'Annual Budget'!$A$1" },
          { name: 'OutputScope', formula: 'Output!$A$1', sheetIndex: 0 },
          { name: 'BudgetScope', formula: "'Annual Budget'!$B$1", sheetIndex: 1 },
        ],
        preserveNames: ['HiddenOpaqueName'],
      },
    })
    const before = structuredClone(saveRequest)
    const test = harness(saveRequest)
    const originalNames = new Map([
      ['sheet-1', 'Budget'],
      ['removed-sheet', 'Old'],
    ])
    const phaseNames = new Map([
      ['phase-output-id', 'Output'],
      ['phase-budget-id', 'Annual Budget'],
    ])
    const sheetNames = vi.fn((session: Session) =>
      session.layout === 'original' ? originalNames : phaseNames,
    )
    await writeDocumentSavePipeline({ ...test.options, sheetNames })
    expect(sheetNames.mock.calls.map(([session]) => session.layout)).toEqual([
      'original',
      'reopened',
    ])
    expect(test.events).toEqual([
      'allocate',
      'private',
      'open',
      'guard',
      'final',
      'close',
      'cleanup',
    ])
    const final = test.writes[1]!.request
    expect(final.tableAdditions).toEqual([{ ...table(newId), sheetId: 'phase-output-id' }])
    expect(final.tableEdits).toEqual([
      { ...saveRequest.tableEdits![0], sheetId: 'phase-budget-id' },
    ])
    expect(final.pivotAdditions).toEqual([
      {
        ...saveRequest.pivotAdditions[0],
        sheetId: 'phase-output-id',
        sourceSheetId: 'phase-budget-id',
      },
      {
        ...saveRequest.pivotAdditions[1],
        sheetId: 'phase-budget-id',
        sourceSheetId: 'phase-output-id',
      },
    ])
    expect(final.definedNamesState).toEqual(saveRequest.definedNamesState)
    expect(workbookSaveRequestSchema.safeParse(final).success).toBe(true)
    expect(saveRequest).toEqual(before)
    expect(originalNames).toEqual(
      new Map([
        ['sheet-1', 'Budget'],
        ['removed-sheet', 'Old'],
      ]),
    )
    expect(phaseNames).toEqual(
      new Map([
        ['phase-output-id', 'Output'],
        ['phase-budget-id', 'Annual Budget'],
      ]),
    )
  })

  it('rebinds a duplicated sheet independently from its renamed source', async () => {
    const saveRequest = structuralRequest()
    saveRequest.sheetOps = [
      {
        kind: 'duplicate-sheet',
        sheetId: 'copy-client-id',
        name: 'Copied',
        sourceSheetId: 'sheet-1',
      },
      { kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'Source Renamed' },
    ]
    saveRequest.sheetOrder = ['copy-client-id', 'sheet-1']
    saveRequest.tableAdditions = [table('copy-client-id')]
    saveRequest.pivotAdditions = [pivot('copy-client-id', 'sheet-1')]
    const test = harness(saveRequest)
    await writeDocumentSavePipeline({
      ...test.options,
      sheetNames: async (session) =>
        session.layout === 'original'
          ? new Map([['sheet-1', 'Source']])
          : new Map([
              ['reopened-copy', 'Copied'],
              ['reopened-source', 'Source Renamed'],
            ]),
    })
    expect(test.writes[1]!.request.tableAdditions[0]!.sheetId).toBe('reopened-copy')
    expect(test.writes[1]!.request.pivotAdditions[0]).toMatchObject({
      sheetId: 'reopened-copy',
      sourceSheetId: 'reopened-source',
    })
  })

  it.each([
    { entries: [['phase-source', 'Data']] },
    {
      entries: [
        ['phase-source', 'Data'],
        ['phase-output', 'Wrong name'],
      ],
    },
    {
      entries: [
        ['phase-source', 'Data'],
        ['phase-output', 'Output'],
        ['phase-extra', 'Unrequested'],
      ],
    },
    {
      entries: [
        ['phase-source', 'Data'],
        ['phase-duplicate', 'DATA'],
      ],
    },
    {
      entries: [
        ['phase-output', 'Output'],
        ['phase-source', 'Data'],
      ],
    },
  ] as const)(
    'preserves the final target when the reopened worksheet map is missing, ambiguous or inconsistent: %j',
    async ({ entries }) => {
      const saveRequest = structuralRequest()
      saveRequest.sheetOps = [{ kind: 'add-sheet', sheetId: 'new-output', name: 'Output' }]
      saveRequest.sheetOrder = ['sheet-1', 'new-output']
      saveRequest.pivotAdditions = [pivot('new-output', 'sheet-1')]
      const before = structuredClone(saveRequest)
      const test = harness(saveRequest)
      let finalContents = 'original workbook bytes'
      await expect(
        writeDocumentSavePipeline({
          ...test.options,
          sheetNames: (session) =>
            session.layout === 'original' ? new Map([['sheet-1', 'Data']]) : new Map(entries),
          write: async (session, payload, target) => {
            if (target === test.targetPath) finalContents = 'incorrectly published'
            return test.options.write(session, payload, target)
          },
        }),
      ).rejects.toThrow(/worksheet (?:map|layout)/)
      expect(finalContents).toBe('original workbook bytes')
      expect(test.writes).toHaveLength(1)
      expect(test.writes[0]!.target).toBe(test.phasePath)
      expect(test.options.beforePublish).not.toHaveBeenCalled()
      expect(test.options.closePhase).toHaveBeenCalledTimes(1)
      expect(test.cleanup).toHaveBeenCalledTimes(1)
      expect(saveRequest).toEqual(before)
    },
  )

  it('rejects a removed pivot source before allocating or writing a phase', async () => {
    const saveRequest = structuralRequest()
    saveRequest.sheetOps = [{ kind: 'remove-sheet', sheetId: 'source-removed' }]
    saveRequest.sheetOrder = ['sheet-1']
    saveRequest.pivotAdditions = [pivot('sheet-1', 'source-removed')]
    const test = harness(saveRequest)
    await expect(
      writeDocumentSavePipeline({
        ...test.options,
        sheetNames: () =>
          new Map([
            ['sheet-1', 'Keep'],
            ['source-removed', 'Source'],
          ]),
      }),
    ).rejects.toThrow('missing final worksheet')
    expect(test.options.allocatePhase).not.toHaveBeenCalled()
    expect(test.options.write).not.toHaveBeenCalled()
  })

  it('rejects ambiguous original names before writing any private or final bytes', async () => {
    const test = harness(structuralRequest())
    await expect(
      writeDocumentSavePipeline({
        ...test.options,
        sheetNames: () =>
          new Map([
            ['sheet-1', 'Data'],
            ['other-sheet', 'DATA'],
          ]),
      }),
    ).rejects.toThrow('original worksheet map is ambiguous')
    expect(test.options.allocatePhase).not.toHaveBeenCalled()
    expect(test.options.write).not.toHaveBeenCalled()
  })

  it('rejects an invalid final defined-name scope before the final write', async () => {
    const saveRequest = structuralRequest()
    saveRequest.definedNamesState = {
      names: [{ name: 'BadScope', formula: 'Data!$A$1', sheetIndex: 99 }],
      preserveNames: [],
    }
    const test = harness(saveRequest)
    await expect(
      writeDocumentSavePipeline({
        ...test.options,
        sheetNames: (session) =>
          new Map([[session.layout === 'original' ? 'sheet-1' : 'phase-sheet', 'Data']]),
      }),
    ).rejects.toThrow('invalid final worksheet scope')
    expect(test.writes).toHaveLength(1)
    expect(test.options.beforePublish).not.toHaveBeenCalled()
    expect(test.options.closePhase).toHaveBeenCalledTimes(1)
    expect(test.cleanup).toHaveBeenCalledTimes(1)
  })

  it('rejects an allocator that aliases the final target without invoking its destructive cleanup', async () => {
    const test = harness(structuralRequest())
    await expect(
      writeDocumentSavePipeline({
        ...test.options,
        allocatePhase: async () => ({ path: test.targetPath, cleanup: test.cleanup }),
      }),
    ).rejects.toThrow('private absolute path')
    expect(test.options.write).not.toHaveBeenCalled()
    expect(test.cleanup).not.toHaveBeenCalled()
  })
})
