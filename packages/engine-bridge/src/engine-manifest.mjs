import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function fileSha256(path) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    bytes += chunk.length
    if (bytes > 256 * 1024 * 1024)
      throw new Error('Engine component exceeds the 256 MiB hashing budget')
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function descendant(base, path) {
  const child = relative(base, path)
  return child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

/** Portable engine paths cannot use URLs, traversal, alternate streams or linked escapes. */
export async function portableFile(base, path) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes(':') ||
    path.includes('\0') ||
    path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Relative engine path leaves the engine manifest directory')
  const target = resolve(base, ...path.split(/[\\/]/))
  if (!descendant(base, target))
    throw new Error('Relative engine path leaves the engine manifest directory')
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error('Engine component must be a regular file')
    if (!descendant(await realpath(base), await realpath(target)))
      throw new Error('Linked engine path leaves the engine manifest directory')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return target
}

export async function readEngineManifest(manifestPath) {
  if (!manifestPath) return null
  try {
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Engine manifest must be a regular file')
    if (info.size > 65536) throw new Error('Engine manifest exceeds 64 KiB')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) ||
      !manifest.engines ||
      typeof manifest.engines !== 'object' ||
      Array.isArray(manifest.engines)
    )
      throw new Error('Unsupported engine manifest schema')
    const base = dirname(
      manifestPath instanceof URL ? fileURLToPath(manifestPath) : resolve(manifestPath),
    )
    for (const [id, pin] of Object.entries(manifest.engines)) {
      if (!pin || typeof pin !== 'object' || typeof pin.path !== 'string')
        throw new Error('Engine entry requires an executable path')
      if (pin.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(pin.sha256))
        throw new Error('Engine executable SHA256 must contain 64 hexadecimal characters')
      if (!isAbsolute(pin.path)) pin.path = await portableFile(base, pin.path)
      if (pin.launch !== undefined) {
        const launch = pin.launch
        if (
          id !== 'verapdf' ||
          !launch ||
          typeof launch !== 'object' ||
          Array.isArray(launch) ||
          launch.kind !== 'java-jar' ||
          Object.keys(launch).some((key) => !['kind', 'jar', 'sha256'].includes(key)) ||
          !/^[a-f0-9]{64}$/i.test(launch.sha256 ?? '') ||
          !pin.sha256 ||
          typeof launch.jar !== 'string' ||
          !launch.jar.toLowerCase().endsWith('.jar')
        )
          throw new Error(
            'veraPDF requires a constrained java-jar launch with pinned executable and JAR hashes',
          )
        launch.jar = await portableFile(base, launch.jar)
      }
    }
    return manifest
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('Cannot load local engine configuration: ' + error.message)
  }
}

export async function verifiedJar(launch) {
  const info = await lstat(launch.jar)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 128 * 1024 * 1024)
    throw new Error('veraPDF JAR must be a regular file between 1 byte and 128 MiB')
  if ((await fileSha256(launch.jar)) !== launch.sha256.toLowerCase())
    throw new Error('veraPDF JAR differs from its pinned SHA256; revalidate the local component')
}

export function javaArguments(launch, work, args) {
  return [
    '-Xms16m',
    '-Xmx256m',
    '-XX:ActiveProcessorCount=2',
    '-Djava.awt.headless=true',
    '-Dfile.encoding=UTF8',
    '-Djava.io.tmpdir=' + work,
    '-Duser.home=' + work,
    '-Dapp.home=' + work,
    '-Dbasedir=' + work,
    '-Dapp.repo=' + dirname(launch.jar),
    '--add-exports=java.base/sun.security.pkcs=ALL-UNNAMED',
    '-jar',
    launch.jar,
    ...args,
  ]
}

export function privateJavaEnvironment(overrides = {}, inherited = process.env) {
  const safe = { ...overrides }
  // Windows accepts environment names case-insensitively; clear every spelling.
  for (const key of new Set([...Object.keys(inherited), ...Object.keys(overrides)]))
    if (/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|CLASSPATH|JAVA_OPTS)$/i.test(key))
      safe[key] = undefined
  return safe
}
