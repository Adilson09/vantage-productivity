import path from 'node:path'

export const desktopSpecs = [
  'engineering-workspace.spec.ts',
  'vantage-workspace.spec.ts',
  'recovery-drafts.spec.ts',
  'markdown-source-retention.spec.ts',
  'calendar-workspace.spec.ts',
  'docs-draft-recovery.spec.ts',
  'pdf-standards.spec.ts',
]

/** Exact source scopes, shared by the runner and its invocation regression tests. */
export function verificationPlan(root, node, npm, out) {
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
  const vitest = path.join(root, 'node_modules/vitest/vitest.mjs')
  const check = (name, args, cwd, extra = {}) => ({ name, command: node, args, cwd, ...extra })
  const types = (name, cwd) => check(`types-${name}`, [tsc, '--noEmit'], cwd)
  const tests = (name, cwd, files = []) => {
    const summaryPath = path.join(out, `tests-${name}.json`)
    return check(
      `tests-${name}`,
      [
        vitest,
        'run',
        ...files,
        '--maxWorkers=1',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${summaryPath}`,
      ],
      cwd,
      { kind: 'vitest', summaryPath, requiredFiles: files },
    )
  }
  const plan = [
    check('runtime-capabilities', [path.join(root, 'tools/check-runtime-capabilities.mjs')], root),
    check(
      'fixtures-sheets',
      [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/generate-fixtures.ts'],
      path.join(root, 'apps/sheets'),
    ),
  ]
  for (const name of [
    'electron-utils',
    'productivity-engine',
    'ai-provider',
    'shell',
    'markdown',
    'xlsx-gateway',
    'cli',
    'slides',
  ]) {
    const cwd = path.join(
      root,
      ['shell', 'markdown', 'slides'].includes(name) ? 'apps' : 'packages',
      name,
    )
    plan.push(types(name, cwd), tests(name, cwd))
  }
  const docx = path.join(root, 'packages/docx-engine')
  plan.push(
    types('docx-engine', docx),
    tests('docx-preservation', docx, ['tests/zip-splice-lazy-limits.test.ts']),
  )
  const docs = path.join(root, 'apps/docs')
  plan.push(
    types('docs', docs),
    tests('docs-draft', docs, [
      'tests/doc-draft-controller.test.ts',
      'tests/doc-draft-package.test.ts',
      'tests/doc-draft-renderer.test.ts',
      'tests/textbox-edit.test.ts',
    ]),
  )
  plan.push(
    check('tests-native-sheets', [npm, 'run', 'native:test', '-w', '@vantage/sheets'], root, {
      kind: 'rust',
    }),
    tests('sheets-session', path.join(root, 'apps/sheets'), [
      'tests/sidecar-session-recovery.test.ts',
      'tests/xlsx-sidecar-restart.test.ts',
      'tests/xlsx-edit-session.test.ts',
    ]),
    check('types-engine-bridge', [npm, 'run', 'typecheck', '-w', '@vantage/engine-bridge'], root),
    check(
      'tests-engine-bridge',
      ['--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/*.test.mjs'],
      path.join(root, 'packages/engine-bridge'),
      { kind: 'tap' },
    ),
  )
  return plan
}

export function desktopPlan(root, node, out) {
  const summaryPath = path.join(out, 'desktop-workflows.json')
  return {
    name: 'desktop-workflows',
    command: node,
    cwd: root,
    args: [
      path.join(root, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'e2e/playwright.config.ts',
      ...desktopSpecs,
      '--reporter=list,json',
    ],
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: summaryPath },
    kind: 'playwright',
    summaryPath,
    requiredFiles: desktopSpecs,
  }
}

const integer = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} in test report`)
  return value
}
const normalized = (value) => value.replaceAll('\\', '/')
function requireFiles(required, reported) {
  const missing = required.filter(
    (file) => !reported.some((name) => normalized(name).endsWith(normalized(file))),
  )
  if (missing.length)
    throw new Error(`Required test files absent from report: ${missing.join(', ')}`)
}

/** A zero process exit is insufficient when tests were omitted or excluded. */
export function summarizeTests(kind, content, requiredFiles = []) {
  if (kind === 'vitest') {
    const data = JSON.parse(content)
    const tests = integer(data.numTotalTests, 'test count')
    const summary = {
      tests,
      passed: integer(data.numPassedTests, 'passes'),
      failed: integer(data.numFailedTests, 'failures'),
      skipped: integer(data.numPendingTests, 'pending/skips'),
      todo: integer(data.numTodoTests, 'todos'),
      failedSuites: integer(data.numFailedTestSuites, 'suite failures'),
      excluded: [],
    }
    const files = data.testResults
    if (!Array.isArray(files)) throw new Error('Missing Vitest file results')
    requireFiles(
      requiredFiles,
      files.map((file) => file.name),
    )
    for (const file of files) {
      for (const test of file.assertionResults ?? []) {
        if (['skipped', 'pending', 'todo'].includes(test.status)) {
          summary.excluded.push({ file: file.name, test: test.fullName, status: test.status })
        }
      }
    }
    if (data.success !== true && summary.failed === 0 && summary.failedSuites === 0)
      throw new Error('Vitest did not report success')
    if (summary.passed + summary.failed + summary.skipped + summary.todo !== tests)
      throw new Error('Inconsistent Vitest counts')
    return summary
  }
  if (kind === 'playwright') {
    const data = JSON.parse(content)
    const stats = data.stats ?? {}
    const summary = {
      passed: integer(stats.expected, 'expected passes'),
      failed: integer(stats.unexpected, 'unexpected failures'),
      skipped: integer(stats.skipped, 'skips'),
      flaky: integer(stats.flaky, 'flaky outcomes'),
      errors: Array.isArray(data.errors) ? data.errors.length : 0,
      excluded: [],
    }
    summary.tests = summary.passed + summary.failed + summary.skipped + summary.flaky
    const files = []
    const visit = (suites) => {
      for (const suite of suites ?? []) {
        for (const spec of suite.specs ?? []) {
          files.push(spec.file ?? suite.file ?? '')
          for (const test of spec.tests ?? []) {
            if (test.status === 'skipped')
              summary.excluded.push({
                file: spec.file ?? suite.file,
                test: spec.title,
                status: 'skipped',
                reasons: (test.annotations ?? [])
                  .filter((a) => a.type === 'skip' || a.type === 'fixme')
                  .map((a) => a.description ?? a.type),
              })
          }
        }
        visit(suite.suites)
      }
    }
    visit(data.suites)
    requireFiles(requiredFiles, files)
    return summary
  }
  if (kind === 'tap') {
    const value = (name) => {
      const matches = [...content.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))]
      if (!matches.length) throw new Error(`Missing TAP ${name} summary`)
      return Number(matches.at(-1)[1])
    }
    return {
      tests: value('tests'),
      passed: value('pass'),
      failed: value('fail'),
      skipped: value('skipped'),
      cancelled: value('cancelled'),
      todo: value('todo'),
      excluded: content
        .split(/\r?\n/)
        .filter((line) => /^\s*(?:not )?ok\b.*#\s*(?:SKIP|TODO)\b/i.test(line)),
    }
  }
  if (kind === 'rust') {
    const rows = [
      ...content.matchAll(
        /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/g,
      ),
    ]
    if (!rows.length) throw new Error('Missing Rust test summary')
    const summary = { tests: 0, passed: 0, failed: 0, skipped: 0, filtered: 0, excluded: [] }
    for (const row of rows) {
      summary.passed += Number(row[1])
      summary.failed += Number(row[2])
      summary.skipped += Number(row[3])
      summary.filtered += Number(row[5])
    }
    summary.tests = summary.passed + summary.failed + summary.skipped + summary.filtered
    summary.excluded = content.split(/\r?\n/).filter((line) => /\.\.\. ignored\b/.test(line))
    return summary
  }
  throw new Error(`Unknown test report kind: ${kind}`)
}

export function checkStatus(processResult, summary) {
  if (processResult.status !== 'passed') return processResult.status
  if (!summary) return 'passed'
  if (!summary.tests) return 'incomplete'
  if (
    summary.failed ||
    summary.failedSuites ||
    summary.cancelled ||
    summary.flaky ||
    summary.errors
  )
    return 'failed'
  if (summary.skipped || summary.todo || summary.filtered) return 'passed-with-exclusions'
  return 'passed'
}

export function reportExitCode(checks) {
  return checks.some((check) => !['passed', 'passed-with-exclusions'].includes(check.status))
    ? 1
    : 0
}
