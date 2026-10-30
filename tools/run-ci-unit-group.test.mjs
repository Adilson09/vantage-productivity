import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  COMPATIBILITY_COMMANDS,
  UNIT_GROUPS,
  commandInvocation,
  findNpmCli,
  parseCommand,
  runGroup,
  validateManifest,
  validatePartition,
} from './run-ci-unit-group.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const script = manifest.scripts.test
const commands = script.split(' && ')
const cloneGroups = () => structuredClone(UNIT_GROUPS)

test('the three groups cover the actual root test chain exactly once and in order', () => {
  assert.deepEqual(validatePartition(script), commands)
  assert.deepEqual(Object.values(UNIT_GROUPS).flat(), commands)
  assert.equal(commands.length, 30)
  assert.equal(UNIT_GROUPS['core-docs'].at(-1), 'npm run test -w @vantage/docs')
  assert.deepEqual(UNIT_GROUPS['sheets-compat'], ['npm run test -w @vantage/sheets'])
  assert.equal(
    UNIT_GROUPS['editors-bridge'].at(-1),
    'npm run test:release-evidence',
  )
})

test('a newly added workspace cannot silently disappear from CI', () => {
  assert.throws(
    () => validatePartition(`${script} && npm run test -w @vantage/new-engine`),
    /Unpartitioned/,
  )
})

test('new shell syntax and empty root commands are rejected', () => {
  for (const suffix of ['; echo done', ' || true', ' && '])
    assert.throws(() => validatePartition(script + suffix), /Unrecognized/)
  assert.throws(() => parseCommand('npm run test -w "@vantage/docs"'), /Unrecognized/)
})

test('duplicate root commands fail instead of inflating apparent coverage', () => {
  assert.throws(() => validatePartition(`${script} && ${commands[0]}`), /Duplicate command in root/)
})

test('overlapping group membership fails', () => {
  const groups = cloneGroups()
  groups['editors-bridge'].push(groups['core-docs'][0])
  assert.throws(() => validatePartition(script, groups), /Duplicate command in CI/)
})

test('removed commands and an empty group require a partition update', () => {
  assert.throws(() => validatePartition(commands.slice(1).join(' && ')), /missing from root/)
  const groups = cloneGroups()
  groups['sheets-compat'] = []
  assert.throws(() => validatePartition(script, groups), /Empty or invalid CI group/)
})

test('reordering an existing root command is not silently accepted', () => {
  const changed = [...commands]
  ;[changed[0], changed[1]] = [changed[1], changed[0]]
  assert.throws(() => validatePartition(changed.join(' && ')), /order differs/)
})

test('the runtime pretest is part of the reviewed contract', () => {
  const changed = structuredClone(manifest)
  changed.scripts.pretest += ' && node extra-check.mjs'
  assert.throws(() => validateManifest(changed), /pretest changed/)
})

test('unknown groups and invalid partitions fail before any child could start', async () => {
  let calls = 0
  const execute = async () => {
    calls++
    return { code: 0 }
  }
  await assert.rejects(runGroup('other', manifest, { execute }), /Unknown CI unit group/)
  const changed = structuredClone(manifest)
  changed.scripts.test += ' && npm run test -w @vantage/new-engine'
  await assert.rejects(runGroup('core-docs', changed, { execute }), /Unpartitioned/)
  assert.equal(calls, 0)
})

test('Windows npm invocation uses Node and literal argv, including paths with spaces and shell characters', () => {
  const execPath = 'C:\\Program Files\\node\\node.exe'
  const npmCli = 'D:\\build & review $literal\\npm-cli.js'
  const cwd = 'D:\\a workspace with spaces'
  const invocation = commandInvocation('npm run test -w @vantage/docs', { execPath, npmCli, cwd })
  assert.equal(invocation.executable, execPath)
  assert.deepEqual(invocation.args, [npmCli, 'run', 'test', '-w', '@vantage/docs'])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.cwd, cwd)
})

test('the explicit broader bridge glob runs directly with Node and literal argv', () => {
  const invocation = commandInvocation('node --test packages/engine-bridge/tests/*.test.mjs')
  assert.equal(invocation.executable, process.execPath)
  assert.deepEqual(invocation.args, ['--test', 'packages/engine-bridge/tests/*.test.mjs'])
  assert.equal(invocation.options.shell, false)
})

test('npm discovery uses an existing JS entry and never executes npm.cmd', () => {
  const npmCli = 'D:\\private runtime\\npm-cli.js'
  assert.equal(
    findNpmCli({ env: { npm_execpath: npmCli }, exists: (path) => path === npmCli }),
    npmCli,
  )
  assert.throws(
    () => findNpmCli({ env: { npm_execpath: 'npm.cmd' }, exists: () => false }),
    /Cannot locate/,
  )
})

test('a failed independent suite does not omit later suites, and the group still fails', async () => {
  const called = []
  const report = await runGroup('editors-bridge', manifest, {
    execute: async (command) => {
      called.push(command)
      return { code: command === UNIT_GROUPS['editors-bridge'][0] ? 7 : 0 }
    },
  })
  assert.deepEqual(called, ['npm run check:runtime', ...UNIT_GROUPS['editors-bridge']])
  assert.equal(report.status, 'failed')
  assert.equal(report.commands[0].status, 'failed')
  assert.ok(report.commands.slice(1).every((result) => result.status === 'passed'))
})

test('failed runtime preflight leaves every selected command explicitly not-run', async () => {
  const called = []
  const report = await runGroup('core-docs', manifest, {
    execute: async (command) => {
      called.push(command)
      return { code: 1 }
    },
  })
  assert.deepEqual(called, ['npm run check:runtime'])
  assert.equal(report.status, 'failed')
  assert.equal(report.commands.length, UNIT_GROUPS['core-docs'].length)
  assert.ok(report.commands.every((result) => result.status === 'not-run'))
})

test('failed Sheets tests/native build never accepts compatibility from a stale runtime', async () => {
  const called = []
  const report = await runGroup('sheets-compat', manifest, {
    execute: async (command) => {
      called.push(command)
      return { code: command === UNIT_GROUPS['sheets-compat'][0] ? 1 : 0 }
    },
  })
  assert.deepEqual(called, ['npm run check:runtime', ...UNIT_GROUPS['sheets-compat']])
  assert.equal(report.status, 'failed')
  assert.deepEqual(
    report.commands.map(({ status }) => status),
    ['failed', 'not-run', 'not-run'],
  )
})

test('failed fixture generation prevents compatibility acceptance', async () => {
  const called = []
  const report = await runGroup('sheets-compat', manifest, {
    execute: async (command) => {
      called.push(command)
      return { code: command === COMPATIBILITY_COMMANDS[0] ? 1 : 0 }
    },
  })
  assert.deepEqual(called, [
    'npm run check:runtime',
    ...UNIT_GROUPS['sheets-compat'],
    COMPATIBILITY_COMMANDS[0],
  ])
  assert.equal(report.status, 'failed')
  assert.deepEqual(
    report.commands.map(({ status }) => status),
    ['passed', 'failed', 'not-run'],
  )
})

test('successful Sheets validation runs both original compatibility commands in order', async () => {
  const report = await runGroup('sheets-compat', manifest, { execute: async () => ({ code: 0 }) })
  assert.equal(report.status, 'passed')
  assert.deepEqual(
    report.commands.map(({ command }) => command),
    [...UNIT_GROUPS['sheets-compat'], ...COMPATIBILITY_COMMANDS],
  )
  assert.ok(report.commands.every(({ status }) => status === 'passed'))
})

test('an executor error is recorded as failed, never as a skipped success', async () => {
  const report = await runGroup('editors-bridge', manifest, {
    execute: async (command) => {
      if (command === UNIT_GROUPS['editors-bridge'][0]) throw new Error('spawn unavailable')
      return { code: 0 }
    },
  })
  assert.equal(report.status, 'failed')
  assert.match(report.commands[0].error, /spawn unavailable/)
  assert.equal(report.commands.at(-1).status, 'passed')
})

test('CLI validation reads the actual manifest without running any workspace tests', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run-ci-unit-group.mjs', import.meta.url)), '--validate'],
    {
      cwd: dirnameOfTest(),
      encoding: 'utf8',
      shell: false,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.rootCommands, 30)
  assert.equal(report.groups['sheets-compat'].at(-1), COMPATIBILITY_COMMANDS.at(-1))
})

function dirnameOfTest() {
  return fileURLToPath(new URL('./', import.meta.url))
}

test('the CI matrix is emitted from the validated partition, so a hand-written matrix cannot omit a group', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run-ci-unit-group.mjs', import.meta.url)), '--matrix'],
    {
      encoding: 'utf8',
      shell: false,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.startsWith('groups='))
  assert.deepEqual(JSON.parse(result.stdout.slice('groups='.length)), Object.keys(UNIT_GROUPS))
})


test('current bridge workspace keeps its full serial glob and release evidence remains in CI', () => {
  const bridge = JSON.parse(readFileSync(new URL('../packages/engine-bridge/package.json', import.meta.url), 'utf8'))
  assert.equal(bridge.scripts.test, 'node --test --test-concurrency=1 tests/*.test.mjs')
  assert.equal(UNIT_GROUPS['editors-bridge'].at(-2), 'npm run test -w @vantage/engine-bridge')
  assert.equal(UNIT_GROUPS['editors-bridge'].at(-1), 'npm run test:release-evidence')
  assert.equal(manifest.scripts['test:release-evidence'], 'node --test --test-concurrency=1 tools/tests/release-evidence.test.mjs')
  assert.ok(manifest.scripts.typecheck.endsWith('npm run typecheck -w @vantage/engine-bridge'))
  assert.throws(() => parseCommand('node --test packages/engine-bridge/tests/bridge.test.mjs'), /Unrecognized/)
})
