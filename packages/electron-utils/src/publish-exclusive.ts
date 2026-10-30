import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, link, open, stat, unlink } from 'node:fs/promises'

// libuv reports unsupported Windows exFAT hardlinks as EISDIR as well.
const NO_HARD_LINKS = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EPERM',
  'EINVAL',
  'EISDIR',
])

/** Exclusively publish a new copy. NTFS supports an atomic hardlink publish;
 * exFAT and other filesystems use an exclusive copy and flush. Existing files
 * are never overwritten in either path. A process crash during the fallback
 * can leave a partial NEW destination; only successful return certifies it.
 */
export async function publishExclusiveCopy(
  temporaryPath: string,
  destination: string,
  expected: {
    bytes: number
    sha256: string
  },
): Promise<{ atomic: boolean }> {
  let ownsDestination = false
  let atomic = true
  try {
    try {
      await link(temporaryPath, destination)
      ownsDestination = true
    } catch (error) {
      if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error
      atomic = false
      // COPYFILE_EXCL is enforced by the filesystem. Never emulate it with a
      // separate existence check followed by an overwrite-capable operation.
      await copyFile(temporaryPath, destination, constants.COPYFILE_EXCL)
      ownsDestination = true
      const handle = await open(destination, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const before = await stat(destination)
    if (!before.isFile() || before.size !== expected.bytes)
      throw new Error('Recovered copy failed its size check')
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(destination, { highWaterMark: 64 * 1024 })) {
      bytes += chunk.length
      if (bytes > expected.bytes) throw new Error('Recovered copy grew during verification')
      hash.update(chunk)
    }
    const after = await stat(destination)
    if (
      bytes !== expected.bytes ||
      hash.digest('hex') !== expected.sha256 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino
    )
      throw new Error('Recovered copy failed its byte integrity check')
    return { atomic }
  } catch (error) {
    if (ownsDestination) await unlink(destination).catch(() => {})
    throw error
  }
}
