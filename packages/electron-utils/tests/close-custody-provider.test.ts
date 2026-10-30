import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerCloseCleanupRuntime,
  registerCloseCustodyProvider,
  beginCloseCleanup,
  stageCloseCleanup,
  prepareProviderCloseCleanupRestore,
  retireCloseCleanupCustody,
  recordCloseCleanupFailure,
  getCloseCleanupStatus,
} from '../src/close-cleanup-runtime'
import type { CloseCustodyProvider } from '../src/close-custody-providers'
import type { CloseCleanupTask } from '../src/close-cleanup'
const fsHooks = vi.hoisted(() => ({ missingChild: undefined as string | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    lstat: vi.fn(async (...args: Parameters<typeof real.lstat>) => {
      if (String(args[0]) === fsHooks.missingChild)
        throw Object.assign(new Error('Child disappeared during inventory'), { code: 'ENOENT' })
      return real.lstat(...args)
    }),
  }
})
let fixtureRoot: string, root: string, userFiles: string
const reset = () => {
  delete (globalThis as typeof globalThis & { __vantageCloseCleanupRuntime?: unknown })
    .__vantageCloseCleanupRuntime
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
beforeEach(async () => {
  reset()
  fsHooks.missingChild = undefined
  fixtureRoot = await mkdtemp(join(tmpdir(), 'vantage-native-custody-'))
  root = join(fixtureRoot, 'profile')
  userFiles = join(fixtureRoot, 'user-files')
  await mkdir(root)
  await mkdir(userFiles)
  registerCloseCleanupRuntime({
    app: { on: () => {}, whenReady: async () => {}, quit: () => {} },
    userDataRoot: root,
    warning: vi.fn(),
  })
})
afterEach(async () => {
  reset()
  fsHooks.missingChild = undefined
  const target = resolve(fixtureRoot)
  if (!target.startsWith(resolve(join(tmpdir(), 'vantage-native-custody-'))))
    throw new Error('Unexpected fixture cleanup')
  await rm(target, { recursive: true, force: true })
})
function fixture() {
  const bytes = Buffer.from('consistent native snapshot'),
    id = 'test-' + randomUUID(),
    binding = {
      module: 'sheets',
      documentPath: join(userFiles, 'source.xlsx'),
      sha256: hash(bytes),
    }
  const provider: CloseCustodyProvider = {
    id,
    limits: { maxEntryBytes: 1024, maxTotalBytes: 2048, maxEntries: 4 },
    capture: vi.fn(async ({ task, targetRoot, signal, reserve }) => {
      if ((task.custody.input as { skipSnapshot?: boolean })?.skipSnapshot) return null
      signal.throwIfAborted()
      reserve(bytes.length)
      await mkdir(targetRoot, { recursive: true })
      await writeFile(join(targetRoot, 'snapshot.bin'), bytes)
      return { bytes: bytes.length, binding, receipt: { sha256: binding.sha256 } }
    }),
    validateReceipt: (value) =>
      !!value &&
      typeof value === 'object' &&
      (value as { sha256?: unknown }).sha256 === binding.sha256,
    purge: vi.fn(async ({ targetRoot, signal }) => {
      signal.throwIfAborted()
      await rm(targetRoot, { recursive: true, force: true })
    }),
    restore: vi.fn(async ({ targetRoot, destination, signal, beforePublication, created }) => {
      const value = await readFile(join(targetRoot, 'snapshot.bin'))
      signal.throwIfAborted()
      beforePublication()
      await writeFile(destination, value, { flag: 'wx' })
      created()
      signal.throwIfAborted()
      return { binding }
    }),
  }
  registerCloseCustodyProvider(provider)
  const task: CloseCleanupTask = {
    id: randomUUID(),
    module: 'sheets',
    ownerKey: 'native-owner',
    source: 'main-native-session',
    generation: 7,
    token: randomUUID(),
    documentPath: binding.documentPath,
    custody: { provider: id, input: { privateSessionId: 'owned-main-only' } },
    run: vi.fn(async () => {}),
  }
  return { bytes, binding, provider, task }
}
describe('main-owned native provider isolation and admission', () => {
  it('keeps native custody separate from the bounded generic draft journal namespace', async () => {
    const f = fixture(),
      handle = await stageCloseCleanup(f.task)
    handle.cancel()
    expect(handle.status()).toMatchObject({
      custodyProvider: f.provider.id,
      capturedEntry: f.binding,
      custody: true,
    })
    expect(await readdir(join(root, 'close-cleanup', 'custody'))).toEqual([])
    expect((await readdir(join(root, 'close-cleanup', 'providers', f.provider.id))).length).toBe(1)
    const destination = join(userFiles, 'restored-native.xlsx'),
      restored = await prepareProviderCloseCleanupRestore(handle.id, destination)
    expect(await readFile(destination)).toEqual(f.bytes)
    expect(restored.commitHandoff(() => true)).toBe(true)
    await retireCloseCleanupCustody({ module: 'sheets', ids: [handle.id] }, 'selected native copy')
    expect(f.provider.purge).toHaveBeenCalledTimes(1)
    expect(await readFile(destination)).toEqual(f.bytes)
  })
  it('keeps a durable status intent when a provider returns no snapshot', async () => {
    const f = fixture()
    f.task.custody.input = { skipSnapshot: true }
    const handle = await stageCloseCleanup(f.task)
    handle.cancel()
    expect(handle.status().custody).toBe(false)
    expect(await readdir(join(root, 'close-cleanup', 'providers', f.provider.id))).toEqual([])
  })
  it('refuses unregistered native providers without running primary-authority cleanup', async () => {
    const f = fixture()
    f.task.custody.provider = 'not-registered'
    await expect(stageCloseCleanup(f.task)).rejects.toThrow('primary authority is retained')
    expect(f.task.run).not.toHaveBeenCalled()
  })
  it('rejects snapshots which exceed their reserved charge even if a provider receipt claims a smaller size', async () => {
    const f = fixture()
    f.provider.capture = vi.fn(async ({ targetRoot, reserve }) => {
      reserve(1)
      await mkdir(targetRoot, { recursive: true })
      await writeFile(join(targetRoot, 'overrun.bin'), f.bytes)
      return { bytes: 1, binding: f.binding, receipt: { sha256: f.binding.sha256 } }
    })
    await expect(stageCloseCleanup(f.task)).rejects.toThrow('bounded receipt')
    expect(f.task.run).not.toHaveBeenCalled()
  })
  it('continues inventory past a transiently missing child and charges later existing bytes', async () => {
    const f = fixture()
    f.provider.limits = { maxEntryBytes: 50, maxTotalBytes: 100, maxEntries: 4 }
    const area = join(root, 'close-cleanup', 'providers', f.provider.id)
    await mkdir(area, { recursive: true })
    const ghost = join(area, 'a-disappearing')
    await writeFile(ghost, 'x')
    await writeFile(join(area, 'b-existing'), Buffer.alloc(100))
    fsHooks.missingChild = ghost
    await expect(stageCloseCleanup(f.task)).rejects.toThrow('custody is full')
    expect(f.task.run).not.toHaveBeenCalled()
  })
  it('admits the measured small snapshot near quota without demanding the maximum possible entry headroom', async () => {
    const f = fixture(),
      area = join(root, 'close-cleanup', 'providers', f.provider.id)
    await mkdir(area, { recursive: true })
    const existing = Buffer.alloc(f.provider.limits.maxTotalBytes - f.bytes.length, 'R')
    await writeFile(join(area, 'retained-unrelated.bin'), existing)
    const handle = await stageCloseCleanup(f.task)
    handle.cancel()
    expect(handle.status().custody).toBe(true)
    expect(await readFile(join(area, 'retained-unrelated.bin'))).toEqual(existing)
  })
  it('retains and accounts an unverified partial until a separate checked provider cleanup is available', async () => {
    const f = fixture()
    f.provider.capture = vi.fn(async ({ targetRoot, reserve }) => {
      reserve(f.bytes.length)
      await mkdir(targetRoot, { recursive: true })
      await writeFile(join(targetRoot, 'partial.bin'), f.bytes.subarray(0, 4))
      throw new Error('native snapshot interrupted')
    })
    const admission = beginCloseCleanup(f.task)
    await expect(admission.ready).rejects.toThrow('snapshot interrupted')
    await admission.actualSettled
    expect(getCloseCleanupStatus(f.task.id)).toMatchObject({ custody: false, phase: 'retained' })
    const [folder] = await readdir(join(root, 'close-cleanup', 'providers', f.provider.id)),
      partial = join(root, 'close-cleanup', 'providers', f.provider.id, folder!, 'partial.bin')
    expect(await readFile(partial)).toEqual(f.bytes.subarray(0, 4))
    await expect(
      retireCloseCleanupCustody({ module: 'sheets', ids: [f.task.id] }, 'selected partial'),
    ).rejects.toThrow('registered checked ownership')
    expect(f.provider.purge).not.toHaveBeenCalled()
    expect(await readFile(partial)).toEqual(f.bytes.subarray(0, 4))
    f.provider.purgePartial = vi.fn(async ({ status, targetRoot, signal }) => {
      expect(status.id).toBe(f.task.id)
      signal.throwIfAborted()
      await rm(targetRoot, { recursive: true, force: true })
    })
    await retireCloseCleanupCustody(
      { module: 'sheets', ids: [f.task.id] },
      'selected checked partial',
    )
    expect(f.provider.purgePartial).toHaveBeenCalledTimes(1)
    expect(f.provider.purge).not.toHaveBeenCalled()
  })
  it('cannot rewrite the expected lineage by annotating its delegated restore context', async () => {
    const f = fixture(),
      handle = await stageCloseCleanup(f.task)
    handle.cancel()
    f.provider.restore = vi.fn(async ({ status, destination, beforePublication, created }) => {
      expect(Object.isFrozen(status)).toBe(true)
      expect(Object.isFrozen(status.capturedEntry!)).toBe(true)
      expect(Reflect.set(status.capturedEntry!, 'sha256', 'f'.repeat(64))).toBe(false)
      beforePublication()
      await writeFile(destination, f.bytes, { flag: 'wx' })
      created()
      return { binding: { ...f.binding, sha256: 'f'.repeat(64) } }
    })
    const destination = join(userFiles, 'different-binding.xlsx')
    await expect(prepareProviderCloseCleanupRestore(handle.id, destination)).rejects.toThrow(
      'captured binding check',
    )
    expect(await readFile(destination)).toEqual(f.bytes)
    expect(getCloseCleanupStatus(handle.id)?.restoration?.phase).toBe('uncertain')
  })
  it('records exact owned cleanup failure status without granting a custody restore or path-deletion capability', async () => {
    const f = fixture()
    const status = recordCloseCleanupFailure(
      {
        id: f.task.id,
        module: f.task.module,
        ownerKey: f.task.ownerKey,
        source: f.task.source,
        generation: f.task.generation,
        token: f.task.token,
        documentPath: f.task.documentPath,
      },
      'A checked PDF private base could not be removed',
    )
    expect(status).toMatchObject({ id: f.task.id, custody: false, phase: 'retained' })
    await expect(
      prepareProviderCloseCleanupRestore(status.id, join(userFiles, 'no-copy.xlsx')),
    ).rejects.toThrow('no verified')
    expect(getCloseCleanupStatus(status.id)?.error).toContain('private base')
  })
})
