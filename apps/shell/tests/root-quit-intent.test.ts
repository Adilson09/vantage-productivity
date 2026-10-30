import { describe, expect, it, vi } from 'vitest'
import { RootQuitIntent } from '../src/main/root-quit-intent'
describe('common Root quit cancellation', () => {
  it('invalidates all retry permissions exactly once even when MCP interruption reenters', () => {
    let intent!: RootQuitIntent
    const writer = { pending: true },
      order: string[] = []
    const hooks = {
      cancelMcp: vi.fn(() => {
        order.push('mcp')
        intent.cancel('MCP interrupted')
      }),
      cancelCleanup: vi.fn(() => order.push('cleanup')),
      resetSheets: vi.fn(() => order.push('sheets')),
      resetShell: vi.fn(() => order.push('shell')),
      revealWorkspace: vi.fn(() => order.push('show')),
      report: vi.fn(),
    }
    intent = new RootQuitIntent(hooks)
    const old = intent.capture(),
      listener = vi.fn(() => order.push('leaf'))
    intent.subscribe(listener)
    intent.cancel('Return to workspace')
    expect(intent.current(old)).toBe(false)
    expect(order).toEqual(['mcp', 'cleanup', 'sheets', 'shell', 'leaf', 'show'])
    expect(hooks.cancelMcp).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(writer.pending).toBe(true)
  })
  it('attempts every guard reset after a failing cancellation hook and permits a future explicit quit', () => {
    const cancelMcp = vi.fn(() => {
        throw new Error('service unavailable')
      }),
      cancelCleanup = vi.fn(),
      resetSheets = vi.fn(),
      resetShell = vi.fn(),
      show = vi.fn(),
      report = vi.fn()
    const intent = new RootQuitIntent({
      cancelMcp,
      cancelCleanup,
      resetSheets,
      resetShell,
      revealWorkspace: show,
      report,
    })
    const old = intent.capture()
    intent.cancel('native Sheets veto')
    expect(intent.current(old)).toBe(false)
    expect(cancelCleanup).toHaveBeenCalledOnce()
    expect(resetSheets).toHaveBeenCalledOnce()
    expect(resetShell).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledOnce()
    const later = intent.capture()
    intent.beginApproval()
    expect(resetSheets).toHaveBeenCalledTimes(2)
    expect(intent.current(later)).toBe(true)
  })
  it('a late family refusal cancels both cleanup and MCP drain retries without changing actual ownership', async () => {
    let resolve!: () => void
    const actual = new Promise<void>((done) => {
      resolve = done
    })
    let mcpEpoch = 0,
      cleanupEpoch = 0,
      retries = 0,
      actualSettled = false
    const intent = new RootQuitIntent({
      cancelMcp: () => {
        ++mcpEpoch
      },
      cancelCleanup: () => {
        ++cleanupEpoch
      },
      resetSheets: () => {},
      resetShell: () => {},
      revealWorkspace: () => {},
      report: () => {},
    })
    const a = mcpEpoch,
      b = cleanupEpoch
    void actual.then(() => {
      actualSettled = true
      if (a === mcpEpoch) ++retries
      if (b === cleanupEpoch) ++retries
    })
    intent.cancel('later PDF close declined')
    expect(actualSettled).toBe(false)
    resolve()
    await actual
    await Promise.resolve()
    expect(retries).toBe(0)
    expect(actualSettled).toBe(true)
  })
})

it('a physical move cancels older approval and blocks new close until native path refresh actually settles', () => {
  const intent = new RootQuitIntent(),
    old = intent.capture(),
    release = intent.beginMutation('file moved')
  expect(intent.current(old)).toBe(false)
  const during = intent.capture()
  expect(intent.current(during)).toBe(false)
  expect(() => intent.beginMutation('overlapping file move')).toThrow('file move')
  release()
  expect(intent.current(during)).toBe(true)
  release()
  expect(intent.current(during)).toBe(true)
})
