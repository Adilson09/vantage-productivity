import { lstat, unlink } from 'node:fs/promises'
import { publishExclusiveCopy } from '../../../../packages/electron-utils/src/publish-exclusive'
import { verifyRelocatedWorkbook } from './workbook-relocation'

/** W2 caller owns source+destination throughout; never overwrite or roll back a destination by pathname. */
export async function moveWorkbookExclusively(source: string, destination: string, expectedSha256: string): Promise<void> {
  await verifyRelocatedWorkbook(source, expectedSha256)
  const before = await lstat(source)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('The loaded workbook source is no longer a regular file.')
  await publishExclusiveCopy(source, destination, { bytes: before.size, sha256: expectedSha256 })
  await verifyRelocatedWorkbook(destination, expectedSha256)
  // The expected hash is the one captured from the loaded/own-published state,
  // never a new baseline read from a potentially changed source or destination.
  await verifyRelocatedWorkbook(source, expectedSha256)
  const current = await lstat(source)
  if (current.isSymbolicLink() || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev ||
    current.size !== before.size || current.mtimeMs !== before.mtimeMs)
    throw new Error('The source changed after exclusive copy; both paths were retained for review.')
  await unlink(source)
}
