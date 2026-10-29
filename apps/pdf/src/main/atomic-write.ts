import { atomicWriteFile } from '@vantage/electron-utils/atomic-write'

/**
 * Shared temp + rename writer: retries the transient Windows EPERM/EBUSY rename
 * locks (Defender, indexer, an open preview). Vantage Productivity retains a completed
 * rescue file on publication failure and captures eligible previous versions.
 */
export async function writePdfAtomically(targetPath: string, bytes: Uint8Array): Promise<void> {
  await atomicWriteFile(targetPath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}
