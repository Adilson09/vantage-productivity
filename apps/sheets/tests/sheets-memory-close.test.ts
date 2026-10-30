import { describe, expect, it, vi } from 'vitest'
import type { CapturedNativeCloseAuthority } from '../src/main/workbook-document-recovery'
import { beginSheetsMemoryClose } from '../src/main/sheets-memory-close'

function fixture() {
  const authority = {
    id: '00000000-0000-4000-8000-000000000001',
    producer: '00000000-0000-4000-8000-000000000001',
    generation: 1,
    ownerId: '1',
    sessionId: 'reader',
    originalPath: 'C:/work/protected.xlsx',
    encrypted: true,
    ready: Promise.resolve(),
    cancelled: false,
    attest: () => ({
      documentId: '00000000-0000-4000-8000-000000000001',
      revision: 2,
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      payloadSha256: 'b'.repeat(64),
      pending: false,
    }),
    snapshotProof: vi.fn(),
    retireCapturedOnly: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    settled: () => Promise.resolve(),
  } satisfies CapturedNativeCloseAuthority
  const held: Promise<void>[] = []
  const order: string[] = []
  const ledger = {
    holdUntilSettled: (work: Promise<void>) => {
      held.push(work)
      order.push('hold')
    },
    report: vi.fn(),
  }
  return { authority, held, order, ledger }
}

describe('protected Sheets memory-only close admission', () => {
  it('registers the actual cleanup quit hold before synchronous removal', async () => {
    const f = fixture()
    const admitted = beginSheetsMemoryClose(f.authority, 'lineage', f.ledger)
    const handle = await admitted.ready
    expect(handle.status().custody).toBe(false)
    expect(
      handle.commitRemoval(() => {
        f.order.push('remove')
        return true
      }),
    ).toBe(true)
    expect(f.order).toEqual(['hold', 'hold', 'remove'])
    await Promise.all(f.held)
    expect(f.authority.retireCapturedOnly).toHaveBeenCalledTimes(1)
    expect((await handle.outcome).phase).toBe('complete')
    expect(f.authority.snapshotProof).not.toHaveBeenCalled()
  })

  it('does not retire memory when exact removal is refused', async () => {
    const f = fixture()
    const handle = await beginSheetsMemoryClose(f.authority, 'lineage', f.ledger).ready
    expect(handle.commitRemoval(() => false)).toBe(false)
    await Promise.all(f.held)
    expect(f.authority.retireCapturedOnly).not.toHaveBeenCalled()
    expect((await handle.outcome).phase).toBe('canceled')
  })

  it('refuses a pending checkpoint ACK without asking for a disk snapshot', async () => {
    const f = fixture()
    f.authority.attest = () => ({
      documentId: f.authority.id,
      revision: 2,
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      payloadSha256: 'b'.repeat(64),
      pending: true,
    })
    const admitted = beginSheetsMemoryClose(f.authority, 'lineage', f.ledger)
    await expect(admitted.ready).rejects.toThrow('uncertain')
    await admitted.actualSettled
    expect(f.authority.snapshotProof).not.toHaveBeenCalled()
    expect(f.authority.retireCapturedOnly).not.toHaveBeenCalled()
  })
})
