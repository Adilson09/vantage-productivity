import { open } from 'node:fs/promises'
import { HTML_DRAFT_MAX_BYTES } from '../shared/html-draft'
/** Exact bounded read: file growth cannot cause readFile to allocate past the checked size. */
export async function readHtmlReloadSource(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > HTML_DRAFT_MAX_BYTES)
      throw new Error('Reload exceeds the 16 MiB HTML limit; the current document is retained.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        Math.min(1024 * 1024, bytes.length - offset),
        offset,
      )
      if (!result.bytesRead) throw new Error('The reload source changed while being read.')
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino ||
      before.dev !== after.dev
    )
      throw new Error('The reload source changed while being read.')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } finally {
    await handle.close()
  }
}
