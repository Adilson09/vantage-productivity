import { mkdtemp, readFile, writeFile, rename, unlink, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadedDocVersion,
  prepareAndPublishDocx,
  readAtomicFileVersion,
  rebindDocRename,
} from '../src/main/doc-publication'
const roots: string[] = []
let previousRecoveryRoot: string | undefined
beforeEach(() => {
  previousRecoveryRoot = process.env.VANTAGE_RECOVERY_ROOT
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vantage-doc-publication-'))
  roots.push(root)
  process.env.VANTAGE_RECOVERY_ROOT = join(root, 'owned-history')
  const file = join(root, 'original.docx')
  await writeFile(file, 'loaded original')
  const expected = (await readAtomicFileVersion(file))!
  return { root, file, expected }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  if (previousRecoveryRoot === undefined) delete process.env.VANTAGE_RECOVERY_ROOT
  else process.env.VANTAGE_RECOVERY_ROOT = previousRecoveryRoot
  for (const root of roots.splice(0)) {
    const actual = resolve(root),
      prefix = resolve(tmpdir()) + sep + 'vantage-doc-publication-'
    if (!actual.startsWith(prefix))
      throw new Error('Refuse cleanup outside owned publication fixtures.')
    await rm(actual, { recursive: true, force: true })
  }
})
describe('actual Docs conditional publisher across asynchronous preparation', () => {
  it.each(['rename', 'delete', 'replacement', 'non-file'] as const)(
    'refuses %s during paused materialization without recreating or overwriting the changed target',
    async (change) => {
      const f = await fixture(),
        gate = deferred(),
        parked = join(f.root, 'moved.docx')
      const work = prepareAndPublishDocx(f.file, f.expected, async () => {
        await gate.promise
        return { bytes: Buffer.from('new authored document') }
      })
      const rejection = expect(work).rejects.toThrow()
      if (change === 'rename') await rename(f.file, parked)
      if (change === 'delete') await unlink(f.file)
      if (change === 'replacement') await writeFile(f.file, 'foreign replacement')
      if (change === 'non-file') {
        await rename(f.file, parked)
        await mkdir(f.file)
        await writeFile(join(f.file, 'foreign.txt'), 'foreign directory')
      }
      gate.resolve()
      await rejection
      if (change === 'rename') {
        expect(await readFile(parked, 'utf8')).toBe('loaded original')
        await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      if (change === 'delete')
        await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' })
      if (change === 'replacement')
        expect(await readFile(f.file, 'utf8')).toBe('foreign replacement')
      if (change === 'non-file')
        expect(await readFile(join(f.file, 'foreign.txt'), 'utf8')).toBe('foreign directory')
    },
  )
  it('publishes an ordinary unchanged loaded version and returns the exact prepared state', async () => {
    const f = await fixture(),
      prepared = { bytes: Buffer.from('authored after edit'), authoredRevision: '17' }
    expect(await prepareAndPublishDocx(f.file, f.expected, async () => prepared)).toBe(prepared)
    expect(await readFile(f.file, 'utf8')).toBe('authored after edit')
  })
  it('uses expected absence for new/Save As and preserves a racing independently created file', async () => {
    const f = await fixture(),
      fresh = join(f.root, 'new.docx'),
      racing = join(f.root, 'racing.docx'),
      gate = deferred()
    await prepareAndPublishDocx(fresh, null, async () => ({ bytes: Buffer.from('new output') }))
    expect(await readFile(fresh, 'utf8')).toBe('new output')
    const work = prepareAndPublishDocx(racing, null, async () => {
        await gate.promise
        return { bytes: Buffer.from('ours') }
      }),
      rejection = expect(work).rejects.toThrow()
    await writeFile(racing, 'other owner')
    gate.resolve()
    await rejection
    expect(await readFile(racing, 'utf8')).toBe('other owner')
    expect(await readFile(f.file, 'utf8')).toBe('loaded original')
  })
  it('captures explicitly selected overwrite authority before preparation and never rebases it afterward', async () => {
    const f = await fixture(),
      target = join(f.root, 'selected.docx')
    await writeFile(target, 'selected prior file')
    const selected = (await readAtomicFileVersion(target))!
    await prepareAndPublishDocx(target, selected, async () => ({
      bytes: Buffer.from('explicit overwrite'),
    }))
    expect(await readFile(target, 'utf8')).toBe('explicit overwrite')
    expect(await readFile(f.file, 'utf8')).toBe('loaded original')
  })
  it('clones input authority before awaiting and refuses unknown loaded authority', async () => {
    const f = await fixture(),
      gate = deferred(),
      version = { ...f.expected }
    const work = prepareAndPublishDocx(f.file, version, async () => {
        await gate.promise
        return { bytes: Buffer.from('ours') }
      }),
      rejection = expect(work).rejects.toThrow()
    await writeFile(f.file, 'replacement')
    Object.assign(version, (await readAtomicFileVersion(f.file))!)
    gate.resolve()
    await rejection
    expect(await readFile(f.file, 'utf8')).toBe('replacement')
    expect(() => loadedDocVersion(undefined)).toThrow('original file version')
  })
})

it('rebinds an owned rename only after matching the immutable loaded bytes, then permits ordinary Save', async () => {
  const f = await fixture(),
    moved = join(f.root, 'renamed.docx')
  await rename(f.file, moved)
  const rebound = await rebindDocRename(moved, f.expected, f.expected.sha256!)
  await prepareAndPublishDocx(moved, rebound, async () => ({
    bytes: Buffer.from('subsequent legitimate edit'),
  }))
  expect(await readFile(moved, 'utf8')).toBe('subsequent legitimate edit')
  await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('never adopts fresh foreign metadata or content as an owned rename baseline', async () => {
  const f = await fixture(),
    moved = join(f.root, 'renamed.docx')
  await rename(f.file, moved)
  await writeFile(moved, 'foreign renamed')
  await expect(rebindDocRename(moved, f.expected, f.expected.sha256!)).rejects.toThrow()
  expect(await readFile(moved, 'utf8')).toBe('foreign renamed')
})

it('a canceled close permission after materialization prevents starting publication and retains original bytes', async () => {
  const f = await fixture(),
    gate = deferred()
  let current = true
  const work = prepareAndPublishDocx(
    f.file,
    f.expected,
    async () => {
      await gate.promise
      return { bytes: Buffer.from('old close snapshot') }
    },
    () => {
      if (!current) throw new Error('close canceled')
    },
  )
  const rejection = expect(work).rejects.toThrow('close canceled')
  current = false
  gate.resolve()
  await rejection
  expect(await readFile(f.file, 'utf8')).toBe('loaded original')
})
