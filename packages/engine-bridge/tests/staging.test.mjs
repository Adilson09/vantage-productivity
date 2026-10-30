import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { stageEnginePackage } from '../../../tools/stage-engine-package.mjs'
const sha = (data) => createHash('sha256').update(data).digest('hex')
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'vantage-specialist-staging-'))
  try {
    const source = join(root, 'source'),
      packageRoot = join(root, 'package')
    async function file(name, bytes) {
      const path = join(source, name)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, bytes)
    }
    await mkdir(join(packageRoot, 'resources'), { recursive: true })
    await writeFile(join(packageRoot, 'resources', 'app.asar'), 'frozen app bytes')
    for (const [name, bytes] of [
      ['qpdf-12.4.2/bin/qpdf.exe', 'qpdf fixture'],
      ['qpdf-12.4.2/LICENSE.txt', 'Apache-2.0 fixture'],
      ['qpdf-12.4.2/NOTICE.md', 'notice fixture'],
      ['temurin21/jdk/bin/java.exe', 'java fixture'],
      ['temurin21/jdk/legal/java.base/LICENSE', 'GPLv2 fixture'],
      ['temurin21/jdk/legal/java.base/ADDITIONAL_LICENSE_INFO', 'Classpath Exception fixture'],
      ['temurin21/SOURCE.json', '{}'],
      ['verapdf-1.30.3/bin/cli.jar', 'jar fixture'],
      ['verapdf-1.30.3/LICENSE.MPL', 'MPL fixture'],
      ['verapdf-1.30.3/LICENSE.GPL', 'GPL fixture'],
      ['verapdf-1.30.3/SOURCE.json', '{}'],
    ])
      await file(name, bytes)
    const qpdf = {
      schemaVersion: 1,
      engines: {
        qpdf: {
          path: 'qpdf-12.4.2/bin/qpdf.exe',
          sha256: sha('qpdf fixture'),
          validation: { status: 'structural-smoke-passed', detail: 'Fixture test only' },
        },
        libreoffice: { path: 'unavailable.exe' },
      },
    }
    const vera = {
      schemaVersion: 1,
      engines: {
        verapdf: {
          path: 'temurin21/jdk/bin/java.exe',
          sha256: sha('java fixture'),
          launch: {
            kind: 'java-jar',
            jar: 'verapdf-1.30.3/bin/cli.jar',
            sha256: sha('jar fixture'),
          },
          validation: { status: 'conformance-smoke-passed', detail: 'Fixture test only' },
        },
      },
    }
    const manifestPath = join(source, 'qpdf.json'),
      additionalManifestPath = join(source, 'vera.json')
    await writeFile(manifestPath, JSON.stringify(qpdf))
    await writeFile(additionalManifestPath, JSON.stringify(vera))
    await action({ root, source, packageRoot, manifestPath, additionalManifestPath, vera })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('stages complete pinned qpdf and private Java/JAR trees with portable manifest and legal files', () =>
  fixture(async (options) => {
    const first = await stageEnginePackage(options)
    const root = join(options.packageRoot, 'resources', 'engines')
    const manifest = JSON.parse(await readFile(join(root, 'engines.json'), 'utf8'))
    assert.deepEqual(first.engineIds, ['qpdf', 'verapdf'])
    assert.deepEqual(first.skippedEngineIds, ['libreoffice'])
    assert.equal(first.copiedAndVerifiedFiles, 11)
    assert.equal(manifest.engines.verapdf.launch.jar, 'verapdf-1.30.3/bin/cli.jar')
    assert.equal(
      await readFile(join(root, 'temurin21/jdk/legal/java.base/ADDITIONAL_LICENSE_INFO'), 'utf8'),
      'Classpath Exception fixture',
    )
    assert.match(
      await readFile(join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8'),
      /human accessibility/,
    )
    const repeated = await stageEnginePackage(options)
    assert.equal(repeated.copiedAndVerifiedFiles, 11)
    assert.equal(
      await readFile(join(options.packageRoot, 'resources', 'app.asar'), 'utf8'),
      'frozen app bytes',
    )
  }))
for (const [label, mutate] of [
  [
    'unvalidated runtime',
    (v) => {
      v.engines.verapdf.validation.status = 'available'
    },
  ],
  [
    'wrong Java executable hash',
    (v) => {
      v.engines.verapdf.sha256 = '0'.repeat(64)
    },
  ],
  [
    'wrong JAR hash',
    (v) => {
      v.engines.verapdf.launch.sha256 = '0'.repeat(64)
    },
  ],
  [
    'JAR path traversal',
    (v) => {
      v.engines.verapdf.launch.jar = '../escape.jar'
    },
  ],
])
  test('specialist staging refuses ' + label, () =>
    fixture(async (options) => {
      mutate(options.vera)
      await writeFile(options.additionalManifestPath, JSON.stringify(options.vera))
      await assert.rejects(stageEnginePackage(options))
      assert.equal(
        await readFile(join(options.packageRoot, 'resources', 'app.asar'), 'utf8'),
        'frozen app bytes',
      )
    }),
  )
test('staging refuses a changed existing runtime file and never overwrites it', () =>
  fixture(async (options) => {
    await stageEnginePackage(options)
    const target = join(
      options.packageRoot,
      'resources',
      'engines',
      'temurin21',
      'jdk',
      'bin',
      'java.exe',
    )
    await writeFile(target, 'tampered bytes')
    await assert.rejects(stageEnginePackage(options), /Refusing to overwrite changed specialist/)
    assert.equal(await readFile(target, 'utf8'), 'tampered bytes')
  }))
test('qpdf-only staging retains its original manifest and skips unavailable companions', () =>
  fixture(async (options) => {
    const result = await stageEnginePackage({ ...options, additionalManifestPath: undefined })
    assert.deepEqual(result.engineIds, ['qpdf'])
    assert.deepEqual(result.skippedEngineIds, ['libreoffice'])
    assert.equal(result.copiedAndVerifiedFiles, 3)
  }))
