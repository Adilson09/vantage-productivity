import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { knownRelocationDigest, sessionAfterVerifiedRelocation, verifyRelocatedWorkbook } from '../src/main/workbook-relocation'
import { SheetsSourceLineages } from '../src/main/sheets-source-lineage'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sheets-relocation-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const hash = (data: string) => createHash('sha256').update(data).digest('hex')

describe('known-byte owned workbook relocation (source-only regressions)', () => {
  it('uses a recorded own-publication fingerprint before any immutable opening fingerprint', () => {
    const old = join(directory, 'old.xlsx'), own = hash('acknowledged own publication')
    const session = { path: old, sha256: hash('opened'), publishedVersions: new Map([[old, own]]) }
    expect(knownRelocationDigest(session, old)).toBe(own)
  })

  it('selects the matching original alias hash, never the converted/decrypted base hash', () => {
    const old = join(directory, 'source.csv'), converted = join(directory, 'converted.xlsx')
    expect(knownRelocationDigest({ path: converted, sha256: hash('converted'), csvSourcePath: old, csvSourceSha: hash('csv') }, old)).toBe(hash('csv'))
    expect(knownRelocationDigest({ path: converted, sha256: hash('converted'), restoreTarget: old, restoreTargetSha: hash('restored original') }, old)).toBe(hash('restored original'))
    expect(knownRelocationDigest({ path: converted, sha256: hash('converted'), recoverySourcePath: old, recoverySourceSha: hash('imported original') }, old)).toBe(hash('imported original'))
    expect(knownRelocationDigest({ path: converted, sha256: hash('converted'), suggestSaveAs: old.replace(/\.csv$/, '.xlsx') }, old)).toBeUndefined()
  })

  it('requires an existing regular moved file with the previously known bytes and refuses a new baseline', async () => {
    const target = join(directory, 'moved.xlsx'), expected = hash('known bytes')
    await writeFile(target, 'known bytes')
    await expect(verifyRelocatedWorkbook(target, expected)).resolves.toBeUndefined()
    await writeFile(target, 'external replacement')
    await expect(verifyRelocatedWorkbook(target, expected)).rejects.toThrow('previously known bytes')
    await expect(verifyRelocatedWorkbook(target, undefined)).rejects.toThrow('no known source fingerprint')
    await expect(verifyRelocatedWorkbook(join(directory, 'missing.xlsx'), expected)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(join(directory, 'folder.xlsx'))
    await expect(verifyRelocatedWorkbook(join(directory, 'folder.xlsx'), expected)).rejects.toThrow('existing regular file')
  })

  it('relocates path/guard/display while preserving native base, password, payload policy and the old object', () => {
    const old = join(directory, 'old.xlsx'), moved = join(directory, 'new.xlsx'), expected = hash('original ciphertext')
    const session = { path: old, sha256: expected, nativeSourceFingerprint: `sha256:${hash('plaintext base')}`, snapshotPath: 'owned-snapshot', password: '',
      publishedVersions: new Map([[old, expected]]), relocationPending: true, readerDisplay: { name: 'old.xlsx', path: old, readOnly: false } }
    const next = sessionAfterVerifiedRelocation(session, old, moved, expected)
    expect(next.path).toBe(moved)
    expect(next.readerDisplay.path).toBe(moved)
    expect(next.readerDisplay.name).toBe('new.xlsx')
    expect(next.publishedVersions.get(moved)).toBe(expected)
    expect(next.publishedVersions.has(old)).toBe(false)
    expect(next.nativeSourceFingerprint).toBe(session.nativeSourceFingerprint)
    expect(next.snapshotPath).toBe(session.snapshotPath)
    expect(next.sha256).toBe(expected)
    expect(next.password).toBe('')
    expect(next.relocationPending).toBe(false)
    expect(session.path).toBe(old)
    expect(session.relocationPending).toBe(true)
  })

  it('updates CSV/restore/recovery aliases without exposing a private converted path as the visible target', () => {
    const old = join(directory, 'old.csv'), moved = join(directory, 'new.csv'), expected = hash('CSV original')
    const session = { path: join(directory, 'private-converted.xlsx'), sha256: hash('converted base'), csvSourcePath: old, csvSourceSha: expected,
      restoreTarget: old, restoreTargetSha: expected, recoverySourcePath: old, recoverySourceSha: expected,
      suggestSaveAs: old.replace(/\.csv$/, '.xlsx'), readerDisplay: { name: 'old.csv', path: old, readOnly: false } }
    const next = sessionAfterVerifiedRelocation(session, old, moved, expected)
    expect(next.path).toBe(session.path)
    expect(next.csvSourcePath).toBe(moved)
    expect(next.restoreTarget).toBe(moved)
    expect(next.recoverySourcePath).toBe(moved)
    expect(next.suggestSaveAs).toBe(moved.replace(/\.csv$/, '.xlsx'))
    expect(next.readerDisplay.path).toBe(moved)
    expect(next.csvSourceSha).toBe(expected)
    expect(next.recoveryOriginalFingerprint).toBe(`sha256:${expected}`)
  })

  it('physical unsaved relocation uses the new target folder while a private alias move preserves the visible restore target', () => {
    const old = join(directory, 'old.xlsx'), moved = join(directory, 'another-folder', 'new.xlsx'), expected = hash('owned base')
    const unsaved = { path: old, sha256: expected, unsavedNew: true, suggestSaveAs: join(directory, 'old-folder', 'suggest.xlsx') }
    expect(sessionAfterVerifiedRelocation(unsaved, old, moved, expected).suggestSaveAs).toBe(moved)
    const visible = join(directory, 'visible.xlsx')
    const restored = { path: old, sha256: expected, restoreTarget: visible, restoreTargetSha: hash('original'),
      readerDisplay: { name: 'visible.xlsx', path: visible, readOnly: false } }
    const next = sessionAfterVerifiedRelocation(restored, old, moved, expected)
    expect(next.path).toBe(moved)
    expect(next.readerDisplay.path).toBe(visible)
    expect(next.readerDisplay.name).toBe(basename(visible))
  })

  it('relocates only the main-owned path capability and invalidates previously issued reader adoptions', () => {
    const owner = {}, invalidations: string[] = [], sources = new SheetsSourceLineages<object>((_owner, reason) => invalidations.push(reason))
    const open = sources.beginOpen(owner), old = join(directory, 'old.xlsx'), moved = join(directory, 'new.xlsx')
    sources.commitOpen(owner, open, { sessionId: 'reader', openedSha256: hash('immutable base'), documentPath: old })
    const prior = sources.current(owner)!
    const stale = sources.offerOwnedPublication(owner, prior, { sessionId: 'replacement', openedSha256: prior.openedSha256, documentPath: old })
    const next = sources.relocateOwnedPath(owner, prior, moved)!
    expect(next).toEqual({ ...prior, documentPath: moved })
    expect(sources.adoptOwnedPublication(owner, stale)).toBeNull()
    expect(invalidations).toContain('owned source path relocated')
    expect(sources.relocateOwnedPath({}, prior, moved)).toBeNull()
  })
})
