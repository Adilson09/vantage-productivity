import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runBounded } from '../packages/engine-bridge/src/index.mjs'
import { compareRenderedPages } from './compare-rendered-pages.mjs'
const [reportArg, rasterizerArg, outputArg] = process.argv.slice(2)
if (!reportArg || !rasterizerArg || !outputArg)
  throw new Error(
    'Usage: node tools/compare-office-reference.mjs OFFICE_REPORT PDFTOPPM NEW_OUTPUT_DIR',
  )
const input = JSON.parse(await readFile(reportArg, 'utf8'))
const output = resolve(outputArg)
await mkdir(output, { recursive: true })
const report = {
  createdAt: new Date().toISOString(),
  referenceEnvironment: resolve(reportArg),
  dpi: 96,
  renderer: 'Installed Word/PowerPoint PDF export, Poppler pdftoppm 96DPI rasterization',
  scope:
    'Independent Office renders of original and native-engine no-op output files, paired pixel comparison excluding antialias differences. Native UI rendering, targeted-edit visual review, repair dialogs and human critical layout review are separate acceptance requirements.',
  cases: [],
}
for (const item of input.cases) {
  if (item.status !== 'rendered') {
    report.cases.push({ id: item.id, status: 'not-rendered', reason: item.error })
    continue
  }
  try {
    const reference = item.variants.find((variant) => variant.name === 'reference')
    const candidate = item.variants.find((variant) => variant.name === 'native-noop')
    const referenceDir = join(output, item.id + '-reference'),
      candidateDir = join(output, item.id + '-native')
    await mkdir(referenceDir)
    await mkdir(candidateDir)
    const a = await runBounded(
      resolve(rasterizerArg),
      ['-r', '96', '-png', reference.pdf, join(referenceDir, 'page')],
      { timeoutMs: 60000 },
    )
    const b = await runBounded(
      resolve(rasterizerArg),
      ['-r', '96', '-png', candidate.pdf, join(candidateDir, 'page')],
      { timeoutMs: 60000 },
    )
    if (a.code || b.code || a.stopped || b.stopped)
      throw new Error('Rasterizer did not complete within its budget')
    const comparison = await compareRenderedPages(referenceDir, candidateDir)
    report.cases.push({
      id: item.id,
      kind: item.kind,
      status: comparison.passed ? 'passed' : 'failed',
      ...comparison,
    })
  } catch (error) {
    report.cases.push({ id: item.id, status: 'failed', error: String(error) })
  }
}
report.totals = {
  passed: report.cases.filter((item) => item.status === 'passed').length,
  failed: report.cases.filter((item) => item.status === 'failed').length,
  notRendered: report.cases.filter((item) => item.status === 'not-rendered').length,
}
await writeFile(join(output, 'office-raster-evidence.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report.totals))
if (report.totals.failed) process.exitCode = 1
