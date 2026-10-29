#!/usr/bin/env node
/** Candidate-specific evidence. Missing checks remain unavailable or not-run. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
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
  ],
}
const write = () =>
  fs.writeFileSync(
    path.join(out, 'Vantage-Implementation-Validation.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
async function run(name, command, commandArgs, cwd = root) {
  const logPath = path.join(out, `${name}.log`)
  const fd = fs.openSync(logPath, 'w')
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048' },
      stdio: ['ignore', fd, fd],
    })
    let done = false
    const finish = (value) => {
      if (!done) {
        done = true
        resolve(value)
      }
    }
    child.on('error', (error) => finish({ status: 'unavailable', error: error.message }))
    child.on('close', (code) =>
      finish({ status: code === 0 ? 'passed' : 'failed', exitCode: code }),
    )
  })
  fs.closeSync(fd)
  report.checks.push({
    name,
    ...result,
    durationMs: Date.now() - started,
    logPath,
    logSha256: hash(logPath),
  })
  write()
  console.log(`${name}: ${result.status}`)
  return result
}
const npm =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
if (args.includes('--build')) await run('build-all', process.execPath, [npm, 'run', 'build:all'])
if (args.includes('--verify')) {
  const runtime = await run('runtime-capabilities', process.execPath, [
    path.join(root, 'tools/check-runtime-capabilities.mjs'),
  ])
  if (runtime.status !== 'passed') {
    report.finishedAt = new Date().toISOString()
    write()
    throw new Error(
      'Use the Node 24 runtime pinned in .nvmrc before running implementation verification.',
    )
  }
  await run(
    'fixtures-sheets',
    process.execPath,
    [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/generate-fixtures.ts'],
    path.join(root, 'apps/sheets'),
  )
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
    await run(
      `types-${name}`,
      process.execPath,
      [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'],
      ['shell', 'markdown', 'slides'].includes(name)
        ? path.join(root, 'apps', name)
        : path.join(root, 'packages', name),
    )
    await run(
      `tests-${name}`,
      process.execPath,
      [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1'],
      ['shell', 'markdown', 'slides'].includes(name)
        ? path.join(root, 'apps', name)
        : path.join(root, 'packages', name),
    )
  }
  await run('tests-engine-bridge', process.execPath, [
    '--test',
    'packages/engine-bridge/tests/bridge.test.mjs',
  ])
}
if (args.includes('--e2e'))
  await run('desktop-workflows', process.execPath, [
    path.join(root, 'node_modules/@playwright/test/cli.js'),
    'test',
    '--config',
    'e2e/playwright.config.ts',
    'engineering-workspace.spec.ts',
    'vantage-workspace.spec.ts',
    'recovery-drafts.spec.ts',
    'markdown-source-retention.spec.ts',
    '--reporter=list',
  ])
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
report.releaseAccepted = false
write()
console.log(path.join(out, 'Vantage-Implementation-Validation.json'))
if (report.checks.some((c) => c.status === 'failed')) process.exitCode = 1
