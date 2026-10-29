// Aster Office addition: preserve the previous workbook before the native writer runs.
import { withAtomicSaveQueue } from '@genoffice/electron-utils/atomic-write'
import { captureRecoverySnapshot } from '../../../../packages/electron-utils/src/recovery-vault'

export async function withNativeSaveRecovery<T>(
  targetPath: string,
  write: () => Promise<T>,
): Promise<T> {
  return withAtomicSaveQueue(targetPath, async () => {
    try {
      await captureRecoverySnapshot(targetPath)
    } catch (cause) {
      throw new Error(
        `The recovery snapshot for "${targetPath}" could not be saved. The workbook was not overwritten. ` +
          'Use Save As to preserve your edits in a new file. ' +
          `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    return write()
  })
}
