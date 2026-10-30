#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  discoverEngines,
  checkPdf,
  runBounded,
  parseVeraPdfReport,
} from '../packages/engine-bridge/src/index.mjs'

const FIXTURES = [
  [
    'pdfa-1b-pass.pdf',
    '1b',
    'pass',
    '0a578e09d02ca14e2b669cae84e66056d646d47680688f62468d527bc4c9e222',
  ],
  [
    'pdfa-1b-fail.pdf',
    '1b',
    'fail',
    'ee0792dbe6a3802a31e9e73abe7bb372e01d21d738c7abc785d46d8521bb5643',
  ],
  [
    'pdfua-1-pass.pdf',
    'ua1',
    'pass',
    '853fc52f5dca32dd257cac1da4ca9c1702623e357b48a361f835c4f271bd2c68',
  ],
  [
    'pdfua-1-fail.pdf',
    'ua1',
    'fail',
    '33d9008d84746cb8cf7cf11f50d8e67a97b3640978d845050e18ee47bfb95310',
  ],
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Real, serial bridge acceptance; never changes the supplied corpus files. */
export async function validateSpecialistEngines({ manifestPath, fixturesRoot, evidencePath }) {
  const report = {
    startedAt: new Date().toISOString(),
    manifestPath: resolve(manifestPath),
    corpusCommit: 'bb75f4f0073d9350dfd058c0162a367e6fadf25e',
    corpusLicense: 'CC-BY-4.0',
    corpusSource: 'https://github.com/veraPDF/veraPDF-corpus',
    cases: [],
    failures: [],
  }
  const root = resolve(fixturesRoot)
  const evidenceRoot = resolve(evidencePath, '..')
  await mkdir(evidenceRoot, { recursive: true })
  const options = { manifestPath: report.manifestPath, env: { PATH: '' }, tempRoot: evidenceRoot }
  const persist = () => writeFile(resolve(evidencePath), JSON.stringify(report, null, 2) + '\n')
  report.engines = await discoverEngines(options)
  await persist()
  const vera = report.engines.find((engine) => engine.id === 'verapdf' && engine.available)
  if (!vera?.launch) throw new Error('The verified private veraPDF Java/JAR runtime is unavailable')
  for (const [name, flavour, expected, sha256] of FIXTURES) {
    const path = join(root, name)
    if (hash(await readFile(path)) !== sha256)
      throw new Error('Official fixture hash mismatch: ' + name)
    const result = await checkPdf(path, { ...options, engine: 'verapdf', flavour })
    const unchanged = hash(await readFile(path)) === sha256
    const qpdf = report.engines.some((engine) => engine.id === 'qpdf' && engine.available)
      ? await checkPdf(path, { ...options, engine: 'qpdf' })
      : null
    report.cases.push({
      name,
      flavour,
      expected,
      sourceSha256: sha256,
      sourceUnchanged: unchanged,
      result,
      qpdf: qpdf ? { status: qpdf.status, code: qpdf.code } : null,
    })
    if (
      result.status !== expected ||
      !result.conformance?.complete ||
      !result.sourceUnchanged ||
      !unchanged
    )
      report.failures.push(name)
    await persist()
  }
  const malformed = join(evidenceRoot, 'standards-malformed.pdf')
  const bytes = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\nendobj\n%%EOF\n'
  try {
    await writeFile(malformed, bytes, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST' || (await readFile(malformed, 'utf8')) !== bytes) throw error
  }
  const malformedResult = await checkPdf(malformed, {
    ...options,
    engine: 'verapdf',
    flavour: '1b',
  })
  report.cases.push({ name: 'malformed.pdf', expected: 'incomplete', result: malformedResult })
  if (
    malformedResult.status !== 'incomplete' ||
    malformedResult.code !== 7 ||
    (await readFile(malformed, 'utf8')) !== bytes
  )
    report.failures.push('malformed.pdf')
  await persist()
  const timed = await checkPdf(join(root, FIXTURES[0][0]), {
    ...options,
    engine: 'verapdf',
    flavour: '1b',
    timeoutMs: 1,
  })
  report.cases.push({ name: 'owned-runtime-deadline', expected: 'incomplete', result: timed })
  if (timed.status !== 'incomplete' || timed.stopped !== 'timeout' || !timed.sourceUnchanged)
    report.failures.push('owned-runtime-deadline')
  await persist()
  const memoryInput = join(evidenceRoot, 'owned-memory-input.pdf')
  try {
    await copyFile(join(root, FIXTURES[0][0]), memoryInput, 1)
  } catch (error) {
    if (error.code !== 'EEXIST' || hash(await readFile(memoryInput)) !== FIXTURES[0][3]) throw error
  }
  const memory = await runBounded(
    vera.path,
    [
      '-Xms4m',
      '-Xmx8m',
      '-XX:ActiveProcessorCount=1',
      '-Djava.awt.headless=true',
      '-Duser.home=' + evidenceRoot,
      '-Dapp.home=' + evidenceRoot,
      '-Djava.io.tmpdir=' + evidenceRoot,
      '-jar',
      vera.launch.jar,
      '--format',
      'json',
      '--flavour',
      '1b',
      memoryInput,
    ],
    {
      timeoutMs: 60000,
      maxOutputBytes: 1024 * 1024,
      cwd: evidenceRoot,
      processEnv: {
        JAVA_TOOL_OPTIONS: undefined,
        JDK_JAVA_OPTIONS: undefined,
        _JAVA_OPTIONS: undefined,
      },
    },
  )
  const memoryResult = parseVeraPdfReport(memory, { flavour: '1b' })
  const actualHeapFailure = /OutOfMemory|Java heap space/i.test(memory.stderr + memory.stdout)
  report.cases.push({
    name: 'owned-JVM-heap-failure',
    expected: 'incomplete',
    actualHeapFailure,
    result: { ...memory, ...memoryResult },
  })
  if (memoryResult.status !== 'incomplete' || !actualHeapFailure)
    report.failures.push('owned-JVM-heap-failure')
  for (const [name, , , expected] of FIXTURES)
    if (hash(await readFile(join(root, name))) !== expected)
      report.failures.push('source changed: ' + name)
  report.completedAt = new Date().toISOString()
  report.passed = report.failures.length === 0
  await persist()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    const flags = ['--manifest', '--fixtures', '--evidence']
    if (
      args.length !== 6 ||
      args.some((value, index) => index % 2 === 0 && !flags.includes(value)) ||
      new Set(args.filter((_, i) => i % 2 === 0)).size !== 3
    )
      throw new Error(
        'Usage: node tools/validate-specialist-engines.mjs --manifest FILE --fixtures DIRECTORY --evidence REPORT.json',
      )
    const value = (flag) => args[args.indexOf(flag) + 1]
    const report = await validateSpecialistEngines({
      manifestPath: value('--manifest'),
      fixturesRoot: value('--fixtures'),
      evidencePath: value('--evidence'),
    })
    console.log(
      JSON.stringify({
        passed: report.passed,
        cases: report.cases.length,
        failures: report.failures,
        evidence: resolve(value('--evidence')),
      }),
    )
    if (!report.passed) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
