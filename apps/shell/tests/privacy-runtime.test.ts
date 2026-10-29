import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RequestListener = (
  details: { url: string },
  reply: (result: { cancel: boolean }) => void,
) => void
const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  aiGuard: undefined as ((url: string, kind: string) => void) | undefined,
  listeners: new Map<string, (...args: unknown[]) => void>(),
  requestListener: undefined as RequestListener | undefined,
  defaultSession: { webRequest: { onBeforeRequest: vi.fn() } },
  guardInstall: vi.fn(),
  settingsWrite: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/mock/vantage-profile',
    on: (name: string, callback: (...args: unknown[]) => void) => {
      state.listeners.set(name, callback)
    },
  },
  session: { defaultSession: state.defaultSession },
}))
vi.mock('../src/main/app-settings', () => ({
  readAppSettings: () => state.settings,
  writeAppSetting: (path: string, key: string, value: unknown) => {
    state.settingsWrite(path, key, value)
    state.settings = { ...state.settings, [key]: value }
  },
}))
vi.mock('@vantage/ai-provider', () => ({
  setAiRequestGuard: (guard: (url: string, kind: string) => void) => {
    state.guardInstall(guard)
    state.aiGuard = guard
  },
}))

const originalFetch = globalThis.fetch
let network: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(() => {
  vi.resetModules()
  state.settings = {}
  state.aiGuard = undefined
  state.requestListener = undefined
  state.listeners.clear()
  state.guardInstall.mockClear()
  state.settingsWrite.mockClear()
  state.defaultSession.webRequest.onBeforeRequest.mockReset()
  state.defaultSession.webRequest.onBeforeRequest.mockImplementation(
    (_filter: unknown, listener: RequestListener) => {
      state.requestListener = listener
    },
  )
  network = vi.fn<typeof fetch>().mockResolvedValue(new Response('mock response'))
  globalThis.fetch = network
})
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function approve(...origins: string[]): void {
  state.settings = {
    networkPolicy: { localOnly: false, features: { ai: true }, origins: { ai: origins } },
  }
}
async function install() {
  const module = await import('../src/main/privacy-runtime')
  module.installPrivacyRuntime()
  return module
}

describe('workspace privacy runtime with mocked transports and Electron sessions', () => {
  it('preserves a bodyless method on a 307 redirect', async () => {
    approve('https://service.example')
    network
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response('done'))
    await install()
    await fetch('https://service.example/start', { method: 'OPTIONS' })
    expect((network.mock.calls[1]![0] as Request).method).toBe('OPTIONS')
  })
  it('drops body headers when a 303 changes POST into GET', async () => {
    approve('https://service.example')
    network
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response('done'))
    await install()
    await fetch('https://service.example/start', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
    })
    const redirected = network.mock.calls[1]![0] as Request
    expect(redirected.method).toBe('GET')
    expect(redirected.body).toBeNull()
    expect(redirected.headers.has('content-type')).toBe(false)
    expect(redirected.headers.has('content-length')).toBe(false)
  })
  it('installs one interceptor per session and applies updated policy without reinstalling', async () => {
    const runtime = await install()
    runtime.installPrivacyRuntime()
    expect(state.guardInstall).toHaveBeenCalledTimes(1)
    expect(state.defaultSession.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    const replies: { cancel: boolean }[] = []
    state.requestListener!({ url: 'https://service.example/test' }, (value) => replies.push(value))
    state.requestListener!({ url: 'http://127.0.0.1:8080/test' }, (value) => replies.push(value))
    approve('https://service.example')
    state.requestListener!({ url: 'https://service.example/test' }, (value) => replies.push(value))
    expect(replies).toEqual([{ cancel: true }, { cancel: false }, { cancel: false }])
    const another = { webRequest: { onBeforeRequest: vi.fn() } }
    state.listeners.get('session-created')!(another)
    state.listeners.get('session-created')!(another)
    expect(another.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
  })

  it('blocks remote fetch before transport while allowing loopback local services', async () => {
    await install()
    await expect(fetch('https://remote.example/data')).rejects.toThrow('Local mode')
    expect(network).not.toHaveBeenCalled()
    expect(await (await fetch('http://localhost:8080/model')).text()).toBe('mock response')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('requires an exact approved encrypted origin before starting the connection', async () => {
    approve('https://service.example')
    await install()
    for (const url of [
      'https://service.example.attacker.test/',
      'http://service.example/',
      'https://user:password@service.example/',
    ])
      await expect(fetch(url)).rejects.toThrow()
    expect(network).not.toHaveBeenCalled()
    await fetch('https://service.example/v1/data')
    expect(network).toHaveBeenCalledTimes(1)
    expect(network.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('strips standard and vendor secrets before following an approved cross-origin redirect', async () => {
    approve('https://first.example', 'https://second.example')
    network.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://second.example/result' } }),
    )
    network.mockResolvedValueOnce(new Response('finished'))
    await install()
    await fetch('https://first.example/start', {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'x-api-key': 'vendor secret',
        'api-key': 'other secret',
        'x-goog-api-key': 'google secret',
        'x-private-metadata': 'private',
        Accept: 'application/json',
        'Accept-Language': 'en',
        'Content-Type': 'application/json',
      },
    })
    expect(network).toHaveBeenCalledTimes(2)
    const destination = network.mock.calls[1]?.[0] as Request
    expect(destination.url).toBe('https://second.example/result')
    for (const header of [
      'authorization',
      'cookie',
      'x-api-key',
      'api-key',
      'x-goog-api-key',
      'x-private-metadata',
    ])
      expect(destination.headers.has(header), header).toBe(false)
    expect(destination.headers.get('accept')).toBe('application/json')
    expect(destination.headers.get('accept-language')).toBe('en')
  })

  it('preserves credentials on a same-origin redirect', async () => {
    approve('https://service.example')
    network
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response('done'))
    await install()
    await fetch('https://service.example/start', {
      headers: { 'x-api-key': 'same origin credential' },
    })
    expect((network.mock.calls[1]?.[0] as Request).headers.get('x-api-key')).toBe(
      'same origin credential',
    )
  })

  it('rejects an unapproved redirected origin before any request reaches that origin', async () => {
    approve('https://service.example')
    network.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://unapproved.example/collect' },
      }),
    )
    await install()
    await expect(
      fetch('https://service.example/start', { headers: { 'x-api-key': 'secret' } }),
    ).rejects.toThrow('not been approved')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('honors explicit manual/error redirect modes instead of following them', async () => {
    approve('https://service.example')
    network
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
    await install()
    expect((await fetch('https://service.example/start', { redirect: 'manual' })).status).toBe(302)
    await expect(fetch('https://service.example/start', { redirect: 'error' })).rejects.toThrow(
      'Redirect refused',
    )
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('refuses replaying a request body after a 307 redirect', async () => {
    approve('https://service.example')
    network.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: '/next' } }),
    )
    await install()
    await expect(
      fetch('https://service.example/start', { method: 'POST', body: 'private prompt' }),
    ).rejects.toThrow('body cannot be redirected')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('guards native AI commands by explicit AI permission as well as local mode', async () => {
    await install()
    expect(() => state.aiGuard!('ignored-command-address', 'command')).toThrow('Enable ai')
    approve('https://model.example')
    expect(() => state.aiGuard!('ignored-command-address', 'command')).not.toThrow()
    state.settings = {
      networkPolicy: {
        localOnly: false,
        features: { assets: true },
        origins: { assets: ['https://model.example'] },
      },
    }
    expect(() => state.aiGuard!('ignored-command-address', 'command')).toThrow('Enable ai')
    expect(() => state.aiGuard!('https://model.example/chat', 'network')).toThrow('Enable ai')
    approve('https://model.example')
    expect(() => state.aiGuard!('https://model.example/chat', 'network')).not.toThrow()
    expect(network).not.toHaveBeenCalled()
  })

  it('persists normalized permission choices without converting malformed booleans into consent', async () => {
    const runtime = await install()
    const policy = runtime.saveNetworkPolicy({
      localOnly: false,
      features: { ai: true, mail: 'true' },
      origins: {
        ai: ['https://model.example/path', 'http://plain.example', 'https://model.example/other'],
      },
    })
    expect(policy.features.mail).toBe(false)
    expect(policy.origins.ai).toEqual(['https://model.example'])
    expect(state.settingsWrite).toHaveBeenCalledTimes(1)
    expect(runtime.currentNetworkPolicy()).toEqual(policy)
  })

  it('bounds redirect loops', async () => {
    approve('https://service.example')
    network.mockImplementation(
      async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    )
    await install()
    await expect(fetch('https://service.example/loop')).rejects.toThrow(
      'Too many service redirects',
    )
    expect(network).toHaveBeenCalledTimes(11)
  })
})
