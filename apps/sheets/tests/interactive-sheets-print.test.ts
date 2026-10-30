import { describe, expect, it, vi } from 'vitest'
import { runInteractiveSheetsPrint } from '../src/main/interactive-sheets-print'

describe('interactive spreadsheet print admission', () => {
  it.each([
    { recoveryDisabled: true, headlessOwner: false },
    { recoveryDisabled: false, headlessOwner: true },
    { recoveryDisabled: true, headlessOwner: true },
  ])('refuses $recoveryDisabled/$headlessOwner before session, parsing or printing', (mode) => {
    const sessionFor = vi.fn(() => {
      throw new Error('The destroyed owner has no session.')
    })
    const parseRequest = vi.fn(() => {
      throw new Error('The queued request is invalid.')
    })
    const print = vi.fn(async (_session: unknown, _request: unknown) => ({ canceled: false }))
    expect(() =>
      runInteractiveSheetsPrint(mode, () => {
        const session = sessionFor()
        const request = parseRequest()
        return print(session, request)
      }),
    ).toThrow('Printing is unavailable during headless spreadsheet export.')
    expect(sessionFor).not.toHaveBeenCalled()
    expect(parseRequest).not.toHaveBeenCalled()
    expect(print).not.toHaveBeenCalled()
  })

  it('preserves the GUI print promise and invokes its effects exactly once', async () => {
    const order: string[] = []
    const session = { owner: 'interactive' },
      request = { pages: [1] }
    const result = { canceled: false }
    const actual = Promise.resolve(result)
    const sessionFor = vi.fn(() => {
      order.push('session')
      return session
    })
    const parseRequest = vi.fn(() => {
      order.push('parse')
      return request
    })
    const print = vi.fn((owned: typeof session, parsed: typeof request) => {
      order.push('print')
      expect(owned).toBe(session)
      expect(parsed).toBe(request)
      return actual
    })
    const returned = runInteractiveSheetsPrint(
      { recoveryDisabled: false, headlessOwner: false },
      () => {
        const owned = sessionFor()
        const parsed = parseRequest()
        return print(owned, parsed)
      },
    )
    expect(returned).toBe(actual)
    expect(await returned).toBe(result)
    expect(order).toEqual(['session', 'parse', 'print'])
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('preserves ordinary GUI print rejection without treating it as headless refusal', async () => {
    const failure = new Error('The interactive printer rejected the request.')
    const actual = Promise.reject(failure)
    const returned = runInteractiveSheetsPrint(
      { recoveryDisabled: false, headlessOwner: false },
      () => actual,
    )
    expect(returned).toBe(actual)
    await expect(returned).rejects.toBe(failure)
  })
})
