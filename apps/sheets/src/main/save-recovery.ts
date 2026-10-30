// Vantage Productivity addition: preserve the previous workbook before the native writer runs.
import {
  withAtomicSaveQueue,
  readAtomicFileVersion,
  getLastAtomicSaveReport,
  recordAtomicSaveReport,
} from '@vantage/electron-utils/atomic-write'
import { captureRecoverySnapshot } from '../../../../packages/electron-utils/src/recovery-vault'

export async function withNativeSaveRecovery<T>(
  targetPath: string,
  write: () => Promise<T>,
): Promise<T> {
  return withAtomicSaveQueue(targetPath, async () => {
    const firstSave = (await readAtomicFileVersion(targetPath)) === null
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
    const result = await write()
    // Sidecar serializers may publish through the shared JS contract or a
    // direct native implementation. Both get a first-save baseline after the
    // writer reports successful publication; this never converts success into
    // a misleading "not saved" error if only the history side effect fails.
    if (firstSave && getLastAtomicSaveReport(targetPath)?.recovery !== 'first-save') {
      try {
        const baseline = await captureRecoverySnapshot(targetPath, undefined, 'first-save')
        recordAtomicSaveReport(targetPath, {
          published: true,
          recovery: baseline ? 'first-save' : 'not-applicable',
        })
      } catch (error) {
        const warning = `The workbook was saved, but its first recovery baseline could not be stored: ${error instanceof Error ? error.message : String(error)}`
        recordAtomicSaveReport(targetPath, { published: true, recovery: 'failed', warning })
        console.warn('[sheets]', warning)
      }
    }
    return result
  })
}
