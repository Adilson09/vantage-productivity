import {
  atomicWriteFile,
  readAtomicFileVersion,
  type AtomicFileVersion,
} from '@vantage/electron-utils/atomic-write'
import type { FilePublicationScope } from '@vantage/electron-utils/file-publication-exclusion'

export interface CapturedSheetsOutput {
  readonly targetPath: string
  readonly expectedVersion: Readonly<AtomicFileVersion> | null
}

/** Called immediately after a main-owned picker, before actual publication admission. */
export async function captureSelectedSheetsOutput(
  targetPath: string,
  assertCurrent: () => void,
): Promise<CapturedSheetsOutput> {
  assertCurrent()
  const observed = await readAtomicFileVersion(targetPath)
  const expectedVersion = observed === null ? null : Object.freeze({ ...observed })
  assertCurrent()
  return Object.freeze({ targetPath, expectedVersion })
}

/** Only a main-owned fresh-name policy may supply absence authority. */
export function captureFreshSheetsOutput(targetPath: string): CapturedSheetsOutput {
  return Object.freeze({ targetPath, expectedVersion: null })
}

export type AdmitSheetsOutput = (
  scope: FilePublicationScope,
  actual: () => Promise<void>,
) => Promise<void>

/** The caller supplies its real main-owned actual-settlement lifecycle. */
export function publishCapturedSheetsOutput(
  output: CapturedSheetsOutput,
  options: {
    sourcePaths?: readonly string[]
    assertCurrent(): void
    prepare(): Promise<Uint8Array>
    afterPublished?(): void | Promise<void>
  },
  admit: AdmitSheetsOutput,
): Promise<void> {
  // Keep the main-captured choice, never a later implicit atomic queue version.
  const targetPath = output.targetPath
  const expectedVersion =
    output.expectedVersion === null ? null : Object.freeze({ ...output.expectedVersion })
  const sourcePaths = options.sourcePaths ? [...options.sourcePaths] : undefined
  options.assertCurrent()
  return admit({ targetPath, sourcePaths }, async () => {
    options.assertCurrent()
    const bytes = await options.prepare()
    options.assertCurrent()
    await atomicWriteFile(targetPath, Buffer.from(bytes), { expectedVersion })
    await options.afterPublished?.()
  })
}
