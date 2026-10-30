/** Real Rust + OOXML adapter acceptance; never opens a desktop or user workbook. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicCopyFile, atomicWriteFile } from '@vantage/electron-utils/atomic-write'
import {
  decryptOoxml,
  encryptOoxml,
  isEncryptedOoxml,
} from '../../../packages/electron-utils/src/ooxml-encryption'
import {
  listRecoveryEntries,
  readRecoveryEntry,
} from '../../../packages/electron-utils/src/recovery-vault'
import {
  emptyDocumentPayload,
  type WorkbookDocumentPayload,
} from '../src/shared/document-checkpoint'
import {
  SpreadsheetDocumentBackend,
  type SpreadsheetNativeClient,
} from '../src/main/spreadsheet-document-backend'
import { withNativeSaveRecovery } from '../src/main/save-recovery'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
import { buildEditFixture, buildMacroFixture, macroVbaProjectPayload } from './fixture-builder'

const binary = process.env.SHEET_BACKEND_TEST_BINARY
const suite = binary ? describe : describe.skip
const oneCell = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }
let root: string
let client: XlsxSidecarClient
let backend: SpreadsheetDocumentBackend
let oldVault: string | undefined
let oldExclude: string | undefined

async function fixture(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await buildEditFixture())
  zip.file(
    'xl/styles.xml',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B4"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="1"><c r="A1" s="1"><v>10</v></c><c r="B1"><f>A1*2</f><v>20</v></c></row><row r="2"><c r="A2" t="b"><f>A1&gt;0</f><v>1</v></c><c r="B2" t="str"><f>"TRUE"</f><v>TRUE</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>12</t></is></c><c r="B3" t="b"><f>ISTEXT(A3)</f><v>1</v></c></row><row r="4"><c r="A4" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>',
  )
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir && name.endsWith('.xml'))
      zip.file(name, (await entry.async('string')).replace(/>\s+</g, '><').trim())
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function createBackend(native: SpreadsheetNativeClient = client): SpreadsheetDocumentBackend {
  return new SpreadsheetDocumentBackend({
    client: native,
    privateRoot: join(root, 'private'),
    tempRoot: join(root, 'temp'),
    atomicCopyFile,
    atomicWriteFile,
    encryptOoxml,
    decryptOoxml,
    withNativeSaveRecovery,
  })
}
async function source(name = 'source.xlsx', bytes?: Buffer): Promise<string> {
  const path = join(root, name)
  await writeFile(path, bytes ?? (await fixture()))
  return path
}
function changed(
  sheetId: string,
  value: string | number | boolean | null,
): WorkbookDocumentPayload {
  return {
    ...emptyDocumentPayload(),
    edits: [{ sheetId, row: 0, column: 0, writeValue: true, value }],
  }
}
async function xml(path: string, name = 'xl/worksheets/sheet1.xml'): Promise<string> {
  return (await JSZip.loadAsync(await readFile(path))).file(name)!.async('string')
}

suite('complete backend against the real native process', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vantage-document-native-'))
    await mkdir(join(root, 'temp'))
    oldVault = process.env.VANTAGE_RECOVERY_ROOT
    oldExclude = process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT
    process.env.VANTAGE_RECOVERY_ROOT = join(root, 'vault')
    process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT = join(root, 'private')
    client = new XlsxSidecarClient(binary!)
    backend = createBackend()
  })
  afterEach(async () => {
    await backend?.shutdown()
    client?.stop()
    if (oldVault === undefined) delete process.env.VANTAGE_RECOVERY_ROOT
    else process.env.VANTAGE_RECOVERY_ROOT = oldVault
    if (oldExclude === undefined) delete process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT
    else process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT = oldExclude
    if (root) {
      const checked = resolve(root)
      if (
        !basename(checked).startsWith('vantage-document-native-') ||
        relative(resolve(tmpdir()), checked).startsWith('..')
      )
        throw new Error('Unexpected test cleanup path')
      await rm(checked, { recursive: true, force: true })
    }
  })

  it('calculates a pinned revision and saves its typed derived cache for reopening', async () => {
    const original = await source()
    const handle = await backend.open(original)
    const sheetId = handle.sheets[0]!.id
    const receipt = await backend.checkpoint(handle, changed(sheetId, 21), {
      commandId: 'typed-calc',
      expectedRevision: 0,
    })
    const calculated = await backend.recalculate(
      handle,
      [{ sheet: 'Data', range: { ...oneCell, endRow: 3, endColumn: 1 } }],
      receipt.revision,
    )
    expect(calculated.cells.find((cell) => cell.row === 0 && cell.column === 1)).toMatchObject({
      value: 42,
      number: 42,
      isFormula: true,
    })
    expect(calculated.cells.find((cell) => cell.row === 1 && cell.column === 0)?.value).toBe(true)
    expect(calculated.cells.find((cell) => cell.row === 1 && cell.column === 1)?.value).toBe('TRUE')
    expect(calculated.cells.find((cell) => cell.row === 3 && cell.column === 0)?.value).toEqual({
      error: '#DIV/0!',
    })
    expect((await backend.snapshot(handle)).revision).toBe(receipt.revision)
    const target = join(root, 'calculated.xlsx')
    const saved = await backend.save(handle, target)
    expect(saved.audit).toMatchObject({ preserved: true, violations: [] })
    expect(await xml(target)).toMatch(/<c r="B1"[^>]*><f>A1\*2<\/f><v>42<\/v><\/c>/)
    expect(saved.handle).not.toBeNull()
    const reopened = await backend.readRange(saved.handle!, {
      sheetId: saved.handle!.sheets[0]!.id,
      range: { ...oneCell, endColumn: 1 },
    })
    expect(reopened.result).toMatchObject({
      cells: expect.arrayContaining([expect.objectContaining({ row: 0, column: 1, value: 42 })]),
    })
    expect(await xml(original)).toContain('<v>10</v>')
  }, 120_000)

  it('restores a complete acknowledged checkpoint after the helper and owner restart, and discards it explicitly', async () => {
    const original = await source()
    const handle = await backend.open(original)
    const payload = changed(handle.sheets[0]!.id, '12')
    payload.edits[0] = { ...payload.edits[0]!, style: { bold: true, numberFormat: '0.00' } }
    payload.noteStates = [
      {
        sheetId: handle.sheets[0]!.id,
        notes: [{ row: 1, column: 0, text: 'Recovery note', author: 'Test' }],
      },
    ]
    const receipt = await backend.checkpoint(handle, payload, { commandId: 'recover-all' })
    expect(receipt.durable).toBe(true)
    await backend.shutdown()
    client.stop()
    client = new XlsxSidecarClient(binary!)
    backend = createBackend()
    const candidates = await backend.candidates(original)
    expect(candidates.map((candidate) => candidate.id)).toContain(receipt.candidateId)
    const recovered = await backend.recover(receipt.candidateId!, original)
    expect((await backend.snapshot(recovered)).payload).toEqual(payload)
    const target = join(root, 'recovered.xlsx')
    await backend.save(recovered, target)
    expect(await xml(target)).toContain('<t>12</t>')
    expect(await xml(original)).toContain('<v>10</v>')
    expect(await backend.candidates(original)).toEqual([])
    const next = await backend.open(original)
    await backend.checkpoint(next, changed(next.sheets[0]!.id, 88))
    await backend.close(next, { discard: true })
    expect(await backend.candidates(original)).toEqual([])
  }, 120_000)

  it('audits before publication and preserves the target and recoverable edits if the audit fails', async () => {
    const original = await source()
    const handle = await backend.open(original)
    const before = await readFile(original)
    const receipt = await backend.checkpoint(handle, changed(handle.sheets[0]!.id, 99))
    const audit = client.auditPreservation.bind(client)
    client.auditPreservation = async () => ({
      preserved: false,
      violations: [{ reason: 'synthetic preserved-part mismatch' }],
    })
    await expect(backend.save(handle, original, { overwrite: true })).rejects.toMatchObject({
      code: 'preservation_failed',
    })
    client.auditPreservation = audit
    expect(await readFile(original)).toEqual(before)
    expect((await backend.snapshot(handle)).revision).toBe(receipt.revision)
    await backend.close(handle)
    expect((await backend.candidates(original)).map((candidate) => candidate.id)).toContain(
      receipt.candidateId,
    )
  }, 120_000)

  it('publishes structure and dependent names and tables together while retaining opaque parts', async () => {
    const original = await source()
    const handle = await backend.open(original)
    const sheetId = handle.sheets[0]!.id
    const payload: WorkbookDocumentPayload = {
      ...emptyDocumentPayload(),
      structuralOps: [{ sheetId, kind: 'insert-rows', index: 1, count: 1 }],
      sheetOps: [{ kind: 'rename-sheet', sheetId, newName: 'Budget' }],
      sheetOrder: [sheetId],
      edits: [
        { sheetId, row: 0, column: 2, writeValue: true, value: 'Category' },
        { sheetId, row: 0, column: 3, writeValue: true, value: 'Amount' },
        { sheetId, row: 1, column: 2, writeValue: true, value: 'Travel' },
        { sheetId, row: 1, column: 3, writeValue: true, value: 40 },
      ],
      tableAdditions: [
        {
          sheetId,
          area: { startRow: 0, endRow: 1, startColumn: 2, endColumn: 3 },
          name: 'Expenses',
          columnNames: ['Category', 'Amount'],
          bandedRows: true,
        },
      ],
      definedNamesState: {
        names: [{ name: 'Amount', formula: 'Budget!$D$2' }],
        preserveNames: ['Total'],
      },
    }
    await backend.checkpoint(handle, payload)
    const target = join(root, 'structured.xlsx')
    const saved = await backend.save(handle, target)
    expect(saved.audit).toMatchObject({ preserved: true, violations: [] })
    const zip = await JSZip.loadAsync(await readFile(target))
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('name="Budget"')
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('Budget!$D$2')
    expect(await zip.file('xl/tables/table1.xml')!.async('string')).toContain('ref="C1:D2"')
    expect(await zip.file('customXml/item1.xml')!.async('string')).toBe(
      '<compatibility-marker value="must-survive"/>',
    )
  }, 120_000)

  it('preserves macro bytes and package type on an ordinary XLSM save', async () => {
    const original = await source('macro.xlsm', await buildMacroFixture())
    const handle = await backend.open(original)
    await backend.checkpoint(handle, changed(handle.sheets[0]!.id, 'updated'))
    await expect(backend.save(handle, join(root, 'macro-disguised.xlsx'))).rejects.toMatchObject({
      code: 'save_format_mismatch',
    })
    const target = join(root, 'macro-saved.xlsm')
    await backend.save(handle, target)
    const zip = await JSZip.loadAsync(await readFile(target))
    expect(await zip.file('xl/vbaProject.bin')!.async('nodebuffer')).toEqual(macroVbaProjectPayload)
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain(
      'macroEnabled.main+xml',
    )
  }, 120_000)

  it('rebinds a pivot on a newly created worksheet before publishing the completed package', async () => {
    const original = await source()
    const handle = await backend.open(original)
    const sheetId = handle.sheets[0]!.id
    const pendingId = 'pending-summary'
    const area = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }
    await backend.checkpoint(handle, {
      ...emptyDocumentPayload(),
      sheetOps: [{ kind: 'add-sheet', sheetId: pendingId, name: 'Summary' }],
      sheetOrder: [sheetId, pendingId],
      edits: [
        ...[
          ['Category', 'Amount'],
          ['Travel', 120],
          ['Meals', 35],
        ].flatMap((row, r) =>
          row.map((value, column) => ({ sheetId, row: r, column, writeValue: true, value })),
        ),
        ...[
          ['Category', 'Sum of Amount'],
          ['Travel', 120],
          ['Meals', 35],
          ['Grand Total', 155],
        ].flatMap((row, r) =>
          row.map((value, column) => ({
            sheetId: pendingId,
            row: r,
            column,
            writeValue: true,
            value,
          })),
        ),
      ],
      pivotAdditions: [
        {
          sheetId: pendingId,
          sourceSheetId: sheetId,
          sourceArea: area,
          location: { ...area, endRow: 3 },
          name: 'ExpenseSummary',
          fieldNames: ['Category', 'Amount'],
          rowFieldIndices: [0],
          rowItems: ['Travel', 'Meals'],
          values: [{ fieldIndex: 1, agg: 'sum' }],
        },
      ],
    })
    const target = join(root, 'new-sheet-pivot.xlsx')
    const saved = await backend.save(handle, target)
    expect(saved.audit).toMatchObject({ preserved: true, violations: [] })
    expect(saved.handle?.sheets.map((sheet) => sheet.name)).toEqual(['Data', 'Summary'])
    const visible = await backend.readRange(saved.handle!, {
      sheetId: saved.handle!.sheets.find((sheet) => sheet.name === 'Summary')!.id,
      range: { ...area, endRow: 3 },
    })
    expect(visible.result).toMatchObject({
      cells: expect.arrayContaining([expect.objectContaining({ row: 3, column: 1, value: 155 })]),
    })
    const zip = await JSZip.loadAsync(await readFile(target))
    expect(await zip.file('xl/pivotTables/pivotTable1.xml')!.async('string')).toContain(
      'ExpenseSummary',
    )
    // A Pivot Table part has an implicit worksheet relationship, rather than
    // a worksheet <pivotPart> element (OOXML Part 1, section 12.3.11).
    const destinationRelationships = await zip
      .file('xl/worksheets/_rels/sheet2.xml.rels')!
      .async('string')
    expect(destinationRelationships).toContain('/relationships/pivotTable')
    expect(destinationRelationships).toContain('../pivotTables/pivotTable1.xml')
    const sourceRelationships =
      (await zip.file('xl/worksheets/_rels/sheet1.xml.rels')?.async('string')) ?? ''
    expect(sourceRelationships).not.toContain('/relationships/pivotTable')
    const cache = await zip.file('xl/pivotCache/pivotCacheDefinition1.xml')!.async('string')
    expect(cache).toContain('sheet="Data"')
    expect(cache).toContain('ref="A1:B3"')
  }, 120_000)

  it('withholds an unsupported dependency hidden by IFERROR outside the requested viewport', async () => {
    const zip = await JSZip.loadAsync(await fixture())
    const sheet = (await zip.file('xl/worksheets/sheet1.xml')!.async('string'))
      .replace('<f>A1*2</f><v>20</v>', '<f>IFERROR(A5,0)</f><v>777</v>')
      .replace(
        '</sheetData>',
        '<row r="5"><c r="A5"><f>NOT_YET_SUPPORTED(1)</f><v>777</v></c></row></sheetData>',
      )
    zip.file('xl/worksheets/sheet1.xml', sheet)
    const original = await source(
      'unsupported.xlsx',
      await zip.generateAsync({ type: 'nodebuffer' }),
    )
    const handle = await backend.open(original)
    await backend.checkpoint(handle, changed(handle.sheets[0]!.id, 21))
    const result = await backend.recalculate(handle, [
      { sheet: 'Data', range: { ...oneCell, startColumn: 1, endColumn: 1 } },
    ])
    expect(result).toMatchObject({
      cacheWritebackAllowed: false,
      calculationCompleteness: 'unverified',
      cacheWriteback: 'withheld',
    })
    const target = join(root, 'unsupported-preserved.xlsx')
    await backend.save(handle, target)
    expect(await xml(target)).toContain('<f>IFERROR(A5,0)</f><v>777</v>')
    expect(await xml(target)).not.toContain('<f>IFERROR(A5,0)</f><v>0</v>')
  }, 120_000)

  it('uses memory-only protected checkpoints and puts only encrypted published bytes into the version vault', async () => {
    const password = 'Synthetic-test-password-23'
    const original = await source('protected.xlsx', encryptOoxml(await fixture(), password))
    const handle = await backend.open(original, { password })
    const receipt = await backend.checkpoint(
      handle,
      changed(handle.sheets[0]!.id, 'secret test value'),
    )
    expect(receipt).toMatchObject({ durable: false, candidateId: null })
    await expect(readdir(join(root, 'private'))).rejects.toMatchObject({ code: 'ENOENT' })
    const target = join(root, 'protected-saved.xlsx')
    await backend.save(handle, target)
    const bytes = await readFile(target)
    expect(isEncryptedOoxml(bytes)).toBe(true)
    expect(bytes.includes(Buffer.from('secret test value'))).toBe(false)
    const plain = await decryptOoxml(bytes, password)
    expect((await JSZip.loadAsync(plain)).file('xl/worksheets/sheet1.xml')).not.toBeNull()
    const history = await listRecoveryEntries(join(root, 'vault'))
    expect(history.length).toBeGreaterThan(0)
    expect(history.every((entry) => entry.originalPath === target)).toBe(true)
    for (const entry of history)
      expect(isEncryptedOoxml((await readRecoveryEntry(join(root, 'vault'), entry.id)).bytes)).toBe(
        true,
      )
    expect(await backend.candidates()).toEqual([])
  }, 180_000)

  it('refuses overwriting a changed source while retaining an explicit Save As escape', async () => {
    const original = await source()
    const handle = await backend.open(original)
    await backend.checkpoint(handle, changed(handle.sheets[0]!.id, 71))
    const externallyChanged = Buffer.concat([
      await readFile(original),
      Buffer.from('changed outside this session'),
    ])
    await writeFile(original, externallyChanged)
    await expect(backend.save(handle, original, { overwrite: true })).rejects.toMatchObject({
      code: 'source_conflict',
    })
    expect(await readFile(original)).toEqual(externallyChanged)
    await backend.save(handle, join(root, 'separate.xlsx'))
    expect(await readFile(original)).toEqual(externallyChanged)
  }, 120_000)
})
