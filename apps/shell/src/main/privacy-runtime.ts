import { app, session } from 'electron'
import { join } from 'node:path'
import { readAppSettings, writeAppSetting } from './app-settings'
import {
  networkDecision,
  normalizeNetworkPolicy,
  requireRemoteFeature,
  type NetworkPolicy,
} from '../../../../packages/electron-utils/src/network-policy'
import { setAiRequestGuard } from '@vantage/ai-provider'

const settingsPath = () => join(app.getPath('userData'), 'app-settings.json')
export const currentNetworkPolicy = (): NetworkPolicy =>
  normalizeNetworkPolicy(readAppSettings(settingsPath()).networkPolicy)
export function saveNetworkPolicy(value: unknown): NetworkPolicy {
  const policy = normalizeNetworkPolicy(value)
  writeAppSetting(settingsPath(), 'networkPolicy', policy)
  return policy
}
let installed = false
const installedSessions = new WeakSet<Electron.Session>()
function installSessionPolicy(target: Electron.Session): void {
  if (installedSessions.has(target)) return
  installedSessions.add(target)
  // Electron supports one listener per event; this module owns onBeforeRequest.
  target.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      callback({ cancel: !networkDecision(currentNetworkPolicy(), details.url).allowed })
    },
  )
}
/** Covers shell/editor Chromium sessions and Node fetch in this main process.
 * Raw sockets and native companions need separate controls and traffic acceptance. */
export function installPrivacyRuntime(): void {
  if (installed) return
  installed = true
  setAiRequestGuard((url, kind) => {
    const policy = currentNetworkPolicy()
    if (kind === 'command') {
      requireRemoteFeature(policy, 'ai')
      return
    }
    const decision = networkDecision(policy, url, 'ai')
    if (!decision.allowed) throw new Error(decision.reason)
  })
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const decision = networkDecision(currentNetworkPolicy(), url)
    if (!decision.allowed) throw new Error(decision.reason)
    // Inspect every redirect before another connection can be made.
    let request = new Request(input, init)
    for (let redirects = 0; redirects <= 10; redirects++) {
      const next = networkDecision(currentNetworkPolicy(), request.url)
      if (!next.allowed) throw new Error(next.reason)
      const response = await originalFetch(request, { redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status) || request.redirect === 'manual')
        return response
      if (request.redirect === 'error') {
        await response.body?.cancel()
        throw new Error('Redirect refused.')
      }
      const location = response.headers.get('location')
      if (!location) return response
      const destination = new URL(location, request.url)
      const decision = networkDecision(currentNetworkPolicy(), destination.href)
      if (!decision.allowed) {
        await response.body?.cancel()
        throw new Error(decision.reason)
      }
      const headers = new Headers(request.headers)
      if (destination.origin !== new URL(request.url).origin) {
        // Never forward custom provider keys or other caller-specific metadata
        // between origins. This also covers credentials with vendor header names.
        const safe = new Set(['accept', 'accept-language', 'content-type', 'user-agent'])
        for (const name of [...headers.keys()])
          if (!safe.has(name.toLowerCase())) headers.delete(name)
      }
      // Streaming bodies cannot be replayed safely; callers may retry explicitly.
      if (
        request.body &&
        response.status !== 303 &&
        !(['POST'].includes(request.method) && [301, 302].includes(response.status))
      ) {
        await response.body?.cancel()
        throw new Error('A request with a body cannot be redirected automatically.')
      }
      await response.body?.cancel()
      const becomesGet =
        (response.status === 303 && request.method !== 'GET' && request.method !== 'HEAD') ||
        ([301, 302].includes(response.status) && request.method === 'POST')
      if (becomesGet) {
        for (const name of [
          'content-type',
          'content-length',
          'content-encoding',
          'content-language',
          'content-location',
        ])
          headers.delete(name)
      }
      request = new Request(destination, {
        method: becomesGet ? 'GET' : request.method,
        headers,
        signal: request.signal,
      })
    }
    throw new Error('Too many service redirects.')
  }
  installSessionPolicy(session.defaultSession)
  app.on('session-created', installSessionPolicy)
}
