import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  applyCellEditsToXlsx,
  applyPlanToXlsx,
  assembleWithJsZip,
  createBufferEntrySource,
  inspectMacroPreservation,
  MacroPreservationError,
  planCellEditsToXlsx,
  readBasicWorkbook,
  type MutationPlan,
} from '../src/gateway/xlsx-gateway'
import { isPureNoteVml } from '../src/gateway/xlsx-macro-preservation'

// These are synthetic *package-preservation* fixtures. Binary blobs are inert
// sentinel bytes, not executable VBA/ActiveX/OLE or valid signed VBA projects.
// They establish byte/relationship preservation, never macro execution/parity.
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const MS_REL = 'http://schemas.microsoft.com/office/2006/relationships/'
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const rels = (items: string[]): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`
const relation = (id: string, type: string, target: string): string =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`
function sentinel(label: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from(`INERT_PACKAGE_SENTINEL:${label}`),
    Buffer.alloc(128, label.length),
  ])
}

interface Profile {
  name: string
  parts: Record<string, string | Buffer>
  sheetExtras?: string
  sheetRels?: string[]
  workbookExtra?: string
  workbookRels?: string[]
  rootRels?: string[]
  types?: string
  signed?: boolean
}
const profiles: Profile[] = [
  { name: 'plain VBA project with worksheet code names', parts: {} },
  {
    name: 'classic VBA project signature',
    parts: {
      'xl/vbaProjectSignature.bin': sentinel('classic-signature'),
      'xl/_rels/vbaProject.bin.rels': rels([
        relation('rIdSig', MS_REL + 'vbaProjectSignature', 'vbaProjectSignature.bin'),
      ]),
    },
  },
  {
    name: 'agile and version3 VBA project signatures',
    parts: {
      'xl/vbaProjectSignatureAgile.bin': sentinel('agile-signature'),
      'xl/vbaProjectSignatureV3.bin': sentinel('v3-signature'),
      'xl/_rels/vbaProject.bin.rels': rels([
        relation(
          'rIdAgile',
          'http://schemas.microsoft.com/office/2014/relationships/vbaProjectSignatureAgile',
          'vbaProjectSignatureAgile.bin',
        ),
        relation(
          'rIdV3',
          'http://schemas.microsoft.com/office/2020/07/relationships/vbaProjectSignatureV3',
          'vbaProjectSignatureV3.bin',
        ),
      ]),
    },
  },
  {
    name: 'ActiveX control XML, binary and persistence relationships',
    parts: {
      'xl/activeX/activeX1.xml':
        '<ax:ocx xmlns:ax="http://schemas.microsoft.com/office/2006/activeX" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" classid="{SYNTHETIC}" persistence="persistStreamInit" r:id="rIdPersist"/>',
      'xl/activeX/activeX1.bin': sentinel('activex'),
      'xl/activeX/_rels/activeX1.xml.rels': rels([
        relation('rIdPersist', MS_REL + 'activeXControlBinary', 'activeX1.bin'),
      ]),
    },
    sheetExtras: '<controls><control shapeId="1025" name="Button1" r:id="rIdControl"/></controls>',
    sheetRels: [relation('rIdControl', MS_REL + 'activeXControl', '../activeX/activeX1.xml')],
    types:
      '<Override PartName="/xl/activeX/activeX1.xml" ContentType="application/vnd.ms-office.activeX+xml"/>',
  },
  {
    name: 'legacy VML form button and macro binding',
    parts: {
      'xl/drawings/vmlDrawing1.vml':
        '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape id="_x0000_s1025"><x:ClientData ObjectType="Button"><x:FmlaMacro>[0]!Synthetic_Click</x:FmlaMacro><x:Anchor>0,0,0,0,2,0,2,0</x:Anchor></x:ClientData></v:shape></xml>',
    },
    sheetExtras: '<legacyDrawing r:id="rIdVml"/>',
    sheetRels: [relation('rIdVml', REL + 'vmlDrawing', '../drawings/vmlDrawing1.vml')],
    types:
      '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>',
  },
  {
    name: 'custom ribbon callbacks and resources',
    parts: {
      'customUI/customUI.xml':
        '<customUI xmlns="http://schemas.microsoft.com/office/2006/01/customui"><ribbon><tabs><tab id="vantage" label="Test"><group id="group" label="Test"><button id="button" label="Inert callback" onAction="SyntheticAction"/></group></tab></tabs></ribbon></customUI>',
      'customUI/images/icon.bin': sentinel('custom-ui-icon'),
      'customUI/_rels/customUI.xml.rels': rels([
        relation('rIdIcon', REL + 'image', 'images/icon.bin'),
      ]),
    },
    rootRels: [
      relation(
        'rIdUI',
        'http://schemas.microsoft.com/office/2006/relationships/ui/extensibility',
        'customUI/customUI.xml',
      ),
    ],
  },
  {
    name: 'embedded OLE object and worksheet binding',
    parts: { 'xl/embeddings/oleObject1.bin': sentinel('embedded-ole') },
    sheetExtras:
      '<oleObjects><oleObject progId="Synthetic.Inert" shapeId="1026" r:id="rIdOle"/></oleObjects>',
    sheetRels: [relation('rIdOle', REL + 'oleObject', '../embeddings/oleObject1.bin')],
    types:
      '<Override PartName="/xl/embeddings/oleObject1.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>',
  },
  {
    name: 'XLM macro sheet with a preserved auto-open definition',
    parts: {
      'xl/macrosheets/sheet2.xml': `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><f>HALT()</f><v>0</v></c></row></sheetData></worksheet>`,
    },
    workbookExtra: '<sheet name="MacroSheet" sheetId="2" state="veryHidden" r:id="rIdMacro"/>',
    workbookRels: [relation('rIdMacro', MS_REL + 'xlMacrosheet', 'macrosheets/sheet2.xml')],
    types:
      '<Override PartName="/xl/macrosheets/sheet2.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/>',
  },
  {
    name: 'form-control properties with preserved relationship IDs',
    parts: {
      'xl/ctrlProps/ctrlProp1.xml':
        '<formControlPr xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" objectType="Button" macro="[0]!Synthetic_Click"/>',
    },
    sheetExtras:
      '<controls><control shapeId="1027" name="FormButton" r:id="rIdFormControl"/></controls>',
    sheetRels: [relation('rIdFormControl', MS_REL + 'ctrlProp', '../ctrlProps/ctrlProp1.xml')],
    types:
      '<Override PartName="/xl/ctrlProps/ctrlProp1.xml" ContentType="application/vnd.ms-excel.controlproperties+xml"/>',
  },
  {
    name: 'OPC-signed XLSM whose document edits must be refused',
    parts: {
      '_xmlsignatures/origin.sigs': '',
      '_xmlsignatures/_rels/origin.sigs.rels': rels([
        relation(
          'rIdSignature',
          'http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature',
          'sig1.xml',
        ),
      ]),
      '_xmlsignatures/sig1.xml':
        '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><Reference URI="/xl/worksheets/sheet1.xml"><DigestValue>INERT_SENTINEL_DIGEST</DigestValue></Reference></SignedInfo><SignatureValue>INERT_SENTINEL_SIGNATURE</SignatureValue></Signature>',
    },
    rootRels: [
      relation(
        'rIdSigned',
        'http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin',
        '_xmlsignatures/origin.sigs',
      ),
    ],
    signed: true,
  },
]

async function fixture(profile: Profile): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${profile.types ?? ''}</Types>`,
  )
  zip.file(
    '_rels/.rels',
    rels([
      relation('rIdOffice', REL + 'officeDocument', 'xl/workbook.xml'),
      ...(profile.rootRels ?? []),
    ]),
  )
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr codeName="ThisWorkbook"/><sheets><sheet name="Data" sheetId="1" r:id="rIdSheet"/>${profile.workbookExtra ?? ''}</sheets></workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    rels([
      relation('rIdSheet', REL + 'worksheet', 'worksheets/sheet1.xml'),
      relation('rIdStyles', REL + 'styles', 'styles.xml'),
      relation('rIdVba', MS_REL + 'vbaProject', 'vbaProject.bin'),
      ...(profile.workbookRels ?? []),
    ]),
  )
  zip.file(
    'xl/styles.xml',
    `<styleSheet xmlns="${NS}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`,
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr codeName="SheetData"/><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData>${profile.sheetExtras ?? ''}</worksheet>`,
  )
  if (profile.sheetRels) zip.file('xl/worksheets/_rels/sheet1.xml.rels', rels(profile.sheetRels))
  zip.file('xl/vbaProject.bin', sentinel(profile.name))
  for (const [path, bytes] of Object.entries(profile.parts)) zip.file(path, bytes)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

const edit = [
  { sheetName: 'Data', row: 0, column: 0, writeValue: true, cell: { value: 43 } },
] as const
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function emptyPlan(): MutationPlan {
  return {
    replaced: new Map(),
    added: new Map(),
    addedBinary: new Map(),
    removedEntries: [],
    addedEntries: [],
    touchedEntries: [],
  }
}

describe('ten synthetic XLSM preservation fixtures (no VBA execution)', () => {
  for (const profile of profiles)
    it(profile.name, async () => {
      const source = await fixture(profile),
        originalHash = sha(source)
      const imported = await readBasicWorkbook(source)
      expect(imported.snapshot.sheets.find((s) => s.name === 'Data')?.cells.A1?.value).toBe(42)
      const info = await inspectMacroPreservation(await createBufferEntrySource(source))
      expect(info).toMatchObject({
        vbaProject: true,
        execution: 'never',
        packageSigned: profile.signed ?? false,
      })
      const noop = await applyCellEditsToXlsx(source, [])
      const copies = [noop]
      if (profile.signed) {
        await expect(applyCellEditsToXlsx(source, edit)).rejects.toThrow(
          'document package signatures',
        )
        expect(noop.touchedEntries).toEqual([])
      } else {
        const edited = await applyCellEditsToXlsx(source, edit)
        expect(
          (await readBasicWorkbook(edited.buffer)).snapshot.sheets.find((s) => s.name === 'Data')
            ?.cells.A1?.value,
        ).toBe(43)
        copies.push(edited)
      }
      const beforeZip = await JSZip.loadAsync(source)
      const preserved = new Set([
        ...info.preservedParts,
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        ...(profile.sheetRels ? ['xl/worksheets/_rels/sheet1.xml.rels'] : []),
        ...Object.keys(profile.parts),
      ])
      for (const copy of copies) {
        const afterZip = await JSZip.loadAsync(copy.buffer)
        for (const path of preserved) {
          expect(afterZip.file(path), `${profile.name}: ${path} exists`).not.toBeNull()
          const original = await beforeZip.file(path)!.async('nodebuffer'),
            actual = await afterZip.file(path)!.async('nodebuffer')
          expect(sha(actual), `${profile.name}: untouched part ${path}`).toBe(sha(original))
          expect(copy.removedEntries).not.toContain(path)
        }
        expect(await afterZip.file('xl/workbook.xml')!.async('string')).toContain(
          'codeName="ThisWorkbook"',
        )
        const sheet = await afterZip.file('xl/worksheets/sheet1.xml')!.async('string')
        expect(sheet).toContain('codeName="SheetData"')
        if (profile.sheetExtras) expect(sheet).toContain(profile.sheetExtras)
      }
      expect(sha(source)).toBe(originalHash)
    })
})

describe('macro preservation fails closed on unsupported destructive edits', () => {
  it('distinguishes ordinary note drawings from mixed or unknown VML controls', () => {
    const note =
      '<v:shape id="note"><x:ClientData ObjectType="Note"><x:Row>0</x:Row></x:ClientData></v:shape>'
    const button =
      '<v:shape id="button"><x:ClientData ObjectType="Button"><x:FmlaMacro>Click</x:FmlaMacro></x:ClientData></v:shape>'
    expect(isPureNoteVml(`<xml>${note}</xml>`)).toBe(true)
    expect(isPureNoteVml(`<xml>${note}${button}</xml>`)).toBe(false)
    expect(isPureNoteVml('<xml><v:shape id="unknown"/></xml>')).toBe(false)
    expect(isPureNoteVml(note.replace('<x:Row>', '<x:FmlaMacro>Click</x:FmlaMacro><x:Row>'))).toBe(
      false,
    )
  })

  it('can add, update and remove ordinary notes while preserving an unrelated VBA project', async () => {
    const original = await fixture(profiles[0]!)
    const writeNotes = (bytes: Buffer, text: string | null) =>
      applyCellEditsToXlsx(
        bytes,
        [],
        [],
        [],
        undefined,
        [],
        [],
        [],
        [],
        [],
        null,
        [],
        [
          {
            sheetName: 'Data',
            notes: text === null ? [] : [{ row: 0, column: 0, author: 'Vantage', text }],
          },
        ],
      )
    const first = await writeNotes(original, 'First note')
    const second = await writeNotes(first.buffer, 'Edited note')
    const final = await writeNotes(second.buffer, null)
    const originalZip = await JSZip.loadAsync(original)
    const project = await originalZip.file('xl/vbaProject.bin')!.async('nodebuffer')
    for (const copy of [first, second, final]) {
      const zip = await JSZip.loadAsync(copy.buffer)
      expect(await zip.file('xl/vbaProject.bin')!.async('nodebuffer')).toEqual(project)
    }
    const updated = await JSZip.loadAsync(second.buffer)
    const comments = Object.keys(updated.files).find((path) => /^xl\/comments\d*\.xml$/.test(path))!
    expect(await updated.file(comments)!.async('string')).toContain('Edited note')
    expect(
      Object.keys((await JSZip.loadAsync(final.buffer)).files).some((path) =>
        /^xl\/comments\d*\.xml$/.test(path),
      ),
    ).toBe(false)
  })

  it('continues refusing VML rewrites when an actual form-control binding is present', async () => {
    const source = await fixture(profiles[4]!)
    await expect(
      applyCellEditsToXlsx(
        source,
        [],
        [],
        [],
        undefined,
        [],
        [],
        [],
        [],
        [],
        null,
        [],
        [
          {
            sheetName: 'Data',
            notes: [{ row: 0, column: 0, author: 'Vantage', text: 'New note' }],
          },
        ],
      ),
    ).rejects.toThrow('macro/control content')
  })

  it('refuses sheet deletion, rename, cloning and row shifts before publication', async () => {
    const source = await fixture(profiles[0]!),
      entry = await createBufferEntrySource(source)
    for (const plan of [
      { renames: [], additions: [], removals: ['Data'], order: [] },
      {
        renames: [{ sheetName: 'Data', newName: 'Changed' }],
        additions: [],
        removals: [],
        order: ['Changed'],
      },
      {
        renames: [],
        additions: [{ name: 'Copy', sourceSheetName: 'Data' }],
        removals: [],
        order: ['Data', 'Copy'],
      },
    ])
      await expect(planCellEditsToXlsx(entry, [], [], [], plan)).rejects.toBeInstanceOf(
        MacroPreservationError,
      )
    await expect(
      planCellEditsToXlsx(
        entry,
        [],
        [{ sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] }],
      ),
    ).rejects.toThrow('bindings')
  })

  it('also guards legacy sheet-renaming writes', async () => {
    const source = await fixture(profiles[0]!)
    const imported = await readBasicWorkbook(source),
      sheet = imported.snapshot.sheets[0]!
    await expect(
      applyPlanToXlsx(
        source,
        {
          transactionId: 'macro-preserve-test',
          baseRevision: 0,
          cellChanges: [],
          structuralChanges: [],
          formatChanges: [],
          sheetRenames: [{ sheetId: sheet.id, before: 'Data', after: 'Renamed' }],
          warnings: [],
        },
        imported.sheetNamesById,
      ),
    ).rejects.toThrow('bindings')
  })

  it('refuses assembler plans that drop a VBA binary, signature relationship or control binding', async () => {
    const source = await fixture(profiles[1]!)
    await expect(
      assembleWithJsZip(source, { ...emptyPlan(), removedEntries: ['xl/vbaProject.bin'] }),
    ).rejects.toThrow('macro/control content')
    await expect(
      assembleWithJsZip(source, {
        ...emptyPlan(),
        replaced: new Map([['xl/_rels/vbaProject.bin.rels', rels([])]]),
      }),
    ).rejects.toThrow('macro/control content')
    const control = await fixture(profiles[3]!)
    await expect(
      assembleWithJsZip(control, {
        ...emptyPlan(),
        replaced: new Map([['xl/worksheets/_rels/sheet1.xml.rels', rels([])]]),
      }),
    ).rejects.toThrow('macro/control relationship')
  })

  it('refuses macro-enabled content-type loss and arbitrary edits to an OPC-signed package', async () => {
    const source = await fixture(profiles[0]!),
      zip = await JSZip.loadAsync(source)
    const types = (await zip.file('[Content_Types].xml')!.async('string')).replace(
      'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    )
    await expect(
      assembleWithJsZip(source, {
        ...emptyPlan(),
        replaced: new Map([['[Content_Types].xml', types]]),
      }),
    ).rejects.toThrow('macro-enabled content types')
    const signed = await fixture(profiles[9]!)
    await expect(
      assembleWithJsZip(signed, {
        ...emptyPlan(),
        replaced: new Map([['xl/worksheets/sheet1.xml', '<worksheet/>']]),
      }),
    ).rejects.toThrow('document package signatures')
  })
})
