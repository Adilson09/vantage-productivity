import { describe, expect, it } from 'vitest'
import { editRecalcResultSchema } from '../src/main/xlsx-edit-contract'

function result(cell: Record<string, unknown>) {
  return {
    workbookId: 'document',
    revision: 1,
    cells: [
      {
        sheet: 'Sheet1',
        row: 0,
        column: 0,
        formatted: 'display',
        isFormula: true,
        ...cell,
      },
    ],
  }
}

describe('native edit calculation result raw values', () => {
  it.each([12, '12', true, 'TRUE', '', null, { error: '#DIV/0!' }])(
    'preserves the engine value %j without inferring from display text',
    (value) => {
      expect(editRecalcResultSchema.parse(result({ value })).cells[0]?.value).toEqual(value)
    },
  )

  it('accepts older sidecar results while leaving raw value absent', () => {
    expect(editRecalcResultSchema.parse(result({})).cells[0]?.value).toBeUndefined()
  })

  it.each([{ error: 'x'.repeat(33) }, { error: '#REF!', extra: true }, [], { value: 12 }])(
    'rejects malformed raw values %j',
    (value) => {
      expect(() => editRecalcResultSchema.parse(result({ value }))).toThrow()
    },
  )
})
