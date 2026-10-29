/** Runs real installed engines against deterministic local fixtures. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import JSZip from 'jszip'
import {
  convertDocument,
  discoverEngines,
  checkPdf,
  runBounded,
} from '../packages/engine-bridge/src/index.mjs'
import { compareRenderedPages } from './compare-rendered-pages.mjs'
const require = createRequire(import.meta.url)
const { PDFDocument } = require('pdf-lib')
const [manifestArg, outputArg, rasterizerArg] = process.argv.slice(2)
if (!manifestArg || !outputArg)
  throw new Error('Usage: tsx tools/engine-smoke.mts MANIFEST OUTPUT_DIRECTORY [PDFTOPPM]')
const manifestPath = resolve(manifestArg),
  output = resolve(outputArg)
await mkdir(output, { recursive: true })
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
const options = { manifestPath, tempRoot: output, timeoutMs: 60000, signal: controller.signal }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const report: any = {
  createdAt: new Date().toISOString(),
  engines: await discoverEngines(options),
  cases: [],
  scope:
    'Real local LibreOffice conversion and qpdf structural diagnostics on three deterministic fixtures. Same-renderer no-op comparisons are supplementary and do not establish Microsoft Office equivalence.',
}
const saveReport = () =>
  writeFile(join(output, 'engine-smoke-evidence.json'), JSON.stringify(report, null, 2) + '\n')
await saveReport()

const xlsx = new JSZip()
xlsx.file(
  '[Content_Types].xml',
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
)
xlsx.file(
  '_rels/.rels',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
)
xlsx.file(
  'xl/workbook.xml',
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Test" sheetId="1" r:id="r1"/></sheets></workbook>',
)
xlsx.file(
  'xl/_rels/workbook.xml.rels',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
)
xlsx.file(
  'xl/worksheets/sheet1.xml',
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Vantage engine test</t></is></c><c r="B1"><v>5</v></c><c r="C1"><f>SUM(B1,5)</f><v>10</v></c></row></sheetData></worksheet>',
)
const workbook = join(output, 'sample.xlsx')
await writeFile(workbook, await xlsx.generateAsync({ type: 'nodebuffer' }))
const docx = join(output, 'sample.docx'),
  pptx = join(output, 'sample.pptx')
await copyFile(
  resolve('packages/docx-engine/tests/fixtures/truths/bidi-level-ind-start-end/probe.docx'),
  docx,
)
await copyFile(resolve('packages/pptx-engine/tests/fixtures/01_standard_business.pptx'), pptx)
for (const source of [docx, workbook, pptx]) {
  if (controller.signal.aborted) break
  try {
    const before = hash(await readFile(source)),
      destination = source + '.pdf'
    const converted = await convertDocument(source, destination, options)
    const checked = await checkPdf(destination, options)
    const pdf = await PDFDocument.load(await readFile(destination))
    const unchanged = hash(await readFile(source)) === before
    report.cases.push({
      source,
      passed:
        converted.bytes > 0 && checked.status === 'pass' && pdf.getPageCount() > 0 && unchanged,
      converted,
      qpdf: checked,
      parsedPages: pdf.getPageCount(),
      originalUnchanged: unchanged,
    })
  } catch (error) {
    report.cases.push({ source, passed: false, error: String(error) })
  }
  await saveReport()
}
const malformed = join(output, 'malformed.pdf')
await writeFile(malformed, '%PDF-1.7\nNo object tree\n%%EOF')
const malformedCheck = await checkPdf(malformed, options)
report.cases.push({
  source: malformed,
  passed: malformedCheck.status === 'fail',
  expected: 'fail',
  qpdf: malformedCheck,
})

if (rasterizerArg) {
  const nativeReport = JSON.parse(
    await readFile(
      join(resolve(output, '..'), 'native-corpus', 'native-corpus-evidence.json'),
      'utf8',
    ),
  )
  report.visualComparisons = []
  for (const kind of ['docx', 'pptx']) {
    const sample = nativeReport.cases.find(
      (item: any) => item.kind === kind && item.noOp?.status === 'passed',
    )
    const originalPdf = join(output, kind + '-reference.pdf'),
      nativePdf = join(output, kind + '-native-noop.pdf')
    await convertDocument(sample.source, originalPdf, options)
    await convertDocument(sample.noOp.output, nativePdf, options)
    const referenceDir = join(output, kind + '-reference-pages'),
      candidateDir = join(output, kind + '-native-pages')
    await mkdir(referenceDir)
    await mkdir(candidateDir)
    const a = await runBounded(
      resolve(rasterizerArg),
      ['-r', '96', '-png', originalPdf, join(referenceDir, 'page')],
      { timeoutMs: 60000 },
    )
    const b = await runBounded(
      resolve(rasterizerArg),
      ['-r', '96', '-png', nativePdf, join(candidateDir, 'page')],
      { timeoutMs: 60000 },
    )
    if (a.code || b.code || a.stopped || b.stopped)
      throw new Error('Reference raster rendering did not complete')
    report.visualComparisons.push({
      kind,
      source: sample.source,
      sameRendererOnly: true,
      ...(await compareRenderedPages(referenceDir, candidateDir)),
    })
  }
}
report.passed =
  report.cases.every((item: any) => item.passed) &&
  (!report.visualComparisons || report.visualComparisons.every((item: any) => item.passed))
await writeFile(join(output, 'engine-smoke-evidence.json'), JSON.stringify(report, null, 2) + '\n')
console.log(
  JSON.stringify({
    passed: report.passed,
    cases: report.cases.length,
    report: join(output, 'engine-smoke-evidence.json'),
  }),
)
if (!report.passed) process.exitCode = 1
