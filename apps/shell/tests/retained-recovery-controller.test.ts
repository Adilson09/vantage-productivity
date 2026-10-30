import { describe, expect, it, vi } from 'vitest'
import type { CloseCleanupStatus } from '../../../packages/electron-utils/src/close-cleanup'
import { createRetainedRecoveryController } from '../src/main/retained-recovery-controller'

function fixture() {
  const status: CloseCleanupStatus = {
    id: 'docs:retained-one',
    module: 'docs',
    ownerKey: 'main-owned-view',
    source: 'main-source',
    generation: 4,
    token: '11111111-1111-4111-8111-111111111111',
    documentPath: '/documents/Report.docx',
    phase: 'retained',
    updatedAt: '2026-10-30T07:00:00.000Z',
    custody: true,
    capturedEntry: {
      module: 'docs',
      documentPath: '/documents/Report.docx',
      sha256: 'a'.repeat(64),
    },
    custodyReceipt: { privateProof: 'never-send-to-renderer' },
  }
  const rows = new Map([[status.id, status]])
  const prepared = {
    destination: '/physical/Recovered.docx',
    commitHandoff: vi.fn((action: () => boolean) => action()),
    cancel: vi.fn(),
  }
  const dependencies = {
    list: () => [...rows.values()],
    get: (id: string) => rows.get(id),
    capabilities: () => ({ restore: true, remove: true, retry: false }),
    prepare: vi.fn(async () => prepared),
    remove: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    keep: vi.fn(),
  }
  const controller = createRetainedRecoveryController(dependencies)
  return {
    status,
    rows,
    prepared,
    dependencies,
    controller,
    selection: { id: status.id, updatedAt: status.updatedAt },
  }
}

describe('selected retained recovery operations', () => {
  it('projects useful filenames without exposing journal tokens or private proofs', () => {
    const { controller } = fixture()
    const result = controller.list()
    expect(result.items[0]).toMatchObject({
      fileName: 'Report.docx',
      canRestore: true,
      state: 'needs-review',
    })
    expect(JSON.stringify(result)).not.toMatch(
      /main-owned-view|main-source|11111111|privateProof|never-send|sha256/,
    )
  })

  it('rejects caller-supplied paths and cleanup grants before invoking any operation', async () => {
    const { controller, selection, dependencies } = fixture()
    for (const extra of [{ documentPath: '/other.docx' }, { token: 'forged' }, { module: 'pdf' }]) {
      await expect(controller.remove({ ...selection, ...extra })).rejects.toThrow(
        'valid recovery item',
      )
    }
    expect(dependencies.remove).not.toHaveBeenCalled()
  })

  it('refuses a stale row even when its identifier is unchanged', async () => {
    const { controller, status, selection, dependencies } = fixture()
    status.updatedAt = '2026-10-30T07:00:01.000Z'
    await expect(controller.remove(selection)).rejects.toThrow('changed')
    expect(dependencies.remove).not.toHaveBeenCalled()
  })

  it('rechecks the selected record after the save dialog awaits', async () => {
    const { controller, status, selection, dependencies } = fixture()
    await expect(
      controller.recover(selection, async () => {
        status.updatedAt = '2026-10-30T07:00:02.000Z'
        return '/alias/Recovered.docx'
      }),
    ).rejects.toThrow('changed')
    expect(dependencies.prepare).not.toHaveBeenCalled()
  })

  it('hands over the verified physical destination rather than a mutable selected alias', async () => {
    const { controller, selection, prepared, dependencies, status } = fixture()
    await expect(
      controller.recover(selection, async () => '/alias/Recovered.docx'),
    ).resolves.toEqual({ path: '/physical/Recovered.docx', module: 'docs' })
    expect(dependencies.prepare).toHaveBeenCalledWith(status, '/alias/Recovered.docx')
    expect(prepared.commitHandoff).toHaveBeenCalledTimes(1)
    expect(prepared.cancel).not.toHaveBeenCalled()
  })

  it('cancels a refused handoff and does not report a recovered copy', async () => {
    const { controller, selection, prepared } = fixture()
    prepared.commitHandoff.mockImplementation(() => false)
    await expect(controller.recover(selection, async () => '/new.docx')).rejects.toThrow(
      'needs review',
    )
    expect(prepared.cancel).toHaveBeenCalledTimes(1)
  })

  it('leaves storage alone when the save dialog is canceled', async () => {
    const { controller, selection, dependencies } = fixture()
    await expect(controller.recover(selection, async () => null)).resolves.toBeNull()
    expect(dependencies.prepare).not.toHaveBeenCalled()
    expect(dependencies.remove).not.toHaveBeenCalled()
  })

  it('refuses removal and restoration while a previous output needs review', async () => {
    const { controller, status, selection, dependencies } = fixture()
    status.restoration = {
      id: '22222222-2222-4222-8222-222222222222',
      destination: '/user/kept.docx',
      phase: 'uncertain',
      created: true,
    }
    expect(controller.list().items[0]).toMatchObject({
      canRemove: false,
      canRestore: false,
      pendingOutput: { path: '/user/kept.docx' },
    })
    await expect(controller.remove(selection)).rejects.toThrow('still in use')
    expect(() => controller.keep(selection, 'other-output')).toThrow('changed')
    controller.keep(selection, status.restoration.id)
    expect(dependencies.keep).toHaveBeenCalledWith(status, status.restoration.id)
    expect(dependencies.remove).not.toHaveBeenCalled()
  })

  it('does not offer removal for a status-only failure without an app-owned repair', async () => {
    const { controller, status, selection, dependencies } = fixture()
    status.custody = false
    delete status.capturedEntry
    dependencies.capabilities = () => ({ restore: false, remove: false, retry: true })
    expect(controller.list().items[0]).toMatchObject({
      canRestore: false,
      canRemove: false,
      canRetry: true,
    })
    await expect(controller.remove(selection)).rejects.toThrow('separate repair')
    await controller.retry(selection)
    expect(dependencies.retry).toHaveBeenCalledWith(status)
  })

  it('bounds and orders the public list and excludes already-purged records', () => {
    const { controller, status, rows } = fixture()
    rows.clear()
    for (let i = 0; i < 258; i++)
      rows.set(`row:${i}`, {
        ...status,
        id: `row:${i}`,
        updatedAt: new Date(Date.UTC(2026, 9, 30, 0, 0, i)).toISOString(),
      })
    rows.set('purged', {
      ...status,
      id: 'purged',
      phase: 'purged',
      updatedAt: '2027-01-01T00:00:00.000Z',
    })
    const result = controller.list()
    expect(result.items).toHaveLength(256)
    expect(result.truncated).toBe(true)
    expect(result.items[0].id).toBe('row:257')
    expect(result.items.some((row) => row.id === 'purged')).toBe(false)
  })
})
