import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, open, stat } from 'node:fs/promises'

// libuv reports unsupported Windows exFAT hardlinks as EISDIR as well.
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM', 'EINVAL', 'EISDIR'])

/** Exclusively publish a new copy. NTFS supports an atomic hardlink publish;
 * exFAT and other filesystems use an exclusive copy and flush. Existing files
 * are never overwritten in either path. A process crash during the fallback
 * can leave a partial NEW destination; only successful return certifies it.
 */
export async function publishExclusiveCopy(temporaryPath: string, destination: string, expected: {
  bytes: number; sha256: string
}): Promise<{ atomic: boolean }> {
  let published = false
  let atomic = true
  try {
    try {
      await link(temporaryPath, destination)
      published = true
    } catch (error) {
      if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error
      atomic = false
      // copyFile may internally unlink a failed destination. Own a wx handle
      // instead, so every failure preserves any current path for explicit review.
      const input = await open(temporaryPath, 'r')
      let output: Awaited<ReturnType<typeof open>> | undefined
      let failure: unknown, failed = false
      try {
        output = await open(destination, 'wx', 0o600)
        published = true
        const buffer = Buffer.alloc(64 * 1024)
        let total = 0
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
          if (!bytesRead) break
          total += bytesRead
          if (total > expected.bytes) throw new Error('Recovery source grew beyond its expected publication length')
          let offset = 0
          while (offset < bytesRead) {
            const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null)
            if (!bytesWritten) throw new Error('Recovery output made no write progress')
            offset += bytesWritten
          }
        }
        if (total !== expected.bytes) throw new Error('Recovery source changed before exclusive publication')
        await output.sync()
      } catch (error) { failed = true; failure = error }
      finally {
        for (const handle of [output, input]) if (handle) {
          try { await handle.close() } catch (error) { if (!failed) { failed = true; failure = error } }
        }
      }
      if (failed) throw failure
    }
    const before = await stat(destination)
    if (!before.isFile() || before.size !== expected.bytes) throw new Error('Recovered copy failed its size check')
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(destination, { highWaterMark: 64 * 1024 })) {
      bytes += chunk.length
      if (bytes > expected.bytes) throw new Error('Recovered copy grew during verification')
      hash.update(chunk)
    }
    const after = await stat(destination)
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256 || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino)
      throw new Error('Recovered copy failed its byte integrity check')
    return { atomic }
  } catch (error) {
    // An awaited verifier cannot prove that the current path is still ours.
    // Never roll back by pathname: a different writer may have replaced it.
    if (!published && (error as NodeJS.ErrnoException)?.code === 'EEXIST') throw error
    const retained = new Error('Recovered copy could not be certified; a separate or incomplete destination may remain for review: ' + destination, { cause: error })
    if ((error as NodeJS.ErrnoException)?.code) Object.assign(retained, { code: (error as NodeJS.ErrnoException).code })
    throw retained
  }
}
