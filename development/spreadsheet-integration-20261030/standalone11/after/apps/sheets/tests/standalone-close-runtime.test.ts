import { describe, expect, it, vi } from 'vitest'
import {
  createStandaloneSheetsCloseRuntimeInitializer,
  type StandaloneSheetsCloseRuntimeOptions,
} from '../src/main/standalone-close-runtime'
import {
  installSheetsCloseQuitGuard,
  SheetsCloseQuitLedger,
  SheetsProtectedRetirementBlockedError,
  type SheetsBeforeQuitEvent,
} from '../../shell/src/main/sheets-close-quit-ledger'
import type { SheetsCloseRuntimeInstallationOptions } from '../../shell/src/main/sheets-close-runtime'

// Startup order and host cancellation are exercised without Electron/Main or
// shared recovery initialization. Production adapters are injected below.
vi.mock('../../shell/src/main/sheets-close-runtime', () => ({ installSheetsCloseRuntime: vi.fn() }))
vi.mock('../../../packages/electron-utils/src/close-cleanup-runtime', () => ({ cancelCloseCleanupQuitDrain: vi.fn() }))

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function flush() { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }

class TestApp {
  readonly listeners: ((event: SheetsBeforeQuitEvent) => void)[] = []
  readonly events: { prevented: boolean; preventDefault(): void }[] = []
  on(_name: 'before-quit', listener: (event: SheetsBeforeQuitEvent) => void): this {
    this.listeners.push(listener); return this
  }
  removeListener(_name: 'before-quit', listener: (event: SheetsBeforeQuitEvent) => void): this {
    const index = this.listeners.indexOf(listener)
    if (index !== -1) this.listeners.splice(index, 1)
    return this
  }
  quit(): void {
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    this.events.push(event)
    for (const listener of [...this.listeners]) listener(event)
  }
}

function fixture() {
  const events: string[] = []
  const app = new TestApp()
  const initializeShared = vi.fn(() => { events.push('shared') })
  const startEditors = vi.fn(() => { events.push('editors') })
  const resetShutdown = vi.fn()
  const warning = vi.fn()
  const onBlocked = vi.fn<StandaloneSheetsCloseRuntimeOptions['onBlocked']>()
  const setRuntime = vi.fn((_runtime: Parameters<StandaloneSheetsCloseRuntimeOptions['setRuntime']>[0]) => { events.push('setter') })
  const closeState = vi.fn(() => null)
  const createLedger = vi.fn((options: { report(error: unknown): void }) => {
    events.push('ledger'); return new SheetsCloseQuitLedger(options)
  })
  const installGuard = vi.fn<typeof installSheetsCloseQuitGuard>((...args) => {
    events.push('guard'); return installSheetsCloseQuitGuard(...args)
  })
  const installRuntime = vi.fn((options: SheetsCloseRuntimeInstallationOptions) => {
    events.push('native-runtime')
    // Native provider/observer installation is covered by its own adapter
    // tests. This fixture only records the actual startup/setter boundary.
    options.setRuntime({} as Parameters<StandaloneSheetsCloseRuntimeOptions['setRuntime']>[0])
  })
  const cancelShared = vi.fn()
  const initialize = createStandaloneSheetsCloseRuntimeInitializer({
    createLedger, installGuard, installRuntime, cancelSharedQuitDrain: cancelShared,
  })
  const options: StandaloneSheetsCloseRuntimeOptions = {
    mode: 'gui', lockAcquired: true, app, setRuntime, closeState,
    initializeShared, startEditors, resetShutdown, warning, onBlocked,
  }
  return { initialize, options, app, events, initializeShared, startEditors, resetShutdown, warning,
    onBlocked, setRuntime, closeState, createLedger, installGuard, installRuntime, cancelShared }
}

describe('standalone Sheets close runtime startup', () => {
  it.each([
    { mode: 'headless-export' as const, lockAcquired: true },
    { mode: 'headless-export' as const, lockAcquired: false },
    { mode: 'gui' as const, lockAcquired: false },
  ])('performs no GUI/runtime initialization for $mode with lock=$lockAcquired', mode => {
    const f = fixture()
    expect(f.initialize({ ...f.options, ...mode })).toBeNull()
    expect(f.events).toEqual([])
    for (const operation of [f.initializeShared, f.createLedger, f.installGuard, f.installRuntime,
      f.setRuntime, f.startEditors, f.cancelShared, f.resetShutdown, f.warning])
      expect(operation).not.toHaveBeenCalled()
    expect(f.app.listeners).toEqual([])
  })

  it('installs shared recovery, memory quit guard and native runtime before editor services', () => {
    const f = fixture()
    const control = f.initialize(f.options)
    expect(control).not.toBeNull()
    expect(f.events).toEqual(['shared', 'ledger', 'guard', 'native-runtime', 'setter', 'editors'])
    expect(f.installRuntime).toHaveBeenCalledExactlyOnceWith({
      ledger: control!.ledger, setRuntime: f.setRuntime, closeState: f.closeState,
    })
    expect(f.warning).not.toHaveBeenCalled()
    expect(f.initialize(f.options)).toBe(control)
    expect(f.startEditors).toHaveBeenCalledTimes(1)
    expect(f.installGuard).toHaveBeenCalledTimes(1)
  })

  it('keeps GUI startup available after shared bootstrap failure and reports only a generic warning', () => {
    const f = fixture()
    f.initializeShared.mockImplementationOnce(() => { f.events.push('shared'); throw new Error('synthetic private bootstrap detail') })
    expect(f.initialize(f.options)).not.toBeNull()
    expect(f.events).toEqual(['shared', 'ledger', 'guard', 'native-runtime', 'setter', 'editors'])
    expect(f.warning).toHaveBeenCalledWith('Spreadsheet recovery could not be initialized. Close checks may be unavailable.')
    expect(JSON.stringify(f.warning.mock.calls)).not.toContain('synthetic private bootstrap detail')
  })

  it('does not expose a runtime if quit-guard installation failed, but still starts the GUI', () => {
    const f = fixture()
    f.installGuard.mockImplementationOnce(() => { throw new Error('synthetic guard error') })
    expect(f.initialize(f.options)).not.toBeNull()
    expect(f.installRuntime).not.toHaveBeenCalled()
    expect(f.setRuntime).not.toHaveBeenCalled()
    expect(f.startEditors).toHaveBeenCalledTimes(1)
    expect(f.warning).toHaveBeenCalledWith('Spreadsheet close protection could not be initialized. Keep the application open.')
  })

  it('warns and leaves the runtime unset when native installation fails while preserving GUI startup', async () => {
    const f = fixture()
    f.installRuntime.mockImplementationOnce(() => { throw new Error('synthetic private native error') })
    const control = f.initialize(f.options)!
    expect(f.setRuntime).not.toHaveBeenCalled()
    expect(f.startEditors).toHaveBeenCalledTimes(1)
    expect(f.warning).toHaveBeenCalledWith('Spreadsheet close protection could not be installed. Keep the application open.')
    expect(JSON.stringify(f.warning.mock.calls)).not.toContain('synthetic private native error')
    const actual = deferred()
    control.ledger.holdUntilSettled(actual.promise)
    f.app.quit()
    expect(f.app.events[0]?.prevented).toBe(true)
    control.cancel()
    actual.resolve()
    await control.ledger.joinActual()
  })

  it('cancels native and shared quit intentions without abandoning actual work or auto-resuming', async () => {
    const f = fixture(), control = f.initialize(f.options)!, actual = deferred()
    control.ledger.holdUntilSettled(actual.promise)
    f.app.quit()
    expect(f.app.events[0]?.prevented).toBe(true)
    control.cancel()
    expect(f.cancelShared).toHaveBeenCalledTimes(1)
    expect(f.resetShutdown).toHaveBeenCalledTimes(1)
    expect(control.ledger.hasPending()).toBe(true)
    actual.resolve()
    await control.ledger.joinActual(); await flush()
    expect(f.app.events).toHaveLength(1)
  })

  it('cancels failed protected quit and offers exact cleanup retry without reviving that quit', async () => {
    const f = fixture(), control = f.initialize(f.options)!, actual = deferred(), cleanup = deferred()
    const retry = vi.fn(() => cleanup.promise)
    control.ledger.holdProtectedRetirement(actual.promise, retry)
    f.app.quit()
    actual.reject(new Error('synthetic protected detail'))
    await expect(control.ledger.joinActual()).rejects.toBeInstanceOf(SheetsProtectedRetirementBlockedError)
    await flush()
    expect(f.onBlocked).toHaveBeenCalledTimes(1)
    expect(f.cancelShared).toHaveBeenCalledTimes(1)
    expect(f.resetShutdown).toHaveBeenCalledTimes(1)
    const offeredRetry = f.onBlocked.mock.calls[0]![0]
    const retried = offeredRetry()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(control.ledger.hasPending()).toBe(true)
    cleanup.resolve()
    await retried; await flush()
    expect(control.ledger.hasBlockedFailures()).toBe(false)
    expect(f.app.events).toHaveLength(1)
    expect(JSON.stringify(f.warning.mock.calls)).not.toContain('synthetic protected detail')
  })
})
