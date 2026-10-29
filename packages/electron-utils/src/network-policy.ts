/** Application-level permission policy. This is not an operating-system firewall. */
export const REMOTE_FEATURES = [
  'ai',
  'mail',
  'calendar',
  'collaboration',
  'updates',
  'assets',
  'telemetry',
] as const
export type RemoteFeature = (typeof REMOTE_FEATURES)[number]
export interface NetworkPolicy {
  localOnly: boolean
  features: Record<RemoteFeature, boolean>
  origins: Partial<Record<RemoteFeature, string[]>>
}
export function normalizeNetworkPolicy(value: unknown): NetworkPolicy {
  const raw = value && typeof value === 'object' ? (value as Partial<NetworkPolicy>) : {}
  const features = Object.fromEntries(
    REMOTE_FEATURES.map((key) => [key, raw.features?.[key] === true]),
  ) as NetworkPolicy['features']
  const origins: NetworkPolicy['origins'] = {}
  for (const key of REMOTE_FEATURES) {
    const values = raw.origins?.[key]
    origins[key] = Array.isArray(values)
      ? [
          ...new Set(
            values
              .filter((v): v is string => typeof v === 'string')
              .slice(0, 32)
              .flatMap((v) => {
                try {
                  const u = new URL(v)
                  return u.protocol === 'https:' && !u.username && !u.password ? [u.origin] : []
                } catch {
                  return []
                }
              }),
          ),
        ]
      : []
  }
  return { localOnly: raw.localOnly !== false, features, origins }
}
export function isLoopbackUrl(url: URL): boolean {
  return (
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) &&
    !url.username &&
    !url.password
  )
}
export function networkDecision(
  policy: NetworkPolicy,
  value: string,
  feature?: RemoteFeature,
): { allowed: boolean; reason: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { allowed: false, reason: 'Invalid network address.' }
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
    return { allowed: false, reason: 'Unsupported network protocol.' }
  if (isLoopbackUrl(url)) return { allowed: true, reason: 'Local service.' }
  if (policy.localOnly)
    return { allowed: false, reason: 'Local mode is enabled. Remote services are disabled.' }
  if (url.username || url.password || !['https:', 'wss:'].includes(url.protocol))
    return {
      allowed: false,
      reason: 'Remote services require an encrypted connection without credentials in the address.',
    }
  const origin = url.protocol === 'wss:' ? `https://${url.host}` : url.origin
  const matching = REMOTE_FEATURES.filter(
    (key) => policy.features[key] && policy.origins[key]?.includes(origin),
  )
  if (feature ? matching.includes(feature) : matching.length > 0)
    return { allowed: true, reason: 'Enabled service and approved origin.' }
  return {
    allowed: false,
    reason: feature
      ? `Enable ${feature} and approve its service origin in Privacy and engines.`
      : 'This remote origin has not been approved in Privacy and engines.',
  }
}
export function requireRemoteFeature(policy: NetworkPolicy, feature: RemoteFeature): void {
  if (policy.localOnly || !policy.features[feature])
    throw new Error(`Enable ${feature} in Privacy and engines before using this remote feature.`)
}
