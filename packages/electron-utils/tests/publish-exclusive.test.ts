import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { publishExclusiveCopy } from '../src/publish-exclusive'
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: vi.fn(async () => {
      throw Object.assign(new Error('No hardlinks'), { code: 'EISDIR' })
    }),
    open: vi.fn(real.open),
    stat: vi.fn(real.stat),
  }
})
const prefix = join(tmpdir(), 'vantage-exclusive-copy-')
let root: string
beforeEach(async () => {
  root = await mkdtemp(prefix)
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockReset().mockImplementation(real.open)
  vi.mocked(stat).mockReset().mockImplementation(real.stat)
})
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(prefix))) throw new Error('Unexpected cleanup folder')
  await rm(root, { recursive: true, force: true })
})
const content = Buffer.from('complete verified recovery bytes'),
  expected = { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }
it('supports a filesystem without hardlinks using an exclusive write handle and hash verification', async () => {
  const source = join(root, 'complete.tmp'),
    destination = join(root, 'restored.md')
  await writeFile(source, content)
  expect(await publishExclusiveCopy(source, destination, expected)).toEqual({ atomic: false })
  expect(await readFile(destination)).toEqual(content)
  expect(await readFile(source)).toEqual(content)
})
it('never overwrites an existing destination when hardlinks are unavailable', async () => {
  const source = join(root, 'complete.tmp'),
    destination = join(root, 'occupied.md')
  await writeFile(source, content)
  await writeFile(destination, 'keep this original')
  await expect(publishExclusiveCopy(source, destination, expected)).rejects.toMatchObject({
    code: 'EEXIST',
  })
  expect(await readFile(destination, 'utf8')).toBe('keep this original')
  expect(await readFile(source)).toEqual(content)
})
it('retains a new output for review when the source no longer matches its expected digest', async () => {
  const source = join(root, 'complete.tmp'),
    destination = join(root, 'restored.md'),
    changed = Buffer.alloc(content.length, 'X')
  await writeFile(source, changed)
  await expect(publishExclusiveCopy(source, destination, expected)).rejects.toThrow(
    'could not be certified',
  )
  expect(await readFile(destination)).toEqual(changed)
  expect(await readFile(source)).toEqual(changed)
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
it('preserves a real external replacement between awaited verification and failure', async () => {
  const source = join(root, 'complete.tmp'),
    destination = join(root, 'external.md'),
    entered = deferred(),
    gate = deferred(),
    replacement = Buffer.alloc(content.length, 'Z')
  await writeFile(source, content)
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(stat).mockImplementationOnce(async (...args) => {
    const result = await real.stat(...args)
    entered.resolve()
    await gate.promise
    return result
  })
  const publishing = publishExclusiveCopy(source, destination, expected),
    refused = expect(publishing).rejects.toThrow('destination may remain for review')
  await entered.promise
  await unlink(destination)
  await writeFile(destination, replacement)
  gate.resolve()
  await refused
  expect(await readFile(destination)).toEqual(replacement)
  expect(await readFile(source)).toEqual(content)
})
it('keeps a partial new output after a real handle write fails and never calls copyFile rollback', async () => {
  const source = join(root, 'complete.tmp'),
    destination = join(root, 'partial.md')
  await writeFile(source, content)
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await real.open(...args)
    if (args[1] !== 'wx') return handle
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'write')
          return async (buffer: Buffer) => {
            await target.write(buffer.subarray(0, 4))
            throw Object.assign(new Error('late write failure'), { code: 'EIO' })
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
  await expect(publishExclusiveCopy(source, destination, expected)).rejects.toMatchObject({
    code: 'EIO',
  })
  expect(await readFile(destination)).toEqual(content.subarray(0, 4))
  expect(await readFile(source)).toEqual(content)
})
