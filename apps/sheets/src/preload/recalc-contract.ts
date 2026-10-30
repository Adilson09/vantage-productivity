/** Pure preload validation; no runtime schema library crosses the sandbox. */
import type { WorkbookRecalcResult } from '../shared/desktop-api'

type Value = NonNullable<WorkbookRecalcResult['cells'][number]['value']> | null
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const coordinate = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
function scalar(value: unknown): value is Value {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (record(value) &&
      Object.keys(value).length === 1 &&
      typeof value.error === 'string' &&
      value.error.length > 0 &&
      value.error.length <= 32)
  )
}
function invalid(): never {
  throw new Error('Invalid workbook recalc response.')
}

export function parseRecalcResult(input: unknown): WorkbookRecalcResult {
  if (
    !record(input) ||
    !Array.isArray(input.cells) ||
    input.cells.length > 20_000 ||
    (input.cacheWritebackAllowed !== undefined &&
      typeof input.cacheWritebackAllowed !== 'boolean') ||
    (input.calculationCompleteness !== undefined &&
      input.calculationCompleteness !== 'complete' &&
      input.calculationCompleteness !== 'unverified') ||
    (input.cacheWritebackReasons !== undefined &&
      (!Array.isArray(input.cacheWritebackReasons) ||
        input.cacheWritebackReasons.length > 100 ||
        input.cacheWritebackReasons.some(
          (reason) => typeof reason !== 'string' || reason.length === 0 || reason.length > 64,
        )))
  )
    invalid()
  const cells = input.cells.map((cell) => {
    if (
      !record(cell) ||
      typeof cell.sheetId !== 'string' ||
      !cell.sheetId ||
      !coordinate(cell.row, 1_048_575) ||
      !coordinate(cell.column, 16_383) ||
      typeof cell.formatted !== 'string' ||
      typeof cell.isFormula !== 'boolean' ||
      (cell.number !== undefined &&
        (typeof cell.number !== 'number' || !Number.isFinite(cell.number))) ||
      (cell.isError !== undefined && typeof cell.isError !== 'boolean') ||
      (cell.value !== undefined &&
        (!scalar(cell.value) || Boolean(cell.isError) !== record(cell.value)))
    )
      invalid()
    return {
      sheetId: cell.sheetId,
      row: cell.row,
      column: cell.column,
      formatted: cell.formatted,
      isFormula: cell.isFormula,
      ...(cell.value === undefined ? {} : { value: cell.value as Value }),
      ...(cell.number === undefined ? {} : { number: cell.number }),
      ...(cell.isError ? { isError: true } : {}),
    }
  })
  return {
    cells,
    ...(input.cacheWritebackAllowed === undefined
      ? {}
      : { cacheWritebackAllowed: input.cacheWritebackAllowed }),
    ...(input.calculationCompleteness === undefined
      ? {}
      : { calculationCompleteness: input.calculationCompleteness }),
    ...(input.cacheWritebackReasons === undefined
      ? {}
      : { cacheWritebackReasons: input.cacheWritebackReasons as string[] }),
  }
}
