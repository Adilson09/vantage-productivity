import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'

const fake = vi.hoisted(() => ({
  phase: 'ready',
  messages: [] as string[],
  listeners: new Set<() => void>(),
  initialize: vi.fn(),
  require: vi.fn(),
  order: [] as string[],
}))
vi.mock('../../../packages/electron-utils/src/recovery-bootstrap', () => ({
  initializeRecoveryRuntime: (...args: unknown[]) => {
    fake.order.push('foundation')
    fake.initialize(...args)
    return {
      phase: fake.phase,
      available: fake.phase === 'ready',
      message: 'Public recovery unavailable',
      warningCount: fake.messages.length,
    }
  },
  recoveryRuntimeState: () => ({
    phase: fake.phase,
    available: fake.phase === 'ready',
    message: 'Public recovery unavailable',
    warningCount: fake.messages.length,
  }),
  requireRecoveryRuntime: () => {
    fake.require()
    if (fake.phase !== 'ready') throw new Error('Recovery-dependent action refused')
  },
  queueRecoveryWarning: (_id: string, message: string) => {
    fake.messages.push(message)
    for (const listener of fake.listeners) listener()
  },
  flushRecoveryWarnings: (deliver: (message: string) => boolean) => {
    while (fake.messages.length && deliver(fake.messages[0]!)) fake.messages.shift()
  },
  onRecoveryRuntimeState: (listener: () => void) => {
    fake.listeners.add(listener)
    return () => fake.listeners.delete(listener)
  },
}))
import {
  initializeShellRecovery,
  registerRecoveryRuntimeIpc,
  type RecoveryMaintenance,
} from '../src/main/recovery-runtime-bootstrap'

beforeEach(() => {
  fake.phase = 'ready'
  fake.messages = []
  fake.listeners.clear()
  fake.order = []
  fake.initialize.mockReset()
  fake.require.mockReset()
})
const warn = (message: string) => {
  fake.messages.push(message)
  for (const listener of fake.listeners) listener()
}
function hostFixture() {
  let loading = false,
    navigation!: (...args: unknown[]) => void,
    terminal!: () => void
  const send = vi.fn(),
    frame = {}
  const contents = {
    mainFrame: frame,
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    send,
    on: vi.fn((_name: string, callback: (...args: unknown[]) => void) => {
      navigation = callback
    }),
    removeListener: vi.fn(),
  } as unknown as WebContents
  const host = { isDestroyed: () => false, webContents: contents } as BrowserWindow
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
  registerRecoveryRuntimeIpc({
    ipc: {
      handle: (name, handler) => {
        handlers.set(name, handler)
      },
    },
    getHost: () => host,
    hostFor: (event) => {
      if (event.sender !== contents) throw new Error('Wrong workspace')
      return host
    },
    terminal: (callback) => {
      terminal = callback
    },
  })
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  return {
    send,
    contents,
    event,
    query: (value = event) => handlers.get('vantage:recovery-runtime-status')!(value),
    navigation: () => navigation({}, 'vantage://root', false, true),
    loading: (value: boolean) => {
      loading = value
    },
    terminal: () => terminal(),
  }
}
describe('concrete Root recovery startup/IPC', () => {
  it('registers selected PDF checked maintenance after foundation and inspects without blocking ordinary startup', async () => {
    let maintenance!: RecoveryMaintenance
    const ready = initializeShellRecovery({
      app: {} as never,
      userDataRoot: 'reserved-profile',
      lockAcquired: true,
      registerMaintenance: (value) => {
        fake.order.push('maintenance')
        maintenance = value
      },
      inspectPdf: async () => {
        fake.order.push('inspection')
      },
      retryPdf: vi.fn(),
    })
    expect(fake.order).toEqual(['foundation', 'maintenance'])
    await ready.inspection
    expect(fake.order).toEqual(['foundation', 'maintenance', 'inspection'])
    expect(
      maintenance.matches({
        module: 'pdf',
        id: 'pdf-private:66959647-a295-4db7-9f19-1108cd4ed012',
      } as never),
    ).toBe(true)
    expect(
      maintenance.matches({
        module: 'docs',
        id: 'pdf-private:66959647-a295-4db7-9f19-1108cd4ed012',
      } as never),
    ).toBe(false)
    expect(maintenance.matches({ module: 'pdf', id: '../../arbitrary.pdf' } as never)).toBe(false)
  })
  it('unavailable foundation never invokes PDF private inspection or offers unchecked maintenance', async () => {
    fake.phase = 'unavailable'
    const inspect = vi.fn(),
      register = vi.fn()
    const result = initializeShellRecovery({
      app: {} as never,
      userDataRoot: 'reserved-profile',
      lockAcquired: true,
      registerMaintenance: register,
      inspectPdf: inspect,
      retryPdf: vi.fn(),
    })
    await result.inspection
    expect(result.state.available).toBe(false)
    expect(inspect).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })
  it('PDF inventory failure queues a public warning without disabling unrelated workspace/recovery', async () => {
    const result = initializeShellRecovery({
      app: {} as never,
      userDataRoot: 'reserved-profile',
      lockAcquired: true,
      registerMaintenance: () => {},
      inspectPdf: async () => {
        throw new Error('private reserved filename')
      },
      retryPdf: vi.fn(),
    })
    await result.inspection
    expect(result.state.available).toBe(true)
    expect(fake.messages.join()).toContain('could not be inspected')
    expect(fake.messages.join()).not.toContain('private reserved filename')
  })
  it('retains warnings until authenticated preload subscribes and replays after navigation', () => {
    const f = hostFixture()
    warn('Before renderer listener')
    expect(f.send).not.toHaveBeenCalled()
    f.query()
    expect(f.send).toHaveBeenCalledWith('vantage:save-warning', 'Before renderer listener')
    f.navigation()
    warn('After reload before listener')
    expect(fake.messages).toEqual(['After reload before listener'])
    f.query()
    expect(f.send).toHaveBeenLastCalledWith('vantage:save-warning', 'After reload before listener')
    f.terminal()
    warn('After terminal teardown')
    expect(fake.messages).toEqual(['After terminal teardown'])
  })
  it('rejects editor/subframe status requests and exposes unavailable state persistently', () => {
    const f = hostFixture()
    fake.phase = 'unavailable'
    expect(() => f.query({ ...f.event, sender: {} } as IpcMainInvokeEvent)).toThrow(
      /Wrong workspace/,
    )
    expect(() => f.query({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow(
      /main workspace/,
    )
    expect(f.query()).toMatchObject({ phase: 'unavailable', available: false })
    expect(f.send).toHaveBeenCalledWith('vantage:save-warning', 'Public recovery unavailable')
  })
})
