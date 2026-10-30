/** Known-byte path relocation; observing new bytes never establishes a baseline. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { ReaderDisplay } from './reader-recovery'

export interface RelocatableWorkbookSession {
  readonly path: string
  readonly sha256: string
  readonly csvSourcePath?: string
  readonly csvSourceSha?: string
  readonly restoreTarget?: string
  readonly restoreTargetSha?: string
  readonly recoverySourcePath?: string
  readonly recoverySourceSha?: string
  readonly suggestSaveAs?: string
  readonly unsavedNew?: boolean
  readonly publishedVersions?: ReadonlyMap<string, string>
  readonly readerDisplay?: ReaderDisplay
  readonly recoveryOriginalFingerprint?: string | null
  readonly relocationPending?: boolean
}
export function sameWorkbookPath(a: string, b: string): boolean {
  const left = resolve(a), right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
export function matchesWorkbookRelocation(s: RelocatableWorkbookSession, oldPath: string): boolean {
  return [s.path, s.csvSourcePath, s.restoreTarget, s.recoverySourcePath].some(path => path !== undefined && sameWorkbookPath(path, oldPath)) ||
    s.suggestSaveAs !== undefined && sameWorkbookPath(s.suggestSaveAs, oldPath.replace(/\.[^.]+$/, '.xlsx'))
}
export function knownRelocationDigest(s: RelocatableWorkbookSession, oldPath: string): string | undefined {
  for (const [path, digest] of s.publishedVersions ?? []) if (sameWorkbookPath(path, oldPath)) return digest
  const aliases: readonly [string | undefined, string | undefined][] = [
    [s.csvSourcePath, s.csvSourceSha], [s.restoreTarget, s.restoreTargetSha],
    [s.recoverySourcePath, s.recoverySourceSha], [s.path, s.sha256],
  ]
  return aliases.find(([path]) => path !== undefined && sameWorkbookPath(path, oldPath))?.[1]
}
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function verifyRelocatedWorkbook(path: string, knownDigest: string | undefined,
  readDigest: (path: string) => Promise<string> = fileDigest): Promise<void> {
  if (!isAbsolute(path) || !knownDigest || !/^[a-f0-9]{64}$/i.test(knownDigest)) throw new Error('The moved workbook has no known source fingerprint.')
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('The moved workbook must be an existing regular file.')
  if ((await readDigest(path)).toLowerCase() !== knownDigest.toLowerCase()) throw new Error('The moved workbook differs from the previously known bytes. Its source was not adopted.')
  const after = await lstat(path)
  if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('The moved workbook changed during verification. Its source was not adopted.')
}
export function sessionAfterVerifiedRelocation<S extends RelocatableWorkbookSession>(s: S, oldPath: string, newPath: string, knownDigest: string): S & RelocatableWorkbookSession {
  if (!matchesWorkbookRelocation(s, oldPath) || !/^[a-f0-9]{64}$/i.test(knownDigest)) throw new Error('The path move does not match this owned session.')
  const changed: { -readonly [Key in keyof RelocatableWorkbookSession]?: RelocatableWorkbookSession[Key] } = { relocationPending: false }
  if (sameWorkbookPath(s.path, oldPath)) changed.path = newPath
  if (s.csvSourcePath && sameWorkbookPath(s.csvSourcePath, oldPath)) changed.csvSourcePath = newPath
  if (s.restoreTarget && sameWorkbookPath(s.restoreTarget, oldPath)) changed.restoreTarget = newPath
  if (s.recoverySourcePath && sameWorkbookPath(s.recoverySourcePath, oldPath)) changed.recoverySourcePath = newPath
  if (s.unsavedNew && s.suggestSaveAs) changed.suggestSaveAs = newPath
  else if (s.suggestSaveAs && sameWorkbookPath(s.suggestSaveAs, oldPath.replace(/\.[^.]+$/, '.xlsx')))
    changed.suggestSaveAs = newPath.replace(/\.[^.]+$/, '.xlsx')
  const versions = new Map(s.publishedVersions)
  for (const path of versions.keys()) if (sameWorkbookPath(path, oldPath)) versions.delete(path)
  versions.set(newPath, knownDigest)
  changed.publishedVersions = versions
  const visibleBefore = s.restoreTarget ?? s.recoverySourcePath ?? s.csvSourcePath ?? s.readerDisplay?.path ?? s.path
  const movedVisible = sameWorkbookPath(visibleBefore, oldPath)
  const visibleAfter = movedVisible ? newPath : s.readerDisplay?.path ?? visibleBefore
  changed.readerDisplay = { ...(s.readerDisplay ?? { readOnly: false }), name: movedVisible ? basename(newPath) : s.readerDisplay?.name ?? basename(visibleAfter), path: visibleAfter,
    ...(changed.csvSourcePath ? { csvPath: changed.csvSourcePath } : {}) }
  const next = { ...s, ...changed }
  const original = next.restoreTarget ?? next.recoverySourcePath ?? next.csvSourcePath ?? next.suggestSaveAs ?? next.path
  return { ...next, ...(sameWorkbookPath(original, newPath) ? { recoveryOriginalFingerprint: `sha256:${knownDigest}` } : {}) }
}
