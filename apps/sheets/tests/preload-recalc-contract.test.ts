import { describe, expect, it } from 'vitest'
import { parseRecalcResult } from '../src/preload/recalc-contract'

function response(value: unknown) {
  return {
    cells: [
      {
        sheetId: 's',
        row: 0,
        column: 0,
        formatted: 'display',
        isFormula: true,
        value,
        isError: typeof value === 'object' && value !== null && !Array.isArray(value),
      },
    ],
    cacheWritebackAllowed: false,
    calculationCompleteness: 'unverified',
    cacheWritebackReasons: ['unsupported_function'],
  }
}
describe('native calculation across the actual preload contract', () => {
  it.each([12, '12', true, 'TRUE', '', null, { error: '#REF!' }])(
    'retains typed %j and its cache denial',
    (value) => {
      const parsed = parseRecalcResult(response(value))
      expect(parsed.cells[0]!.value).toEqual(value)
      expect(parsed).toMatchObject({
        cacheWritebackAllowed: false,
        calculationCompleteness: 'unverified',
        cacheWritebackReasons: ['unsupported_function'],
      })
    },
  )
  it('keeps older display-only sidecars compatible without inventing permission', () => {
    expect(
      parseRecalcResult({
        cells: [{ sheetId: 's', row: 0, column: 0, formatted: 'TRUE', isFormula: true }],
      }),
    ).toEqual({
      cells: [{ sheetId: 's', row: 0, column: 0, formatted: 'TRUE', isFormula: true }],
    })
  })
  it.each([Number.NaN, Number.POSITIVE_INFINITY, { error: '#REF!', extra: 1 }, [], { error: '' }])(
    'refuses malformed raw %j',
    (value) => {
      expect(() => parseRecalcResult(response(value))).toThrow('Invalid workbook recalc response')
    },
  )
  it('refuses malformed completeness metadata rather than dropping it', () => {
    expect(() => parseRecalcResult({ ...response(1), cacheWritebackAllowed: 'true' })).toThrow()
    expect(() =>
      parseRecalcResult({ ...response(1), calculationCompleteness: 'probably' }),
    ).toThrow()
    expect(() => parseRecalcResult({ ...response(1), cacheWritebackReasons: [42] })).toThrow()
  })
  it('rejects contradictory typed errors', () => {
    expect(() =>
      parseRecalcResult({
        cells: [
          {
            sheetId: 's',
            row: 0,
            column: 0,
            formatted: '#REF!',
            isFormula: true,
            value: { error: '#REF!' },
            isError: false,
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      parseRecalcResult({
        cells: [
          {
            sheetId: 's',
            row: 0,
            column: 0,
            formatted: '#REF!',
            isFormula: true,
            value: '#REF!',
            isError: true,
          },
        ],
      }),
    ).toThrow()
  })
})
