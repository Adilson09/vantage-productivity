import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  list: vi.fn(), get: vi.fn(), prepare: vi.fn(), prepareProvider: vi.fn(), retire: vi.fn(), keep: vi.fn(), activity: vi.fn(),
  provider: vi.fn(), dialog: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) },
  dialog: { showSaveDialog: mocks.dialog },
}))
vi.mock('../../../packages/electron-utils/src/close-cleanup-runtime', () => ({
  getCloseCleanupStatus: mocks.get, queryCloseCleanupCustody: mocks.list,
  prepareCloseCleanupRestore: mocks.prepare, prepareProviderCloseCleanupRestore: mocks.prepareProvider,
  beginRetireCloseCleanupCustody: mocks.retire, getCloseCleanupRetirementActivity: mocks.activity,
  acknowledgeCloseCleanupRestoreArtifact: mocks.keep,
}))
vi.mock('../../../packages/electron-utils/src/close-custody-providers', () => ({ registeredCloseCustodyProvider: mocks.provider }))

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.handlers.clear() })
async function setup(unlock = vi.fn(async () => {})) {
  const { registerRetainedRecoveryIpc } = await import('../src/main/retained-recovery-ipc')
  const { VANTAGE_CHANNELS } = await import('../src/shared/vantage-api')
  const status = { id: 'docs:one', module: 'docs', ownerKey: 'main', source: 'source', generation: 1, token: '11111111-1111-4111-8111-111111111111', documentPath: '/user/Report.docx', phase: 'retained', updatedAt: '2026-10-30T07:00:00.000Z', custody: true, capturedEntry: { module: 'docs', documentPath: '/user/Report.docx', sha256: 'a'.repeat(64) } }
  mocks.list.mockImplementation((filter: { module: string }) => filter.module === status.module ? [status] : [])
  mocks.get.mockImplementation((id: string) => id === status.id ? status : undefined)
  mocks.retire.mockImplementation(() => ({ ready: Promise.resolve(), actualSettled: Promise.resolve() }))
  mocks.activity.mockReturnValue({ busy: false, retryable: false })
  let authorized = true
  const hostFor = vi.fn(() => { if (!authorized) throw new Error('This window no longer owns a workspace.'); return {} as never })
  registerRetainedRecoveryIpc(hostFor, unlock)
  const call = (key: keyof typeof VANTAGE_CHANNELS, ...args: unknown[]) => mocks.handlers.get(VANTAGE_CHANNELS[key])!({}, ...args)
  return { call, status, selection: { id: status.id, updatedAt: status.updatedAt }, unlock, revoke: () => { authorized = false } }
}

describe('retained recovery IPC ownership and unlock boundary', () => {
  it('disables removal while a timed-out purge is actually active and permits a failed settled retry', async () => {
    const { call, selection } = await setup()
    mocks.activity.mockReturnValue({ busy: true, retryable: false })
    await expect(call('retainedRecoveryList')).resolves.toMatchObject({ items: [{ canRemove: false, canRestore: false }] })
    await expect(call('removeRetainedCopy', selection)).rejects.toThrow('still in use')
    expect(mocks.retire).not.toHaveBeenCalled()
    mocks.activity.mockReturnValue({ busy: false, retryable: true, error: 'Checked removal failed' })
    await expect(call('retainedRecoveryList')).resolves.toMatchObject({ items: [{ canRemove: true }] })
    await call('removeRetainedCopy', selection)
    expect(mocks.retire).toHaveBeenCalledTimes(1)
  })

  it('lists and removes a selected raw custody item even when recovery cannot unlock', async () => {
    const unlock = vi.fn(async () => { throw new Error('Recovery key is locked') })
    const { call, selection } = await setup(unlock)
    await expect(call('retainedRecoveryList')).resolves.toMatchObject({ items: [{ id: 'docs:one' }] })
    await call('removeRetainedCopy', selection)
    expect(mocks.retire).toHaveBeenCalledWith({ module: 'docs', ids: ['docs:one'] }, expect.any(String))
    expect(unlock).not.toHaveBeenCalled()
  })

  it('requires successful unlock before choosing or publishing a recovered copy', async () => {
    const unlock = vi.fn(async () => { throw new Error('Recovery key is locked') })
    const { call, selection } = await setup(unlock)
    await expect(call('recoverRetainedCopy', selection)).rejects.toThrow('key is locked')
    expect(mocks.dialog).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('does not let an unauthorized sender inspect or mutate retained storage', async () => {
    const { call, selection, revoke } = await setup()
    revoke()
    await expect(call('retainedRecoveryList')).rejects.toThrow('no longer owns')
    await expect(call('removeRetainedCopy', selection)).rejects.toThrow('no longer owns')
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.retire).not.toHaveBeenCalled()
  })

  it('rechecks host ownership after recovery unlock settles', async () => {
    let resolve!: () => void
    const unlock = vi.fn(() => new Promise<void>(done => { resolve = done }))
    const { call, selection, revoke } = await setup(unlock)
    const result = call('recoverRetainedCopy', selection)
    revoke(); resolve()
    await expect(result).rejects.toThrow('no longer owns')
    expect(mocks.dialog).not.toHaveBeenCalled()
  })

  it('can acknowledge an output without decrypting or deleting its user-owned file', async () => {
    const { call, selection, status, unlock } = await setup()
    Object.assign(status, { restoration: { id: 'output:one', destination: '/user/Copy.docx', phase: 'uncertain', created: true } })
    await call('keepRetainedOutput', selection, 'output:one')
    expect(mocks.keep).toHaveBeenCalledWith('docs:one', 'output:one')
    expect(unlock).not.toHaveBeenCalled()
    expect(mocks.retire).not.toHaveBeenCalled()
  })
})
