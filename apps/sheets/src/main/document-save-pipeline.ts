/** Whole-document saves publish once, after structural and dependent mutations agree. */
import { isAbsolute, resolve } from 'node:path'

import type { WorkbookSaveRequest } from '../shared/desktop-api'

export interface DocumentSavePipeline<TSession, TResult> {
  readonly session: TSession
  readonly request: WorkbookSaveRequest
  readonly targetPath: string
  /** The writer must atomically publish its target after planning succeeds. */
  readonly write: (
    session: TSession,
    request: WorkbookSaveRequest,
    targetPath: string,
  ) => Promise<TResult>
  readonly openPhase: (path: string) => Promise<TSession>
  readonly closePhase: (session: TSession) => Promise<void>
  /** An app-owned private temporary file, separate from the final target. */
  readonly allocatePhase: () => Promise<{
    readonly path: string
    readonly cleanup: () => Promise<void>
  }>
  readonly beforePublish?: () => void | Promise<void>
  readonly phaseSessionId?: (session: TSession) => string
  /** Stable ID -> name, in actual workbook tab order, for each reader. When
   * supplied, dependent references are rebound after reopening the phase. */
  readonly sheetNames?: (
    session: TSession,
  ) => ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>
  readonly combineResults?: (first: TResult, last: TResult) => TResult | Promise<TResult>
  /** Cleanup errors never replace the actual save outcome. */
  readonly onCleanupError?: (error: unknown) => void
}

function pathIdentity(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function checkedSheetNames(names: ReadonlyMap<string, string>, label: string): Map<string, string> {
  const result = new Map<string, string>()
  const seen = new Set<string>()
  for (const [id, name] of names) {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof name !== 'string' ||
      name.length === 0
    ) {
      throw new Error(`The ${label} worksheet map contains an invalid ID or name.`)
    }
    const key = name.toLowerCase()
    if (result.has(id) || seen.has(key)) throw new Error(`The ${label} worksheet map is ambiguous.`)
    result.set(id, name)
    seen.add(key)
  }
  if (result.size === 0) throw new Error(`The ${label} worksheet map is empty.`)
  return result
}

function finalSheetLayout(
  original: ReadonlyMap<string, string>,
  request: WorkbookSaveRequest,
): {
  names: Map<string, string>
  order: string[]
} {
  const names = new Map(original)
  const usedIds = new Set(original.keys())
  for (const operation of request.sheetOps) {
    if (operation.kind === 'reorder-sheets') continue
    if (operation.kind === 'add-sheet' || operation.kind === 'duplicate-sheet') {
      if (usedIds.has(operation.sheetId))
        throw new Error(`A new worksheet reuses the ID "${operation.sheetId}".`)
      // The preserving writer seeds duplicates from the original package,
      // including a source removed in the same save. The renderer resolves
      // duplicate chains back to that original stable source ID.
      if (operation.kind === 'duplicate-sheet' && !original.has(operation.sourceSheetId)) {
        throw new Error(`Unknown duplicate source worksheet "${operation.sourceSheetId}".`)
      }
      usedIds.add(operation.sheetId)
      names.set(operation.sheetId, operation.name)
      continue
    }
    if (!names.has(operation.sheetId))
      throw new Error(`Unknown worksheet "${operation.sheetId}" in the document save plan.`)
    if (operation.kind === 'rename-sheet') names.set(operation.sheetId, operation.newName)
    else if (operation.kind === 'remove-sheet') names.delete(operation.sheetId)
  }
  checkedSheetNames(names, 'final')
  const order = request.sheetOrder.length > 0 ? [...request.sheetOrder] : [...names.keys()]
  if (
    order.length !== names.size ||
    new Set(order).size !== order.length ||
    order.some((id) => !names.has(id))
  ) {
    throw new Error('The document save sheet order does not match its final worksheet set.')
  }
  return { names, order }
}

function bindPhaseSheets(
  expected: ReturnType<typeof finalSheetLayout>,
  phase: ReadonlyMap<string, string>,
): { id: (originalId: string) => string; index: (finalIndex: number) => number } {
  const reopened = checkedSheetNames(phase, 'reopened')
  const byName = new Map(
    [...reopened].map(([id, name], index) => [name.toLowerCase(), { id, index }]),
  )
  const expectedNames = expected.order.map((id) => expected.names.get(id)!.toLowerCase())
  const actualNames = [...reopened.values()].map((name) => name.toLowerCase())
  if (
    expectedNames.length !== actualNames.length ||
    expectedNames.some((name, index) => name !== actualNames[index])
  ) {
    throw new Error(
      'The reopened document worksheet layout does not match the committed save plan.',
    )
  }
  const id = (originalId: string): string => {
    const name = expected.names.get(originalId)
    const target = name === undefined ? undefined : byName.get(name.toLowerCase())
    if (!target)
      throw new Error(
        `Dependent worksheet "${originalId}" is missing after the document save phase.`,
      )
    return target.id
  }
  return {
    id,
    index: (finalIndex) => {
      const originalId = expected.order[finalIndex]
      if (originalId === undefined)
        throw new Error(`A defined name has an invalid final worksheet scope (${finalIndex}).`)
      const name = expected.names.get(originalId)!
      return byName.get(name.toLowerCase())!.index
    },
  }
}

export async function writeDocumentSavePipeline<TSession, TResult>(
  input: DocumentSavePipeline<TSession, TResult>,
): Promise<TResult> {
  const request = structuredClone(input.request)
  const hasStructure = request.structuralOps.length > 0
  const hasShifts =
    hasStructure || request.sheetOps.some((operation) => operation.kind !== 'set-sheet-tab-color')
  const heldPivots = hasShifts ? request.pivotAdditions : []
  const heldTables = hasStructure ? request.tableAdditions : []
  const heldTableEdits = hasStructure
    ? (request.tableEdits ?? []).filter((edit) => edit.area !== undefined)
    : []
  const phaseOneTableEdits = (request.tableEdits ?? []).filter(
    (edit) => !heldTableEdits.includes(edit),
  )
  const heldNames = hasShifts ? request.definedNamesState : null
  const split =
    heldPivots.length > 0 ||
    heldTables.length > 0 ||
    heldTableEdits.length > 0 ||
    heldNames !== null

  if (!split) {
    await input.beforePublish?.()
    return input.write(input.session, request, input.targetPath)
  }

  const addedSheetIds = new Set(
    request.sheetOps.flatMap((operation) =>
      operation.kind === 'add-sheet' || operation.kind === 'duplicate-sheet'
        ? [operation.sheetId]
        : [],
    ),
  )
  const heldSheetIds = [
    ...heldPivots.flatMap((pivot) => [pivot.sheetId, pivot.sourceSheetId]),
    ...heldTables.map((table) => table.sheetId),
    ...heldTableEdits.map((table) => table.sheetId),
  ]
  if (!input.sheetNames && heldSheetIds.some((id) => addedSheetIds.has(id))) {
    throw new Error(
      'A dependent pivot or table on a newly added worksheet cannot be addressed safely across save phases.',
    )
  }
  const expectedLayout = input.sheetNames
    ? finalSheetLayout(
        checkedSheetNames(await input.sheetNames(input.session), 'original'),
        request,
      )
    : undefined
  // Reject a dependent reference to a removed or unknown sheet before even
  // creating a private phase. Reopening may change IDs but cannot repair it.
  if (expectedLayout && heldSheetIds.some((id) => !expectedLayout.names.has(id))) {
    throw new Error('A dependent pivot or table refers to a missing final worksheet.')
  }

  let allocation: Awaited<ReturnType<typeof input.allocatePhase>> | undefined
  let phaseSession: TSession | undefined
  let opened = false
  const reportCleanup = (error: unknown) => {
    try {
      if (input.onCleanupError) input.onCleanupError(error)
      else console.warn('[sheets] Private document save phase cleanup failed:', error)
    } catch {
      /* Reporting must not turn a published workbook into a failed save. */
    }
  }
  try {
    const allocated = await input.allocatePhase()
    if (
      !isAbsolute(allocated.path) ||
      pathIdentity(allocated.path) === pathIdentity(input.targetPath)
    ) {
      // An invalid allocator must never be allowed to clean up the final file.
      throw new Error(
        'A document save phase requires a private absolute path separate from the final target.',
      )
    }
    allocation = allocated
    const phaseOne: WorkbookSaveRequest = {
      ...request,
      mode: 'save-as',
      targetPath: allocation.path,
      overwrite: true,
      quiet: true,
      tableAdditions: heldTables.length > 0 ? [] : request.tableAdditions,
      tableEdits: phaseOneTableEdits,
      pivotAdditions: heldPivots.length > 0 ? [] : request.pivotAdditions,
      definedNamesState: null,
    }
    // CSV publication belongs to the final host operation, never a private
    // intermediate workbook. Inline edits were materialized by that host.
    delete phaseOne.csvContent
    delete phaseOne.defaultName
    delete phaseOne.editsTransferId
    const first = await input.write(input.session, phaseOne, allocation.path)
    phaseSession = await input.openPhase(allocation.path)
    opened = true
    const binding =
      expectedLayout && input.sheetNames
        ? bindPhaseSheets(expectedLayout, await input.sheetNames(phaseSession))
        : undefined
    const phaseTwo: WorkbookSaveRequest = {
      sessionId: input.phaseSessionId?.(phaseSession) ?? request.sessionId,
      mode: 'save',
      targetPath: input.targetPath,
      ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite }),
      ...(request.quiet === undefined ? {} : { quiet: request.quiet }),
      ...(request.restoreWriteBack === undefined
        ? {}
        : { restoreWriteBack: request.restoreWriteBack }),
      edits: [],
      bulkConstantFills: [],
      structuralOps: [],
      chartEdits: [],
      visualEdits: [],
      visualAdditions: [],
      cellImageAdditions: [],
      tableAdditions: binding
        ? heldTables.map((table) => ({ ...table, sheetId: binding.id(table.sheetId) }))
        : heldTables,
      tableEdits: binding
        ? heldTableEdits.map((table) => ({ ...table, sheetId: binding.id(table.sheetId) }))
        : heldTableEdits,
      pivotAdditions: binding
        ? heldPivots.map((pivot) => ({
            ...pivot,
            sheetId: binding.id(pivot.sheetId),
            sourceSheetId: binding.id(pivot.sourceSheetId),
          }))
        : heldPivots,
      sheetOps: [],
      sheetOrder: [],
      filterStates: [],
      hyperlinkEdits: [],
      cfStates: [],
      dvStates: [],
      pageSetupStates: [],
      noteStates: [],
      pivotCacheRefreshPaths: [],
      pivotRefreshUpdates: [],
      sheetProtections: [],
      sparklineAdditions: [],
      formulaValues: [],
      // The current wire model scopes names by final tab index rather than
      // sheet ID. Bind that index through the verified layout as well.
      definedNamesState:
        binding && heldNames
          ? {
              ...heldNames,
              names: heldNames.names.map((name) => ({
                ...name,
                ...(name.sheetIndex === undefined
                  ? {}
                  : { sheetIndex: binding.index(name.sheetIndex) }),
              })),
            }
          : heldNames,
      themeState: null,
      workbookProtectionState: null,
      protectedRangeStates: [],
      redactionStates: null,
    }
    // The reopened private workbook supplies the post-structure sheet names,
    // parts and IDs; only the dependent entities are then applied to it.
    await input.beforePublish?.()
    const last = await input.write(phaseSession, phaseTwo, input.targetPath)
    return input.combineResults ? await input.combineResults(first, last) : last
  } finally {
    if (opened) {
      try {
        await input.closePhase(phaseSession as TSession)
      } catch (error) {
        reportCleanup(error)
      }
    }
    if (allocation) {
      try {
        await allocation.cleanup()
      } catch (error) {
        reportCleanup(error)
      }
    }
  }
}
