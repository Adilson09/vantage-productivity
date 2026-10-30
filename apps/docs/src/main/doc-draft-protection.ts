import {
  docPasswordFor,
  encryptDocx,
  isDiskEncrypted,
  snapshotDocPassword,
} from './docx-encryption'

/**
 * Capture before materialization awaits. A pending password protects a new draft;
 * removing a disk password does not expose recovery before a real save commits it.
 * The returned closure never persists the password itself.
 */
export function captureDocDraftProtection(
  owner: number,
  documentPath: string | null,
  expectedProtected: boolean,
): (plain: Buffer) => Buffer {
  const desired = snapshotDocPassword(owner, documentPath).password
  const diskProtected = documentPath !== null && isDiskEncrypted(owner, documentPath)
  const password = desired ?? (diskProtected ? docPasswordFor(owner, documentPath) : null)
  if ((expectedProtected || diskProtected) && !password)
    throw new Error('The document password is unavailable; its draft was not written.')
  return password ? (plain) => encryptDocx(plain, password) : (plain) => plain
}
