// Aster Office: interrupted recovery-copy writes must never publish partial data or leave debris.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const injected = vi.hoisted(() => ({ mode: '' as '' | 'write' | 'flush', refusedUnlink: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      if (String(args[0]) === injected.refusedUnlink)
        throw Object.assign(new Error('history file is busy'), { code: 'EACCES' })
      return real.unlink(...args)
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (String(args[0]).endsWith('.recovery.tmp')) {
        if (injected.mode === 'write') {
          const write = handle.writeFile.bind(handle)
          handle.writeFile = async () => {
            await write(Buffer.from('partial'))
            throw Object.assign(new Error('disk full during restore'), { code: 'ENOSPC' })
          }
        }
        if (injected.mode === 'flush')
          handle.sync = async () => {
            throw Object.assign(new Error('restore flush failed'), { code: 'EIO' })
          }
      }
      return handle
    },
  }
})

import {
  captureRecoverySnapshot,
  listRecoveryEntries,
  RECOVERY_POLICY,
  restoreRecoveryCopy,
} from '../src/recovery-vault'

const prefix = join(tmpdir(), 'aster-restore-fault-')
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(prefix)
  injected.mode = ''
  injected.refusedUnlink = ''
})
afterEach(async () => {
  injected.mode = ''
  injected.refusedUnlink = ''
  if (!dir.startsWith(prefix)) throw new Error('Unexpected test folder')
  await rm(dir, { recursive: true, force: true })
})

it('keeps a revision indexed when quota pruning cannot remove its payload', async () => {
  const root = join(dir, 'vault')
  const original = join(dir, 'report.docx')
  await mkdir(root)
  const emptyHash = createHash('sha256').update('').digest('hex')
  let oldest = ''
  for (let index = 0; index < RECOVERY_POLICY.maxRevisionsPerFile; index += 1) {
    const id = randomUUID()
    if (index === 0) oldest = id
    await writeFile(join(root, `${id}.bin`), '')
    await writeFile(
      join(root, `${id}.json`),
      JSON.stringify({
        id,
        originalPath: original,
        fileName: 'report.docx',
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString(),
        bytes: 0,
        sha256: emptyHash,
      }),
    )
  }
  await writeFile(original, 'keep current original')
  injected.refusedUnlink = join(root, `${oldest}.bin`)
  await expect(captureRecoverySnapshot(original, root)).rejects.toMatchObject({ code: 'EACCES' })
  expect(await readFile(original, 'utf8')).toBe('keep current original')
  expect((await listRecoveryEntries(root)).some((entry) => entry.id === oldest)).toBe(true)
  expect(await listRecoveryEntries(root)).toHaveLength(RECOVERY_POLICY.maxRevisionsPerFile)
  expect((await readdir(root)).filter((name) => name.endsWith('.bin'))).toHaveLength(
    RECOVERY_POLICY.maxRevisionsPerFile,
  )
}, 20000)

describe.each(['write', 'flush'] as const)('restore %s failure', (mode) => {
  it('preserves the original, leaves no destination and removes the owned temporary copy', async () => {
    const original = join(dir, 'report.docx')
    const root = join(dir, 'vault')
    const destination = join(dir, 'recovered.docx')
    await writeFile(original, 'previous bytes')
    const entry = await captureRecoverySnapshot(original, root)
    await writeFile(original, 'current bytes')
    injected.mode = mode
    await expect(restoreRecoveryCopy(root, entry!.id, destination)).rejects.toMatchObject({
      code: mode === 'write' ? 'ENOSPC' : 'EIO',
    })
    expect(await readFile(original, 'utf8')).toBe('current bytes')
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(dir)).filter((name) => name.endsWith('.recovery.tmp'))).toEqual([])
    expect(await readFile(join(root, `${entry!.id}.bin`), 'utf8')).toBe('previous bytes')
  })
})
