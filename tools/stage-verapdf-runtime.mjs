import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readEngineManifest, verifiedJar } from '../packages/engine-bridge/src/engine-manifest.mjs'

const within = (base, path) => {
  const part = relative(base, path)
  if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part))
    throw new Error('Specialist engine path leaves its constrained directory')
  return path
}
async function hash(path) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path, { highWaterMark: 1024 * 1024 }))
    digest.update(bytes)
  return digest.digest('hex')
}
async function directory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Specialist distribution must use real directories')
}
async function regular(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Required specialist license/source file is missing or linked')
}
async function files(root) {
  const found = []
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = within(root, join(path, entry.name))
      if (entry.isSymbolicLink())
        throw new Error('Linked specialist distribution entries are not accepted')
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile())
        found.push({ path: full, relative: relative(root, full), bytes: (await lstat(full)).size })
      else throw new Error('Specialist distribution contains a nonregular entry')
      if (found.length > 5000) throw new Error('Specialist distribution exceeds 5000 files')
    }
  }
  await walk(root)
  return found
}
function parts(path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes(':'))
    throw new Error('Specialist staging requires portable relative paths')
  const values = path.replaceAll('\\', '/').split('/')
  if (values.some((p) => !p || p === '.' || p === '..'))
    throw new Error('Specialist staging path leaves the portable layout')
  return values
}

/** Prepare only a verified Java/JAR launch; no shell scripts or arbitrary launch arguments. */
export async function prepareVeraPdfStage(manifestPath) {
  if (!manifestPath) return null
  manifestPath = resolve(manifestPath)
  await regular(manifestPath)
  if ((await lstat(manifestPath)).size > 65536)
    throw new Error('Specialist manifest exceeds 64 KiB')
  const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (raw.schemaVersion !== 1) throw new Error('Unsupported specialist manifest schema')
  const pin = raw.engines?.verapdf
  if (pin?.validation?.status !== 'conformance-smoke-passed' || pin.launch?.kind !== 'java-jar')
    throw new Error('Only veraPDF with conformance-smoke-passed validation can be staged')
  const loaded = await readEngineManifest(manifestPath)
  const runtime = loaded.engines.verapdf
  const java = parts(pin.path)
  const jar = parts(pin.launch.jar)
  if (
    java.length < 4 ||
    !/^temurin(?:\d+|-[\d._+-]+)$/.test(java[0]) ||
    basename(java.at(-1)).toLowerCase() !== 'java.exe' ||
    jar.length < 3 ||
    !/^verapdf-[\d.]+$/.test(jar[0]) ||
    java[0] === jar[0]
  )
    throw new Error('Unsupported private veraPDF/Temurin distribution layout')
  if ((await hash(runtime.path)) !== pin.sha256.toLowerCase())
    throw new Error('Private Java executable differs from its pinned SHA256')
  await verifiedJar(runtime.launch)
  const base = dirname(manifestPath)
  const roots = [java[0], jar[0]].map((name) => ({ name, path: within(base, join(base, name)) }))
  for (const root of roots) await directory(root.path)
  for (const license of ['LICENSE.GPL', 'LICENSE.MPL', 'SOURCE.json'])
    await regular(join(base, jar[0], license))
  await regular(join(base, java[0], 'SOURCE.json'))
  await regular(join(dirname(dirname(runtime.path)), 'legal', 'java.base', 'LICENSE'))
  await regular(
    join(dirname(dirname(runtime.path)), 'legal', 'java.base', 'ADDITIONAL_LICENSE_INFO'),
  )
  for (const root of roots) root.files = await files(root.path)
  const distributionBytes = roots.reduce(
    (n, r) => n + r.files.reduce((sum, f) => sum + f.bytes, 0),
    0,
  )
  if (distributionBytes > 512 * 1024 * 1024 || roots.some((r) => !r.files.length))
    throw new Error('Private specialist distribution exceeds its staging budget')
  return {
    roots,
    pin: {
      path: java.join('/'),
      sha256: pin.sha256.toLowerCase(),
      launch: { kind: 'java-jar', jar: jar.join('/'), sha256: pin.launch.sha256.toLowerCase() },
      validation: pin.validation,
    },
    archives: (raw.archives ?? []).filter((a) =>
      ['veraPDF', 'Eclipse Temurin'].includes(a.component),
    ),
    distributionBytes,
    skippedEngineIds: Object.keys(raw.engines ?? {}).filter((id) => id !== 'verapdf'),
    notices: `\nveraPDF 1.30.3, unmodified official CLI; dual licensed MPLv2+ / GPLv3+.\nLicenses: ${jar[0]}/LICENSE.MPL and LICENSE.GPL; source/build references: ${jar[0]}/SOURCE.json.\nThird-party notices and licenses remain embedded in the CLI JAR.\nPrivate Eclipse Temurin Java runtime: GPLv2 with Classpath Exception and bundled component licenses.\nAll upstream legal files are retained under ${java[0]}; source/build references: ${java[0]}/SOURCE.json.\nMachine PDF/A and PDF/UA checks do not replace human accessibility or visual review.\n`,
  }
}

export async function copyVeraPdfStage(plan, destinationRoot) {
  if (!plan) return { files: 0, bytes: 0 }
  let copied = 0
  for (const root of plan.roots) {
    const destination = within(destinationRoot, join(destinationRoot, root.name))
    await mkdir(destination, { recursive: true })
    await directory(destination)
    const names = new Set(root.files.map((file) => file.relative))
    for (const file of await files(destination))
      if (!names.has(file.relative))
        throw new Error('Unexpected staged specialist file: ' + file.relative)
    for (const file of root.files) {
      const target = within(destination, join(destination, file.relative))
      await mkdir(dirname(target), { recursive: true })
      const expected = await hash(file.path)
      try {
        await regular(target)
        if ((await hash(target)) !== expected)
          throw new Error('Refusing to overwrite changed specialist file: ' + file.relative)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await copyFile(file.path, target, constants.COPYFILE_EXCL)
      }
      if ((await hash(target)) !== expected || (await hash(file.path)) !== expected)
        throw new Error('Specialist copied file hash mismatch: ' + file.relative)
      copied++
    }
  }
  return { files: copied, bytes: plan.distributionBytes }
}
