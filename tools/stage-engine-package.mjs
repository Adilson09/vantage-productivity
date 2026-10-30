#!/usr/bin/env node
import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyVeraPdfStage, prepareVeraPdfStage } from './stage-verapdf-runtime.mjs'

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }))
    digest.update(chunk)
  return digest.digest('hex')
}

function within(root, path) {
  const child = relative(root, path)
  if (!child || child.startsWith('..' + sep) || child === '..' || isAbsolute(child))
    throw new Error('Engine staging path leaves its named destination')
  return path
}

async function regularDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Engine staging requires a real directory: ' + path)
}

async function tree(root) {
  const files = []
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = within(root, join(path, entry.name))
      if (entry.isSymbolicLink())
        throw new Error('Linked engine distribution entries are not accepted')
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile())
        files.push({ path: full, relative: relative(root, full), bytes: (await lstat(full)).size })
      else throw new Error('Engine distribution contains a nonregular entry')
    }
  }
  await walk(root)
  return files
}

async function atomicText(path, text) {
  const temporary = path + `.staging-${process.pid}`
  await writeFile(temporary, text, { flag: 'wx' })
  await rename(temporary, path)
}

/** Stage validated distributions; never rebuild or modify app.asar. */
export async function stageEnginePackage({ packageRoot, manifestPath, additionalManifestPath }) {
  packageRoot = resolve(packageRoot)
  manifestPath = resolve(manifestPath)
  await regularDirectory(packageRoot)
  const resources = within(packageRoot, join(packageRoot, 'resources'))
  await regularDirectory(resources)
  const specialist = await prepareVeraPdfStage(additionalManifestPath)
  const manifestInfo = await lstat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
    throw new Error('The verified engine manifest must be a regular file')
  if (manifestInfo.size > 65536) throw new Error('Engine manifest exceeds 64 KiB')
  const sourceManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (sourceManifest.schemaVersion !== 1) throw new Error('Unsupported engine manifest schema')
  const pin = sourceManifest.engines?.qpdf
  if (!pin || pin.validation?.status !== 'structural-smoke-passed')
    throw new Error('Only qpdf with structural-smoke-passed validation can be staged')
  if (
    typeof pin.path !== 'string' ||
    isAbsolute(pin.path) ||
    !/^[0-9a-f]{64}$/i.test(pin.sha256 ?? '')
  )
    throw new Error('qpdf requires a relative path and pinned SHA256')
  const parts = pin.path.replaceAll('\\', '/').split('/')
  if (
    parts.length < 3 ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes(':')) ||
    !/^qpdf-[\d.]+$/.test(parts[0])
  )
    throw new Error('The qpdf package path is outside the constrained portable layout')
  const sourceRoot = within(dirname(manifestPath), join(dirname(manifestPath), parts[0]))
  await regularDirectory(sourceRoot)
  const sourceExe = within(sourceRoot, join(dirname(manifestPath), ...parts))
  if (basename(sourceExe).toLowerCase() !== 'qpdf.exe')
    throw new Error('This Windows staging tool requires qpdf.exe')
  if ((await sha256(sourceExe)) !== pin.sha256.toLowerCase())
    throw new Error('Source qpdf executable differs from its pin')
  for (const legal of ['LICENSE.txt', 'NOTICE.md']) {
    const info = await lstat(join(sourceRoot, legal))
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Required qpdf license/notice is missing')
  }
  const destinationRoot = within(resources, join(resources, 'engines'))
  await mkdir(destinationRoot, { recursive: true })
  await regularDirectory(destinationRoot)
  const destinationPackage = within(destinationRoot, join(destinationRoot, parts[0]))
  const allowed = new Set([
    parts[0],
    'engines.json',
    'THIRD-PARTY-NOTICES.txt',
    ...(specialist?.roots.map((root) => root.name) ?? []),
  ])
  for (const entry of await readdir(destinationRoot))
    if (!allowed.has(entry))
      throw new Error('Unexpected existing engine entry; refusing to merge: ' + entry)
  await mkdir(destinationPackage, { recursive: true })
  await regularDirectory(destinationPackage)
  const files = await tree(sourceRoot)
  if (!files.length || files.length > 5000)
    throw new Error('qpdf distribution file count is outside the staging budget')
  if (files.reduce((total, file) => total + file.bytes, 0) > 512 * 1024 * 1024)
    throw new Error('qpdf distribution exceeds 512 MiB')
  const expectedNames = new Set(files.map((file) => file.relative))
  for (const file of await tree(destinationPackage))
    if (!expectedNames.has(file.relative))
      throw new Error('Destination contains an unexpected distribution file: ' + file.relative)
  for (const file of files) {
    const destination = within(destinationPackage, join(destinationPackage, file.relative))
    await mkdir(dirname(destination), { recursive: true })
    try {
      const info = await lstat(destination)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await sha256(destination)) !== (await sha256(file.path))
      )
        throw new Error('Refusing to overwrite changed staged file: ' + file.relative)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await copyFile(file.path, destination, constants.COPYFILE_EXCL)
    }
    if ((await sha256(file.path)) !== (await sha256(destination)))
      throw new Error('Copied file hash mismatch: ' + file.relative)
  }
  const specialistCopy = await copyVeraPdfStage(specialist, destinationRoot)
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    engines: {
      qpdf: { path: parts.join('/'), sha256: pin.sha256.toLowerCase(), validation: pin.validation },
      ...(specialist ? { verapdf: specialist.pin } : {}),
    },
    archives: [
      ...(sourceManifest.archives ?? []).filter((entry) => entry.component === 'qpdf'),
      ...(specialist?.archives ?? []),
    ],
  }
  await atomicText(join(destinationRoot, 'engines.json'), JSON.stringify(manifest, null, 2) + '\n')
  await atomicText(
    join(destinationRoot, 'THIRD-PARTY-NOTICES.txt'),
    'Vantage optional local PDF engines\n\n' +
      'qpdf, unmodified official Windows distribution, Apache License 2.0.\n' +
      'Source and releases: https://github.com/qpdf/qpdf/releases\n' +
      `Full license: ${parts[0]}/LICENSE.txt\nUpstream/component notices: ${parts[0]}/NOTICE.md and included distribution files.\n` +
      'The portable manifest pins the executable and records the verified upstream archive.\nStructural diagnostics do not certify rendering fidelity or accessibility.\n' +
      (specialist?.notices ?? ''),
  )
  return {
    stagedAt: new Date().toISOString(),
    packageRoot,
    manifest: join(destinationRoot, 'engines.json'),
    engineIds: ['qpdf', ...(specialist ? ['verapdf'] : [])],
    skippedEngineIds: [
      ...new Set([
        ...Object.keys(sourceManifest.engines ?? {}).filter((id) => id !== 'qpdf'),
        ...(specialist?.skippedEngineIds ?? []),
      ]),
    ].filter((id) => !specialist || id !== 'verapdf'),
    copiedAndVerifiedFiles: files.length + specialistCopy.files,
    distributionBytes: files.reduce((total, file) => total + file.bytes, 0) + specialistCopy.bytes,
    executableSha256: await sha256(join(destinationRoot, ...parts)),
    ...(specialist
      ? { privateJavaSha256: specialist.pin.sha256, veraPdfJarSha256: specialist.pin.launch.sha256 }
      : {}),
    manifestSha256: await sha256(join(destinationRoot, 'engines.json')),
    appBuildModified: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    const value = (flag) => {
      const index = args.indexOf(flag)
      return index < 0 ? undefined : args[index + 1]
    }
    if (
      args.length % 2 !== 0 ||
      !value('--package') ||
      !value('--manifest') ||
      args.some(
        (arg, index) =>
          index % 2 === 0 &&
          !['--package', '--manifest', '--additional-manifest', '--evidence'].includes(arg),
      ) ||
      new Set(args.filter((_, index) => index % 2 === 0)).size !== args.length / 2
    )
      throw new Error(
        'Usage: node tools/stage-engine-package.mjs --package UNPACKED_ROOT --manifest VERIFIED_QPDF_MANIFEST [--additional-manifest VERIFIED_VERAPDF_MANIFEST] [--evidence REPORT.json]',
      )
    const report = await stageEnginePackage({
      packageRoot: value('--package'),
      manifestPath: value('--manifest'),
      additionalManifestPath: value('--additional-manifest'),
    })
    if (value('--evidence'))
      await writeFile(resolve(value('--evidence')), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
