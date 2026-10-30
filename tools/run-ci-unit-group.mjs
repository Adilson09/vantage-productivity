import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceTest = (workspace) => `npm run test -w @vantage/${workspace}`
export const UNIT_GROUPS = Object.freeze({
  'core-docs': Object.freeze([
    'npm run test:format',
    ...[
      'i18n',
      'electron-utils',
      'font-metrics',
      'zip-gate',
      'docx-engine',
      'pdf2docx',
      'html2docx',
      'file-parse',
      'pptx-engine',
      'xlsx-gateway',
      'pptx-ops',
      'pptx-render',
      'pipelines',
      'ai-search',
      'agent-core',
      'ai-provider',
      'project-store',
      'cli',
      'ui',
      'docs',
    ].map(workspaceTest),
  ]),
  'sheets-compat': Object.freeze([workspaceTest('sheets')]),
  'editors-bridge': Object.freeze([
    ...['shell', 'slides', 'pdf', 'markdown', 'html', 'productivity-engine'].map(workspaceTest),
    workspaceTest('engine-bridge'),
    'npm run test:release-evidence',
  ]),
})
export const COMPATIBILITY_COMMANDS = Object.freeze([
  'npm run fixtures -w @vantage/sheets',
  'npm run compat -w @vantage/sheets',
])
const PRETEST = 'npm run check:runtime'
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

/** Deliberately accepts only this repository's reviewed argv forms, never shell text. */
export function parseCommand(command) {
  if (command === 'npm run test:format' || command === 'npm run test:release-evidence' || command === PRETEST)
    return { runtime: 'npm', args: ['run', command.slice('npm run '.length)] }
  const workspace = /^npm run (test|fixtures|compat) -w (@vantage\/[a-z0-9-]+)$/.exec(command)
  if (workspace) return { runtime: 'npm', args: ['run', workspace[1], '-w', workspace[2]] }
  if (command === 'node --test packages/engine-bridge/tests/*.test.mjs')
    return { runtime: 'node', args: ['--test', 'packages/engine-bridge/tests/*.test.mjs'] }
  throw new Error(`Unrecognized test command; review the CI partition: ${command}`)
}

/** Any added, removed, repeated, or reordered root command requires an explicit review. */
export function validatePartition(testScript, groups = UNIT_GROUPS) {
  if (typeof testScript !== 'string' || !testScript.trim())
    throw new Error('Missing root scripts.test')
  const actual = testScript.split('&&').map((command) => command.trim())
  for (const command of actual) parseCommand(command)
  if (new Set(actual).size !== actual.length)
    throw new Error('Duplicate command in root scripts.test')
  const partition = Object.entries(groups).flatMap(([group, commands]) => {
    if (!Array.isArray(commands) || commands.length === 0)
      throw new Error(`Empty or invalid CI group: ${group}`)
    for (const command of commands) parseCommand(command)
    return commands
  })
  if (new Set(partition).size !== partition.length)
    throw new Error('Duplicate command in CI partition')
  const unpartitioned = actual.filter((command) => !partition.includes(command))
  if (unpartitioned.length)
    throw new Error(`Unpartitioned root command: ${unpartitioned.join(', ')}`)
  const missing = partition.filter((command) => !actual.includes(command))
  if (missing.length)
    throw new Error(`CI partition command missing from root scripts.test: ${missing.join(', ')}`)
  if (actual.some((command, index) => command !== partition[index]))
    throw new Error('CI partition order differs from root scripts.test')
  return actual
}

export function validateManifest(manifest) {
  validatePartition(manifest.scripts?.test)
  if (manifest.scripts?.pretest !== PRETEST)
    throw new Error('Root pretest changed; review the CI runtime preflight')
}

export function groupPlan(group, manifest) {
  validateManifest(manifest)
  if (!Object.hasOwn(UNIT_GROUPS, group)) throw new Error(`Unknown CI unit group: ${group}`)
  const plan = UNIT_GROUPS[group].map((command) => ({ command, kind: 'unit' }))
  if (group === 'sheets-compat')
    plan.push(...COMPATIBILITY_COMMANDS.map((command) => ({ command, kind: 'compatibility' })))
  return plan
}

/** npm.cmd needs a shell on Windows; invoking npm's JS entry with Node avoids one. */
export function findNpmCli({
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  const candidates = [
    env.npm_execpath,
    resolve(dirname(execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ]
  const found = candidates.find(
    (path) => typeof path === 'string' && /[\\/]npm-cli\.js$/.test(path) && exists(path),
  )
  if (!found)
    throw new Error('Cannot locate npm-cli.js; run this tool through its npm run test:ci:* script')
  return found
}

export function commandInvocation(
  command,
  { execPath = process.execPath, npmCli, cwd = repositoryRoot } = {},
) {
  const parsed = parseCommand(command)
  if (parsed.runtime === 'npm' && !npmCli) throw new Error('An npm CLI path is required')
  return {
    executable: execPath,
    args: parsed.runtime === 'npm' ? [npmCli, ...parsed.args] : parsed.args,
    options: { cwd, shell: false, stdio: 'inherit' },
  }
}

function spawnCommand(invocation) {
  return new Promise((finish) => {
    const child = spawn(invocation.executable, invocation.args, invocation.options)
    child.once('error', (error) => finish({ code: 1, error: error.message }))
    child.once('close', (code, signal) =>
      finish({ code: code ?? 1, ...(signal ? { signal } : {}) }),
    )
  })
}

/** Independent suites continue after failures; dependent compatibility gates fail closed. */
export async function runGroup(group, manifest, { execute, log = () => {} } = {}) {
  const plan = groupPlan(group, manifest)
  if (typeof execute !== 'function') throw new Error('A command executor is required')
  const executeOne = async (command, kind) => {
    log(`Running ${command}`)
    try {
      const result = await execute(command)
      return { ...result, command, kind, status: result.code === 0 ? 'passed' : 'failed' }
    } catch (error) {
      return { command, kind, status: 'failed', code: 1, error: String(error) }
    }
  }
  const preflight = await executeOne(PRETEST, 'preflight')
  const commands = []
  for (const item of plan) {
    const dependencyFailed =
      preflight.status !== 'passed' ||
      (item.kind === 'compatibility' && commands.some((result) => result.status !== 'passed'))
    if (dependencyFailed) {
      const reason =
        preflight.status !== 'passed'
          ? 'Runtime preflight failed'
          : 'Sheets tests/native build or fixture generation did not pass'
      commands.push({ ...item, status: 'not-run', reason })
      log(`Not run: ${item.command} (${reason})`)
    } else commands.push(await executeOne(item.command, item.kind))
  }
  const status =
    preflight.status === 'passed' && commands.every((result) => result.status === 'passed')
      ? 'passed'
      : 'failed'
  return { group, status, preflight, commands }
}

async function main(args) {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'))
  if (args.length === 1 && args[0] === '--matrix') {
    validateManifest(manifest)
    console.log(`groups=${JSON.stringify(Object.keys(UNIT_GROUPS))}`)
    return
  }
  if (args.length === 1 && args[0] === '--validate') {
    const commands = validatePartition(manifest.scripts?.test)
    validateManifest(manifest)
    console.log(
      JSON.stringify(
        {
          rootCommands: commands.length,
          groups: Object.fromEntries(
            Object.keys(UNIT_GROUPS).map((group) => [
              group,
              groupPlan(group, manifest).map((item) => item.command),
            ]),
          ),
        },
        null,
        2,
      ),
    )
    return
  }
  const [group, reportOption, reportPath] = args
  if (
    !group ||
    (args.length !== 1 && !(args.length === 3 && reportOption === '--report' && reportPath))
  )
    throw new Error(
      'Usage: node tools/run-ci-unit-group.mjs <group> [--report <path>] | --validate | --matrix',
    )
  groupPlan(group, manifest) // Validate before npm discovery or any child process.
  const npmCli = findNpmCli()
  const report = await runGroup(group, manifest, {
    execute: (command) => spawnCommand(commandInvocation(command, { npmCli })),
    log: console.log,
  })
  if (reportPath) {
    const target = resolve(repositoryRoot, reportPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
