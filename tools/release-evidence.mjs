#!/usr/bin/env node
/** Candidate-specific evidence. Missing checks remain unavailable or not-run. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  checkStatus,
  desktopPlan,
  reportExitCode,
  summarizeTests,
  verificationPlan,
} from './release-evidence-plan.mjs'
import { defaultCheckTimeoutMs, runEvidenceProcess } from './release-evidence-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const timeoutArg = args.indexOf('--check-timeout-ms')
const checkTimeoutMs = timeoutArg < 0 ? defaultCheckTimeoutMs : Number(args[timeoutArg + 1])
if (
  !Number.isSafeInteger(checkTimeoutMs) ||
  checkTimeoutMs < 1000 ||
  checkTimeoutMs > 2 * 60 * 60 * 1000
)
  throw new Error('--check-timeout-ms must be between 1000 and 7200000')
const outputArg = args.indexOf('--out')
const out = path.resolve(
  outputArg >= 0 ? args[outputArg + 1] : path.join(root, 'validation', 'implementation'),
)
fs.mkdirSync(out, { recursive: true })
const shell = JSON.parse(fs.readFileSync(path.join(root, 'apps/shell/package.json'), 'utf8'))
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? r.stdout.trim() : null
}
const report = {
  product: 'Vantage Productivity',
  version: shell.version,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  source: {
    head: git('rev-parse', 'HEAD'),
    dirty: Boolean(git('status', '--porcelain')),
    lockSha256: hash(path.join(root, 'package-lock.json')),
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemory: os.totalmem(),
  },
  checks: [],
  checkTimeoutMs,
  requestedModes: {
    build: args.includes('--build'),
    verify: args.includes('--verify'),
    e2e: args.includes('--e2e'),
  },
  scopeNote:
    'Targeted implementation gates. This command does not replace the full npm test suite, specialist runtime acceptance or release review.',
  artifacts: [],
  externalAcceptance: [
    {
      name: 'Licensed Microsoft Office reference and 50 DOCX / 30 PPTX corpus',
      status: 'not-run',
      reason:
        'Requires a pinned licensed reference, hashed document corpus, rendered comparison and human critical-layout review.',
    },
    {
      name: 'Two screen readers, contrast and full six-editor accessibility',
      status: 'not-run',
      reason: 'Automated keyboard coverage does not establish human screen-reader acceptance.',
    },
    {
      name: 'Whole-process offline traffic / five cycles per editor',
      status: 'not-run',
      reason: 'Application permission tests do not establish operating-system traffic isolation.',
    },
    {
      name: 'Mail and provider authorization',
      status: 'not-run',
      reason: 'No live inbox, credentials or real-message sends are used in automated tests.',
    },
    {
      name: 'Publisher signing and clean-machine install/update/uninstall',
      status: 'unavailable',
      reason: 'No selected publisher certificate or disposable Windows VM is configured.',
    },
    {
      name: 'AI 30 tasks × five runs, blind rubric',
      status: 'not-run',
      reason:
        'Requires selected models, local weights or provider authorization and an independent rubric.',
    },
    {
      name: 'Optional specialist engine runtime and standards acceptance',
      status: 'not-run',
      reason:
        'Manifest, staging and saved-report parser tests do not establish live LibreOffice or veraPDF acceptance. Missing qpdf in desktop tests is recorded as an exclusion, not structural acceptance.',
    },
  ],
}
const write = () =>
  fs.writeFileSync(
    path.join(out, 'Vantage-Implementation-Validation.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
async function run(name, command, commandArgs, cwd = root, options = {}) {
  const logPath = path.join(out, `${name}.log`)
  const fd = fs.openSync(logPath, 'w')
  const started = Date.now()
  const check = {
    name,
    status: 'running',
    command,
    args: commandArgs,
    cwd,
    logPath,
    ...(options.requiredFiles?.length ? { requiredFiles: options.requiredFiles } : {}),
  }
  report.checks.push(check)
  write()
  if (options.summaryPath) fs.rmSync(options.summaryPath, { force: true })
  const result = await runEvidenceProcess(command, commandArgs, {
    cwd,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048', ...options.env },
    stdio: ['ignore', fd, fd],
    timeoutMs: checkTimeoutMs,
  })
  fs.closeSync(fd)
  let testSummary
  let summaryError
  if (options.kind) {
    try {
      testSummary = summarizeTests(
        options.kind,
        fs.readFileSync(options.summaryPath || logPath, 'utf8'),
        options.requiredFiles,
      )
    } catch (error) {
      summaryError = error.message
    }
  }
  const status =
    result.status === 'passed' && summaryError ? 'incomplete' : checkStatus(result, testSummary)
  Object.assign(check, {
    ...result,
    status,
    ...(testSummary ? { testSummary } : {}),
    ...(summaryError ? { summaryError } : {}),
    ...(options.summaryPath && fs.existsSync(options.summaryPath)
      ? { summaryPath: options.summaryPath, summarySha256: hash(options.summaryPath) }
      : {}),
    durationMs: Date.now() - started,
    logSha256: hash(logPath),
  })
  write()
  console.log(`${name}: ${status}`)
  return check
}
const npm =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
let buildResult
if (args.includes('--build'))
  buildResult = await run('build-all', process.execPath, [npm, 'run', 'build:all'])
if (args.includes('--verify')) {
  for (const check of verificationPlan(root, process.execPath, npm, out)) {
    const result = await run(check.name, check.command, check.args, check.cwd, check)
    if (check.name === 'runtime-capabilities' && result.status !== 'passed') {
      report.finishedAt = new Date().toISOString()
      write()
      throw new Error(
        'Use the Node 24 runtime pinned in .nvmrc before running implementation verification.',
      )
    }
  }
}
if (args.includes('--e2e')) {
  if (buildResult && buildResult.status !== 'passed') {
    report.checks.push({
      name: 'desktop-workflows',
      status: 'not-run',
      reason:
        'The requested build did not pass; existing application outputs were not accepted as this candidate.',
    })
    write()
  } else {
    const check = desktopPlan(root, process.execPath, out)
    await run(check.name, check.command, check.args, check.cwd, check)
  }
}
for (const relative of [
  'package-lock.json',
  'apps/shell/out/main/index.js',
  'apps/shell/out/preload/index.js',
  'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe',
  'companions/depesha-bin/vantage-mail.exe',
]) {
  const file = path.join(root, relative)
  report.artifacts.push(
    fs.existsSync(file)
      ? { path: relative, bytes: fs.statSync(file).size, sha256: hash(file) }
      : { path: relative, status: 'unavailable' },
  )
}
for (const name of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'cli']) {
  const relative = `${name === 'cli' ? 'packages' : 'apps'}/${name}/${name === 'cli' ? 'dist/vantage.cjs' : 'out/main/index.js'}`
  const file = path.join(root, relative)
  report.artifacts.push(
    fs.existsSync(file)
      ? { path: relative, bytes: fs.statSync(file).size, sha256: hash(file) }
      : { path: relative, status: 'unavailable' },
  )
}
report.finishedAt = new Date().toISOString()
report.completedChecksPassed =
  report.checks.length > 0 && report.checks.every((c) => c.status === 'passed')
report.hasExclusions = report.checks.some((c) => c.status === 'passed-with-exclusions')
report.releaseAccepted = false
write()
console.log(path.join(out, 'Vantage-Implementation-Validation.json'))
process.exitCode = reportExitCode(report.checks)
