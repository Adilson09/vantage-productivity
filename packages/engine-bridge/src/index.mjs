import { spawn } from 'node:child_process'
import { access, copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

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
    license: 'GPL-3.0-or-later / MPL-2.0 (verify selected distribution)',
    url: 'https://docs.verapdf.org/cli/validation/',
    commands: ['verapdf.exe', 'verapdf'],
    env: 'VANTAGE_VERAPDF_PATH',
    capabilities: ['pdf-conformance-report'],
  },
])

/** Bounded output/deadline, direct executable invocation. No shell or document-supplied arguments. */
export function runBounded(
  executable,
  args,
  { timeoutMs = 30000, maxOutputBytes = 1024 * 1024, signal, cwd, processEnv } = {},
) {
  if (!isAbsolute(executable)) throw new Error('An absolute engine executable path is required')
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error('Engine arguments must be strings')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error('Deadline must be 1–120000 ms')
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 4 * 1024 * 1024
  )
    throw new Error('Output budget must be 1–4194304 bytes')
  return new Promise((done) => {
    if (signal?.aborted) {
      done({ code: null, stdout: '', stderr: '', stopped: 'cancelled' })
      return
    }
    let child
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        cwd,
        ...(processEnv ? { env: { ...process.env, ...processEnv } } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      done({ code: null, stdout: '', stderr: error.message, stopped: 'unavailable' })
      return
    }
    let used = 0,
      stopped,
      stdout = '',
      stderr = '',
      settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      done({ code, stdout, stderr, ...(stopped ? { stopped } : {}) })
    }
    const stop = (reason) => {
      if (stopped) return
      stopped = reason
      // soffice.com and Java launchers may have descendants holding pipes open.
      if (process.platform === 'win32' && child.pid && process.env.SystemRoot) {
        const killer = spawn(
          join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, shell: false, stdio: 'ignore' },
        )
        killer.once('error', () => child.kill())
        killer.once('close', (code) => {
          if (code !== 0) child.kill()
        })
      } else child.kill('SIGKILL')
    }
    const abort = () => stop('cancelled')
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const output = (chunk, target) => {
      const remaining = Math.max(0, maxOutputBytes - used)
      const text = chunk.subarray(0, remaining).toString('utf8')
      used += chunk.length
      if (target === 'stdout') stdout += text
      else stderr += text
      if (used > maxOutputBytes) stop('output-limit')
    }
    child.stdout.on('data', (chunk) => output(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => output(chunk, 'stderr'))
    child.once('error', (error) => {
      stderr += error.message
      stopped = 'unavailable'
      finish(null)
    })
    child.once('close', finish)
  })
}

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

export async function discoverEngines(options = {}) {
  let manifest = null
  const manifestPath =
    options.manifestPath ??
    (options.env ?? process.env).VANTAGE_ENGINE_MANIFEST ??
    (!options.env ? new URL('../engines.local.json', import.meta.url) : null)
  if (manifestPath) {
    try {
      if ((await stat(manifestPath)).size > 65536) throw new Error('Engine manifest exceeds 64 KiB')
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      for (const pin of Object.values(manifest.engines ?? {})) {
        if (pin && typeof pin.path === 'string' && !isAbsolute(pin.path)) {
          const base = dirname(
            manifestPath instanceof URL ? fileURLToPath(manifestPath) : resolve(manifestPath),
          )
          const expanded = resolve(base, pin.path)
          // Portable manifests may reference only descendants of their own folder.
          if (!expanded.startsWith(base + '/') && !expanded.startsWith(base + '\\'))
            throw new Error('Relative engine path leaves the engine manifest directory')
          pin.path = expanded
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Cannot load local engine configuration: ' + error.message)
    }
  }
  return Promise.all(
    ENGINE_CATALOG.map(async (engine) => {
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
        const executableSha256 = createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
        if (
          pinned?.path === path &&
          pinned.sha256 &&
          executableSha256 !== pinned.sha256.toLowerCase()
        ) {
          reason =
            'Installed executable differs from its pinned SHA256; revalidate the local component.'
          continue
        }
        // Even a version probe must never attach to a user's running Office profile.
        const probeRoot =
          engine.id === 'libreoffice'
            ? await mkdtemp(
                join(
                  options.tempRoot ?? process.env.VANTAGE_ENGINE_TEMP_DIR ?? tmpdir(),
                  'vantage-version-',
                ),
              )
            : null
        let result
        try {
          result = await runBounded(
            path,
            probeRoot
              ? [
                  '-env:UserInstallation=' + pathToFileURL(join(probeRoot, 'profile')).href,
                  '--headless',
                  '--norestore',
                  '--version',
                ]
              : ['--version'],
            {
              timeoutMs: 5000,
              maxOutputBytes: 16384,
              signal: options.signal,
              ...(probeRoot ? { processEnv: { SAL_SKIA: 'raster', SAL_DISABLE_OPENCL: '1' } } : {}),
            },
          )
        } finally {
          if (probeRoot) await rm(probeRoot, { recursive: true, force: true })
        }
        if (result.stopped || result.code !== 0) {
          reason = 'The configured executable did not complete its version probe.'
          continue
        }
        return {
          id: engine.id,
          name: engine.name,
          available: true,
          path,
          executableSha256,
          version: (result.stdout || result.stderr).trim().slice(0, 200),
          license: engine.license,
          url: engine.url,
          capabilities: engine.capabilities,
          ...(pinned?.validation ? { validation: pinned.validation } : {}),
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
    }),
  )
}

async function selectedEngine(id, options) {
  const engine = (await discoverEngines(options)).find((item) => item.id === id)
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
  const installed = await selectedEngine(engine, options)
  if (flavour && !/^(?:1[ab]|2[abu]|3[abu]|4[ef]?|ua[12])$/.test(flavour))
    throw new Error('Unsupported veraPDF validation flavour')
  const args =
    engine === 'qpdf'
      ? ['--check', input]
      : [
          '--format',
          'json',
          '--maxfailuresdisplayed',
          '10',
          ...(flavour ? ['--flavour', flavour] : []),
          input,
        ]
  const result = await runBounded(installed.path, args, options)
  let report
  if (engine === 'verapdf' && !result.stopped) {
    try {
      report = JSON.parse(result.stdout)
    } catch {
      /* Missing valid machine report cannot pass. */
    }
  }
  const status = result.stopped
    ? 'incomplete'
    : engine === 'qpdf'
      ? result.code === 0
        ? 'pass'
        : result.code === 3
          ? 'warning'
          : 'fail'
      : report && result.code === 0
        ? 'report'
        : 'fail'
  return {
    engine: installed.id,
    version: installed.version,
    filePath: input,
    status,
    ...result,
    ...(report ? { report } : {}),
    scope:
      engine === 'qpdf'
        ? 'Structural diagnostics only; visual fidelity and accessibility are not certified.'
        : 'Machine conformance report. Review validation results in the report; human accessibility requirements remain separate.',
  }
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
        'LibreOffice conversion did not complete: ' + (result.stopped ?? `exit ${result.code}`),
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
    await rm(work, { recursive: true, force: true })
  }
}
