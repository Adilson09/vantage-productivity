import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureRecoveryProfile, createRecoveryBootstrap } from '../src/recovery-bootstrap'
import type { CloseCleanupStatus } from '../src/close-cleanup'

const path = join(tmpdir(), 'reserved-recovery-bootstrap-profile')
type Register = Parameters<typeof createRecoveryBootstrap>[0]['register']
function fixture(register: Register = vi.fn()) {
  let profile = path
  const app = { getPath: () => profile, on: vi.fn(), quit: vi.fn(), whenReady: async () => {} }
  const gate = createRecoveryBootstrap({ register })
  const options = { app, userDataRoot: path, mode: 'gui' as const, lockAcquired: true }
  return { gate, register, options, changeProfile: () => { profile = join(tmpdir(), 'different-profile') } }
}
describe('profile-bound recovery runtime admission', () => {
  it('registers exactly once for the configured GUI profile and reuses duplicate editor requests', () => {
    const f = fixture()
    expect(f.gate.initialize(f.options).phase).toBe('ready')
    expect(f.gate.initialize(f.options).phase).toBe('ready')
    expect(f.register).toHaveBeenCalledTimes(1)
    expect(() => f.gate.require('Custody-required close')).not.toThrow()
  })
  it('a losing instance never initializes storage or installs quit ownership', () => {
    const f = fixture()
    expect(f.gate.initialize({ ...f.options, lockAcquired: false }).available).toBe(false)
    expect(f.register).not.toHaveBeenCalled()
    expect(() => f.gate.require()).toThrow(/refused/)
    expect(f.gate.initialize(f.options).available).toBe(true)
  })
  it('corrupt/unavailable custody storage keeps workspace startup alive but refuses dependent close/copy', () => {
    const f = fixture(vi.fn(() => { throw new Error('reserved corrupt fixture') }))
    expect(() => f.gate.initialize(f.options)).not.toThrow()
    expect(f.gate.state().phase).toBe('unavailable')
    expect(() => f.gate.require('Close requiring custody')).toThrow(/refused/)
    f.gate.initialize(f.options)
    expect(f.register).toHaveBeenCalledTimes(1) // sticky; no duplicate partial listeners
    expect(f.gate.state().message).not.toContain('reserved corrupt fixture')
  })
  it('refuses preexisting out-of-bootstrap runtime rather than changing its profile/warning owner', () => {
    const register = vi.fn(), gate = createRecoveryBootstrap({ register, preinitialized: () => true }), f = fixture()
    expect(gate.initialize(f.options).phase).toBe('unavailable')
    expect(register).not.toHaveBeenCalled()
  })
  it('a later profile change disables new operations without reinitializing old quit-owned work', () => {
    const f = fixture(); f.gate.initialize(f.options); f.changeProfile()
    expect(f.gate.state().available).toBe(false)
    expect(() => f.gate.require()).toThrow(/refused/)
    expect(f.register).toHaveBeenCalledTimes(1)
  })
  it('headless keeps required handlers possible while recovery stays disabled with no storage registration', () => {
    const f = fixture()
    expect(f.gate.initialize({ ...f.options, mode: 'headless-export', lockAcquired: false }).phase).toBe('disabled')
    expect(f.register).not.toHaveBeenCalled()
    expect(() => f.gate.require('Journal')).toThrow(/export process/)
  })
  it('does not falsely certify an isolated export when another caller already initialized recovery', () => {
    const register = vi.fn(), gate = createRecoveryBootstrap({ register, preinitialized: () => true }), f = fixture()
    expect(gate.initialize({ ...f.options, mode: 'headless-export', lockAcquired: false }).phase).toBe('unavailable')
    expect(register).not.toHaveBeenCalled()
  })
  it('headless ignores inherited GUI profile/auth paths and configures isolated children before handlers', () => {
    const scratch = join(tmpdir(), 'reserved-isolated-export-profile'), order: string[] = []
    const env: Record<string, string | undefined> = { VANTAGE_USER_DATA: path, VANTAGE_RECOVERY_ROOT: join(path, 'recovery') }
    const app = { getPath: () => path, setPath: (_name: 'userData', value: string) => { order.push('profile:' + value) } }
    const selected = configureRecoveryProfile({ app, mode: 'headless-export', guiProfile: path, environment: env,
      io: { temporary: () => scratch, ensure: value => order.push('directory:' + value) } })
    expect(selected.userDataRoot).toBe(scratch)
    expect(env.VANTAGE_USER_DATA).toBe(scratch); expect(env.VANTAGE_RECOVERY_ROOT).toBe(join(scratch, 'recovery'))
    expect(env.VANTAGE_RECOVERY_MODE).toBe('disabled-headless')
    expect(order).toEqual(['directory:' + scratch, 'profile:' + scratch])
  })
  it('queues before a host exists, retains failed delivery, bounds repeats and exposes persistent unavailability', () => {
    const f = fixture(vi.fn(() => { throw new Error('fixture') })); f.gate.initialize(f.options)
    const early = vi.fn(() => false); f.gate.flushWarnings(early)
    expect(f.gate.state().warningCount).toBe(1)
    const received: string[] = []; f.gate.flushWarnings(message => { received.push(message); return true })
    expect(received).toHaveLength(1); expect(f.gate.state().warningCount).toBe(0)
    expect(f.gate.state().phase).toBe('unavailable')
    for (let i = 0; i < 100; i++) f.gate.warn('same-warning', 'repeat')
    expect(f.gate.state().warningCount).toBe(1)
    for (let i = 0; i < 50; i++) f.gate.warn('fixture-' + i, 'bounded')
    expect(f.gate.state().warningCount).toBe(32)
  })
  it('cleanup warnings contain public scope only and do not expose private paths/tokens/errors', () => {
    let warning!: (status: CloseCleanupStatus) => void
    const f = fixture(vi.fn((options: Parameters<Register>[0]) => { warning = options.warning })); f.gate.initialize(f.options)
    warning({ module: 'pdf', error: 'reserved-secret-value', token: 'reserved-token', documentPath: path } as CloseCleanupStatus)
    const delivered: string[] = []; f.gate.flushWarnings(message => { delivered.push(message); return true })
    expect(delivered[0]).toContain('pdf recovery')
    expect(delivered[0]).not.toContain(path); expect(delivered[0]).not.toContain('reserved-secret-value'); expect(delivered[0]).not.toContain('reserved-token')
  })
})
