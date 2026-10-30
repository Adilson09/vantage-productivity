import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocsHeadlessOutputAdmission } from '../src/main/headless-output-admission'

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function flush() { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('headless Docs setup and genuine output settlement', () => {
  it('finishes the main target pin before the renderer may load', async () => {
    const pin = deferred(), order: string[] = [], load = vi.fn()
    const admission = new DocsHeadlessOutputAdmission({
      pin: () => { order.push('pin'); return pin.promise },
      closeAdmission: () => { order.push('closed') },
      awaitSettlement: async () => { order.push('drained') },
    })
    const setup = admission.prepare().then(ready => { if (ready) load() })
    await flush()
    expect(order).toEqual(['pin'])
    expect(load).not.toHaveBeenCalled()
    pin.resolve(); await setup
    expect(load).toHaveBeenCalledTimes(1)
    await admission.settle()
    expect(order).toEqual(['pin', 'closed', 'drained'])
  })

  it('closes synchronously on timeout but retains a real accepted output promise before cleanup', async () => {
    const actualOutput = deferred(), close = vi.fn(), cleanup = vi.fn()
    const admission = new DocsHeadlessOutputAdmission({
      pin: async () => {}, closeAdmission: close, awaitSettlement: () => actualOutput.promise,
    })
    expect(await admission.prepare()).toBe(true)
    setTimeout(() => admission.close(), 20)
    await vi.advanceTimersByTimeAsync(20)
    expect(close).toHaveBeenCalledTimes(1)
    const settlement = admission.settle().then(cleanup)
    await flush()
    expect(cleanup).not.toHaveBeenCalled()
    expect(await admission.prepare()).toBe(false)
    actualOutput.resolve(); await settlement
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('never loads after a terminal report arrives during setup and drains only after actual pin completion', async () => {
    const pin = deferred(), actualOutput = deferred(), load = vi.fn(), drain = vi.fn(() => actualOutput.promise)
    const admission = new DocsHeadlessOutputAdmission({ pin: () => pin.promise,
      closeAdmission: vi.fn(), awaitSettlement: drain })
    const setup = admission.prepare().then(ready => { if (ready) load() })
    await flush()
    admission.close()
    let finished = false
    const settlement = admission.settle().then(() => { finished = true })
    await flush()
    expect(drain).not.toHaveBeenCalled()
    expect(finished).toBe(false)
    pin.resolve(); await setup; await flush()
    expect(load).not.toHaveBeenCalled()
    expect(drain).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    actualOutput.resolve(); await settlement
    expect(finished).toBe(true)
  })

  it('preserves setup failure only after the provider confirms genuine actual settlement', async () => {
    const pin = deferred(), actualOutput = deferred(), failure = new Error('Synthetic target pin failure')
    const admission = new DocsHeadlessOutputAdmission({ pin: () => pin.promise,
      closeAdmission: vi.fn(), awaitSettlement: () => actualOutput.promise })
    const setup = admission.prepare()
    const rejectedSetup = expect(setup).rejects.toBe(failure)
    await flush(); pin.reject(failure); await rejectedSetup
    const settlement = admission.settle()
    let finished = false
    void settlement.then(() => { finished = true }, () => { finished = true })
    await flush()
    expect(finished).toBe(false)
    const rejectedSettlement = expect(settlement).rejects.toBe(failure)
    actualOutput.resolve(); await rejectedSettlement
    expect(finished).toBe(true)
  })

  it('shares one actual drain across repeated report/finally settlement calls', async () => {
    const actualOutput = deferred(), close = vi.fn(), drain = vi.fn(() => actualOutput.promise)
    const admission = new DocsHeadlessOutputAdmission({ pin: async () => {}, closeAdmission: close, awaitSettlement: drain })
    await admission.prepare()
    admission.close(); admission.close()
    const first = admission.settle(), second = admission.settle()
    expect(second).toBe(first)
    await flush()
    expect(close).toHaveBeenCalledTimes(1)
    expect(drain).toHaveBeenCalledTimes(1)
    actualOutput.resolve(); await first
  })
})
