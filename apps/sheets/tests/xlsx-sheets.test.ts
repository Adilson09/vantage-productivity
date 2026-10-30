import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import {
  applyCellEditsToXlsx,
  assertOnlyTouchedEntriesChanged,
  createBufferEntrySource,
  inspectMacroPreservation,
  MacroPreservationError,
  planCellEditsToXlsx,
} from '@vantage/xlsx-gateway/gateway/xlsx-gateway'
import { relsPathFor, resolveRelTarget } from '@vantage/xlsx-gateway/gateway/xlsx-drawing-add'
import {
  classifyRemovedSheetRels,
  definedNamesUseToken,
  formatSheetQualifier,
  partPathForRels,
  parseRelationships,
  pivotCacheReadsFromSheet,
  prepareClonedSheetRels,
  renameSheetInFormula,
  renameSheetInPivotCacheSource,
  sanitizeClonedWorksheetXml,
  SheetEditError,
  stripPageSetupRelIds,
  tableDisplayName,
  validateSheetName,
} from '@vantage/xlsx-gateway/gateway/xlsx-sheets'
import {
  buildCompatibilityFixture,
  buildSatelliteSheetFixture,
  buildSheetsFixture,
} from './fixture-builder'

async function entryText(buffer: Buffer, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return zip.file(path)?.async('text') ?? ''
}

describe('sheet name rules', () => {
  it('accepts ordinary names and rejects forbidden shapes', () => {
    expect(() => validateSheetName('Budget 2026')).not.toThrow()
    expect(() => validateSheetName('')).toThrow(SheetEditError)
    expect(() => validateSheetName('x'.repeat(32))).toThrow(SheetEditError)
    expect(() => validateSheetName('a[b')).toThrow(SheetEditError)
    expect(() => validateSheetName('a:b')).toThrow(SheetEditError)
    expect(() => validateSheetName("'edge")).toThrow(SheetEditError)
  })

  it('quotes qualifiers only when Excel requires it', () => {
    expect(formatSheetQualifier('Data')).toBe('Data')
    expect(formatSheetQualifier('My Sheet')).toBe("'My Sheet'")
    expect(formatSheetQualifier('A1')).toBe("'A1'")
    expect(formatSheetQualifier('TRUE')).toBe("'TRUE'")
    expect(formatSheetQualifier("O'Brien")).toBe("'O''Brien'")
  })
})

describe('renameSheetInFormula', () => {
  it('rewrites qualified references and leaves the rest alone', () => {
    expect(renameSheetInFormula('Data!A1+SUM(Data!B1:B9)+A1', 'Data', 'Numbers')).toBe(
      'Numbers!A1+SUM(Numbers!B1:B9)+A1',
    )
    expect(renameSheetInFormula('\'My Sheet\'!$A$1&"Data!A1"', 'My Sheet', 'Plain')).toBe(
      'Plain!$A$1&"Data!A1"',
    )
    expect(renameSheetInFormula('Other!A1', 'Data', 'Numbers')).toBe('Other!A1')
  })
})

describe('sheet visibility and order save', () => {
  it('writes state="hidden", reorders tabs, and drops calcChain on reorder', async () => {
    const mutation = await applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
      renames: [],
      additions: [],
      removals: [],
      hiddenChanges: [{ sheetName: 'Other', hidden: true }],
      orderChanged: true,
      order: ['My Sheet', 'Data', 'Other'],
    })
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).toContain('<sheet state="hidden" name="Other"')
    const sheetNames = [...workbook.matchAll(/<sheet[^>]*\bname="([^"]+)"/g)].map((m) => m[1])
    expect(sheetNames).toEqual(['My Sheet', 'Data', 'Other'])
  })

  it('unhides by removing the state attribute and rejects hiding every sheet', async () => {
    const source = await buildSheetsFixture()
    await expect(
      applyCellEditsToXlsx(source, [], [], [], {
        renames: [],
        additions: [],
        removals: [],
        hiddenChanges: [
          { sheetName: 'Data', hidden: true },
          { sheetName: 'Other', hidden: true },
          { sheetName: 'My Sheet', hidden: true },
        ],
        order: ['Data', 'Other', 'My Sheet'],
      }),
    ).rejects.toThrow(/at least one visible sheet/)
  })
})

describe('sheet rename save', () => {
  it('renames in workbook.xml and rewrites formulas, chart series, defined names, and hyperlink anchors', async () => {
    const mutation = await applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
      renames: [{ sheetName: 'Data', newName: 'Numbers' }],
      additions: [],
      removals: [],
      order: ['Numbers', 'Other', 'My Sheet'],
    })
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).toContain('<sheet name="Numbers" sheetId="1" r:id="rId1"/>')
    expect(workbook).toContain('<definedName name="GlobalTotal">Numbers!$A$1</definedName>')
    const other = await entryText(mutation.buffer, 'xl/worksheets/sheet2.xml')
    expect(other).toContain("<f>Numbers!A1+SUM('My Sheet'!A1:A2)</f>")
    expect(other).toContain('location="Numbers!A1"')
    const chart = await entryText(mutation.buffer, 'xl/charts/chart1.xml')
    expect(chart).toContain('<c:f>Numbers!$A$1:$A$2</c:f>')
    // The renamed sheet's own content had no self-references; untouched.
    expect(mutation.touchedEntries).not.toContain('xl/worksheets/sheet1.xml')
  })

  it('quotes the new name when needed and unquotes when not', async () => {
    const mutation = await applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
      renames: [{ sheetName: 'My Sheet', newName: 'Plain' }],
      additions: [],
      removals: [],
      order: ['Data', 'Other', 'Plain'],
    })
    const data = await entryText(mutation.buffer, 'xl/worksheets/sheet1.xml')
    expect(data).toContain('<f>Plain!A1*2</f>')
    const other = await entryText(mutation.buffer, 'xl/worksheets/sheet2.xml')
    expect(other).toContain('<f>Data!A1+SUM(Plain!A1:A2)</f>')
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).toContain(
      '<definedName name="LocalMy" localSheetId="2">Plain!$A$1</definedName>',
    )

    const spaced = await applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
      renames: [{ sheetName: 'Data', newName: 'New Data' }],
      additions: [],
      removals: [],
      order: ['New Data', 'Other', 'My Sheet'],
    })
    const spacedOther = await entryText(spaced.buffer, 'xl/worksheets/sheet2.xml')
    expect(spacedOther).toContain("<f>'New Data'!A1+SUM('My Sheet'!A1:A2)</f>")
  })

  it('rejects duplicate and invalid names', async () => {
    await expect(
      applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
        renames: [{ sheetName: 'Data', newName: 'Other' }],
        additions: [],
        removals: [],
        order: ['Other', 'Other', 'My Sheet'],
      }),
    ).rejects.toThrow('same name')
    await expect(
      applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
        renames: [{ sheetName: 'Data', newName: 'bad[name' }],
        additions: [],
        removals: [],
        order: ['bad[name', 'Other', 'My Sheet'],
      }),
    ).rejects.toThrow('forbidden character')
  })
})

describe('sheet add save', () => {
  it('creates the part with its override, relationship, and tab entry, and accepts cell edits', async () => {
    const mutation = await applyCellEditsToXlsx(
      await buildSheetsFixture(),
      [{ sheetName: 'Extra', row: 0, column: 0, writeValue: true, cell: { value: 'hello' } }],
      [],
      [],
      {
        renames: [],
        additions: [{ name: 'Extra' }],
        removals: [],
        order: ['Data', 'Other', 'My Sheet', 'Extra'],
      },
    )
    expect(mutation.addedEntries).toEqual(['xl/worksheets/sheet4.xml'])
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).toContain('<sheet name="Extra" sheetId="4" r:id="rId6"/>')
    const contentTypes = await entryText(mutation.buffer, '[Content_Types].xml')
    expect(contentTypes).toContain('PartName="/xl/worksheets/sheet4.xml"')
    const rels = await entryText(mutation.buffer, 'xl/_rels/workbook.xml.rels')
    expect(rels).toContain('Id="rId6"')
    expect(rels).toContain('Target="worksheets/sheet4.xml"')
    const added = await entryText(mutation.buffer, 'xl/worksheets/sheet4.xml')
    expect(added).toContain('<is><t xml:space="preserve">hello</t></is>')
    // Adding a sheet shifts tab indexes, so calcChain is dropped for rebuild.
    expect(mutation.removedEntries).toContain('xl/calcChain.xml')
  })
})

describe('sheet remove save', () => {
  it('removes the part, its override and relationship, renumbers scoped names, and fixes the active tab', async () => {
    const mutation = await applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
      renames: [],
      additions: [],
      removals: ['Other'],
      order: ['Data', 'My Sheet'],
    })
    expect(mutation.removedEntries).toEqual(['xl/calcChain.xml', 'xl/worksheets/sheet2.xml'])
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const zip = await JSZip.loadAsync(mutation.buffer)
    expect(zip.file('xl/worksheets/sheet2.xml')).toBeNull()
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).not.toContain('name="Other"')
    // The Print_Area scoped to the removed sheet dies with it; the survivor
    // is renumbered from tab 2 to tab 1, as is the active tab.
    expect(workbook).not.toContain('Print_Area')
    expect(workbook).toContain('<definedName name="LocalMy" localSheetId="1">')
    expect(workbook).toContain('activeTab="1"')
    const contentTypes = await entryText(mutation.buffer, '[Content_Types].xml')
    expect(contentTypes).not.toContain('sheet2.xml')
    const rels = await entryText(mutation.buffer, 'xl/_rels/workbook.xml.rels')
    expect(rels).not.toContain('sheet2.xml')
  })

  it('invalidates surviving formulas, chart references and names without losing package relationships or other parts', async () => {
    const relationshipType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
    const relationshipsNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
    const zip = await JSZip.loadAsync(await buildSheetsFixture())
    const otherSource = await zip.file('xl/worksheets/sheet2.xml')!.async('text')
    zip.file(
      'xl/worksheets/sheet2.xml',
      otherSource
        .replace('<worksheet ', `<worksheet xmlns:r="${relationshipType.slice(0, -1)}" `)
        .replace('</worksheet>', '<drawing r:id="drawing1"/></worksheet>'),
    )
    zip.file(
      'xl/worksheets/_rels/sheet2.xml.rels',
      `<Relationships xmlns="${relationshipsNs}">` +
        `<Relationship Id="drawing1" Type="${relationshipType}drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    )
    zip.file(
      'xl/drawings/drawing1.xml',
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
        ` xmlns:r="${relationshipType.slice(0, -1)}">` +
        '<xdr:twoCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
        '<xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
        '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="1" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
        '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic>' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
        '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart1"/>' +
        '</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>',
    )
    zip.file(
      'xl/drawings/_rels/drawing1.xml.rels',
      `<Relationships xmlns="${relationshipsNs}">` +
        `<Relationship Id="chart1" Type="${relationshipType}chart" Target="../charts/chart1.xml"/></Relationships>`,
    )
    const types = await zip.file('[Content_Types].xml')!.async('text')
    zip.file(
      '[Content_Types].xml',
      types.replace(
        '</Types>',
        '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
          '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>',
      ),
    )
    const opaqueXml = '<private xmlns="urn:vantage:test">Preserve &amp; retain exactly.</private>'
    zip.file('customXml/item1.xml', opaqueXml)
    const packageRels = await zip.file('_rels/.rels')!.async('text')
    zip.file(
      '_rels/.rels',
      packageRels.replace(
        '</Relationships>',
        `<Relationship Id="custom1" Type="${relationshipType}customXml" Target="customXml/item1.xml"/></Relationships>`,
      ),
    )
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    const mutation = await applyCellEditsToXlsx(source, [], [], [], {
      renames: [],
      additions: [],
      removals: ['Data'],
      order: ['Other', 'My Sheet'],
    })
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    expect(mutation.removedEntries).toEqual(['xl/calcChain.xml', 'xl/worksheets/sheet1.xml'])
    expect(mutation.addedEntries).toEqual([])
    const saved = await JSZip.loadAsync(mutation.buffer)
    const files = Object.values(saved.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort()
    expect(files).toEqual(
      Object.values(zip.files)
        .filter((entry) => !entry.dir && !mutation.removedEntries.includes(entry.name))
        .map((entry) => entry.name)
        .sort(),
    )
    const other = await saved.file('xl/worksheets/sheet2.xml')!.async('text')
    // Compare every surviving row, including its cached values and text.
    const rows = [...other.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((match) => match[1])
    expect(rows).toEqual([
      '<c r="A1"><f>#REF!+SUM(\'My Sheet\'!A1:A2)</f><v>6</v></c>',
      '<c r="A2" t="inlineStr"><is><t>go</t></is></c>',
    ])
    expect(other).toContain('location="#REF!"')
    expect(other).toContain('<drawing r:id="drawing1"/>')
    expect(await saved.file('xl/charts/chart1.xml')!.async('text')).toContain('<c:f>#REF!</c:f>')
    const workbook = await saved.file('xl/workbook.xml')!.async('text')
    expect(workbook).toContain('<definedName name="GlobalTotal">#REF!</definedName>')
    expect(workbook).toContain(
      '<definedName name="LocalMy" localSheetId="1">\'My Sheet\'!$A$1</definedName>',
    )
    expect(workbook).toContain('fullCalcOnLoad="1"')
    expect(await saved.file('customXml/item1.xml')!.async('text')).toBe(opaqueXml)
    expect(await saved.file('xl/styles.xml')!.async('uint8array')).toEqual(
      await zip.file('xl/styles.xml')!.async('uint8array'),
    )
    for (const rels of Object.values(saved.files).filter(
      (entry) => !entry.dir && entry.name.endsWith('.rels'),
    )) {
      const owner = partPathForRels(rels.name)
      for (const relationship of parseRelationships(await rels.async('text'))) {
        if (!relationship.external)
          expect(
            saved.file(resolveRelTarget(owner, relationship.target)),
            `${rels.name} -> ${relationship.target}`,
          ).not.toBeNull()
      }
    }
  })

  it('also invalidates a deleted quoted sheet name in all surviving sheets', async () => {
    const mutation = await applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
      renames: [],
      additions: [],
      removals: ['My Sheet'],
      order: ['Data', 'Other'],
    })
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    expect(await entryText(mutation.buffer, 'xl/worksheets/sheet1.xml')).toContain('<f>#REF!*2</f>')
    expect(await entryText(mutation.buffer, 'xl/worksheets/sheet2.xml')).toContain(
      '<f>Data!A1+SUM(#REF!)</f>',
    )
  })

  it.each(['Data!ScopedName', 'Data:Other!A1', 'Data!A1#'])(
    'still refuses unsupported surviving references: %s',
    async (formula) => {
      const zip = await JSZip.loadAsync(await buildSheetsFixture())
      const other = await zip.file('xl/worksheets/sheet2.xml')!.async('text')
      zip.file('xl/worksheets/sheet2.xml', other.replace("Data!A1+SUM('My Sheet'!A1:A2)", formula))
      const source = await zip.generateAsync({ type: 'nodebuffer' })
      await expect(
        applyCellEditsToXlsx(source, [], [], [], {
          renames: [],
          additions: [],
          removals: ['Data'],
          order: ['Other', 'My Sheet'],
        }),
      ).rejects.toThrow(/unsupported/)
    },
  )

  it('refuses unpatchable surviving sheets rather than trusting an exact-case raw name scan', async () => {
    const source = await createBufferEntrySource(await buildSheetsFixture())
    await expect(
      planCellEditsToXlsx(
        { ...source, canPatch: async (path) => path !== 'xl/worksheets/sheet2.xml' },
        [],
        [],
        [],
        {
          renames: [],
          additions: [],
          removals: ['Data'],
          order: ['Other', 'My Sheet'],
        },
      ),
    ).rejects.toThrow(/too large to verify/)
  })

  it('refuses to remove the last visible sheet', async () => {
    await expect(
      applyCellEditsToXlsx(await buildCompatibilityFixture(), [], [], [], {
        renames: [],
        additions: [],
        removals: ['Sheet1'],
        order: [],
      }),
    ).rejects.toThrow('visible sheet')
  })

  it('classifies removed-sheet relationships into owned, ignorable, and blocking', () => {
    const rels =
      '<Relationships>' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/>' +
      '</Relationships>'
    expect(classifyRemovedSheetRels(rels, 'Data')).toEqual([
      '../drawings/drawing1.xml',
      '../comments1.xml',
    ])
    const pivotRels =
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>'
    expect(() => classifyRemovedSheetRels(pivotRels, 'Data')).toThrow(/pivot table/)
    const slicerRels =
      '<Relationships><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2007/relationships/slicer" Target="../slicers/slicer1.xml"/></Relationships>'
    expect(() => classifyRemovedSheetRels(slicerRels, 'Data')).toThrow(SheetEditError)
  })

  it('rel-path helpers resolve targets and rels locations', () => {
    expect(resolveRelTarget('xl/worksheets/sheet2.xml', '../drawings/drawing1.xml')).toBe(
      'xl/drawings/drawing1.xml',
    )
    expect(resolveRelTarget('xl/worksheets/sheet2.xml', '../comments1.xml')).toBe(
      'xl/comments1.xml',
    )
    expect(resolveRelTarget('xl/charts/chart1.xml', 'colors1.xml')).toBe('xl/charts/colors1.xml')
    expect(resolveRelTarget('xl/workbook.xml', 'worksheets/sheet%201.xml')).toBe(
      'xl/worksheets/sheet 1.xml',
    )
    expect(resolveRelTarget('xl/worksheets/sheet2.xml', '../media/image%20\u4e00.png')).toBe(
      'xl/media/image \u4e00.png',
    )
    expect(() => resolveRelTarget('xl/workbook.xml', 'worksheets/%ZZ.xml')).toThrow()
    expect(() => resolveRelTarget('xl/workbook.xml', '../../outside.xml')).toThrow()
    expect(relsPathFor('xl/drawings/drawing1.xml')).toBe('xl/drawings/_rels/drawing1.xml.rels')
    expect(partPathForRels('xl/drawings/_rels/drawing1.xml.rels')).toBe('xl/drawings/drawing1.xml')
    expect(partPathForRels('_rels/.rels')).toBe('')
    expect(tableDisplayName('<table id="1" name="T1" displayName="DecoTable" ref="A1:A2"/>')).toBe(
      'DecoTable',
    )
  })

  it('definedNamesUseToken sees surviving names and skips names scoped to removed sheets', () => {
    const scoped =
      '<workbook><definedNames>' +
      '<definedName name="Scoped" localSheetId="1">SUM(DecoTable[Amt])</definedName>' +
      '</definedNames></workbook>'
    expect(definedNamesUseToken(scoped, 'DecoTable[', new Set([1]))).toBe(false)
    expect(definedNamesUseToken(scoped, 'DecoTable[', new Set())).toBe(true)
    const global =
      '<workbook><definedNames>' +
      '<definedName name="Global">SUM(DecoTable[Amt])</definedName>' +
      '</definedNames></workbook>'
    expect(definedNamesUseToken(global, 'DecoTable[', new Set([1]))).toBe(true)
    expect(definedNamesUseToken(global, 'OtherTable[', new Set())).toBe(false)
    // table names are case-insensitive in Excel
    const cased =
      '<workbook><definedNames>' +
      '<definedName name="Global">SUM(decotable[Amt])</definedName>' +
      '</definedNames></workbook>'
    expect(definedNamesUseToken(cased, 'DecoTable[', new Set())).toBe(true)
  })

  it('pivotCacheReadsFromSheet matches the worksheetSource sheet case-insensitively', () => {
    const cache =
      '<pivotCacheDefinition><cacheSource type="worksheet">' +
      '<worksheetSource ref="A1:B9" sheet="P&amp;L Data"/>' +
      '</cacheSource></pivotCacheDefinition>'
    expect(pivotCacheReadsFromSheet(cache, 'P&L Data')).toBe(true)
    expect(pivotCacheReadsFromSheet(cache, 'p&l data')).toBe(true)
    expect(pivotCacheReadsFromSheet(cache, 'Other')).toBe(false)
    expect(pivotCacheReadsFromSheet('<pivotCacheDefinition/>', 'P&L Data')).toBe(false)
  })

  it('renameSheetInPivotCacheSource rewrites only matching sources and encodes the new name', () => {
    const cache =
      '<pivotCacheDefinition><cacheSource type="worksheet">' +
      '<worksheetSource ref="A1:B9" sheet="Data"/>' +
      '</cacheSource></pivotCacheDefinition>'
    expect(renameSheetInPivotCacheSource(cache, 'Data', 'P&L Data')).toContain(
      'sheet="P&amp;L Data"',
    )
    expect(renameSheetInPivotCacheSource(cache, 'Other', 'X')).toBe(cache)
  })

  it('cascade-removes the drawings, charts, images, comments, VML, and tables the sheet owns', async () => {
    const source = await buildSatelliteSheetFixture()
    const inventory = await inspectMacroPreservation(await createBufferEntrySource(source))
    expect(inventory.vbaProject).toBe(false)
    expect(inventory.macroSheets).toBe(false)
    expect(inventory.preservedParts).toEqual([])
    const mutation = await applyCellEditsToXlsx(source, [], [], [], {
      renames: [],
      additions: [],
      removals: ['Deco'],
      order: ['Keep'],
    })
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    expect([...mutation.removedEntries].sort()).toEqual([
      'xl/charts/_rels/chart1.xml.rels',
      'xl/charts/chart1.xml',
      'xl/charts/colors1.xml',
      'xl/comments1.xml',
      'xl/drawings/_rels/drawing1.xml.rels',
      'xl/drawings/drawing1.xml',
      'xl/drawings/vmlDrawing1.vml',
      'xl/media/image1.png',
      'xl/tables/table1.xml',
      'xl/worksheets/_rels/sheet2.xml.rels',
      'xl/worksheets/sheet2.xml',
    ])
    const contentTypes = await entryText(mutation.buffer, '[Content_Types].xml')
    for (const gone of [
      'sheet2.xml',
      'drawing1.xml',
      'chart1.xml',
      'colors1.xml',
      'comments1.xml',
      'table1.xml',
    ]) {
      expect(contentTypes).not.toContain(gone)
    }
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).not.toContain('name="Deco"')
  })

  it.each([
    'unknown VML',
    'VML button',
    'mixed VML',
    'note with macro binding',
    'ActiveX',
  ] as const)('still refuses cascade deletion when %s carries protected bindings', async (kind) => {
    const zip = await JSZip.loadAsync(await buildSatelliteSheetFixture())
    const path = 'xl/drawings/vmlDrawing1.vml'
    const note = await zip.file(path)!.async('text')
    const button =
      '<v:shape id="button"><x:ClientData ObjectType="Button"><x:FmlaMacro>[0]!Synthetic_Click</x:FmlaMacro></x:ClientData></v:shape>'
    if (kind === 'unknown VML') {
      zip.file(
        path,
        '<xml xmlns:v="urn:schemas-microsoft-com:vml"><v:shape id="unknown" type="#_x0000_t202"/></xml>',
      )
    } else if (kind === 'VML button') {
      zip.file(
        path,
        `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel">${button}</xml>`,
      )
    } else if (kind === 'mixed VML') {
      zip.file(path, note.replace('</xml>', `${button}</xml>`))
    } else if (kind === 'note with macro binding') {
      zip.file(
        path,
        note.replace('ObjectType="Note"', 'ObjectType="Note" onClick="Synthetic_Click"'),
      )
    } else {
      zip.file(
        'xl/activeX/activeX1.xml',
        '<ocx xmlns="http://schemas.microsoft.com/office/2006/activeX" classid="inert-test-sentinel"/>',
      )
    }
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    const before = Buffer.from(source)
    await expect(
      applyCellEditsToXlsx(source, [], [], [], {
        renames: [],
        additions: [],
        removals: ['Deco'],
        order: ['Keep'],
      }),
    ).rejects.toBeInstanceOf(MacroPreservationError)
    expect(source).toEqual(before)
  })

  it('keeps an image a surviving sheet still references', async () => {
    const mutation = await applyCellEditsToXlsx(
      await buildSatelliteSheetFixture({ sharedImage: true }),
      [],
      [],
      [],
      { renames: [], additions: [], removals: ['Deco'], order: ['Keep'] },
    )
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    expect(mutation.removedEntries).not.toContain('xl/media/image1.png')
    expect(mutation.removedEntries).toContain('xl/drawings/drawing1.xml')
    const zip = await JSZip.loadAsync(mutation.buffer)
    expect(zip.file('xl/media/image1.png')).not.toBeNull()
    expect(zip.file('xl/drawings/drawing2.xml')).not.toBeNull()
  })

  it('renames another sheet in the same save as the cascade removal', async () => {
    // The rename pass rewrites chart references; charts dying with the
    // removed sheet are already gone from the package and must be skipped.
    const mutation = await applyCellEditsToXlsx(await buildSatelliteSheetFixture(), [], [], [], {
      renames: [{ sheetName: 'Keep', newName: 'Kept' }],
      additions: [],
      removals: ['Deco'],
      order: ['Kept'],
    })
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).toContain('name="Kept"')
    expect(workbook).not.toContain('name="Deco"')
    expect(mutation.removedEntries).toContain('xl/charts/chart1.xml')
  })

  it('ignores a structured reference in a defined name scoped to the removed sheet', async () => {
    const mutation = await applyCellEditsToXlsx(
      await buildSatelliteSheetFixture({ scopedTableName: true }),
      [],
      [],
      [],
      { renames: [], additions: [], removals: ['Deco'], order: ['Keep'] },
    )
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    // The scoped name dies with the sheet.
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).not.toContain('DecoRef')
  })

  it('fails closed on pivot tables and on surviving structured references into the table', async () => {
    await expect(
      applyCellEditsToXlsx(await buildSatelliteSheetFixture({ pivot: true }), [], [], [], {
        renames: [],
        additions: [],
        removals: ['Deco'],
        order: ['Keep'],
      }),
    ).rejects.toThrow(/pivot table/)
    await expect(
      applyCellEditsToXlsx(await buildSatelliteSheetFixture({ tableRef: true }), [], [], [], {
        renames: [],
        additions: [],
        removals: ['Deco'],
        order: ['Keep'],
      }),
    ).rejects.toThrow(/table "DecoTable"/)
  })

  it('fails closed on a differently-cased structured reference into the table', async () => {
    await expect(
      applyCellEditsToXlsx(await buildSatelliteSheetFixture({ tableRefLower: true }), [], [], [], {
        renames: [],
        additions: [],
        removals: ['Deco'],
        order: ['Keep'],
      }),
    ).rejects.toThrow(/table "DecoTable"/)
  })

  it('fails closed when a pivot cache reads its source rows from the removed sheet', async () => {
    await expect(
      applyCellEditsToXlsx(
        await buildSatelliteSheetFixture({ pivotSourceCache: true }),
        [],
        [],
        [],
        { renames: [], additions: [], removals: ['Deco'], order: ['Keep'] },
      ),
    ).rejects.toThrow(/source data/)
  })

  it('rewrites a pivot cache worksheetSource when its source sheet is renamed', async () => {
    const mutation = await applyCellEditsToXlsx(
      await buildSatelliteSheetFixture({ pivotSourceCache: true }),
      [],
      [],
      [],
      {
        renames: [{ sheetName: 'Deco', newName: 'Deco 2' }],
        additions: [],
        removals: [],
        order: ['Keep', 'Deco 2'],
      },
    )
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const cache = await entryText(mutation.buffer, 'xl/pivotCache/pivotCacheDefinition1.xml')
    expect(cache).toContain('sheet="Deco 2"')
    expect(cache).not.toContain('sheet="Deco"')
  })
})

describe('sheet duplicate save', () => {
  it('seeds the new part from the source and applies edits on top', async () => {
    const mutation = await applyCellEditsToXlsx(
      await buildSheetsFixture(),
      [{ sheetName: 'Data Copy', row: 0, column: 1, writeValue: true, cell: { value: 'copied' } }],
      [],
      [],
      {
        renames: [],
        additions: [{ name: 'Data Copy', sourceSheetName: 'Data' }],
        removals: [],
        order: ['Data', 'Data Copy', 'Other', 'My Sheet'],
      },
    )
    expect(mutation.addedEntries).toEqual(['xl/worksheets/sheet4.xml'])
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    expect(workbook).toContain('<sheet name="Data Copy" sheetId="4" r:id="rId6"/>')
    const copy = await entryText(mutation.buffer, 'xl/worksheets/sheet4.xml')
    // Source content survives — including its formula — plus the new edit.
    expect(copy).toContain("<f>'My Sheet'!A1*2</f>")
    expect(copy).toContain(
      '<c r="B1" t="inlineStr"><is><t xml:space="preserve">copied</t></is></c>',
    )
    // The source part itself is byte-untouched.
    expect(mutation.touchedEntries).not.toContain('xl/worksheets/sheet1.xml')
    const source = await entryText(mutation.buffer, 'xl/worksheets/sheet1.xml')
    expect(source).not.toContain('copied')
    expect(mutation.removedEntries).toContain('xl/calcChain.xml')
  })

  it('clones hyperlink relationships and drops printer settings', async () => {
    const zip = await JSZip.loadAsync(await buildSheetsFixture())
    const sheet1 = await zip.file('xl/worksheets/sheet1.xml')!.async('text')
    zip.file(
      'xl/worksheets/sheet1.xml',
      sheet1.replace(
        '</worksheet>',
        '<pageSetup orientation="landscape" r:id="rId2"/></worksheet>',
      ),
    )
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/>' +
        '</Relationships>',
    )
    zip.file('xl/printerSettings/printerSettings1.bin', Buffer.from([1, 2, 3]))
    const source = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const mutation = await applyCellEditsToXlsx(source, [], [], [], {
      renames: [],
      additions: [{ name: 'Data Copy', sourceSheetName: 'Data' }],
      removals: [],
      order: ['Data', 'Data Copy', 'Other', 'My Sheet'],
    })
    expect(mutation.addedEntries).toEqual([
      'xl/worksheets/_rels/sheet4.xml.rels',
      'xl/worksheets/sheet4.xml',
    ])
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const clonedRels = await entryText(mutation.buffer, 'xl/worksheets/_rels/sheet4.xml.rels')
    expect(clonedRels).toContain('Target="https://example.com"')
    expect(clonedRels).not.toContain('printerSettings')
    const copy = await entryText(mutation.buffer, 'xl/worksheets/sheet4.xml')
    expect(copy).toContain('<pageSetup orientation="landscape"/>')
    expect(copy).not.toContain('r:id="rId2"')
  })

  it('fails closed on drawings, tables, and sheet-scoped defined names', async () => {
    const zip = await JSZip.loadAsync(await buildSheetsFixture())
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
        '</Relationships>',
    )
    const withDrawing = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    await expect(
      applyCellEditsToXlsx(withDrawing, [], [], [], {
        renames: [],
        additions: [{ name: 'Data Copy', sourceSheetName: 'Data' }],
        removals: [],
        order: ['Data', 'Data Copy', 'Other', 'My Sheet'],
      }),
    ).rejects.toThrow('not supported yet')

    // "Other" carries a sheet-scoped Print_Area (localSheetId=1).
    await expect(
      applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
        renames: [],
        additions: [{ name: 'Other Copy', sourceSheetName: 'Other' }],
        removals: [],
        order: ['Data', 'Other', 'Other Copy', 'My Sheet'],
      }),
    ).rejects.toThrow('sheet-scoped defined names')
  })

  it('clone helpers sanitize part-scoped state', () => {
    expect(
      sanitizeClonedWorksheetXml(
        '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>',
      ),
    ).toBe('<sheetViews><sheetView workbookViewId="0"/></sheetViews>')
    expect(
      stripPageSetupRelIds('<pageSetup paperSize="9" r:id="rId3" orientation="portrait"/>'),
    ).toBe('<pageSetup paperSize="9" orientation="portrait"/>')
    const hyperlinkOnly =
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>'
    expect(prepareClonedSheetRels(hyperlinkOnly, 'Data')).toEqual({
      relsXml: hyperlinkOnly,
      droppedPrinterSettings: false,
    })
    const printerOnly =
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/></Relationships>'
    expect(prepareClonedSheetRels(printerOnly, 'Data')).toEqual({
      relsXml: null,
      droppedPrinterSettings: true,
    })
    const commentRels =
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>'
    expect(() => prepareClonedSheetRels(commentRels, 'Data')).toThrow(SheetEditError)
  })
})

describe('combined sheet operations', () => {
  it('applies add + rename + remove with a reordered tab list in one save', async () => {
    const mutation = await applyCellEditsToXlsx(
      await buildSheetsFixture(),
      [{ sheetName: 'Summary', row: 0, column: 1, writeValue: true, cell: { value: 42 } }],
      [],
      [],
      {
        renames: [{ sheetName: 'Data', newName: 'Numbers' }],
        additions: [{ name: 'Summary' }],
        removals: ['Other'],
        order: ['Summary', 'Numbers', 'My Sheet'],
      },
    )
    expect(() => assertOnlyTouchedEntriesChanged(mutation)).not.toThrow()
    const workbook = await entryText(mutation.buffer, 'xl/workbook.xml')
    const sheetsBlock = /<sheets>([\s\S]*?)<\/sheets>/.exec(workbook)?.[1] ?? ''
    expect(sheetsBlock).toBe(
      '<sheet name="Summary" sheetId="4" r:id="rId6"/>' +
        '<sheet name="Numbers" sheetId="1" r:id="rId1"/>' +
        '<sheet name="My Sheet" sheetId="3" r:id="rId3"/>',
    )
    const chart = await entryText(mutation.buffer, 'xl/charts/chart1.xml')
    expect(chart).toContain('<c:f>Numbers!$A$1:$A$2</c:f>')
    const summary = await entryText(mutation.buffer, 'xl/worksheets/sheet4.xml')
    expect(summary).toContain('<c r="B1"><v>42</v></c>')
  })

  it('rejects an order that does not match the final sheet set', async () => {
    await expect(
      applyCellEditsToXlsx(await buildSheetsFixture(), [], [], [], {
        renames: [],
        additions: [],
        removals: ['Other'],
        order: ['Data', 'Other', 'My Sheet'],
      }),
    ).rejects.toThrow('sheet order')
  })
})
