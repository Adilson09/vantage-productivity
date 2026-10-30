/** Pure identity checks for same-model sidecar recovery; no disk/source refresh. */
import { basename } from 'node:path'
import type { WorkbookFile } from '../shared/desktop-api'
import type { SheetsCloseSource } from '../shared/sheets-close'

export type ReaderDisplay = Pick<
  WorkbookFile,
  | 'name'
  | 'path'
  | 'fileBytes'
  | 'readOnly'
  | 'needsSaveAs'
  | 'unsavedNew'
  | 'csvPath'
  | 'emptyCsv'
  | 'restoredFromRecovery'
  | 'automaticRecoveryDisabled'
>
export interface ImmutableReaderSession {
  readonly path: string
  readonly snapshotPath: string
  readonly sha256: string
  readonly nativeSourceFingerprint: string
  readonly sheetNames: ReadonlyMap<string, string>
  readonly password?: string
  readonly restoreTarget?: string
  readonly readerDisplay?: ReaderDisplay
}

export function captureReaderDisplay(file: WorkbookFile): ReaderDisplay {
  return {
    name: file.name,
    ...(file.path === undefined ? {} : { path: file.path }),
    ...(file.fileBytes === undefined ? {} : { fileBytes: file.fileBytes }),
    readOnly: file.readOnly,
    ...(file.needsSaveAs === undefined ? {} : { needsSaveAs: file.needsSaveAs }),
    ...(file.unsavedNew === undefined ? {} : { unsavedNew: file.unsavedNew }),
    ...(file.csvPath === undefined ? {} : { csvPath: file.csvPath }),
    ...(file.emptyCsv === undefined ? {} : { emptyCsv: file.emptyCsv }),
    ...(file.restoredFromRecovery === undefined
      ? {}
      : { restoredFromRecovery: file.restoredFromRecovery }),
    ...(file.automaticRecoveryDisabled === undefined
      ? {}
      : { automaticRecoveryDisabled: file.automaticRecoveryDisabled }),
  }
}

export function rebindRecoveredReader<Session extends ImmutableReaderSession>(
  old: Session,
  fresh: ImmutableReaderSession,
): Session {
  if (
    !/^sha256:[a-f0-9]{64}$/i.test(old.nativeSourceFingerprint) ||
    fresh.nativeSourceFingerprint !== old.nativeSourceFingerprint
  )
    throw new Error(
      'Reader recovery refused: the new reader does not match the immutable imported base.',
    )
  if (fresh.snapshotPath === old.snapshotPath)
    throw new Error('Reader recovery must own a separate immutable snapshot.')
  const oldSheets = [...old.sheetNames],
    newSheets = [...fresh.sheetNames]
  if (
    oldSheets.length !== newSheets.length ||
    oldSheets.some(
      ([id, name], index) => newSheets[index]?.[0] !== id || newSheets[index]?.[1] !== name,
    )
  )
    throw new Error('Reader recovery refused: worksheet identity or order changed.')
  // Preserve original/encrypted SHA, password presence, source guards,
  // publishedVersions, import/restore/pending flags and every future policy.
  return {
    ...old,
    snapshotPath: fresh.snapshotPath,
    sheetNames: fresh.sheetNames,
    nativeSourceFingerprint: fresh.nativeSourceFingerprint,
  }
}

export function recoveredReaderFile(
  old: ImmutableReaderSession,
  opened: WorkbookFile,
): WorkbookFile {
  const visiblePath = old.readerDisplay?.path ?? old.restoreTarget ?? old.path
  return {
    ...opened,
    ...old.readerDisplay,
    sessionId: opened.sessionId,
    name: old.readerDisplay?.name ?? basename(visiblePath),
    path: visiblePath,
    sha256: old.sha256,
    passwordProtected: old.password !== undefined,
  }
}

export function recoveredReaderSource(
  previous: SheetsCloseSource,
  sessionId: string,
): SheetsCloseSource {
  if (!sessionId || sessionId === previous.sessionId)
    throw new Error('Reader recovery requires a distinct reader identity.')
  // A password publication may change the current file guard SHA. It does not
  // change this imported-source capability or the plaintext native base.
  return { ...previous, sessionId }
}

export function sessionAfterPasswordPublication<
  Session extends ImmutableReaderSession & {
    readonly publishedVersions?: ReadonlyMap<string, string>
  },
>(old: Session, newPassword: string, ciphertextSha256: string, fileBytes: number): Session {
  if (
    !/^[a-f0-9]{64}$/i.test(ciphertextSha256) ||
    !Number.isSafeInteger(fileBytes) ||
    fileBytes < 0
  )
    throw new Error('The owned password publication has no valid ciphertext receipt.')
  // This is an owned ciphertext publication, not a new imported/plaintext base.
  return {
    ...old,
    password: newPassword,
    sha256: ciphertextSha256,
    publishedVersions: new Map([...(old.publishedVersions ?? []), [old.path, ciphertextSha256]]),
    ...(old.readerDisplay ? { readerDisplay: { ...old.readerDisplay, fileBytes } } : {}),
  }
}
