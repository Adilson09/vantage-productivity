import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_FORMAT_ARGUMENT_UNITS,
  partitionFileArguments,
  runArgumentBatches,
} from './format-batches.mjs'

const fixed = [
  'C:\\Program Files\\node\\node.exe',
  'C:\\A project\\prettier.cjs',
  '--check',
  '--ignore-unknown',
  '--',
]

function quoteWindowsArgument(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

test('large Windows invocations keep every path and fit the real quoted command limit', () => {
  const paths = Array.from(
    { length: 600 },
    (_, index) => `apps/a space/日本語/${'source-'.repeat(14)}${index}.ts`,
  )
  paths.push('src/a "quoted" name.ts', 'src/a $literal.ts', 'src/trailing\\')
  const originalCommand = [...fixed, ...paths].map(quoteWindowsArgument).join(' ')
  assert.ok(originalCommand.length > 32_767)
  const batches = partitionFileArguments(fixed, paths)
  assert.ok(batches.length > 1)
  assert.deepEqual(batches.flat(), paths)
  for (const batch of batches) {
    const command = [...fixed, ...batch].map(quoteWindowsArgument).join(' ')
    assert.ok(command.length <= MAX_FORMAT_ARGUMENT_UNITS)
    assert.ok(command.length < 32_767)
  }
})

test('an individual path that cannot fit is rejected instead of dropped', () => {
  assert.throws(() => partitionFileArguments(fixed, ['x'.repeat(32_768)]), /command-line limit/)
})

test('an empty file selection runs nothing and succeeds', () => {
  let calls = 0
  assert.deepEqual(partitionFileArguments(fixed, []), [])
  assert.equal(
    runArgumentBatches(
      [],
      () => {
        calls++
        return { status: 0 }
      },
      () => {},
    ),
    0,
  )
  assert.equal(calls, 0)
})

test('a later success cannot erase an earlier batch failure', () => {
  const calls = []
  const status = runArgumentBatches(
    [['first'], ['second']],
    (batch) => {
      calls.push(batch)
      return { status: batch[0] === 'first' ? 7 : 0 }
    },
    () => {},
  )
  assert.equal(status, 7)
  assert.deepEqual(calls, [['first'], ['second']])
})

test('a later parser failure propagates its nonzero exit code', () => {
  assert.equal(
    runArgumentBatches(
      [['first'], ['second']],
      (batch) => ({ status: batch[0] === 'second' ? 2 : 0 }),
      () => {},
    ),
    2,
  )
})

test('spawn failures remain failures while subsequent batches still run', () => {
  const failure = Object.assign(new Error('missing executable'), { code: 'ENOENT' })
  const errors = [],
    calls = []
  const status = runArgumentBatches(
    [['first'], ['second']],
    (batch) => {
      calls.push(batch)
      return batch[0] === 'first' ? { status: null, error: failure } : { status: 0 }
    },
    (error) => errors.push(error),
  )
  assert.equal(status, 1)
  assert.deepEqual(errors, [failure])
  assert.equal(calls.length, 2)
})

test('termination without an exit status is not reported as success', () => {
  assert.equal(
    runArgumentBatches(
      [['first']],
      () => ({ status: null, signal: 'SIGTERM' }),
      () => {},
    ),
    1,
  )
})
