import { describe, expect, it } from 'vitest'
import { nativeCalculationValue } from '../src/renderer/native-calculation-value'
import { workbookRecalcResultSchema } from '../src/shared/desktop-api'

describe('typed native calculation bridge', () => {
  it.each([true, false, 12, '12', 'TRUE', '', null])(
    'keeps raw %j distinct from its display text',
    (value) => {
      const cell = workbookRecalcResultSchema.parse({
        cells: [
          { sheetId: 's', row: 0, column: 0, formatted: 'display text', value, isFormula: true },
        ],
      }).cells[0]!
      expect(nativeCalculationValue(cell)).toBe(value)
    },
  )
  it('uses a scalar error token for the grid and preserves legacy display fallback', () => {
    expect(nativeCalculationValue({ value: { error: '#REF!' }, formatted: 'display' })).toBe(
      '#REF!',
    )
    expect(nativeCalculationValue({ number: 0.25, formatted: '25%' })).toBe(0.25)
    expect(nativeCalculationValue({ formatted: 'TRUE' })).toBe('TRUE')
  })
})
