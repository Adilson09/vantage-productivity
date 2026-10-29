import { describe, expect, it } from 'vitest'
import {
  networkDecision,
  normalizeNetworkPolicy,
  requireRemoteFeature,
} from '../src/network-policy'
describe('application network permissions', () => {
  it('keeps local services usable while remote requests are disabled by default', () => {
    const p = normalizeNetworkPolicy(null)
    expect(networkDecision(p, 'http://127.0.0.1:8080/v1').allowed).toBe(true)
    expect(networkDecision(p, 'http://[::1]:8080/').allowed).toBe(true)
    expect(networkDecision(p, 'https://example.org/').allowed).toBe(false)
    expect(networkDecision(p, 'https://localhost.attacker.test').allowed).toBe(false)
  })
  it('requires both feature consent and an exact encrypted origin', () => {
    const p = normalizeNetworkPolicy({
      localOnly: false,
      features: { ai: true },
      origins: { ai: ['https://model.example/v1'] },
    })
    expect(networkDecision(p, 'https://model.example/v1/chat', 'ai').allowed).toBe(true)
    for (const u of [
      'https://model.example.attacker.test',
      'http://model.example',
      'https://user:pass@model.example',
    ])
      expect(networkDecision(p, u, 'ai').allowed).toBe(false)
    expect(networkDecision(p, 'https://model.example', 'mail').allowed).toBe(false)
    expect(() => requireRemoteFeature(p, 'mail')).toThrow('Enable mail')
  })
  it('does not turn malformed stored settings into network permission', () => {
    const p = normalizeNetworkPolicy({
      localOnly: 'false',
      features: { ai: 1 },
      origins: { ai: [42, 'http://plain.test', 'https://a.test', 'https://a.test/x'] },
    })
    expect(p.localOnly).toBe(true)
    expect(p.features.ai).toBe(false)
    expect(p.origins.ai).toEqual(['https://a.test'])
  })
})
