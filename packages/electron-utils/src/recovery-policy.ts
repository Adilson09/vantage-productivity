import { mkdir, open, rename, statfs, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface RecoveryPolicy {
  maxFileBytes: number
  maxVaultBytes: number
  maxRevisionsPerFile: number
  maxEntries: number
  minFreeBytes: number
}

export const RECOVERY_POLICY: Readonly<RecoveryPolicy> = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxVaultBytes: 128 * 1024 * 1024,
  maxRevisionsPerFile: 10,
  maxEntries: 128,
  minFreeBytes: 64 * 1024 * 1024,
})

export const RECOVERY_POLICY_CEILING: Readonly<RecoveryPolicy> = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxVaultBytes: 2 * 1024 * 1024 * 1024,
  maxRevisionsPerFile: 100,
  maxEntries: 384,
  minFreeBytes: 16 * 1024 * 1024 * 1024,
})

export function validateRecoveryPolicy(value: unknown): RecoveryPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recovery storage settings')
  const patch = value as Record<string, unknown>
  const policy = { ...RECOVERY_POLICY }
  for (const name of Object.keys(patch)) {
    if (!Object.hasOwn(policy, name)) throw new Error(`Unknown recovery setting: ${name}`)
    const key = name as keyof RecoveryPolicy
    const amount = patch[key]
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) ||
        amount < (key === 'minFreeBytes' ? 0 : 1) || amount > RECOVERY_POLICY_CEILING[key])
      throw new Error(`Recovery setting ${key} exceeds its allowed range`)
    policy[key] = amount
  }
  if (policy.maxFileBytes > policy.maxVaultBytes)
    throw new Error('The per-document limit cannot exceed the recovery storage budget')
  return policy
}

export async function getRecoveryPolicy(root: string): Promise<RecoveryPolicy> {
  try {
    const handle = await open(join(root, 'policy.json'), 'r')
    try {
      if ((await handle.stat()).size > 4096) throw new Error('Recovery settings exceed their size limit')
      return validateRecoveryPolicy(JSON.parse(await handle.readFile('utf8')))
    } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...RECOVERY_POLICY }
    throw error
  }
}

/** The hard ceilings cannot be disabled by a stored preference. */
export async function setRecoveryPolicy(root: string, patch: Partial<RecoveryPolicy>): Promise<RecoveryPolicy> {
  const next = validateRecoveryPolicy({ ...await getRecoveryPolicy(root), ...patch })
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temp = join(root, `policy.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
    const handle = await open(temp, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await rename(temp, join(root, 'policy.json'))
  } finally { await unlink(temp).catch(() => {}) }
  return next
}

export async function assertRecoveryFreeSpace(root: string, bytes: number, policy: RecoveryPolicy): Promise<void> {
  const capacity = await statfs(root, { bigint: true })
  const available = capacity.bavail * capacity.bsize
  if (available < BigInt(bytes) + BigInt(policy.minFreeBytes))
    throw new Error('Not enough free disk space to keep the configured recovery reserve')
}
