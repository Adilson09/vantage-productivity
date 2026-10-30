import { access, copyFile, mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { releaseEngineDirectory, runBounded } from './process-supervision.mjs'
import {
  fileSha256,
  javaArguments,
  privateJavaEnvironment,
  readEngineManifest,
  verifiedJar,
} from './engine-manifest.mjs'
import { parseVeraPdfReport } from './verapdf-report.mjs'

export { parseVeraPdfReport, VERAPDF_PROFILES } from './verapdf-report.mjs'
export { runBounded } from './process-supervision.mjs'

export const ENGINE_CATALOG = Object.freeze([
  {
    id: 'libreoffice',
    name: 'LibreOffice',
    license: 'MPL-2.0 and bundled component licenses',
    url: 'https://www.libreoffice.org/about-us/licenses/',
    commands: ['soffice.com', 'soffice.exe', 'soffice', 'libreoffice'],
    env: 'VANTAGE_LIBREOFFICE_PATH',
    capabilities: ['convert-local', 'render-reference-pdf'],
  },
  {
    id: 'qpdf',
    name: 'qpdf',
    license: 'Apache-2.0 (verify installed version notices)',
    url: 'https://qpdf.readthedocs.io/en/stable/',
    commands: ['qpdf.exe', 'qpdf'],
    env: 'VANTAGE_QPDF_PATH',
    capabilities: ['pdf-structural-check'],
  },
  {
    id: 'verapdf',
    name: 'veraPDF',
    license: 'MPL-2.0 / GPL-3.0-or-later; bundled Java and dependency notices apply',
    url: 'https://docs.verapdf.org/cli/validation/',
    commands: ['verapdf.exe', 'verapdf'],
    env: 'VANTAGE_VERAPDF_PATH',
    capabilities: ['pdf-conformance-report'],
  },
])

async function executableCandidates(engine, options) {
  const env = options.env ?? process.env
  if (options.paths?.[engine.id] || env[engine.env])
    return [options.paths?.[engine.id] ?? env[engine.env]]
  if (options.manifest?.engines?.[engine.id]?.path)
    return [options.manifest.engines[engine.id].path]
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((p) => p && isAbsolute(p))
  if (engine.id === 'libreoffice') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean))
      dirs.unshift(join(root, 'LibreOffice', 'program'))
    if (process.platform === 'darwin') dirs.unshift('/Applications/LibreOffice.app/Contents/MacOS')
  }
  return dirs.flatMap((dir) => engine.commands.map((name) => join(dir, name)))
}

async function engineWork(options, prefix, action) {
  const work = await mkdtemp(
    join(options.tempRoot ?? process.env.VANTAGE_ENGINE_TEMP_DIR ?? tmpdir(), prefix),
  )
  try {
    return await action(work)
  } finally {
    await releaseEngineDirectory(work)
  }
}

function runInstalledEngine(engine, args, options, work) {
  if (!engine.launch) return runBounded(engine.path, args, { ...options, cwd: work ?? options.cwd })
  return runBounded(engine.path, javaArguments(engine.launch, work, args), {
    ...options,
    cwd: work,
    processEnv: privateJavaEnvironment(options.processEnv),
  })
}

async function discoverEngineSet(options = {}, engineIds) {
  const manifestPath =
    options.manifestPath ??
    (options.env ?? process.env).VANTAGE_ENGINE_MANIFEST ??
    (!options.env ? new URL('../engines.local.json', import.meta.url) : null)
  const manifest = await readEngineManifest(manifestPath)
  return Promise.all(
    ENGINE_CATALOG.filter((engine) => !engineIds || engineIds.includes(engine.id)).map(
      async (engine) => {
        const pinned = manifest?.engines?.[engine.id]
        let reason =
          'Not installed or not found. Configure ' + engine.env + ' with a local executable path.'
        for (const path of await executableCandidates(engine, { ...options, manifest })) {
          if (!isAbsolute(path) || /\.(?:cmd|bat)$/i.test(path)) {
            reason = 'Use a native executable, not a shell script, for ' + engine.env
            continue
          }
          try {
            await access(path, constants.X_OK)
            const info = await stat(path)
            if (!info.isFile() || info.size > 256 * 1024 * 1024) continue
          } catch {
            continue
          }
          const executableSha256 = await fileSha256(path)
          if (
            pinned?.path === path &&
            pinned.sha256 &&
            executableSha256 !== pinned.sha256.toLowerCase()
          ) {
            reason =
              'Installed executable differs from its pinned SHA256; revalidate the local component.'
            continue
          }
          const launch = pinned?.path === path ? pinned.launch : undefined
          if (launch) {
            try {
              await verifiedJar(launch)
            } catch (error) {
              reason = error.message
              continue
            }
          }
          // Even a version probe must never attach to a user's running Office profile.
          const probeRoot =
            engine.id === 'libreoffice' || launch
              ? await mkdtemp(
                  join(
                    options.tempRoot ?? process.env.VANTAGE_ENGINE_TEMP_DIR ?? tmpdir(),
                    'vantage-version-',
                  ),
                )
              : null
          let result
          try {
            const args =
              engine.id === 'libreoffice'
                ? [
                    '-env:UserInstallation=' + pathToFileURL(join(probeRoot, 'profile')).href,
                    '--headless',
                    '--norestore',
                    '--version',
                  ]
                : ['--version']
            result = await runInstalledEngine(
              { path, launch },
              args,
              {
                timeoutMs: launch ? 60000 : 5000,
                maxOutputBytes: 16384,
                signal: options.signal,
                ...(engine.id === 'libreoffice'
                  ? { processEnv: { SAL_SKIA: 'raster', SAL_DISABLE_OPENCL: '1' } }
                  : {}),
              },
              probeRoot,
            )
          } finally {
            if (probeRoot) await releaseEngineDirectory(probeRoot)
          }
          if (result.stopped || result.code !== 0) {
            reason =
              result.cleanup?.status === 'pending'
                ? 'The version probe did not complete. Process cleanup is still pending; temporary files are retained.'
                : 'The configured executable did not complete its version probe.'
            continue
          }
          return {
            id: engine.id,
            name: engine.name,
            available: true,
            path,
            executableSha256,
            ...(launch ? { launch: { ...launch }, jarSha256: launch.sha256.toLowerCase() } : {}),
            version: (launch
              ? (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0]
              : (result.stdout || result.stderr).trim()
            ).slice(0, 200),
            license: engine.license,
            url: engine.url,
            capabilities: engine.capabilities,
            ...(pinned?.path === path && pinned.validation
              ? { validation: pinned.validation }
              : {}),
          }
        }
        return {
          id: engine.id,
          name: engine.name,
          available: false,
          reason,
          license: engine.license,
          url: engine.url,
          capabilities: engine.capabilities,
          ...(pinned?.validation ? { validation: pinned.validation } : {}),
        }
      },
    ),
  )
}

export function discoverEngines(options = {}) {
  return discoverEngineSet(options)
}

async function selectedEngine(id, options) {
  const engine = (await discoverEngineSet(options, [id])).find((item) => item.id === id)
  if (!engine?.available) throw new Error(engine?.reason ?? 'Unknown engine')
  return engine
}

async function inputFile(filePath, extensions) {
  const path = resolve(filePath)
  const info = await stat(path)
  if (!info.isFile() || info.size < 1 || info.size > 128 * 1024 * 1024)
    throw new Error('Engine inputs must be regular files between 1 byte and 128 MiB')
  if (!extensions.includes(extname(path).toLowerCase()))
    throw new Error('Unsupported input format for this engine operation')
  return path
}

export async function checkPdf(filePath, { engine = 'qpdf', flavour, ...options } = {}) {
  const input = await inputFile(filePath, ['.pdf'])
  if (engine !== 'qpdf' && engine !== 'verapdf') throw new Error('Choose qpdf or verapdf')
  if (flavour && !/^(?:1[ab]|2[abu]|3[abu]|4[ef]?|ua[12])$/.test(flavour))
    throw new Error('Unsupported veraPDF validation flavour')
  const installed = await selectedEngine(engine, options)
  if (engine === 'qpdf') {
    const result = await runBounded(installed.path, ['--check', input], options)
    return {
      engine: installed.id,
      version: installed.version,
      filePath: input,
      ...result,
      status: result.stopped
        ? 'incomplete'
        : result.code === 0
          ? 'pass'
          : result.code === 3
            ? 'warning'
            : 'fail',
      scope: 'Structural diagnostics only; visual fidelity and accessibility are not certified.',
    }
  }
  return engineWork(options, 'vantage-standards-', async (work) => {
    // Validation receives an independent copy; metadata fixing is never enabled.
    const before = await fileSha256(input)
    const copy = join(work, 'input.pdf')
    await copyFile(input, copy, constants.COPYFILE_EXCL)
    const copied = await stat(copy)
    if (copied.size > 128 * 1024 * 1024 || (await fileSha256(copy)) !== before)
      throw new Error('Source changed while preparing standards validation; retry after saving it')
    const result = await runInstalledEngine(
      installed,
      [
        '--format',
        'json',
        '--maxfailures',
        '-1',
        '--maxfailuresdisplayed',
        '10',
        ...(flavour ? ['--flavour', flavour] : []),
        copy,
      ],
      { timeoutMs: 60000, ...options },
      work,
    )
    const sourceUnchanged = (await fileSha256(input)) === before
    const parsed = parseVeraPdfReport(result, {
      flavour,
      expectedPath: copy,
      expectedBytes: copied.size,
    })
    if (!sourceUnchanged) {
      parsed.status = 'incomplete'
      parsed.conformance.complete = false
      parsed.conformance.reason =
        'The source changed during validation; this result describes an earlier copy.'
    }
    return {
      engine: installed.id,
      version: installed.version,
      filePath: input,
      ...result,
      ...parsed,
      sourceSha256: before,
      sourceUnchanged,
      scope:
        'Machine checks for the listed PDF/A or PDF/UA profiles only. Human accessibility checks and visual review remain required; qpdf structural checks do not establish standards conformance.',
    }
  })
}

const conversionFormats = ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']
export async function convertDocument(sourcePath, destinationPath, options = {}) {
  const source = await inputFile(sourcePath, [
    '.docx',
    '.xlsx',
    '.pptx',
    '.odt',
    '.ods',
    '.odp',
    '.rtf',
    '.doc',
    '.xls',
    '.ppt',
    '.html',
    '.htm',
  ])
  const destination = resolve(destinationPath)
  const format = extname(destination).slice(1).toLowerCase()
  if (!conversionFormats.includes(format))
    throw new Error('Choose PDF, DOCX, XLSX, PPTX, ODT, ODS or ODP output')
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('Conversion requires a separate destination')
  try {
    await access(destination)
    throw new Error('Conversion never overwrites an existing destination')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const engine = await selectedEngine('libreoffice', options)
  const work = await mkdtemp(
    join(options.tempRoot ?? process.env.VANTAGE_ENGINE_TEMP_DIR ?? tmpdir(), 'vantage-engine-'),
  )
  try {
    // Copy to an independent input so the original can never be modified by a converter.
    const copy = join(work, basename(source))
    const before = await stat(source)
    await copyFile(source, copy, constants.COPYFILE_EXCL)
    const [after, copied] = await Promise.all([stat(source), stat(copy)])
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      copied.size !== before.size ||
      copied.size > 128 * 1024 * 1024
    )
      throw new Error('Source changed while preparing conversion; retry after saving it')
    const sourceHash = createHash('sha256')
      .update(await readFile(copy))
      .digest('hex')
    const outputDir = join(work, 'output')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(outputDir)
    const result = await runBounded(
      engine.path,
      [
        '-env:UserInstallation=' + pathToFileURL(join(work, 'profile')).href,
        '--headless',
        '--nologo',
        '--nodefault',
        '--nolockcheck',
        '--nofirststartwizard',
        '--norestore',
        '--convert-to',
        format,
        '--outdir',
        outputDir,
        copy,
      ],
      { ...options, cwd: work, processEnv: { SAL_SKIA: 'raster', SAL_DISABLE_OPENCL: '1' } },
    )
    if (result.stopped || result.code !== 0)
      throw new Error(
        'LibreOffice conversion did not complete: ' +
          (result.stopped ?? `exit ${result.code}`) +
          (result.cleanup?.status === 'pending'
            ? '. Process cleanup is still pending; temporary files are retained.'
            : ''),
      )
    // LibreOffice sometimes exits zero for a failed import: require the actual artifact.
    const outputs = (await readdir(outputDir)).filter(
      (name) => extname(name).toLowerCase() === '.' + format,
    )
    if (outputs.length !== 1)
      throw new Error('LibreOffice returned no unique output document; no destination was written')
    const output = join(outputDir, outputs[0])
    const info = await stat(output)
    if (!info.isFile() || info.size < 1 || info.size > 128 * 1024 * 1024)
      throw new Error('Converted output is empty or exceeds 128 MiB')
    const bytes = await readFile(output)
    if (
      format === 'pdf'
        ? !bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-')
        : bytes.length < 2 || bytes.readUInt16LE(0) !== 0x4b50
    )
      throw new Error('Converted output does not have the expected container signature')
    await copyFile(output, destination, constants.COPYFILE_EXCL)
    return {
      engine: engine.id,
      version: engine.version,
      sourcePath: source,
      destinationPath: destination,
      format,
      bytes: info.size,
      sourceSha256: sourceHash,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      scope:
        'Separate compatibility conversion. Layout and unsupported-feature preservation require corpus review.',
      diagnostics: result.stdout.slice(0, 4096),
    }
  } finally {
    await releaseEngineDirectory(work)
  }
}
