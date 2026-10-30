import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Expected is the immutable loaded/acknowledged-own-publication digest, never refreshed from disk. */
export async function assertWorkbookTargetUnchanged(
  path: string,
  expected: string | undefined,
  conflictMessage: string,
  readDigest: (path: string) => Promise<string> = fileDigest,
): Promise<void> {
  let current: string
  try { current = await readDigest(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (current !== expected) throw new Error(conflictMessage)
}
