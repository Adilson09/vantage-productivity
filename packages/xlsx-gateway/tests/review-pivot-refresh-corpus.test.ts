import { describe, expect, it } from 'vitest'
import { recomputePivotData } from '../src/domain/pivot-engine'
import { buildPivotLayout } from '../src/domain/pivot-layout'
import type { PivotAggregation } from '../src/domain/pivot-value-modes'
import { buildCacheDefinitionXml, buildPivotTableXml, type PivotAddition } from '../src/gateway/xlsx-pivot-add'
import { parsePivotDefinition } from '../src/gateway/xlsx-pivot'

// Exact independent expectations for the changed source values {3,6,9}.
// The native pivot writer/parser and the live refresh path both participate.
const fixtures: { aggregation: PivotAggregation; expected: number }[] = [
  { aggregation: 'sum', expected: 18 }, { aggregation: 'count', expected: 3 },
  { aggregation: 'countNums', expected: 3 }, { aggregation: 'average', expected: 6 },
  { aggregation: 'min', expected: 3 }, { aggregation: 'max', expected: 9 },
  { aggregation: 'product', expected: 162 }, { aggregation: 'var', expected: 9 },
  { aggregation: 'stdDev', expected: 3 }, { aggregation: 'varp', expected: 6 },
]

describe('ten changed-source pivot fixtures with OOXML definition round trips', () => {
  for (const { aggregation, expected } of fixtures) it(`refreshes ${aggregation} after changing the source and reopening its generated definition`, () => {
    const addition: PivotAddition = {
      worksheetPath: 'xl/worksheets/sheet1.xml', sourceSheetName: 'Data',
      sourceArea: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 },
      location: { startRow: 0, endRow: 3, startColumn: 5, endColumn: 6 },
      name: `Pivot_${aggregation}`, fieldNames: ['Region', 'Amount'], rowFieldIndices: [0], rowItems: ['East', 'West'],
      values: [{ fieldIndex: 1, agg: aggregation }],
    }
    const cache = buildCacheDefinitionXml('rIdRecords', addition, 3)
    const table = buildPivotTableXml(1, addition)
    const definition = parsePivotDefinition(table, cache)
    expect(definition.unsupported).toEqual([])
    const oldSource = [['Region', 'Amount'], ['East', 2], ['East', 4], ['West', 6]]
    const source = [['Region', 'Amount'], ['East', 3], ['East', 6], ['West', 9]]
    const before = recomputePivotData(definition, oldSource)
    const after = recomputePivotData(definition, source)
    expect(after.data.at(-1)?.[0]).toBeCloseTo(expected, 10)
    if (!['count', 'countNums'].includes(aggregation)) expect(before.data).not.toEqual(after.data)
    const rebuilt = buildPivotLayout(source, { rowFields: ['Region'], values: [{ field: 'Amount', agg: aggregation }] })
    expect(rebuilt.matrix.at(-1)?.[1]).toBeCloseTo(expected, 10)
    // A second definition serialization/reopen must not change refresh output.
    const reopened = parsePivotDefinition(buildPivotTableXml(1, addition), buildCacheDefinitionXml('rIdRecords', addition, 3))
    expect(recomputePivotData(reopened, source).data).toEqual(after.data)
  })
})
