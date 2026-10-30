import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  publishNewUserOutput,
  publishSelectedUserOutput,
  publishSelectedUserOutputs,
  withPinnedAssetOutput,
  UserOutputSelections,
} from '../src/user-output-publication'
import { reserveFileMutation, withFilePublication } from '../src/file-publication-exclusion'
import { atomicWriteFile } from '../src/atomic-write'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const prefix = join(tmpdir(), 'vantage-user-output-')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(prefix)
})
afterEach(() => {
  if (!dir.startsWith(prefix)) throw new Error('Unexpected test root')
  rmSync(dir, { recursive: true, force: true })
})

it('pins a selected existing destination before lazy rendering and preserves a peer replacement', async () => {
  const path = join(dir, 'selected.png'),
    started = deferred(),
    finish = deferred()
  writeFileSync(path, 'selected original')
  const save = publishSelectedUserOutput(path, async () => {
    started.resolve()
    await finish.promise
    return Buffer.from('rendered')
  })
  await started.promise
  writeFileSync(path, 'peer content')
  finish.resolve()
  await expect(save).rejects.toMatchObject({ vantageCode: 'SAVE_NOT_PUBLISHED' })
  expect(readFileSync(path, 'utf8')).toBe('peer content')
})

it('reserves every selected batch target before rendering, including a later target being moved', async () => {
  const first = join(dir, 'page-01.png'),
    second = join(dir, 'page-02.png'),
    moved = join(dir, 'moved.png')
  writeFileSync(first, 'first original')
  writeFileSync(second, 'second original')
  const started = deferred(),
    render = deferred(),
    adopted = deferred(),
    finishAdoption = deferred()
  const save = publishSelectedUserOutputs(
    [
      {
        path: first,
        prepare: async () => {
          started.resolve()
          await render.promise
          return Buffer.from('first rendered')
        },
      },
      { path: second, prepare: async () => Buffer.from('second rendered') },
    ],
    {
      afterPublished: async () => {
        adopted.resolve()
        await finishAdoption.promise
      },
    },
  )
  await started.promise
  const mutation = reserveFileMutation([
    { path: second, kind: 'file' },
    { path: moved, kind: 'file' },
  ])
  let movedNow = false
  const move = mutation.run(async () => {
    renameSync(second, moved)
    movedNow = true
  })
  expect(mutation.isReady()).toBe(false)
  render.resolve()
  await adopted.promise
  expect(movedNow).toBe(false)
  expect(readFileSync(second, 'utf8')).toBe('second rendered')
  finishAdoption.resolve()
  await save
  await move
  expect(existsSync(second)).toBe(false)
  expect(readFileSync(moved, 'utf8')).toBe('second rendered')
})

it('never overwrites a peer that wins a generated fresh output name', async () => {
  const path = join(dir, 'generated.pdf')
  writeFileSync(path, 'peer won the name')
  await expect(publishNewUserOutput(path, Buffer.from('generated output'))).rejects.toMatchObject({
    vantageCode: 'SAVE_NOT_PUBLISHED',
  })
  expect(readFileSync(path, 'utf8')).toBe('peer won the name')
})

it('refuses a stale captured source synchronously before any publication namespace or rendering starts', async () => {
  const oldDir = join(dir, 'old'),
    newDir = join(dir, 'new')
  mkdirSync(oldDir)
  renameSync(oldDir, newDir)
  const prepare = vi.fn(async () => Buffer.from('obsolete'))
  expect(() =>
    publishSelectedUserOutput(join(oldDir, 'old.png'), prepare, {
      assertCurrent: () => {
        throw new Error('source moved')
      },
    }),
  ).toThrow('source moved')
  expect(prepare).not.toHaveBeenCalled()
  expect(existsSync(oldDir)).toBe(false)
})

it('an admitted directory operation can finish its own child publication while a move drains it', async () => {
  const source = join(dir, 'assets'),
    destination = join(dir, 'moved-assets')
  mkdirSync(source)
  const ready = deferred(),
    finish = deferred()
  const save = withFilePublication({ targetPath: source, targetKind: 'directory' }, async () => {
    ready.resolve()
    await finish.promise
    await atomicWriteFile(join(source, 'image.png'), Buffer.from('owned image'), {
      expectedVersion: null,
    })
  })
  await ready.promise
  const mutation = reserveFileMutation([
    { path: source, kind: 'directory' },
    { path: destination, kind: 'directory' },
  ])
  const move = mutation.run(async () => {
    renameSync(source, destination)
  })
  finish.resolve()
  await save
  await move
  expect(readFileSync(join(destination, 'image.png'), 'utf8')).toBe('owned image')
  expect(existsSync(source)).toBe(false)
})

it('directory ancestry cannot authorize a new outside target covered by the same mutation', async () => {
  const namespace = join(dir, 'assets'),
    outside = join(dir, 'outside.docx')
  mkdirSync(namespace)
  const ready = deferred(),
    proceed = deferred()
  const save = withFilePublication({ targetPath: namespace, targetKind: 'directory' }, async () => {
    ready.resolve()
    await proceed.promise
    await withFilePublication({ targetPath: outside }, async () => {
      writeFileSync(outside, 'must not publish')
    })
  })
  await ready.promise
  const mutation = reserveFileMutation([
    { path: namespace, kind: 'directory' },
    { path: outside, kind: 'file' },
  ])
  proceed.resolve()
  await expect(save).rejects.toMatchObject({ code: 'VANTAGE_FILE_MUTATION_PENDING' })
  await mutation.run(async () => undefined)
  expect(existsSync(outside)).toBe(false)
})

it('bounds batch namespaces before touching outputs or rendering', async () => {
  const prepare = vi.fn(async () => Buffer.from('unused'))
  await expect(
    publishSelectedUserOutputs(
      Array.from({ length: 4097 }, (_, i) => ({ path: join(dir, `${i}.png`), prepare })),
    ),
  ).rejects.toThrow('smaller batch')
  expect(prepare).not.toHaveBeenCalled()
})

it('SaveAs owns its asset namespace, document and actual main adoption/cleanup before a folder move', async () => {
  const sourceDir = join(dir, 'source'),
    targetDir = join(dir, 'target'),
    movedDir = join(dir, 'moved')
  mkdirSync(sourceDir)
  mkdirSync(targetDir)
  const source = join(sourceDir, 'source.md'),
    target = join(targetDir, 'target.md')
  writeFileSync(source, 'loaded source')
  const started = deferred(),
    materialize = deferred(),
    adopted = deferred(),
    cleanup = deferred()
  let sourceCurrent = true
  const save = withPinnedAssetOutput(
    {
      targetPath: target,
      expectedVersion: null,
      sourceDocumentPath: source,
      assertCurrent: () => {
        if (!sourceCurrent) throw new Error('obsolete source')
      },
    },
    async () => {
      started.resolve()
      await materialize.promise
      mkdirSync(join(targetDir, 'assets'))
      await atomicWriteFile(join(targetDir, 'assets', 'image.png'), Buffer.from('image'), {
        expectedVersion: null,
      })
      await atomicWriteFile(target, Buffer.from('![](assets/image.png)'), { expectedVersion: null })
      sourceCurrent = false
      adopted.resolve()
      await cleanup.promise
    },
  )
  await started.promise
  const mutation = reserveFileMutation([
    { path: targetDir, kind: 'directory' },
    { path: movedDir, kind: 'directory' },
  ])
  let moved = false
  const move = mutation.run(async () => {
    renameSync(targetDir, movedDir)
    moved = true
  })
  materialize.resolve()
  await adopted.promise
  expect(moved).toBe(false)
  cleanup.resolve()
  await save
  await move
  expect(readFileSync(join(movedDir, 'target.md'), 'utf8')).toBe('![](assets/image.png)')
  expect(readFileSync(join(movedDir, 'assets', 'image.png'), 'utf8')).toBe('image')
  expect(existsSync(targetDir)).toBe(false)
})

it('a vanished selected SaveAs parent refuses before asset mkdir can recreate the old namespace', () => {
  const selected = join(dir, 'selected'),
    moved = join(dir, 'moved')
  mkdirSync(selected)
  renameSync(selected, moved)
  const actual = vi.fn(async () => undefined)
  expect(() =>
    withPinnedAssetOutput(
      { targetPath: join(selected, 'new.md'), expectedVersion: null, assertCurrent: () => {} },
      actual,
    ),
  ).toThrow()
  expect(actual).not.toHaveBeenCalled()
  expect(existsSync(selected)).toBe(false)
})

it('an admitted file owner cannot add an undeclared source path covered by the same Root mutation', async () => {
  const target = join(dir, 'target.docx'),
    outside = join(dir, 'outside.png'),
    ready = deferred(),
    proceed = deferred()
  const owner = withFilePublication({ targetPath: target }, async () => {
    ready.resolve()
    await proceed.promise
    await withFilePublication({ targetPath: target, sourcePaths: [outside] }, async () => undefined)
  })
  await ready.promise
  const mutation = reserveFileMutation([
    { path: target, kind: 'file' },
    { path: outside, kind: 'file' },
  ])
  proceed.resolve()
  await expect(owner).rejects.toMatchObject({ code: 'VANTAGE_FILE_MUTATION_PENDING' })
  await mutation.run(async () => undefined)
})

it('the main picker receipt survives renderer work without adopting a moved selected file as absence', async () => {
  const target = join(dir, 'selected.pdf'),
    moved = join(dir, 'moved.pdf')
  writeFileSync(target, 'selected original')
  const registry = new UserOutputSelections<object>(),
    owner = { id: 7 }
  const id = await registry.capture(owner, [target])
  // This happens after the picker returns but BEFORE renderer SVG/PNG work
  // sends its final export message. No user output was admitted yet.
  const mutation = reserveFileMutation([
    { path: target, kind: 'file' },
    { path: moved, kind: 'file' },
  ])
  await mutation.run(async () => {
    renameSync(target, moved)
  })
  const selected = registry.claim(owner, id, [target]),
    prepare = vi.fn(async () => Buffer.from('late rendered export'))
  await expect(
    publishSelectedUserOutput(target, prepare, selected.proof, selected.versions[0]!),
  ).rejects.toMatchObject({ code: 'VANTAGE_SAVE_CONFLICT' })
  expect(prepare).not.toHaveBeenCalled()
  expect(existsSync(target)).toBe(false)
  expect(readFileSync(moved, 'utf8')).toBe('selected original')
})

it('main selection IDs require the exact owner, path and one-time original grant', async () => {
  const target = join(dir, 'selected.png'),
    registry = new UserOutputSelections<object>(),
    owner = { id: 7 },
    copy = { id: 7 }
  const id = await registry.capture(owner, [target])
  expect(() => registry.claim(copy, id, [target])).toThrow('unavailable')
  const selected = registry.claim(owner, id, [target])
  expect(selected.versions).toEqual([null])
  expect(() => registry.claim(owner, id, [target])).toThrow('unavailable')
  const other = await registry.capture(owner, [target])
  expect(() => registry.claim(owner, other, [join(dir, 'other.png')])).toThrow('changed or expired')
})

it('selection consumption rechecks the original loaded session/source proof after rendering', async () => {
  const target = join(dir, 'selected.png'),
    registry = new UserOutputSelections<object>(),
    owner = {},
    session = { current: true }
  const id = await registry.capture(owner, [target], {
    assertCurrent: () => {
      if (!session.current) throw new Error('loaded source changed')
    },
  })
  session.current = false
  expect(() => registry.claim(owner, id, [target])).toThrow('loaded source changed')
  expect(existsSync(target)).toBe(false)
})

it('unused selection expiry revokes only permission, before any publication can start', async () => {
  let now = 10
  const target = join(dir, 'selected.png'),
    registry = new UserOutputSelections<object>(() => now),
    owner = {}
  const id = await registry.capture(owner, [target])
  now += 300_001
  expect(() => registry.claim(owner, id, [target])).toThrow('expired')
  expect(existsSync(target)).toBe(false)
})
