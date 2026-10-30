import { describe, expect, it } from 'vitest'
import type { WorkbookFile } from '../src/shared/desktop-api'
import { captureReaderDisplay, rebindRecoveredReader, recoveredReaderFile, recoveredReaderSource, sessionAfterPasswordPublication,
  type ImmutableReaderSession } from '../src/main/reader-recovery'

function oldSession() {
  return { path: 'C:/private/example/book.xlsx', snapshotPath: 'C:/private/owned/old.xlsx',
    sha256: 'a'.repeat(64), nativeSourceFingerprint: `sha256:${'b'.repeat(64)}`,
    sheetNames: new Map([['sheet-1', 'Budget'], ['sheet-2', 'Notes']]), password: '',
    publishedVersions: new Map([['C:/private/example/book.xlsx', 'c'.repeat(64)]]),
    importTempDir: 'C:/private/owned/import', csvSourcePath: 'C:/private/example/source.csv',
    csvSourceSha: 'd'.repeat(64), restoreTarget: 'C:/private/example/target.xlsx', restoreTargetSha: 'e'.repeat(64),
    recoverySourcePath: 'C:/private/example/original.xls', recoverySourceSha: 'f'.repeat(64),
    unsavedNew: true, pendingBase: true, automaticRecoveryDisabled: true,
    readerDisplay: { name: 'User-visible workbook.xlsx', path: 'C:/private/example/visible.xlsx', readOnly: false,
      fileBytes: 4096, needsSaveAs: true, unsavedNew: true, restoredFromRecovery: true, automaticRecoveryDisabled: true } }
}
function freshSession(old: ImmutableReaderSession): ImmutableReaderSession {
  return { path: old.snapshotPath, snapshotPath: 'C:/private/owned/new.xlsx', sha256: 'b'.repeat(64),
    nativeSourceFingerprint: old.nativeSourceFingerprint, sheetNames: new Map(old.sheetNames) }
}
/** Minimal typed metadata fixture: these tests exercise no importer/actual file I/O. */
function openedFile(): WorkbookFile {
  return { sessionId: '10000000-0000-4000-8000-000000000002', name: 'new-reader-uuid.xlsx',
    path: 'C:/private/owned/old.xlsx', sha256: 'b'.repeat(64), fileBytes: 100,
    sheets: [{ id: 'sheet-1', name: 'Budget' }], readOnly: false, passwordProtected: false } as unknown as WorkbookFile
}

describe('immutable same-model reader recovery identity (source-only regressions)', () => {
  it('matches the native plaintext fingerprint independently of the original encrypted SHA and preserves every old policy/guard', () => {
    const old = oldSession(), fresh = freshSession(old), rebound = rebindRecoveredReader(old, fresh)
    expect(old.sha256).not.toBe(old.nativeSourceFingerprint.slice(7))
    expect(rebound).toEqual({ ...old, snapshotPath: fresh.snapshotPath, sheetNames: fresh.sheetNames })
    expect(rebound.password).toBe('')
    expect(rebound.sha256).toBe(old.sha256)
    expect(rebound.nativeSourceFingerprint).toBe(old.nativeSourceFingerprint)
    expect(rebound.publishedVersions).toBe(old.publishedVersions)
    expect(rebound.importTempDir).toBe(old.importTempDir)
    expect(rebound.restoreTargetSha).toBe(old.restoreTargetSha)
    expect(old.snapshotPath).toBe('C:/private/owned/old.xlsx')
  })

  it('refuses changed source bytes even when an unrelated original-file SHA still matches', () => {
    const old = oldSession(), fresh = { ...freshSession(old), sha256: old.sha256, nativeSourceFingerprint: `sha256:${'9'.repeat(64)}` }
    expect(() => rebindRecoveredReader(old, fresh)).toThrow('immutable imported base')
    expect(old.sha256).toBe('a'.repeat(64))
  })

  it.each([
    [['different-id', 'Budget'], ['sheet-2', 'Notes']],
    [['sheet-1', 'Renamed'], ['sheet-2', 'Notes']],
    [['sheet-2', 'Notes'], ['sheet-1', 'Budget']],
    [['sheet-1', 'Budget']],
  ].map(mapping => ({ mapping })))('refuses a different worksheet mapping or order without changing the old session ($mapping)', ({ mapping }) => {
    const old = oldSession(), original = [...old.sheetNames]
    expect(() => rebindRecoveredReader(old, { ...freshSession(old), sheetNames: new Map(mapping as [string, string][]) })).toThrow('worksheet identity or order')
    expect([...old.sheetNames]).toEqual(original)
  })

  it('refuses reuse of the old snapshot path so new-reader cleanup cannot remove its old source', () => {
    const old = oldSession()
    expect(() => rebindRecoveredReader(old, { ...freshSession(old), snapshotPath: old.snapshotPath })).toThrow('separate immutable snapshot')
  })

  it('returns the new reader ID while preserving old display, ciphertext SHA, password presence and recovery policy', () => {
    const old = oldSession(), opened = openedFile(), recovered = recoveredReaderFile(old, opened)
    expect(recovered.sessionId).toBe(opened.sessionId)
    expect(recovered.name).toBe(old.readerDisplay.name)
    expect(recovered.path).toBe(old.readerDisplay.path)
    expect(recovered.sha256).toBe(old.sha256)
    expect(recovered.fileBytes).toBe(old.readerDisplay.fileBytes)
    expect(recovered.passwordProtected).toBe(true)
    expect(recovered.restoredFromRecovery).toBe(true)
    expect(recovered.automaticRecoveryDisabled).toBe(true)
    expect(recovered.sheets).toBe(opened.sheets)
    expect(opened.passwordProtected).toBe(false)
  })

  it('captures display metadata without granting native/source adoption permissions', () => {
    const opened = { ...openedFile(), closeSource: { lineage: 'lineage', sessionId: 'reader', openedSha256: 'a'.repeat(64), documentPath: 'old.xlsx' },
      ownedOpen: { id: 'token', source: { lineage: 'lineage', sessionId: 'reader', openedSha256: 'a'.repeat(64), documentPath: 'old.xlsx' } } }
    const display = captureReaderDisplay(opened)
    expect(display.name).toBe(opened.name)
    expect(display).not.toHaveProperty('sessionId')
    expect(display).not.toHaveProperty('closeSource')
    expect(display).not.toHaveProperty('ownedOpen')
  })

  it('records an owned password ciphertext publication without replacing the immutable native base or old object', () => {
    const old = oldSession(), nextSha = '8'.repeat(64)
    const updated = sessionAfterPasswordPublication(old, 'example-new-password', nextSha, 8192)
    expect(updated.password).toBe('example-new-password')
    expect(updated.sha256).toBe(nextSha)
    expect(updated.publishedVersions.get(old.path)).toBe(nextSha)
    expect(updated.nativeSourceFingerprint).toBe(old.nativeSourceFingerprint)
    expect(updated.snapshotPath).toBe(old.snapshotPath)
    expect(updated.sheetNames).toBe(old.sheetNames)
    expect(updated.readerDisplay.fileBytes).toBe(8192)
    expect(updated.restoreTargetSha).toBe(old.restoreTargetSha)
    expect(old.sha256).toBe('a'.repeat(64))
    expect(old.password).toBe('')
    expect(old.publishedVersions.get(old.path)).toBe('c'.repeat(64))
  })

  it('same-model recovery preserves imported source capabilities after an owned password change', () => {
    const old = oldSession(), updated = sessionAfterPasswordPublication(old, 'example-next-password', '8'.repeat(64), 8192)
    const previous = { lineage: '10000000-0000-4000-8000-000000000001', sessionId: '20000000-0000-4000-8000-000000000001',
      openedSha256: old.sha256, documentPath: old.path }
    const freshId = '20000000-0000-4000-8000-000000000002'
    const next = recoveredReaderSource(previous, freshId)
    expect(next).toEqual({ ...previous, sessionId: freshId })
    expect(next.openedSha256).not.toBe(updated.sha256)
    expect(next.openedSha256).not.toBe(updated.nativeSourceFingerprint.slice(7))
    expect(previous.sessionId).not.toBe(freshId)
  })
})
