import { z } from 'zod'

/** Independently versioned authority API, carried by the unchanged v1 transport. */
export const EDIT_API_VERSION = 1 as const

export interface EditInput {
  readonly sheetId: string
  readonly row: number
  readonly column: number
  readonly input: string
}

export interface EditSessionOpen {
  readonly apiVersion: 1
  readonly workbookId: string
  readonly sourcePath: string
  readonly sheets: readonly { readonly id: string; readonly name: string }[]
  readonly storePath?: string
}

export interface EditTransaction {
  readonly apiVersion: 1
  readonly workbookId: string
  readonly commandId: string
  readonly expectedRevision: number
  readonly actor: string
  readonly operations: readonly EditOperation[]
}

/** Kernel SDK coordinates are zero-based and half-open. */
export interface SdkRange {
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
}

export type EditOperation =
  | ({ readonly type: 'set_cell' } & EditInput)
  | { readonly type: 'clear_range'; readonly sheetId: string; readonly range: SdkRange }
  | { readonly type: 'replace_inputs'; readonly edits: readonly EditInput[] }

export interface EditRecalcRead {
  readonly sheet: string
  /** Legacy v1 coordinates remain zero-based with inclusive ends. */
  readonly range: {
    readonly startRow: number
    readonly endRow: number
    readonly startColumn: number
    readonly endColumn: number
  }
}

export const editOpenResultSchema = z
  .object({
    apiVersion: z.literal(EDIT_API_VERSION),
    workbookId: z.string().min(1),
    revision: z.number().int().nonnegative().safe(),
    sourceFingerprint: z.string().min(1),
    recovered: z.boolean(),
  })
  .strict()

export const editTransactionResultSchema = z
  .object({
    apiVersion: z.literal(EDIT_API_VERSION),
    workbookId: z.string().min(1),
    commandId: z.string().min(1),
    revision: z.number().int().nonnegative().safe(),
    changed: z.number().int().nonnegative().safe(),
    durable: z.boolean(),
  })
  .strict()

export type EditTransactionResult = z.infer<typeof editTransactionResultSchema>

export const editRecalcResultSchema = z
  .object({
    workbookId: z.string().min(1),
    revision: z.number().int().nonnegative().safe(),
    cells: z.array(
      z
        .object({
          sheet: z.string(),
          row: z.number().int().nonnegative(),
          column: z.number().int().nonnegative(),
          formatted: z.string(),
          // Additive for older sidecars; current native results always send
          // this field. Derived caches must require it rather than infer a
          // boolean or text value from its formatted display.
          value: z
            .union([
              z.number(),
              z.boolean(),
              z.string(),
              z.null(),
              z.object({ error: z.string().max(32) }).strict(),
            ])
            .optional(),
          number: z.number().optional(),
          isError: z.boolean().optional(),
          isFormula: z.boolean(),
        })
        .strict(),
    ),
    cached: z.boolean().optional(),
    cacheWritebackAllowed: z.boolean().optional(),
    calculationCompleteness: z.enum(['complete', 'unverified']).optional(),
    cacheWritebackReasons: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict()

export type EditRecalcResult = z.infer<typeof editRecalcResultSchema>

export interface EditSessionClient {
  openEditSession(input: EditSessionOpen): Promise<unknown>
  applyTransaction(input: EditTransaction): Promise<unknown>
  commandResult(input: {
    readonly apiVersion: 1
    readonly workbookId: string
    readonly commandId: string
  }): Promise<unknown>
  recalcSnapshot(input: {
    readonly apiVersion: 1
    readonly workbookId: string
    readonly revision: number
    readonly reads: readonly EditRecalcRead[]
  }): Promise<unknown>
  onProcessExit(listener: () => void): () => void
}

/** Preserve machine-readable errors instead of matching translated error text. */
export class XlsxSidecarError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message)
    this.name = 'XlsxSidecarError'
  }
}
