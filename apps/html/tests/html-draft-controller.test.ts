// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HtmlDraftController, type HtmlDraftDependencies } from '../src/main/html-draft-controller'
import {
  discardDraftJournal,
  listDraftJournal,
  readDraftJournal,
  writeDraftJournal,
} from '../../../packages/electron-utils/src/draft-journal'
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const data = (text: string) => Uint8Array.from(Buffer.from(text)).buffer
async function fixture(overrides: Partial<HtmlDraftDependencies> = {}) {
  const directory = await mkdtemp(
    join(process.env.VANTAGE_VALIDATION_TEMP || tmpdir(), 'vantage-html-controller-'),
  )
  directories.push(directory)
  const root = join(directory, 'recovery'),
    first = join(directory, 'first.html'),
    second = join(directory, 'second.html'),
    live = new Set([1, 2])
  const controller = new HtmlDraftController({
    recoveryRoot: () => root,
    isLive: (owner) => live.has(owner),
    canWritePath: (_owner, path) => path === first || path === second,
    prepare: (_owner, _path, bytes) => ({ bytes, remoteReferences: 0 }),
    ...overrides,
  })
  const snapshot = (
    token: string,
    sequence: number,
    text: string,
    documentPath: string | null = null,
    revision = sequence,
  ) => controller.snapshot(1, { token, sequence, revision, documentPath, data: data(text) })
  return { directory, root, first, second, controller, snapshot, live }
}
describe('HTML draft identity and lifecycle', () => {
  it('journals untitled text without publishing a normal file', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, null)
    expect(await f.snapshot(token, 1, '<p>unsaved</p>')).toEqual({
      written: true,
      remoteReferences: 0,
    })
    expect(await readdir(f.directory)).toEqual(['recovery'])
    expect((await readDraftJournal(f.root, token)).entry).toMatchObject({
      module: 'html',
      documentPath: null,
      extension: '.html',
    })
  })
  it('retains a deliberately empty named document', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, '', f.first)
    expect((await readDraftJournal(f.root, token)).bytes.length).toBe(0)
  })
  it('keeps current ownership when a granted candidate open is canceled', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, 'current', f.first)
    expect((await f.snapshot(token, 2, 'candidate', f.second)).written).toBe(false)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('current')
  })
  it('rejects a slow earlier revision after newer pending typing', async () => {
    const release = deferred<{ bytes: Buffer; remoteReferences: number }>(),
      f = await fixture({ prepare: () => release.promise }),
      token = f.controller.activate(1, null)
    const snapshot = f.snapshot(token, 1, 'old')
    f.controller.changed(1, { token, revision: 2, dirty: true })
    release.resolve({ bytes: Buffer.from('old'), remoteReferences: 0 })
    expect((await snapshot).written).toBe(false)
    expect(await listDraftJournal(f.root)).toHaveLength(0)
  })
  it('fences pre-save serialization and clean undo-to-original for untitled drafts', async () => {
    const release = deferred<{ bytes: Buffer; remoteReferences: number }>(),
      f = await fixture({ prepare: () => release.promise }),
      token = f.controller.activate(1, null)
    const snapshot = f.snapshot(token, 1, 'old')
    await f.controller.acknowledgeSaved(1, {
      token,
      revision: 1,
      throughSequence: 1,
      documentPath: null,
      clean: true,
    })
    release.resolve({ bytes: Buffer.from('old'), remoteReferences: 0 })
    expect((await snapshot).written).toBe(false)
    expect(await listDraftJournal(f.root)).toHaveLength(0)
  })
  it('keeps newer dirty state when an older save returns and binds Save As to its real path', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'before save')
    await f.snapshot(token, 2, 'typed during save')
    expect(
      await f.controller.acknowledgeSaved(1, {
        token,
        revision: 1,
        throughSequence: 1,
        documentPath: f.first,
        clean: true,
      }),
    ).toBe(false)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('typed during save')
    expect((await f.snapshot(token, 3, 'later named edit', f.first)).written).toBe(true)
  })
  it('never overwrites a faster completed newer snapshot', async () => {
    const release = deferred<{ bytes: Buffer; remoteReferences: number }>(),
      f = await fixture({
        prepare: (_owner, _path, bytes) =>
          bytes.toString() === 'old' ? release.promise : { bytes, remoteReferences: 0 },
      }),
      token = f.controller.activate(1, null)
    const old = f.snapshot(token, 1, 'old')
    await f.snapshot(token, 2, 'new')
    release.resolve({ bytes: Buffer.from('old'), remoteReferences: 0 })
    expect((await old).written).toBe(false)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('new')
  })
  it('waits for an in-flight write before discard and forbids resurrection', async () => {
    const entered = deferred<void>(),
      release = deferred<void>(),
      f = await fixture({
        write: async (...args) => {
          entered.resolve()
          await release.promise
          return writeDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, null)
    const snapshot = f.snapshot(token, 1, 'discard')
    await entered.promise
    const discard = f.controller.discardCurrent(1)
    release.resolve()
    await Promise.all([snapshot, discard])
    expect(await listDraftJournal(f.root)).toHaveLength(0)
    await expect(f.snapshot(token, 2, 'late')).rejects.toThrow('activation')
  })
  it('refuses failed discard but allows a new snapshot on the still-open document', async () => {
    let fail = true
    const f = await fixture({
        discard: async (...args) => {
          if (fail) throw new Error('disk refused')
          await discardDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'good')
    await expect(f.controller.discardCurrent(1)).rejects.toThrow('disk refused')
    expect((await f.snapshot(token, 1, 'old')).written).toBe(false)
    expect((await f.snapshot(token, 2, 'new')).written).toBe(true)
    fail = false
    await f.controller.discardCurrent(1)
    expect(await listDraftJournal(f.root)).toHaveLength(0)
  })
  it('preserves the prior entry across missing assets, quota/storage failure and oversize output', async () => {
    let mode = ''
    const f = await fixture({
        prepare: (_owner, _path, bytes) => {
          if (mode === 'missing') throw new Error('missing asset')
          return {
            bytes: mode === 'oversize' ? Buffer.alloc(16 * 1024 * 1024 + 1) : bytes,
            remoteReferences: 0,
          }
        },
        write: (...args) => {
          if (mode === 'quota') throw new Error('draft quota reached')
          return writeDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'known good')
    for (const [index, failure] of ['missing', 'quota', 'oversize'].entries()) {
      mode = failure
      await expect(f.snapshot(token, index + 2, 'bad')).rejects.toThrow()
      expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('known good')
    }
  })
  it('isolates document activations and view owners and keeps a committed crash copy', async () => {
    const f = await fixture(),
      first = f.controller.activate(1, f.first)
    await f.snapshot(first, 1, 'first', f.first)
    const second = f.controller.activate(1, f.second)
    await expect(f.snapshot(first, 2, 'old', f.first)).rejects.toThrow('activation')
    await expect(
      f.controller.snapshot(2, {
        token: second,
        sequence: 1,
        revision: 1,
        documentPath: f.second,
        data: data('cross view'),
      }),
    ).rejects.toThrow('activation')
    await f.snapshot(second, 1, 'second', f.second)
    f.controller.retire(1)
    f.live.delete(1)
    expect((await readDraftJournal(f.root, first)).bytes.toString()).toBe('first')
    expect((await readDraftJournal(f.root, second)).bytes.toString()).toBe('second')
  })
})

describe('same-UUID Reload journal/content epoch fences', () => {
  it('removes only the old automatic journal and preserves sequence monotonicity and unrelated history', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, f.first),
      other = f.controller.activate(2, f.second)
    await f.snapshot(token, 1, 'old source', f.first)
    await f.controller.snapshot(2, {
      token: other,
      sequence: 1,
      revision: 1,
      documentPath: f.second,
      data: data('unrelated history'),
    })
    const operation = f.controller.sourceOperationFor(1)
    await f.controller.applyReload(1, {
      token,
      documentPath: f.first,
      previousRevision: 1,
      revision: 2,
      throughSequence: 1,
    })
    expect(f.controller.tokenFor(1)).toBe(token)
    expect(f.controller.sourceOperationFor(1)).not.toBe(operation)
    expect((await listDraftJournal(f.root)).map((entry) => entry.id)).toEqual([other])
    expect((await f.snapshot(token, 1, 'late old source', f.first, 1)).written).toBe(false)
    expect((await f.snapshot(token, 2, 'new post-reload edit', f.first, 3)).written).toBe(true)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('new post-reload edit')
  })
  it('fences old snapshot sequences allocated before Reload but delivered afterward', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, 'known source', f.first, 1)
    await f.controller.applyReload(1, {
      token,
      documentPath: f.first,
      previousRevision: 1,
      revision: 2,
      throughSequence: 5,
    })
    expect(
      (await f.snapshot(token, 5, 'renderer serialization started before Reload', f.first, 1))
        .written,
    ).toBe(false)
    expect((await f.snapshot(token, 6, 'new edit', f.first, 3)).written).toBe(true)
  })
  it('checks the floor after an in-flight old commit and then removes it before reporting cleanup complete', async () => {
    const entered = deferred<void>(),
      release = deferred<void>(),
      f = await fixture({
        write: async (...args) => {
          entered.resolve()
          await release.promise
          return writeDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, f.first)
    const old = f.snapshot(token, 1, 'old in-flight source', f.first, 1)
    await entered.promise
    const reload = f.controller.applyReload(1, {
      token,
      documentPath: f.first,
      previousRevision: 1,
      revision: 2,
      throughSequence: 1,
    })
    release.resolve()
    expect((await old).written).toBe(false)
    await reload
    expect(await listDraftJournal(f.root)).toHaveLength(0)
  })
  it('orders a newer post-Reload edit after old in-flight commit and cleanup without deleting it', async () => {
    const entered = deferred<void>(),
      release = deferred<void>()
    let calls = 0
    const f = await fixture({
        write: async (...args) => {
          if (++calls === 1) {
            entered.resolve()
            await release.promise
          }
          return writeDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, f.first)
    const old = f.snapshot(token, 1, 'old in-flight', f.first, 1)
    await entered.promise
    const reload = f.controller.applyReload(1, {
      token,
      documentPath: f.first,
      previousRevision: 1,
      revision: 2,
      throughSequence: 1,
    })
    const fresh = f.snapshot(token, 2, 'post-Reload typing survives', f.first, 3)
    release.resolve()
    await Promise.all([old, reload, fresh])
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe(
      'post-Reload typing survives',
    )
  })
  it('preserves good recovery on cleanup failure and still allows newer edits', async () => {
    let fail = true
    const f = await fixture({
        discard: async (...args) => {
          if (fail) throw new Error('cleanup storage refused')
          await discardDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, 'known good', f.first, 1)
    await expect(
      f.controller.applyReload(1, {
        token,
        documentPath: f.first,
        previousRevision: 1,
        revision: 2,
        throughSequence: 1,
      }),
    ).rejects.toThrow('cleanup storage refused')
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('known good')
    fail = false
    await f.snapshot(token, 2, 'new edit after Reload', f.first, 3)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('new edit after Reload')
  })
  it('rejects old Save receipts before path rebinding or cleanup and rejects stale Reload epochs', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, 'old source', f.first, 1)
    await f.controller.applyReload(1, {
      token,
      documentPath: f.first,
      previousRevision: 1,
      revision: 2,
      throughSequence: 1,
    })
    expect(f.controller.acceptsSourceRevision(1, token, 1)).toBe(false)
    expect(f.controller.acceptsSourceRevision(1, token, 2)).toBe(true)
    expect(
      await f.controller.acknowledgeSaved(1, {
        token,
        revision: 1,
        throughSequence: 1,
        documentPath: f.second,
        clean: true,
      }),
    ).toBe(false)
    expect(f.controller.pathFor(1)).toBe(f.first)
    await expect(
      f.controller.applyReload(1, {
        token,
        documentPath: f.first,
        previousRevision: 1,
        revision: 2,
        throughSequence: 1,
      }),
    ).rejects.toThrow('obsolete')
  })
  it('does not remove a newer snapshot already committed before older cleanup arrives', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, 'old source', f.first, 1)
    await f.snapshot(token, 2, 'newer source', f.first, 3)
    await f.controller.applyReload(1, {
      token,
      documentPath: f.first,
      previousRevision: 1,
      revision: 2,
      throughSequence: 1,
    })
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('newer source')
  })
})
