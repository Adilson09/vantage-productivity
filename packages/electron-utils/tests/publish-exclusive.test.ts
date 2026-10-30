import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    copyFile: vi.fn(real.copyFile),
  }
})
const prefix = join(tmpdir(), 'vantage-exclusive-copy-')
let root: string
beforeEach(async () => {
  root = await mkdtemp(prefix)
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(copyFile).mockReset().mockImplementation(real.copyFile)
})
afterEach(async () => {
  if (!root.startsWith(prefix)) throw new Error('Unexpected cleanup folder')
  await rm(root, { recursive: true, force: true })
})
const content = Buffer.from('complete verified recovery bytes')
const expected = {
  bytes: content.length,
  sha256: createHash('sha256').update(content).digest('hex'),
}
it('supports a filesystem without hardlinks through exclusive copy and hash verification', async () => {
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
it('removes its own newly published destination if byte verification detects damage', async () => {
  const source = join(root, 'complete.tmp'),
    destination = join(root, 'restored.md')
  await writeFile(source, content)
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(copyFile).mockImplementationOnce(async (...args) => {
    await real.copyFile(...args)
    await real.writeFile(String(args[1]), Buffer.alloc(content.length, 'X'))
  })
  await expect(publishExclusiveCopy(source, destination, expected)).rejects.toThrow('integrity')
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(source)).toEqual(content)
})
