#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

export async function compareRenderedPages(referenceDir, candidateDir, tolerance = 0.01) {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.01)
    throw new Error('Pixel tolerance must be between 0 and 1 percent')
  const pages = async (dir) =>
    (await readdir(dir))
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const [reference, candidate] = await Promise.all([pages(referenceDir), pages(candidateDir)])
  if (!reference.length || !candidate.length)
    throw new Error('Both rendered-page folders must contain PNG pages')
  if (reference.length > 500 || candidate.length > 500)
    throw new Error('Raster comparison is limited to 500 pages per document')
  const results = []
  for (let index = 0; index < Math.min(reference.length, candidate.length); index += 1) {
    const load = async (path) => {
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('PNG file exceeds 32 MiB')
      const bytes = await readFile(path)
      // Inspect IHDR before decoding, avoiding an oversized allocation from a compressed image.
      if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452)
        throw new Error('Invalid PNG header')
      const width = bytes.readUInt32BE(16),
        height = bytes.readUInt32BE(20)
      if (!width || !height || width * height > 16000000)
        throw new Error('Raster exceeds the 16-million-pixel page budget')
      return PNG.sync.read(bytes)
    }
    const [a, b] = await Promise.all([
      load(join(referenceDir, reference[index])),
      load(join(candidateDir, candidate[index])),
    ])
    if (a.width !== b.width || a.height !== b.height) {
      results.push({
        page: index + 1,
        passed: false,
        reason: 'Page dimensions differ',
        reference: { width: a.width, height: a.height },
        candidate: { width: b.width, height: b.height },
      })
      continue
    }
    const differentPixels = pixelmatch(a.data, b.data, null, a.width, a.height, {
      includeAA: false,
      threshold: 0.1,
    })
    const ratio = differentPixels / (a.width * a.height)
    results.push({
      page: index + 1,
      passed: ratio <= tolerance,
      differentPixels,
      nonAntialiasDifferenceRatio: ratio,
      totalPixels: a.width * a.height,
    })
  }
  return {
    createdAt: new Date().toISOString(),
    referenceDir: resolve(referenceDir),
    candidateDir: resolve(candidateDir),
    tolerance,
    passed: reference.length === candidate.length && results.every((page) => page.passed),
    referencePages: reference.length,
    candidatePages: candidate.length,
    pages: results,
    scope:
      'Compares corresponding raster pages with pixelmatch antialias exclusion. Pin renderer, DPI, fonts and document inputs separately. A passing pixel comparison does not replace human layout review or an independent Office reference.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [reference, candidate, destination] = process.argv.slice(2)
    if (!reference || !candidate || !destination)
      throw new Error(
        'Usage: node tools/compare-rendered-pages.mjs REFERENCE_DIR CANDIDATE_DIR REPORT.json',
      )
    const result = await compareRenderedPages(reference, candidate)
    await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    console.log(
      JSON.stringify({
        passed: result.passed,
        pages: result.referencePages,
        report: resolve(destination),
      }),
    )
    if (!result.passed) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
