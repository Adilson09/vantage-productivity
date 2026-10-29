/** Native import/save/reopen evidence. Run: npx tsx tools/compatibility-corpus.mts OUTPUT_DIRECTORY */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { parseDocx, saveDocx, type SaveBlock } from '../packages/docx-engine/src/index'
import { openPptx, savePptx } from '../packages/pptx-engine/src/index'
import { assertZipInflatesWithinLimits } from '../packages/zip-gate/src/index'
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs')

const output = process.argv[2] && resolve(process.argv[2])
if (!output) throw new Error('Pass a new output directory for corpus artifacts and evidence')
await mkdir(output, { recursive: true })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function paths(root: string, extension: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await paths(path, extension)))
    else if (entry.name.endsWith(extension)) out.push(path)
  }
  return out.sort()
}
async function compareParts(beforeBytes: Uint8Array, afterBytes: Uint8Array, allowed: string[]) {
  const limits = {
    maxParts: 4000,
    maxPartBytes: 32 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
  }
  await assertZipInflatesWithinLimits(beforeBytes, limits)
  await assertZipInflatesWithinLimits(afterBytes, limits)
  const [before, after] = await Promise.all([
    JSZip.loadAsync(beforeBytes),
    JSZip.loadAsync(afterBytes),
  ])
  const beforeNames = Object.keys(before.files)
    .filter((name) => !before.files[name]!.dir)
    .sort()
  const afterNames = Object.keys(after.files)
    .filter((name) => !after.files[name]!.dir)
    .sort()
  const removed = beforeNames.filter((name) => !after.file(name))
  const added = afterNames.filter((name) => !before.file(name))
  const changed: string[] = []
  for (const name of beforeNames) {
    if (!after.file(name)) continue
    if (
      hash(await before.file(name)!.async('uint8array')) !==
      hash(await after.file(name)!.async('uint8array'))
    )
      changed.push(name)
  }
  return {
    passed: !removed.length && !added.length && changed.every((name) => allowed.includes(name)),
    changed,
    removed,
    added,
  }
}

const report: {
  schemaVersion: number
  createdAt: string
  environment: unknown
  scope: string
  unavailable: string[]
  cases: any[]
  totals?: unknown
} = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    corpusSeed: 'vantage-corpus-2026-10-29-v1',
  },
  scope:
    'Native engine parsing, no-op part preservation, targeted text replacement, save and reopen. Synthetic PPTX variants are explicitly identified. These results do not meet independent Office visual-fidelity acceptance gates.',
  unavailable: [
    'Pinned Microsoft Office visual references and repair-prompt acceptance',
    'Human layout/accessibility review',
    'One-percent non-antialias pixel acceptance',
  ],
  cases: [],
}
const docxInputs = (await paths(resolve('packages/docx-engine/tests/fixtures'), '.docx')).slice(
  0,
  50,
)
for (const [index, source] of docxInputs.entries()) {
  const id = `docx-${String(index + 1).padStart(2, '0')}`
  try {
    const original = await readFile(source)
    const doc = await parseDocx(original)
    const blocks = doc.blocks.filter((block) => !block.hidden)
    const noOp = await saveDocx(
      doc,
      blocks.map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! })),
    )
    const unchanged = await compareParts(original, noOp, [])
    await parseDocx(noOp)
    const noOpPath = join(output, id + '.noop.docx')
    await writeFile(noOpPath, noOp)
    const target = blocks.find((block) => block.type === 'paragraph' && block.docxIndex != null)
    let edit: unknown = { status: 'unavailable', reason: 'No top-level paragraph in this fixture' }
    if (target) {
      const marker = `Vantage corpus edited paragraph ${id}`
      const edited = await saveDocx(
        doc,
        blocks.map((block): SaveBlock =>
          block === target
            ? { kind: 'generated', block: { type: 'paragraph', runs: [{ text: marker }] } }
            : { kind: 'original', docxIndex: block.docxIndex! },
        ),
      )
      const preserved = await compareParts(original, edited, ['word/document.xml'])
      await parseDocx(edited)
      const zip = await JSZip.loadAsync(edited)
      const markerFound = (await zip.file('word/document.xml')!.async('string')).includes(marker)
      const editedPath = join(output, id + '.edited.docx')
      await writeFile(editedPath, edited)
      edit = {
        status: preserved.passed && markerFound ? 'passed' : 'failed',
        ...preserved,
        markerFound,
        output: editedPath,
      }
    }
    report.cases.push({
      id,
      kind: 'docx',
      source,
      provenance: 'Existing native engine fixture',
      sourceSha256: hash(original),
      noOp: { status: unchanged.passed ? 'passed' : 'failed', ...unchanged, output: noOpPath },
      edit,
    })
  } catch (error) {
    report.cases.push({ id, kind: 'docx', source, status: 'failed', error: String(error) })
  }
}

const pptxInputs = await paths(resolve('packages/pptx-engine/tests/fixtures'), '.pptx')
for (let index = 0; index < 30; index += 1) {
  const id = `pptx-synthetic-${String(index + 1).padStart(2, '0')}`
  const deck = new PptxGenJS()
  deck.layout = index % 2 ? 'LAYOUT_16x9' : 'LAYOUT_4x3'
  deck.title = `Vantage deterministic presentation ${index + 1}`
  const slide = deck.addSlide()
  slide.background = { color: index % 2 ? 'FFFFFF' : 'F1F5F9' }
  slide.addText(
    `Title ${index + 1} — ${['English', 'Français', '日本語', 'العربية', 'עברית'][index % 5]}`,
    { x: 0.5, y: 0.4, w: 8, h: 0.8, fontSize: 20 + (index % 6), bold: !!(index % 2) },
  )
  slide.addText(
    [
      { text: 'A paragraph with ', options: { color: '334155' } },
      { text: 'emphasis', options: { bold: true, color: '155E75' } },
    ],
    { x: 0.5, y: 1.6, w: 7, h: 0.8, fontSize: 16 },
  )
  if (index % 3 === 0)
    slide.addTable(
      [
        ['Item', 'Amount'],
        ['Revenue', String(100 + index)],
        ['Costs', String(50 + index)],
      ],
      { x: 0.5, y: 3, w: 5, h: 2, fontSize: 14 },
    )
  if (index % 4 === 0) deck.addSlide().addText('Second slide', { x: 1, y: 1, w: 6, h: 1 })
  const source = join(output, id + '.source.pptx')
  await writeFile(source, (await deck.write({ outputType: 'nodebuffer' })) as Buffer)
  pptxInputs.push(source)
}
for (const [index, source] of pptxInputs.entries()) {
  const id = `pptx-${String(index + 1).padStart(2, '0')}`
  try {
    const original = await readFile(source)
    const doc = await openPptx(original)
    const noOp = await savePptx(doc)
    const unchanged = await compareParts(original, noOp, [])
    const reopened = await openPptx(noOp)
    if (reopened.deck.slides.length !== doc.deck.slides.length) unchanged.passed = false
    const noOpPath = join(output, id + '.noop.pptx')
    await writeFile(noOpPath, noOp)
    const slide = doc.deck.slides[0]
    const target = slide?.elements.find(
      (element) =>
        (element.type === 'text' || element.type === 'shape') &&
        element.text?.paragraphs[0]?.runs.length,
    )
    let edit: unknown = { status: 'unavailable', reason: 'No editable text on first slide' }
    if (target && (target.type === 'text' || target.type === 'shape') && target.text) {
      const marker = `Vantage edited ${id}`
      target.text.paragraphs[0]!.runs[0]!.text = marker
      target.dirty = true
      const edited = await savePptx(doc)
      const preserved = await compareParts(original, edited, [slide!.path])
      await openPptx(edited)
      const zip = await JSZip.loadAsync(edited)
      const markerFound = (await zip.file(slide!.path)!.async('string')).includes(marker)
      const editedPath = join(output, id + '.edited.pptx')
      await writeFile(editedPath, edited)
      edit = {
        status: preserved.passed && markerFound ? 'passed' : 'failed',
        ...preserved,
        markerFound,
        output: editedPath,
      }
    }
    report.cases.push({
      id,
      kind: 'pptx',
      source,
      provenance: basename(source).includes('synthetic')
        ? 'Generated deterministic synthetic variant'
        : 'Existing native engine fixture',
      sourceSha256: hash(original),
      noOp: { status: unchanged.passed ? 'passed' : 'failed', ...unchanged, output: noOpPath },
      edit,
    })
  } catch (error) {
    report.cases.push({ id, kind: 'pptx', source, status: 'failed', error: String(error) })
  }
}
report.totals = {
  docx: docxInputs.length,
  pptx: pptxInputs.length,
  failed: report.cases.filter(
    (item) =>
      item.status === 'failed' || item.noOp?.status === 'failed' || item.edit?.status === 'failed',
  ).length,
  passedNoOp: report.cases.filter((item) => item.noOp?.status === 'passed').length,
  passedEdits: report.cases.filter((item) => item.edit?.status === 'passed').length,
}
await writeFile(join(output, 'native-corpus-evidence.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report.totals))
if ((report.totals as { failed: number }).failed) process.exitCode = 1
