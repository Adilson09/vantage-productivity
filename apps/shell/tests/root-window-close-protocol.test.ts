import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: new EventEmitter() }))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())
it('the actual window guard collects every clean view before synchronous seal and exact removal', async () => {
  const { installShellCloseGuard } = await import('../src/main/window-close-guard')
  const { registerRootCloseAdapter } = await import('../src/main/root-close-adapters')
  const { rootQuitIntent } = await import('../src/main/root-quit-intent')
  const show = vi.fn(),
    resetSheets = vi.fn(),
    resetShell = vi.fn()
  rootQuitIntent.configure({
    cancelMcp: () => {},
    cancelCleanup: () => {},
    resetSheets,
    resetShell,
    revealWorkspace: show,
    report: () => {},
  })
  const second = deferred(),
    order: string[] = [],
    wcA = { isDestroyed: () => false },
    wcB = { isDestroyed: () => false }
  const tabs = [
    { id: 'a', kind: 'docs', webContents: wcA },
    { id: 'b', kind: 'sheets', webContents: wcB },
  ]
  const adapter = (name: string, wait?: Promise<void>) => ({
    prepare: async (
      _wc: unknown,
      _parent: unknown,
      options: { deferSeal?: boolean; isCurrent?: () => boolean; signal?: AbortSignal },
    ) => {
      order.push(`prepare ${name}`)
      if (wait) await wait
      if (!options.isCurrent?.() || options.signal?.aborted) return null
      return { phase: 'prepared' as const, options, valid: true }
    },
    isPrepared: (_wc: unknown, receipt: { valid: boolean }) => receipt.valid,
    seal: (_wc: unknown, receipt: { phase: string; valid: boolean }) => {
      order.push(`seal ${name}`)
      return { ...receipt, phase: 'ready' as const }
    },
    complete: (_wc: unknown, receipt: { valid: boolean }, remove: () => boolean) =>
      receipt.valid && remove(),
    cancel: (_wc: unknown, receipt: { valid: boolean }) => {
      receipt.valid = false
    },
  })
  registerRootCloseAdapter('docs', adapter('docs') as never)
  registerRootCloseAdapter('sheets', adapter('sheets', second.promise) as never)
  const win = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    destroy() {
      this.destroyed = true
      order.push('destroy')
    },
  })
  const manager = { closeGuardTabs: () => tabs, activateTab: vi.fn() }
  const tracker = {
    quitting: () => false,
    hold: vi.fn(),
    release: vi.fn(),
    reset: vi.fn(),
    quit: vi.fn(),
  }
  installShellCloseGuard(win as never, manager as never, tracker)
  const preventDefault = vi.fn()
  win.emit('close', { preventDefault })
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(8_000)
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(order).toEqual(['prepare docs', 'prepare sheets'])
  expect(win.destroyed).toBe(false)
  second.resolve()
  for (let i = 0; i < 25; i++) await Promise.resolve()
  expect(order).toEqual(['prepare docs', 'prepare sheets', 'seal docs', 'seal sheets', 'destroy'])
  expect(win.destroyed).toBe(true)
  expect(show).not.toHaveBeenCalled()
  expect(resetSheets).toHaveBeenCalled()
})
it('the actual window guard cancels both service retries on a later family veto', async () => {
  const { installShellCloseGuard } = await import('../src/main/window-close-guard')
  const { registerRootCloseAdapter } = await import('../src/main/root-close-adapters')
  const { rootQuitIntent } = await import('../src/main/root-quit-intent')
  const cancelMcp = vi.fn(),
    cancelCleanup = vi.fn(),
    resetSheets = vi.fn(),
    resetShell = vi.fn(),
    show = vi.fn()
  rootQuitIntent.configure({
    cancelMcp,
    cancelCleanup,
    resetSheets,
    resetShell,
    revealWorkspace: show,
    report: () => {},
  })
  const cancel = vi.fn()
  registerRootCloseAdapter('docs', {
    prepare: async () => ({ phase: 'prepared' }),
    isPrepared: () => true,
    seal: () => ({ phase: 'ready' }),
    complete: (_w, _r, close) => close(),
    cancel,
  })
  registerRootCloseAdapter('sheets', {
    prepare: async () => null,
    isPrepared: () => false,
    seal: () => null,
    complete: () => false,
    cancel: () => {},
  })
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, destroy: vi.fn() })
  const tabs = [
    { id: 'a', kind: 'docs', webContents: { isDestroyed: () => false } },
    { id: 'b', kind: 'sheets', webContents: { isDestroyed: () => false } },
  ]
  const manager = { closeGuardTabs: () => tabs, activateTab: vi.fn() }
  const tracker = {
    quitting: () => true,
    hold: vi.fn(),
    release: vi.fn(),
    reset: vi.fn(),
    quit: vi.fn(),
  }
  installShellCloseGuard(win as never, manager as never, tracker)
  win.emit('close', { preventDefault: vi.fn() })
  for (let i = 0; i < 25; i++) await Promise.resolve()
  expect(win.destroy).not.toHaveBeenCalled()
  expect(tracker.quit).not.toHaveBeenCalled()
  expect(cancelMcp).toHaveBeenCalledOnce()
  expect(cancelCleanup).toHaveBeenCalledOnce()
  expect(resetShell).toHaveBeenCalledOnce()
  expect(show).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalled()
})
