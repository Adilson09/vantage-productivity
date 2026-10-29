// Vantage Productivity modification: share fail-safe replacement and recovery snapshots,
// while preserving the shell's post-rename directory durability flush.
import { open, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteVia } from '@vantage/electron-utils/atomic-write'

export { atomicCopyFile } from '@vantage/electron-utils/atomic-write'

// cloud-sync folders, AV locks and fsync-less filesystems refuse the flush after a
// successful write; that only weakens power-loss durability, so the save proceeds
const TOLERATED_SYNC_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EINVAL', 'ENOSYS'])
export async function atomicWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  await atomicWriteVia(filePath, (tmp) => writeFile(tmp, data, { flag: 'wx' }))
  // The rename is only durable once its directory entry is flushed. Windows
  // does not allow directory opens; NTFS journals the rename itself.
  if (process.platform !== 'win32') await fsyncPath(dirname(filePath), true)
}

async function fsyncPath(path: string, tolerateAll = false): Promise<void> {
  const tolerated = (error: unknown) =>
    tolerateAll || TOLERATED_SYNC_CODES.has((error as NodeJS.ErrnoException).code ?? '')
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (tolerated(error)) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!tolerated(error)) throw error
  } finally {
    await handle.close()
  }
}
