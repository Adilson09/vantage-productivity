import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  checkStatus,
  desktopPlan,
  desktopSpecs,
  reportExitCode,
  summarizeTests,
  verificationPlan,
} from '../release-evidence-plan.mjs'
import { runEvidenceProcess } from '../release-evidence-process.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const plan = verificationPlan(root, process.execPath, npm, path.join(tmpdir(), 'evidence-plan'))
const get = (name) => {
  const item = plan.find((check) => check.name === name)
  assert.ok(item, `Missing required gate ${name}`)
  return item
}
const json = (value) => JSON.stringify(value)
function removeFixture(directory) {
  const resolved = path.resolve(directory)
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith('vantage-evidence-')
  )
    throw new Error('Refusing unexpected fixture cleanup path')
  rmSync(resolved, { recursive: true, force: true })
}
const vitestReport = (extra = {}) => ({
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numFailedTestSuites: 0,
  success: true,
  testResults: [{ name: '/tests/recovery.test.ts', assertionResults: [] }],
  ...extra,
})
const playwrightReport = (extra = {}) => ({
  stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
  errors: [],
  suites: [
    {
      file: 'calendar-workspace.spec.ts',
      specs: [
        { file: 'calendar-workspace.spec.ts', title: 'reopens', tests: [{ status: 'expected' }] },
      ],
    },
  ],
  ...extra,
})

test('root test/typecheck call the bridge workspace instead of selecting its original test file', () => {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts
  assert.match(scripts.test, /npm run test -w @vantage\/engine-bridge/)
  assert.doesNotMatch(scripts.test, /engine-bridge\/tests\/bridge\.test/)
  assert.match(scripts.typecheck, /npm run typecheck -w @vantage\/engine-bridge/)
  assert.match(scripts.test, /npm run test:release-evidence/)
  assert.deepEqual(get('tests-engine-bridge').args, [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    'tests/*.test.mjs',
  ])
  const bridgeScripts = JSON.parse(
    readFileSync(path.join(root, 'packages/engine-bridge/package.json'), 'utf8'),
  ).scripts
  assert.ok(bridgeScripts.test.includes(get('tests-engine-bridge').args.at(-1)))
  assert.deepEqual(get('types-engine-bridge').args.slice(1), [
    'run',
    'typecheck',
    '-w',
    '@vantage/engine-bridge',
  ])
})

test('verify includes the full calendar workspace suite, focused Docs/source preservation and native receipt recovery', () => {
  assert.equal(get('tests-productivity-engine').requiredFiles.length, 0)
  assert.deepEqual(get('tests-docx-preservation').requiredFiles, [
    'tests/zip-splice-lazy-limits.test.ts',
  ])
  assert.deepEqual(get('tests-docs-draft').requiredFiles, [
    'tests/doc-draft-controller.test.ts',
    'tests/doc-draft-package.test.ts',
    'tests/doc-draft-renderer.test.ts',
    'tests/textbox-edit.test.ts',
  ])
  assert.deepEqual(get('tests-native-sheets').args.slice(1), [
    'run',
    'native:test',
    '-w',
    '@vantage/sheets',
  ])
  assert.equal(get('tests-native-sheets').kind, 'rust')
  assert.deepEqual(get('tests-sheets-session').requiredFiles, [
    'tests/sidecar-session-recovery.test.ts',
    'tests/xlsx-sidecar-restart.test.ts',
    'tests/xlsx-edit-session.test.ts',
  ])
  for (const check of plan)
    for (const file of check.requiredFiles ?? [])
      assert.ok(existsSync(path.join(check.cwd, file)), file)
})

test('desktop plan requires all phase workflows and a machine-readable report without removing older gates', () => {
  const check = desktopPlan(root, process.execPath, tmpdir())
  assert.equal(desktopSpecs.length, 7)
  for (const file of desktopSpecs) {
    assert.ok(check.args.includes(file))
    assert.ok(existsSync(path.join(root, 'e2e', file)), file)
  }
  assert.ok(check.args.includes('--reporter=list,json'))
  assert.equal(check.env.PLAYWRIGHT_JSON_OUTPUT_NAME, check.summaryPath)
})

test('Vitest skips and todos remain exclusions instead of complete pass evidence', () => {
  const summary = summarizeTests(
    'vitest',
    json(
      vitestReport({
        numTotalTests: 3,
        numPassedTests: 1,
        numPendingTests: 1,
        numTodoTests: 1,
        testResults: [
          {
            name: '/tests/recovery.test.ts',
            assertionResults: [
              { fullName: 'optional reference', status: 'skipped' },
              { fullName: 'future acceptance', status: 'todo' },
            ],
          },
        ],
      }),
    ),
  )
  assert.equal(checkStatus({ status: 'passed' }, summary), 'passed-with-exclusions')
  assert.equal(summary.excluded.length, 2)
  assert.throws(
    () => summarizeTests('vitest', json(vitestReport({ numTotalTests: 10 }))),
    /Inconsistent/,
  )
})

test('required files cannot disappear from a passing Vitest report', () => {
  assert.throws(
    () => summarizeTests('vitest', json(vitestReport()), ['tests/not-invoked.test.ts']),
    /absent/,
  )
  assert.equal(
    checkStatus(
      { status: 'passed' },
      summarizeTests('vitest', json(vitestReport()), ['tests/recovery.test.ts']),
    ),
    'passed',
  )
})

test('Playwright optional engine skip retains its reason and prevents complete pass evidence', () => {
  const summary = summarizeTests(
    'playwright',
    json(
      playwrightReport({
        stats: { expected: 0, unexpected: 0, skipped: 1, flaky: 0 },
        suites: [
          {
            file: 'calendar-workspace.spec.ts',
            specs: [
              {
                file: 'calendar-workspace.spec.ts',
                title: 'native engine',
                tests: [
                  {
                    status: 'skipped',
                    annotations: [{ type: 'skip', description: 'qpdf is unavailable' }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
    ['calendar-workspace.spec.ts'],
  )
  assert.equal(checkStatus({ status: 'passed' }, summary), 'passed-with-exclusions')
  assert.deepEqual(summary.excluded[0].reasons, ['qpdf is unavailable'])
})

test('missing desktop files, malformed reports, global errors and flaky cases fail closed', () => {
  assert.throws(
    () => summarizeTests('playwright', json(playwrightReport()), desktopSpecs),
    /absent/,
  )
  assert.throws(() => summarizeTests('playwright', '{}'), /Invalid/)
  assert.throws(() => summarizeTests('vitest', '{'), SyntaxError)
  assert.equal(
    checkStatus(
      { status: 'passed' },
      summarizeTests(
        'playwright',
        json(playwrightReport({ errors: [{ message: 'fixture failed' }] })),
      ),
    ),
    'failed',
  )
  assert.equal(
    checkStatus(
      { status: 'passed' },
      summarizeTests(
        'playwright',
        json(playwrightReport({ stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 1 } })),
      ),
    ),
    'failed',
  )
})

test('Rust ignored/filtered tests and TAP skips cannot become full acceptance', () => {
  const rust = summarizeTests(
    'rust',
    'test result: ok. 5 passed; 0 failed; 1 ignored; 0 measured; 2 filtered out; finished in 0s\n',
  )
  assert.equal(rust.tests, 8)
  assert.equal(checkStatus({ status: 'passed' }, rust), 'passed-with-exclusions')
  assert.throws(() => summarizeTests('rust', 'compiler finished, no tests'), /Missing/)
  assert.throws(() => summarizeTests('tap', '# tests 1\n# pass 1\n'), /Missing/)
})

test('unavailable, interrupted and incomplete checks produce failure exits; exclusions stay explicitly partial', () => {
  for (const status of ['failed', 'unavailable', 'incomplete', 'timed-out', 'running']) {
    assert.equal(reportExitCode([{ status }]), 1, status)
    assert.equal(checkStatus({ status }, { tests: 1, passed: 1 }), status)
  }
  assert.equal(reportExitCode([{ status: 'passed-with-exclusions' }]), 0)
  assert.equal(checkStatus({ status: 'passed' }, { tests: 0 }), 'incomplete')
})

test('real Node TAP output reports a skipped test separately from a pass', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vantage-evidence-tap-'))
  const file = path.join(directory, 'fixture.mjs')
  const log = path.join(directory, 'result.tap')
  writeFileSync(
    file,
    "import {test} from 'node:test'; test('ordinary',()=>{}); test.skip('optional engine',()=>{});\n",
  )
  const fd = openSync(log, 'w')
  try {
    const result = await runEvidenceProcess(
      process.execPath,
      ['--test', '--test-reporter=tap', path.join(directory, '*.mjs')],
      { stdio: ['ignore', fd, fd], timeoutMs: 15000 },
    )
    assert.equal(result.status, 'passed')
    const summary = summarizeTests('tap', readFileSync(log, 'utf8'))
    assert.equal(summary.passed, 1)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.excluded.length, 1)
    assert.equal(checkStatus(result, summary), 'passed-with-exclusions')
  } finally {
    closeSync(fd)
    removeFixture(directory)
  }
})

test('a real stalled check is terminated as a timeout and a missing executable is unavailable', async () => {
  const timed = await runEvidenceProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    timeoutMs: 200,
  })
  assert.equal(timed.status, 'timed-out')
  assert.equal(reportExitCode([timed]), 1)
  const missing = await runEvidenceProcess(
    path.join(tmpdir(), 'vantage-no-such-executable-29428'),
    [],
    { stdio: 'ignore', timeoutMs: 15000 },
  )
  assert.equal(missing.status, 'unavailable')
  assert.equal(reportExitCode([missing]), 1)
})

test('real Vitest reporter arguments produce fresh file evidence with an explicit skip', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vantage-evidence-vitest-'))
  const config = path.join(directory, 'vitest.config.mjs')
  const log = path.join(directory, 'result.log')
  const report = path.join(directory, 'result.json')
  writeFileSync(
    config,
    "export default {test:{globals:true,include:['fixture.test.js'],pool:'threads',maxWorkers:1}}\n",
  )
  writeFileSync(
    path.join(directory, 'fixture.test.js'),
    "test('ordinary',()=>{expect(2+2).toBe(4)});test.skip('optional reference',()=>{});\n",
  )
  const fd = openSync(log, 'w')
  try {
    const result = await runEvidenceProcess(
      process.execPath,
      [
        path.join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
        '--root',
        directory,
        '--maxWorkers=1',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { cwd: root, stdio: ['ignore', fd, fd], timeoutMs: 90000 },
    )
    assert.equal(result.status, 'passed', readFileSync(log, 'utf8'))
    const summary = summarizeTests('vitest', readFileSync(report, 'utf8'), ['fixture.test.js'])
    assert.equal(summary.passed, 1)
    assert.equal(summary.skipped, 1)
    assert.equal(checkStatus(result, summary), 'passed-with-exclusions')
  } finally {
    closeSync(fd)
    removeFixture(directory)
  }
})

test('real Playwright JSON output preserves skipped gate names and reasons without launching an application', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vantage-evidence-playwright-'))
  const config = path.join(directory, 'playwright.config.mjs')
  const log = path.join(directory, 'result.log')
  const report = path.join(directory, 'result.json')
  writeFileSync(
    config,
    `export default ${json({ testDir: directory, outputDir: path.join(directory, 'results'), testMatch: 'fixture.spec.mjs', workers: 1, timeout: 10000 })}\n`,
  )
  writeFileSync(
    path.join(directory, 'fixture.spec.mjs'),
    `import {test,expect} from ${json(pathToFileURL(path.join(root, 'node_modules/@playwright/test/index.mjs')).href)};test('ordinary',()=>{expect(2+2).toBe(4)});test('optional reference',()=>{test.skip(true,'qpdf unavailable in fixture')});\n`,
  )
  const fd = openSync(log, 'w')
  try {
    const result = await runEvidenceProcess(
      process.execPath,
      [
        path.join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        '--config',
        config,
        '--reporter=list,json',
      ],
      {
        cwd: root,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: report },
        stdio: ['ignore', fd, fd],
        timeoutMs: 90000,
      },
    )
    assert.equal(result.status, 'passed', readFileSync(log, 'utf8'))
    const summary = summarizeTests('playwright', readFileSync(report, 'utf8'), ['fixture.spec.mjs'])
    assert.equal(summary.passed, 1)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.excluded[0].test, 'optional reference')
    assert.deepEqual(summary.excluded[0].reasons, ['qpdf unavailable in fixture'])
    assert.equal(checkStatus(result, summary), 'passed-with-exclusions')
  } finally {
    closeSync(fd)
    removeFixture(directory)
  }
})
