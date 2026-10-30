import { describe, expect, it } from 'vitest'

import { shiftFormulaText, StructuralShiftError } from '../src/gateway/xlsx-structure'
import {
  formulaReferencesSheet,
  invalidateSheetInFormula,
  invalidateSheetReferencesInChart,
  invalidateSheetReferencesInDefinedNames,
  invalidateSheetReferencesInWorksheet,
  renameSheetInFormula,
  SheetEditError,
} from '../src/gateway/xlsx-sheets'

function remove(
  formula: string,
  axis: 'row' | 'column',
  first: number,
  count: number,
  qualifiedOnly = false,
): string {
  return shiftFormulaText(
    formula,
    'Data',
    {
      boundary: first,
      delta: -count,
      deleted: { start: first, end: first + count - 1 },
    },
    axis,
    qualifiedOnly,
  )
}

describe('A1 structural deletion reference policy', () => {
  it.each([
    ['left endpoint', '=SUM($A$2:B6)', 1, 2, '=SUM($A$2:B4)'],
    ['right endpoint', '=SUM($A$2:B6)', 4, 2, '=SUM($A$2:B4)'],
    ['interior', '=SUM($A$2:B6)', 2, 2, '=SUM($A$2:B4)'],
    ['all rows', '=SUM($A$2:B6)', 1, 5, '=SUM(#REF!)'],
    ['before', '=SUM($A$2:B6)', 0, 1, '=SUM($A$1:B5)'],
    ['after', '=SUM($A$2:B6)', 8, 2, '=SUM($A$2:B6)'],
    ['reversed range', '=SUM(B6:$A$2)', 2, 2, '=SUM(B4:$A$2)'],
    ['spaced range', '=SUM(A2 : A6)', 1, 2, '=SUM(A2:A4)'],
  ] as const)('shrinks or invalidates rows: %s', (_label, formula, first, count, expected) => {
    expect(remove(formula, 'row', first, count)).toBe(expected)
  })

  it.each([
    ['left endpoint', '=SUM($B$2:F6)', 1, 2, '=SUM($B$2:D6)'],
    ['right endpoint', '=SUM($B$2:F6)', 4, 2, '=SUM($B$2:D6)'],
    ['interior', '=SUM($B$2:F6)', 2, 2, '=SUM($B$2:D6)'],
    ['all columns', '=SUM($B$2:F6)', 1, 5, '=SUM(#REF!)'],
    ['before', '=SUM($B$2:F6)', 0, 1, '=SUM($A$2:E6)'],
    ['after', '=SUM($B$2:F6)', 8, 2, '=SUM($B$2:F6)'],
    ['reversed range', '=SUM(F6:$B$2)', 2, 2, '=SUM(D6:$B$2)'],
  ] as const)('shrinks or invalidates columns: %s', (_label, formula, first, count, expected) => {
    expect(remove(formula, 'column', first, count)).toBe(expected)
  })

  it('preserves operators, absolute markers, whole axes and unaffected sheet references', () => {
    expect(remove('=IF(A2>0,SUM($2:$6)+Data!$A$2+Report!A2,0)', 'row', 1, 5)).toBe(
      '=IF(#REF!>0,SUM(#REF!)+Data!#REF!+Report!A2,0)',
    )
    expect(remove('=SUM($B:$F)+A1+Data!B2+Report!B2', 'column', 1, 5)).toBe(
      '=SUM(#REF!)+A1+Data!#REF!+Report!B2',
    )
    expect(remove('=SUM(B:F)+SUM(2:6)', 'column', 2, 2)).toBe('=SUM(B:D)+SUM(2:6)')
    expect(remove('=SUM(B:F)+SUM(2:6)', 'row', 2, 2)).toBe('=SUM(B:F)+SUM(2:4)')
    expect(remove('=SUM($2 : $6)+SUM($B : $F)', 'row', 1, 5)).toBe('=SUM(#REF!)+SUM($B : $F)')
    expect(remove('=A2+Data!A2+Report!A2', 'row', 1, 1, true)).toBe('=A2+Data!#REF!+Report!A2')
    expect(remove('=sum(a2:a6)+data!b2', 'row', 1, 2)).toBe('=sum(A2:A4)+data!#REF!')
  })

  it('retains #REF! across later operations and treats off-grid names as names', () => {
    expect(remove('=Data!#REF!+A2', 'row', 1, 1)).toBe('=Data!#REF!+#REF!')
    expect(remove('=XFE1+A0+A1048577+LOG10(A2)', 'row', 1, 1)).toBe(
      '=XFE1+A0+A1048577+LOG10(#REF!)',
    )
    expect(
      shiftFormulaText('=A1048576+XFD1', 'Data', { boundary: 0, delta: 1, deleted: null }, 'row'),
    ).toBe('=#REF!+XFD2')
    expect(
      shiftFormulaText(
        '=XFD1+SUM(XFD:XFD)',
        'Data',
        { boundary: 0, delta: 1, deleted: null },
        'column',
      ),
    ).toBe('=#REF!+SUM(#REF!)')
  })

  it('keeps strings, structured-column names, and complete external operands unchanged', () => {
    const protectedText =
      '="A2 ""Data!A2"""&Table1[Q1]&Table1[[#Headers],[A2]]&[Book.xlsx]Data!A2&\'[Book.xlsx]Data\'!A2'
    expect(remove(`${protectedText}&Data!A2`, 'row', 1, 1)).toBe(`${protectedText}&Data!#REF!`)
    expect(remove('=Table1[ A2 ]+Table1[@A2]+SUM([A2])+Data!A2', 'row', 1, 1)).toBe(
      '=Table1[ A2 ]+Table1[@A2]+SUM([A2])+Data!#REF!',
    )
    expect(
      shiftFormulaText(
        '=\'Re"port\'!A2+"A2"',
        'Re"port',
        {
          boundary: 1,
          delta: -1,
          deleted: { start: 1, end: 1 },
        },
        'row',
      ),
    ).toBe('=\'Re"port\'!#REF!+"A2"')
  })

  it.each([
    '=Sheet1:Data!A2',
    "='Sheet1:Data'!A2",
    '=Data!A1:Data!A3',
    '=A1:Data!A3',
    '=Data!A:Data!C',
    '=Data!2:Data!6',
    '=Data !A2',
    '=Data! A2',
    '=A2#',
    '=SUM(Table1[Q1]:A3)',
    '=SUM(MyRange:A3)',
    '=SUM(INDIRECT("A1"):A3)',
    '=SUM(A1:OFFSET(A2,1,0))',
  ])('refuses unsupported reference syntax without partial rewriting: %s', (formula) => {
    expect(() => remove(formula, 'row', 1, 1)).toThrow(StructuralShiftError)
  })
})

describe('sheet deletion A1 invalidation', () => {
  it('replaces deleted sheet operands and preserves unrelated formulas and literals', () => {
    expect(
      invalidateSheetInFormula(
        '=SUM(Data!$A$1:$B$6)+Data!B:B+Data!2:6+Report!A1+"Data!A1"',
        'Data',
      ),
    ).toBe('=SUM(#REF!)+#REF!+#REF!+Report!A1+"Data!A1"')
    expect(invalidateSheetInFormula('=Data!#REF!+data!a1', 'Data')).toBe('=#REF!+#REF!')
    expect(invalidateSheetInFormula("='Bob''s Data'!A1", "Bob's Data")).toBe('=#REF!')
    expect(invalidateSheetInFormula("='Re\"port'!A1", 'Re"port')).toBe('=#REF!')
    const external = "=[Book.xlsx]Data!A1+'[Book.xlsx]Data'!A1+Table1[Data!A1]"
    expect(invalidateSheetInFormula(`${external}+Data!A1`, 'Data')).toBe(`${external}+#REF!`)
    expect(invalidateSheetInFormula('=#REF!', 'REF')).toBe('=#REF!')
    expect(() => invalidateSheetInFormula('=123!ScopedName', '123')).toThrow(SheetEditError)
  })

  it.each([
    '=Data!LocalName',
    '=Sheet1:Data!A1',
    "='Sheet1:Data'!A1",
    '=Data!A1:Data!B2',
    '=Data!A1#',
    '=Data!XFE1',
  ])('refuses unsupported local references: %s', (formula) => {
    expect(() => invalidateSheetInFormula(formula, 'Data')).toThrow(SheetEditError)
  })

  it('keeps sheet discovery and rename aware of protected tokens and quoted names', () => {
    expect(formulaReferencesSheet('=[Book]Data!A1+"Data!A1"+Table1[Data!A1]', 'Data')).toBe(false)
    expect(formulaReferencesSheet('=Data!LocalName', 'Data')).toBe(true)
    expect(renameSheetInFormula('=\'Re"port\'!A1+"A1"', 'Re"port', 'New Name')).toBe(
      '=\'New Name\'!A1+"A1"',
    )
    expect(renameSheetInFormula('=[Book]Data!A1+Data!A1', 'Data', 'Renamed')).toBe(
      '=[Book]Data!A1+Renamed!A1',
    )
  })

  it('rewrites worksheet formula families and hyperlink anchors without swallowing shared followers', () => {
    const source =
      '<worksheet><sheetData><row><c r="A1"><f t="shared" si="0"/><v>1</v></c>' +
      '<c r="B1"><f>Data!A1&amp;"Data!A1"</f></c></row></sheetData>' +
      '<conditionalFormatting><cfRule><formula>Data!A1&gt;0</formula></cfRule></conditionalFormatting>' +
      '<dataValidation><formula1>Data!A1:A3</formula1><formula2>Report!A1</formula2></dataValidation>' +
      '<hyperlink ref="A1" location="Data!$A$1" display="go"/></worksheet>'
    const result = invalidateSheetReferencesInWorksheet(source, 'Data')
    expect(result).toContain('<f t="shared" si="0"/><v>1</v>')
    expect(result).toContain('<f>#REF!&amp;"Data!A1"</f>')
    expect(result).toContain('<formula>#REF!&gt;0</formula>')
    expect(result).toContain('<formula1>#REF!</formula1><formula2>Report!A1</formula2>')
    expect(result).toContain('location="#REF!" display="go"')
  })

  it('rewrites chart and surviving name operands while leaving names scoped to deleted sheets alone', () => {
    expect(
      invalidateSheetReferencesInChart(
        '<c:chart><c:f>Data!$A$1:$A$3</c:f><c:f>Report!A1</c:f></c:chart>',
        'Data',
      ),
    ).toBe('<c:chart><c:f>#REF!</c:f><c:f>Report!A1</c:f></c:chart>')
    const source =
      '<workbook><definedNames><definedName name="global" comment="one > zero">Data!$A$1</definedName>' +
      '<definedName name="surviving" localSheetId="1">Data!$A$1:$A$5</definedName>' +
      '<definedName name="removed" localSheetId="0">Data!UnsupportedName</definedName>' +
      '</definedNames></workbook>'
    const result = invalidateSheetReferencesInDefinedNames(source, 'Data', new Set([0]))
    expect(result).toContain('<definedName name="global" comment="one > zero">#REF!</definedName>')
    expect(result).toContain('<definedName name="surviving" localSheetId="1">#REF!</definedName>')
    expect(result).toContain(
      '<definedName name="removed" localSheetId="0">Data!UnsupportedName</definedName>',
    )
  })
})
