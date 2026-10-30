// @vitest-environment jsdom
// Vantage Mail: Gmail starts in Google's browser flow and never falls back to an account password.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => import('../lib/testing').then((m) => m.eventModule))
vi.mock('@tauri-apps/api/window', () => import('../lib/testing').then((m) => m.windowModule))
vi.mock('@tauri-apps/api/app', () => import('../lib/testing').then((m) => m.appModule))
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<object>()),
  api: (await import('../lib/testing')).api,
}))
vi.mock('../lib/theme', () => ({ applyTheme: () => {} }))

import { flushSync, mount, unmount } from 'svelte'
import Wizard from './Wizard.svelte'
import { app } from '../lib/store.svelte'
import { i18n } from '../lib/i18n.svelte'
import { api, resetFakes, settings } from '../lib/testing'

let view: ReturnType<typeof mount> | null = null
function start() {
  const root = document.createElement('div')
  document.body.append(root)
  view = mount(Wizard, { target: root })
  flushSync()
  return root
}
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => el.textContent?.trim() === label,
  )

beforeEach(() => {
  resetFakes()
  i18n.lang = 'en'
  app.settingsCtl.settings = settings()
  app.mailboxes.accounts = []
  app.ui.wizard = { account: null } as never
  api.oauthProviders.mockResolvedValue([{ provider: 'google', title: 'Google', configured: false }])
})
afterEach(async () => {
  if (view) await unmount(view)
  view = null
  document.body.innerHTML = ''
})

describe('Vantage Mail Google entry', () => {
  it('always offers Google and routes an unconfigured build to real setup without starting authentication', async () => {
    const root = start()
    await vi.waitFor(() => expect(button(root, 'Sign in with Google')).toBeDefined())
    await vi.waitFor(() => expect(button(root, 'Sign in with Google')?.disabled).toBe(false))
    button(root, 'Sign in with Google')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Set up Google sign-in'))
    expect(root.querySelector('input[name=google-client-id]')).not.toBeNull()
    expect(api.oauthSignIn).not.toHaveBeenCalled()
    expect(api.accountCheck).not.toHaveBeenCalled()
    expect(api.accountSave).not.toHaveBeenCalled()
  })

  it('hides the account password for Gmail and opens the backend browser flow with an address hint', async () => {
    api.oauthProviders.mockResolvedValue([
      { provider: 'google', title: 'Google', configured: true },
    ])
    let cancel = () => {}
    api.oauthSignIn.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          cancel = () => reject({ kind: 'auth', message: 'Sign-in cancelled' })
        }),
    )
    api.oauthCancel.mockImplementation(async () => cancel())
    const root = start()
    await vi.waitFor(() => expect(button(root, 'Sign in with Google')?.disabled).toBe(false))
    const email = root.querySelector<HTMLInputElement>('input[type=email]')!
    email.value = 'person@gmail.com'
    email.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    expect(root.querySelector('input[type=password]')).toBeNull()
    root.querySelector<HTMLButtonElement>('footer .btn.primary')!.click()
    await vi.waitFor(() =>
      expect(api.oauthSignIn).toHaveBeenCalledWith('google', 'person@gmail.com'),
    )
    expect(api.detect).not.toHaveBeenCalled()
    expect(api.accountSave).not.toHaveBeenCalled()
    button(root, 'Cancel')!.click()
    await vi.waitFor(() =>
      expect(root.textContent).not.toContain('Waiting for Google in the browser'),
    )
    expect(api.accountSave).not.toHaveBeenCalled()
  })

  it('offers retry when provider readiness cannot be loaded, without opening a browser', async () => {
    api.oauthProviders.mockRejectedValue({ kind: 'io', message: 'Configuration is unavailable' })
    const root = start()
    await vi.waitFor(() => expect(root.textContent).toContain('Configuration is unavailable'))
    expect(button(root, 'Retry')).toBeDefined()
    expect(api.oauthSignIn).not.toHaveBeenCalled()
  })
})

describe('Vantage Mail Google registration setup', () => {
  it('saves only a local Desktop registration, preserves other providers and then requires an explicit Google sign-in', async () => {
    const other = { client_id: 'other-provider' }
    api.settings.mockResolvedValue({ ...settings(), oauth_clients: { yandex: other } })
    api.oauthProviders
      .mockResolvedValueOnce([{ provider: 'google', title: 'Google', configured: false }])
      .mockResolvedValue([{ provider: 'google', title: 'Google', configured: true }])
    api.oauthSignIn.mockRejectedValue({ kind: 'auth', message: 'access_denied' })
    const root = start()
    await vi.waitFor(() => expect(button(root, 'Sign in with Google')?.disabled).toBe(false))
    button(root, 'Sign in with Google')!.click()
    await vi.waitFor(() =>
      expect(root.querySelector('input[name=google-client-id]')).not.toBeNull(),
    )
    const field = root.querySelector<HTMLInputElement>('input[name=google-client-id]')!
    field.value = ' 123-desktop.apps.googleusercontent.com '
    field.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    button(root, 'Save Google setup')!.click()
    await vi.waitFor(() =>
      expect(api.settingsPatch).toHaveBeenCalledWith({
        oauth_clients: {
          yandex: other,
          google: { client_id: '123-desktop.apps.googleusercontent.com' },
        },
      }),
    )
    await vi.waitFor(() => expect(root.querySelector('input[name=google-client-id]')).toBeNull())
    expect(api.oauthSignIn).not.toHaveBeenCalled()
    expect(api.accountSave).not.toHaveBeenCalled()
    button(root, 'Sign in with Google')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('access_denied'))
    expect(root.textContent).toContain('Test users')
    expect(api.accountSave).not.toHaveBeenCalled()
  })

  it('leaves refused client configuration on the setup form without starting authentication', async () => {
    api.settings.mockResolvedValue(settings())
    api.settingsPatch.mockRejectedValue({ kind: 'io', message: 'Settings could not be saved' })
    const root = start()
    await vi.waitFor(() => expect(button(root, 'Sign in with Google')?.disabled).toBe(false))
    button(root, 'Sign in with Google')!.click()
    await vi.waitFor(() =>
      expect(root.querySelector('input[name=google-client-id]')).not.toBeNull(),
    )
    const field = root.querySelector<HTMLInputElement>('input[name=google-client-id]')!
    field.value = '123-desktop.apps.googleusercontent.com'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    button(root, 'Save Google setup')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Settings could not be saved'))
    expect(root.querySelector('input[name=google-client-id]')).not.toBeNull()
    expect(api.oauthSignIn).not.toHaveBeenCalled()
    expect(api.accountSave).not.toHaveBeenCalled()
  })
})
