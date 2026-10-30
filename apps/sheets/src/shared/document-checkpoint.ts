import { z } from 'zod'
import {
  workbookSaveRequestSchema,
  workbookCellEditSchema,
  type WorkbookSaveRequest,
} from './desktop-api'
import { MAX_SAVE_EDITS_TOTAL } from './ipc-channels'

/** File destinations and transport handles never become document contents. */
export const DOCUMENT_OPERATIONAL_FIELDS = [
  'sessionId',
  'mode',
  'targetPath',
  'overwrite',
  'restoreWriteBack',
  'quiet',
  'defaultName',
  'csvContent',
  'editsTransferId',
] as const

export type WorkbookDocumentPayload = Omit<
  WorkbookSaveRequest,
  (typeof DOCUMENT_OPERATIONAL_FIELDS)[number]
>

/** An imported base with no pending mutations, including every required family. */
export function emptyDocumentPayload(): WorkbookDocumentPayload {
  return {
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
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    sheetProtections: [],
    sparklineAdditions: [],
    formulaValues: [],
    definedNamesState: null,
    themeState: null,
    workbookProtectionState: null,
    protectedRangeStates: [],
    redactionStates: null,
  }
}

export function documentPayloadFromSave(request: WorkbookSaveRequest): WorkbookDocumentPayload {
  const payload = { ...request } as Record<string, unknown>
  for (const key of DOCUMENT_OPERATIONAL_FIELDS) delete payload[key]
  return payload as WorkbookDocumentPayload
}

/** Recovered data passes the same feature contracts as a normal save. */
export function validateDocumentPayload(input: unknown): WorkbookDocumentPayload {
  const object = z.record(z.string(), z.unknown()).parse(input)
  if (DOCUMENT_OPERATIONAL_FIELDS.some((key) => Object.hasOwn(object, key))) {
    throw new Error('A document checkpoint cannot contain file destinations or transport handles.')
  }
  const edits = z.array(workbookCellEditSchema).max(MAX_SAVE_EDITS_TOTAL).parse(object.edits)
  const validated = workbookSaveRequestSchema.parse({
    ...object,
    edits: [],
    sessionId: '00000000-0000-4000-8000-000000000000',
    mode: 'save-as',
  })
  return { ...documentPayloadFromSave(validated), edits }
}

export const documentCheckpointReceiptSchema = z
  .object({
    apiVersion: z.literal(1),
    documentId: z.string().uuid(),
    commandId: z.string().min(1),
    revision: z.number().int().nonnegative().safe(),
    durable: z.boolean(),
    candidateId: z.string().uuid().nullable(),
  })
  .strict()

export type DocumentCheckpointReceipt = z.infer<typeof documentCheckpointReceiptSchema>
