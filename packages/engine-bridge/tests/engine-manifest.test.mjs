import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  javaArguments,
  privateJavaEnvironment,
  readEngineManifest,
  verifiedJar,
} from '../src/engine-manifest.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function fixture(action) {
  const base =
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Temp')
      : tmpdir()
  const dir = await mkdtemp(join(base, 'vantage-manifest-'))
  try {
    await mkdir(join(dir, 'bin'))
    await writeFile(join(dir, 'bin', 'validator.jar'), 'test jar bytes')
    const manifest = {
      schemaVersion: 1,
      engines: {
        verapdf: {
          path: process.execPath,
          sha256: 'a'.repeat(64),
          launch: { kind: 'java-jar', jar: 'bin/validator.jar', sha256: digest('test jar bytes') },
        },
      },
    }
    await action({ dir, manifest, path: join(dir, 'engines.json') })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('resolves only a confined JAR and verifies its exact bytes', () =>
  fixture(async ({ dir, manifest, path }) => {
    await writeFile(path, JSON.stringify(manifest))
    const loaded = await readEngineManifest(path)
    assert.equal(loaded.engines.verapdf.launch.jar, join(dir, 'bin', 'validator.jar'))
    await verifiedJar(loaded.engines.verapdf.launch)
    await writeFile(join(dir, 'bin', 'validator.jar'), 'modified')
    await assert.rejects(verifiedJar(loaded.engines.verapdf.launch), /pinned SHA256/)
  }))
for (const jar of [
  '../escape.jar',
  'bin/../escape.jar',
  '/absolute.jar',
  'C:\\escape.jar',
  '\\\\server\\share.jar',
  'https://example.com/validator.jar',
  'bin/validator.jar:stream',
  'bin//validator.jar',
]) {
  test('refuses launch path: ' + jar, () =>
    fixture(async ({ manifest, path }) => {
      manifest.engines.verapdf.launch.jar = jar
      await writeFile(path, JSON.stringify(manifest))
      await assert.rejects(readEngineManifest(path), /manifest directory|constrained java-jar/)
    }),
  )
}
test('refuses a linked directory redirect beyond the manifest directory', () =>
  fixture(async ({ dir, manifest, path }) => {
    const source = join(dir, 'configuration')
    const outside = join(dir, 'outside')
    await mkdir(source)
    await mkdir(outside)
    await writeFile(join(outside, 'validator.jar'), 'test jar bytes')
    await symlink(
      outside,
      join(source, 'redirect'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    manifest.engines.verapdf.launch.jar = 'redirect/validator.jar'
    const confined = join(source, 'engines.json')
    await writeFile(confined, JSON.stringify(manifest))
    await assert.rejects(readEngineManifest(confined), /Linked engine path leaves/)
  }))
for (const [label, mutate] of [
  [
    'arbitrary shell launch',
    (m) => {
      m.engines.verapdf.launch.kind = 'shell'
    },
  ],
  [
    'arbitrary JVM arguments',
    (m) => {
      m.engines.verapdf.launch.args = ['-javaagent:remote.jar']
    },
  ],
  [
    'missing executable hash',
    (m) => {
      delete m.engines.verapdf.sha256
    },
  ],
  [
    'missing JAR hash',
    (m) => {
      delete m.engines.verapdf.launch.sha256
    },
  ],
  [
    'invalid JAR hash',
    (m) => {
      m.engines.verapdf.launch.sha256 = 'not-a-hash'
    },
  ],
  [
    'launch attached to a different engine',
    (m) => {
      m.engines.qpdf = m.engines.verapdf
      delete m.engines.verapdf
    },
  ],
])
  test('refuses ' + label, () =>
    fixture(async ({ manifest, path }) => {
      mutate(manifest)
      await writeFile(path, JSON.stringify(manifest))
      await assert.rejects(readEngineManifest(path), /constrained java-jar/)
    }),
  )

test('fixed JVM limits and isolated paths are not taken from PDF arguments', () => {
  const args = javaArguments({ jar: '/runtime/cli.jar' }, '/private-work', [
    '--format',
    'json',
    '/private-work/input.pdf',
  ])
  assert.ok(args.includes('-Xmx256m'))
  assert.ok(args.includes('-XX:ActiveProcessorCount=2'))
  assert.ok(args.includes('-Duser.home=/private-work'))
  assert.deepEqual(args.slice(-5), [
    '-jar',
    '/runtime/cli.jar',
    '--format',
    'json',
    '/private-work/input.pdf',
  ])
})
test('clears Java agent and option environment names in every Windows spelling', () => {
  const overrides = {
    java_tool_options: '-javaagent:injected.jar',
    CLASSPATH: 'untrusted.jar',
    KEEP: 'value',
  }
  const inherited = {
    JDK_JAVA_OPTIONS: '-Xmx16g',
    _java_options: '-javaagent:other.jar',
    Java_Opts: '-Xmx32g',
  }
  const safe = privateJavaEnvironment(overrides, inherited)
  for (const key of [
    'java_tool_options',
    'CLASSPATH',
    'JDK_JAVA_OPTIONS',
    '_java_options',
    'Java_Opts',
  ])
    assert.equal(safe[key], undefined)
  assert.equal(safe.KEEP, 'value')
  assert.equal(overrides.java_tool_options, '-javaagent:injected.jar')
})
