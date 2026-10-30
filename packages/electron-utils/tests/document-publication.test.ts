// @vitest-environment node
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DocumentPublication,
  PublicationReadRegistry,
  absentPublicationTarget,
  observePublicationTarget,
  readPublicationFile,
} from '../src/document-publication'
let root = '',
  priorVault: string | undefined
function gate() {
  let done!: () => void
  const promise = new Promise<void>((resolve) => {
    done = resolve
  })
  return { promise, done }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vantage-publication-'))
  priorVault = process.env.VANTAGE_RECOVERY_ROOT
  process.env.VANTAGE_RECOVERY_ROOT = join(root, 'history')
})
afterEach(async () => {
  if (priorVault === undefined) delete process.env.VANTAGE_RECOVERY_ROOT
  else process.env.VANTAGE_RECOVERY_ROOT = priorVault
  if (!root.startsWith(join(tmpdir(), 'vantage-publication-')))
    throw new Error('Unexpected fixture ownership')
  await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const path = join(root, 'document.html'),
    journal = join(root, 'previous.complete')
  await writeFile(path, 'ORIGINAL COMPLETE')
  await writeFile(journal, 'PREVIOUS COMPLETE JOURNAL')
  const loaded = await readPublicationFile(path, () => readFile(path))
  return { path, journal, publication: new DocumentPublication(loaded.binding) }
}
describe('real conditional publication with immutable loaded/own file versions', () => {
  for (const mode of ['bytes', 'stream'] as const)
    for (const change of ['rename', 'delete', 'replacement'] as const)
      it(
        mode +
          ' refuses ' +
          change +
          ' while actual preparation is paused, retaining current bytes and the last complete journal',
        async () => {
          const f = await fixture(),
            before = f.publication.snapshot(),
            ticket = f.publication.pin(f.path),
            entered = gate(),
            resume = gate(),
            candidate = Buffer.from('NEW COMPLETE UNSAVED DOCUMENT')
          const pending = (
            mode === 'bytes'
              ? f.publication.publishBytes(ticket, async () => {
                  entered.done()
                  await resume.promise
                  return candidate
                })
              : f.publication.publishVia(ticket, async (temporary) => {
                  await writeFile(temporary, candidate)
                  entered.done()
                  await resume.promise
                })
          ).then(
            (value) => ({ value, error: null as any }),
            (error) => ({ value: null, error }),
          )
          await entered.promise
          const moved = join(root, 'moved.html')
          if (change === 'rename') await rename(f.path, moved)
          else if (change === 'delete') await rm(f.path)
          else {
            await rename(f.path, moved)
            await writeFile(f.path, 'EXTERNAL REPLACEMENT')
          }
          resume.done()
          const result = await pending
          expect(result.error).toBeTruthy()
          expect(f.publication.snapshot()).toBe(before)
          expect(await readFile(f.journal, 'utf8')).toBe('PREVIOUS COMPLETE JOURNAL')
          if (change === 'replacement')
            expect(await readFile(f.path, 'utf8')).toBe('EXTERNAL REPLACEMENT')
          else await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(await readFile(result.error.recoveryPath)).toEqual(candidate)
          if (change !== 'delete') expect(await readFile(moved, 'utf8')).toBe('ORIGINAL COMPLETE')
        },
      )
  it('supports ordinary repeated own Save and keeps the same pinned loaded version through preparation', async () => {
    const f = await fixture(),
      first = f.publication.pin(f.path),
      original = first.expectedVersion
    await f.publication.publishBytes(first, async () => Buffer.from('OWN SAVE ONE'))
    expect(first.expectedVersion).toBe(original)
    expect(Object.isFrozen(first.expectedVersion)).toBe(true)
    await f.publication.publishBytes(f.publication.pin(f.path), () => Buffer.from('OWN SAVE TWO'))
    expect(await readFile(f.path, 'utf8')).toBe('OWN SAVE TWO')
    expect(f.publication.snapshot().sha256).not.toBe(first.source.sha256)
  })
  it('publishes Save As to explicit absence and refuses an interloper created after that choice', async () => {
    const f = await fixture(),
      target = join(root, 'copy.html'),
      choice = absentPublicationTarget(target),
      ticket = f.publication.pin(target, choice)
    await writeFile(target, 'INTERLOPER')
    await expect(f.publication.publishBytes(ticket, () => Buffer.from('COPY'))).rejects.toBeTruthy()
    expect(await readFile(target, 'utf8')).toBe('INTERLOPER')
    const free = join(root, 'new-copy.html')
    await f.publication.publishBytes(f.publication.pin(free, absentPublicationTarget(free)), () =>
      Buffer.from('COMPLETE COPY'),
    )
    expect(await readFile(free, 'utf8')).toBe('COMPLETE COPY')
    expect(await readFile(f.path, 'utf8')).toBe('ORIGINAL COMPLETE')
  })
  it('preserves a confirmed Overwrite version across the user decision and later preparation', async () => {
    const f = await fixture(),
      target = join(root, 'chosen.html')
    await writeFile(target, 'CONFIRMED EXTERNAL VERSION')
    const confirmed = await observePublicationTarget(target),
      ticket = f.publication.pin(target, confirmed)
    await rename(target, join(root, 'original-chosen.html'))
    await writeFile(target, 'LATER UNCONFIRMED VERSION')
    await expect(f.publication.publishBytes(ticket, () => Buffer.from('OURS'))).rejects.toBeTruthy()
    expect(await readFile(target, 'utf8')).toBe('LATER UNCONFIRMED VERSION')
    const reconfirmed = await observePublicationTarget(target)
    await f.publication.publishBytes(f.publication.pin(target, reconfirmed), () =>
      Buffer.from('EXPLICITLY CONFIRMED SAVE'),
    )
    expect(await readFile(target, 'utf8')).toBe('EXPLICITLY CONFIRMED SAVE')
  })
  it('rebinds a real Root move only after matching the immutable known SHA and never recreates the old target', async () => {
    const f = await fixture(),
      old = f.publication.pin(f.path),
      moved = join(root, 'moved.html')
    await rename(f.path, moved)
    await f.publication.rebindMoved(f.path, moved)
    await expect(
      f.publication.publishBytes(old, () => Buffer.from('STALE OLD SAVE')),
    ).rejects.toBeTruthy()
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.publication.publishBytes(f.publication.pin(moved), () =>
      Buffer.from('SAVED AT VERIFIED NEW PATH'),
    )
    expect(await readFile(moved, 'utf8')).toBe('SAVED AT VERIFIED NEW PATH')
  })
  it('refuses a foreign move destination or source switch during rebind without changing its known baseline', async () => {
    const f = await fixture(),
      before = f.publication.snapshot(),
      foreign = join(root, 'foreign.html')
    await writeFile(foreign, 'FOREIGN BYTES')
    await expect(f.publication.rebindMoved(f.path, foreign)).rejects.toThrow(/known document/)
    expect(f.publication.snapshot()).toBe(before)
    const moved = join(root, 'moved.html')
    await rename(f.path, moved)
    await expect(f.publication.rebindMoved(f.path, moved, () => false)).rejects.toThrow()
    expect(f.publication.snapshot()).toBe(before)
  })
  it('does not advance a known baseline after failed preparation or an unknown named load', async () => {
    const f = await fixture(),
      before = f.publication.snapshot()
    await expect(
      f.publication.publishBytes(f.publication.pin(f.path), async () => {
        throw new Error('serializer failed')
      }),
    ).rejects.toThrow('serializer failed')
    expect(f.publication.snapshot()).toBe(before)
    expect(() => new DocumentPublication().pin(f.path)).toThrow(/no loaded/)
    expect(await readFile(f.path, 'utf8')).toBe('ORIGINAL COMPLETE')
  })
})
describe('main read-ticket adoption rather than inspection rebasing', () => {
  it('keeps a declined newer inspection from authorizing Save of the older editor body', async () => {
    const f = await fixture(),
      registry = new PublicationReadRegistry<number>(),
      session = {},
      first = await registry.read(
        1,
        session,
        f.path,
        () => readFile(f.path),
        () => true,
      )
    expect(registry.adopt(1, session, 'source-A', f.path, first.publicationId)).toBe(true)
    await writeFile(f.path, 'NEWER EXTERNAL BODY')
    const inspected = await registry.read(
        1,
        session,
        f.path,
        () => readFile(f.path),
        () => true,
      ),
      active = registry.select(1, session, 'source-A', first.publicationId, f.path)
    await expect(
      active.publication.publishBytes(active.publication.pin(f.path), () =>
        Buffer.from('OLDER EDITOR BODY'),
      ),
    ).rejects.toBeTruthy()
    expect(await readFile(f.path, 'utf8')).toBe('NEWER EXTERNAL BODY')
    expect(registry.adopt(1, session, 'source-B', f.path, inspected.publicationId)).toBe(true)
    const reloaded = registry.select(1, session, 'source-B', inspected.publicationId, f.path)
    await reloaded.publication.publishBytes(reloaded.publication.pin(f.path), () =>
      Buffer.from('EDITED RELOADED BODY'),
    )
    expect(await readFile(f.path, 'utf8')).toBe('EDITED RELOADED BODY')
  })
  it('does not let a late old read or acknowledgment install into a replacement owner session', async () => {
    const f = await fixture(),
      registry = new PublicationReadRegistry<number>(),
      old = {},
      next = {},
      entered = gate(),
      resume = gate()
    const reading = registry
      .read(
        1,
        old,
        f.path,
        async () => {
          const bytes = await readFile(f.path)
          entered.done()
          await resume.promise
          return bytes
        },
        () => false,
      )
      .then(
        () => null,
        (error) => error,
      )
    await entered.promise
    const latest = await registry.read(
      1,
      next,
      f.path,
      () => readFile(f.path),
      () => true,
    )
    resume.done()
    expect(await reading).toBeTruthy()
    expect(registry.adopt(1, old, 'old-source', f.path, latest.publicationId)).toBe(false)
    expect(registry.adopt(1, next, 'new-source', f.path, latest.publicationId)).toBe(true)
    expect(() => registry.select(1, next, 'old-source', latest.publicationId, f.path)).toThrow()
  })
  it('keeps the adopted ticket across bounded unused inspection churn', async () => {
    const f = await fixture(),
      registry = new PublicationReadRegistry<number>(),
      session = {},
      first = await registry.read(
        1,
        session,
        f.path,
        () => readFile(f.path),
        () => true,
      )
    registry.adopt(1, session, 'source', f.path, first.publicationId)
    for (let i = 0; i < 15; i++)
      await registry.read(
        1,
        session,
        f.path,
        () => readFile(f.path),
        () => true,
      )
    expect(
      registry.select(1, session, 'source', first.publicationId, f.path).publication.snapshot()
        .sha256,
    ).toBeTruthy()
    expect((await readdir(root)).filter((name) => name.endsWith('.html'))).toEqual([
      'document.html',
    ])
  })
})
