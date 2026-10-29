import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'

const binary = fileURLToPath(new URL(`../native/xlsx-engine/target/release/xlsx-sidecar${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
type Case = { formula: string; a: number; b: number; expected: number | string; formatted?: string; error?: boolean; category: string }
function corpus(): Case[] {
  const cases: Case[] = []
  for (let sample = 0; sample < 100; sample++) {
    const a = (sample * 37) % 97 + 1, b = (sample * 19) % 53 + 2
    const row = (): number => cases.length + 1
    const add = (category: string, formula: string, expected: number | string, extra: Partial<Case> = {}): void => { cases.push({ category, formula, expected, a, b, ...extra }) }
    add('arithmetic', `=A${row()}+B${row()}`, a + b)
    add('sum-range', `=SUM(A${row()}:B${row()})`, a + b)
    add('average', `=AVERAGE(A${row()},B${row()},3)`, (a + b + 3) / 3)
    add('product', `=PRODUCT(A${row()},B${row()})`, a * b)
    const rounded = Math.round((a / 7 + Number.EPSILON) * 100) / 100
    add('financial-rounding', `=ROUND(A${row()}/7,2)`, rounded, { formatted: rounded.toFixed(2) })
    add('logical-if', `=IF(A${row()}>B${row()},"above","below")`, a > b ? 'above' : 'below')
    add('logical-boolean', `=AND(A${row()}>0,B${row()}>0)`, 'TRUE')
    add('text', `=LEFT("Vantage${sample}",7)`, 'Vantage')
    const day = sample % 27 + 1
    add('date-serial', `=DATE(2024,3,${day})`, (Date.UTC(2024, 2, day) - Date.UTC(1899, 11, 30)) / 86400000)
    add('error-recovery', `=IFERROR(1/0,A${row()})`, a)
    add('financial-pmt', `=PMT(0,12,-A${row()}*12)`, a)
    add('typed-error', '=1/0', '#DIV/0!', { error: true })
  }
  return cases
}

async function blankWorkbook(cases: Case[]): Promise<Buffer> {
  const zip = new JSZip()
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  zip.file('xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
  zip.file('xl/styles.xml', `<styleSheet xmlns="${ns}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${ns}"><dimension ref="A1:C${cases.length}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${cases.map((c, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>0</v></c><c r="B${index + 1}"><v>0</v></c><c r="C${index + 1}"${c.formatted ? ' s="1"' : ''}><v>0</v></c></row>`).join('')}</sheetData></worksheet>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

describe.skipIf(!existsSync(binary))('1,200 deterministic live native calculations', () => {
  it('evaluates fresh formulas with independent mathematical, typed and financial display expectations', async () => {
    const cases = corpus()
    const directory = await mkdtemp(join(tmpdir(), 'vantage-live-calculation-'))
    const path = join(directory, 'live.xlsx')
    await writeFile(path, await blankWorkbook(cases))
    const client = new XlsxSidecarClient(binary)
    try {
      const edits = cases.flatMap((c, row) => [{ sheet: 'Data', row, column: 0, input: String(c.a) }, { sheet: 'Data', row, column: 1, input: String(c.b) }, { sheet: 'Data', row, column: 2, input: c.formula }])
      const reads = [{ sheet: 'Data', range: { startRow: 0, endRow: cases.length - 1, startColumn: 2, endColumn: 2 } }]
      const result = await client.recalcCells({ path, edits, reads }) as { cached: boolean; cells: { row: number; number?: number; formatted: string; isError: boolean; isFormula: boolean }[] }
      expect(result.cached).toBe(false)
      expect(result.cells).toHaveLength(1200)
      for (const cell of result.cells) {
        const expected = cases[cell.row]!
        expect(cell.isFormula, `${cell.row + 1} ${expected.category}`).toBe(true)
        if (typeof expected.expected === 'number') {
          expect(typeof cell.number, `${expected.category} ${expected.formula}`).toBe('number')
          const tolerance = Math.max(1e-9, Math.abs(expected.expected) * 1e-9)
          expect(Math.abs(cell.number! - expected.expected), `${expected.category} ${expected.formula}`).toBeLessThanOrEqual(tolerance)
        } else expect(cell.formatted, `${expected.category} ${expected.formula}`).toBe(expected.expected)
        expect(cell.isError).toBe(expected.error ?? false)
        if (expected.formatted !== undefined) expect(cell.formatted).toBe(expected.formatted)
      }
      // A second request changes a dependency in the resident live model.
      const changed = edits.map((e) => e.row === 0 && e.column === 0 ? { ...e, input: '999' } : e)
      const refreshed = await client.recalcCells({ path, edits: changed, reads: [{ sheet: 'Data', range: { startRow: 0, endRow: 0, startColumn: 2, endColumn: 2 } }] }) as { cached: boolean; cells: { number?: number }[] }
      expect(refreshed.cached).toBe(true)
      expect(refreshed.cells[0]?.number).toBe(999 + cases[0]!.b)
      if (process.env.VANTAGE_CORPUS_FIXTURES) await writeFile(process.env.VANTAGE_CORPUS_FIXTURES, JSON.stringify({ caseCount: cases.length, cases: cases.map((item, row) => ({ row: row + 1, ...item, native: result.cells.find((cell) => cell.row === row) })) }, null, 2))
      if (process.env.VANTAGE_ACCEPTANCE_OUT) await writeFile(process.env.VANTAGE_ACCEPTANCE_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), binary, binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), caseCount: cases.length, categories: [...new Set(cases.map((c) => c.category))], reference: 'Independent exact arithmetic/date/text/error/zero-rate-finance expectations, not an installed Excel reference run.', liveDependencyRefresh: true, passed: true }, null, 2))
    } finally {
      client.stop()
      if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error('Unsafe fixture cleanup path.')
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 60000)
})
