import { beforeEach, describe, expect, it, vi } from 'vitest'
beforeEach(() => vi.resetModules())
describe('Root native phase registry', () => {
  it('fails closed for an unregistered family, including a clean view', async () => {
    const { prepareRootClose } = await import('../src/main/root-close-adapters')
    await expect(
      prepareRootClose('sheets', {} as never, {} as never, {
        deferSeal: true,
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    ).rejects.toThrow('unavailable')
  })
  it('refuses legacy Boolean, force or prematurely ready whole-window results', async () => {
    const { prepareRootClose, registerRootCloseAdapter } =
      await import('../src/main/root-close-adapters')
    const cancel = vi.fn(),
      values: unknown[] = [true, { phase: 'force' }, { phase: 'ready' }]
    registerRootCloseAdapter('docs', {
      prepare: async () => values.shift() as never,
      isPrepared: () => true,
      seal: () => null,
      complete: () => true,
      cancel,
    })
    const options = {
      deferSeal: true as const,
      signal: new AbortController().signal,
      isCurrent: () => true,
    }
    for (let i = 0; i < 3; i++)
      expect(await prepareRootClose('docs', {} as never, {} as never, options)).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(3)
  })
  it('never autoapproves a missing seal or invokes actual removal through a prepared receipt', async () => {
    const { prepareRootClose, registerRootCloseAdapter } =
      await import('../src/main/root-close-adapters')
    const complete = vi.fn(),
      cancel = vi.fn()
    registerRootCloseAdapter('markdown', {
      prepare: async () => ({ phase: 'prepared' }),
      isPrepared: () => true,
      seal: () => null,
      complete,
      cancel,
    })
    const receipt = (await prepareRootClose('markdown', {} as never, {} as never, {
      deferSeal: true,
      signal: new AbortController().signal,
      isCurrent: () => true,
    }))!
    expect(receipt.seal()).toBeNull()
    expect(complete).not.toHaveBeenCalled()
    receipt.cancel('seal refused')
    expect(cancel).toHaveBeenCalled()
  })
  it('only an explicitly allowed individual Docs force can be wrapped for leaf-authoritative removal', async () => {
    const { prepareRootIndividualClose, registerRootCloseAdapter } =
      await import('../src/main/root-close-adapters')
    const complete = vi.fn((_w, _r, remove: () => boolean) => remove()),
      cancel = vi.fn()
    registerRootCloseAdapter('docs', {
      prepare: async () => ({ phase: 'force' }),
      isPrepared: () => false,
      seal: () => null,
      complete,
      cancel,
    })
    expect(
      await prepareRootIndividualClose('docs', {} as never, {} as never, {
        isCurrent: () => true,
        allowForce: false,
      }),
    ).toBeNull()
    const receipt = (await prepareRootIndividualClose('docs', {} as never, {} as never, {
        isCurrent: () => true,
        allowForce: true,
      }))!,
      remove = vi.fn(() => true)
    expect(receipt.complete(remove)).toBe(true)
    expect(complete).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
  })
})
