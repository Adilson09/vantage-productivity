import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiFetch, checkAiRequestPermission, setAiRequestGuard } from '../src/fetch'
afterEach(() => {
  setAiRequestGuard(undefined)
  vi.unstubAllGlobals()
})
describe('optional host AI permission', () => {
  it('checks permission before admission or any fetch begins', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    setAiRequestGuard(() => {
      throw new Error('Cloud AI is disabled')
    })
    await expect(
      aiFetch('https://example.invalid/v1/chat/completions', {
        method: 'POST',
        body: 'private text',
      }),
    ).rejects.toThrow('Cloud AI is disabled')
    expect(request).not.toHaveBeenCalled()
  })
  it('passes a local URL and checks native commands separately', async () => {
    const guard = vi.fn()
    setAiRequestGuard(guard)
    checkAiRequestPermission('http://127.0.0.1:8080/v1')
    checkAiRequestPermission('', 'command')
    expect(guard.mock.calls).toEqual([
      ['http://127.0.0.1:8080/v1', 'http'],
      ['', 'command'],
    ])
  })
})
