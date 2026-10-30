import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverEngines, runBounded, convertDocument, checkPdf } from '../src/index.mjs'

test('subprocess reports stdout, stderr and exit code without a shell', async () => {
  const result = await runBounded(process.execPath, [
    '-e',
    'process.stdout.write("out");process.stderr.write("err");process.exitCode=3',
  ])
  assert.equal(result.code, 3)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
})
test('untrusted argument remains a literal subprocess argument', async () => {
  const payload = 'hello; $(Get-Content secret) & echo unsafe'
  const result = await runBounded(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1])',
    payload,
  ])
  assert.equal(result.stdout, payload)
})
test('enforces deadline on a stalled process', async () => {
  const start = Date.now()
  const result = await runBounded(process.execPath, ['-e', 'setInterval(()=>{},100)'], {
    timeoutMs: 100,
  })
  assert.equal(result.stopped, 'timeout')
  assert.ok(Date.now() - start < 8000)
})
test('stops processes exceeding combined output budget', async () => {
  const result = await runBounded(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(1000000)); setInterval(()=>{},100)'],
    { maxOutputBytes: 1000 },
  )
  assert.equal(result.stopped, 'output-limit')
  assert.ok(result.stdout.length <= 1000)
})
test('cancelled request does not start an engine', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runBounded(process.execPath, ['-e', 'throw Error()'], {
    signal: controller.signal,
  })
  assert.equal(result.stopped, 'cancelled')
})
test('supports cancellation during an active operation', async () => {
  const controller = new AbortController()
  const promise = runBounded(process.execPath, ['-e', 'setInterval(()=>{},100)'], {
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 100)
  assert.equal((await promise).stopped, 'cancelled')
})
test('enforces explicit executable path and resource ceiling', () => {
  assert.throws(() => runBounded('qpdf', []), /absolute/)
  assert.throws(() => runBounded(process.execPath, [], { timeoutMs: Infinity }), /Deadline/)
  assert.throws(() => runBounded(process.execPath, [], { timeoutMs: 120001 }), /Deadline/)
  assert.throws(() => runBounded(process.execPath, [], { maxOutputBytes: 8000000 }), /budget/)
})
test('discovery reports uninstalled engines honestly', async () => {
  const engines = await discoverEngines({
    env: { PATH: '' },
    paths: { libreoffice: '/no-such-engine', qpdf: '/no-such-qpdf', verapdf: '/no-such-verapdf' },
  })
  assert.equal(engines.length, 3)
  assert.ok(engines.every((engine) => !engine.available && engine.reason))
})
test('discovery probes executable and records version and SHA256', async () => {
  const engines = await discoverEngines({ env: { PATH: '' }, paths: { qpdf: process.execPath } })
  const found = engines.find((engine) => engine.id === 'qpdf')
  assert.equal(found.available, true)
  assert.match(found.version, /^v\d/)
  assert.match(found.executableSha256, /^[0-9a-f]{64}$/)
})
test('missing executable does not become a successful tool result', async () => {
  const result = await runBounded(join(tmpdir(), 'no-such-vantage-engine.exe'), ['--version'])
  assert.equal(result.stopped, 'unavailable')
  assert.equal(result.code, null)
})
test('conversion refuses overwrite and preserves source without requiring an engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-bridge-test-'))
  try {
    const source = join(dir, 'source.docx'),
      target = join(dir, 'copy.pdf')
    await writeFile(source, 'source untouched')
    await writeFile(target, 'destination untouched')
    await assert.rejects(convertDocument(source, target), /never overwrites/)
    await assert.rejects(convertDocument(source, source), /separate destination/)
    await assert.rejects(convertDocument(source, join(dir, 'bad.exe')), /Choose PDF/)
    assert.equal(await readFile(source, 'utf8'), 'source untouched')
    assert.equal(await readFile(target, 'utf8'), 'destination untouched')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('PDF diagnostics rejects non-PDF input before invoking a tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-bridge-test-'))
  try {
    const source = join(dir, 'file.docx')
    await writeFile(source, 'docx')
    await assert.rejects(checkPdf(source), /Unsupported input format/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('portable manifest resolves relative executables and enforces pinned bytes before probing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-bridge-test-'))
  try {
    const exe = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    await copyFile(process.execPath, exe)
    const manifestPath = join(dir, 'engines.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        engines: {
          qpdf: {
            path: process.platform === 'win32' ? 'node.exe' : 'node',
            sha256: '0'.repeat(64),
            validation: { status: 'unvalidated', detail: 'Test metadata' },
          },
        },
      }),
    )
    let engines = await discoverEngines({ env: { PATH: '' }, manifestPath })
    assert.equal(engines.find((engine) => engine.id === 'qpdf').available, false)
    assert.match(engines.find((engine) => engine.id === 'qpdf').reason, /pinned SHA256/)
    assert.equal(engines.find((engine) => engine.id === 'qpdf').validation.status, 'unvalidated')
    await writeFile(
      manifestPath,
      JSON.stringify({
        engines: {
          qpdf: {
            path: process.platform === 'win32' ? 'node.exe' : 'node',
            validation: { status: 'probe-only', detail: 'Test metadata' },
          },
        },
      }),
    )
    engines = await discoverEngines({ env: { PATH: '' }, manifestPath })
    assert.equal(engines.find((engine) => engine.id === 'qpdf').available, true)
    assert.equal(engines.find((engine) => engine.id === 'qpdf').validation.status, 'probe-only')
    await writeFile(manifestPath, JSON.stringify({ engines: { qpdf: { path: '../escaped.exe' } } }))
    await assert.rejects(
      discoverEngines({ env: { PATH: '' }, manifestPath }),
      /leaves the engine manifest directory/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an invalid manifest retains the parser failure as its diagnostic cause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-bridge-test-'))
  try {
    const manifestPath = join(dir, 'engines.json')
    await writeFile(manifestPath, '{invalid JSON')
    await assert.rejects(discoverEngines({ env: { PATH: '' }, manifestPath }), (error) => {
      assert.match(error.message, /^Cannot load local engine configuration:/)
      assert.ok(error.cause instanceof SyntaxError)
      assert.ok(error.message.includes(error.cause.message))
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
