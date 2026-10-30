// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discardDraftJournal,
  listDraftJournal,
  readDraftJournal,
} from '../../../packages/electron-utils/src/draft-journal'
import {
  SlidesDraftController,
  type SlidesDraftDependencies,
} from '../src/main/slides-draft-controller'

const roots: string[] = []
const turn = () => new Promise<void>((done) => setImmediate(done))
function deferred<T>() {
  let done!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    done = resolve
  })
  return { promise, done }
}
async function fixture(overrides: Partial<SlidesDraftDependencies> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vantage-slides-controller-'))
  roots.push(root)
  const source = { path: join(root, 'original.pptx') }
  const sources = new Map([
    [1, source],
    [2, source],
  ])
  let revision = '1:0'
  const dependencies: SlidesDraftDependencies = {
    recoveryRoot: () => root,
    sourceFor: (owner) => sources.get(owner),
    revisionFor: () => revision,
    isLive: (owner) => sources.has(owner),
    capture: (_owner, pending) => async () => Buffer.from(JSON.stringify(pending)),
    ...overrides,
  }
  const controller = new SlidesDraftController(dependencies)
  const token = controller.activate(1, source.path)
  const request = (sequence: number, pending = {}, ownerToken = token) => ({
    token: ownerToken,
    sequence,
    expectedRevision: revision,
    documentPath: source.path,
    pending,
  })
  return {
    root,
    source,
    sources,
    controller,
    token,
    request,
    setRevision: (value: string) => {
      revision = value
    },
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith('vantage-slides-controller-')
    )
      throw new Error('Unexpected fixture cleanup path')
    await rm(absolute, { recursive: true, force: true })
  }
})

describe('per-view presentation recovery ownership', () => {
  it('projects bounded queue metadata and never copies unrelated caller fields', async () => {
    const f = await fixture()
    const request = {
      ...f.request(1),
      get unrelated() {
        throw new Error('Unbudgeted field was retained')
      },
    }
    expect(await f.controller.snapshot(1, request)).toBe(true)
    await expect(
      f.controller.snapshot(1, { ...f.request(2), expectedRevision: 'x'.repeat(129) }),
    ).rejects.toThrow('Invalid')
    await expect(
      f.controller.snapshot(1, { ...f.request(2), documentPath: '/' + 'x'.repeat(32769) }),
    ).rejects.toThrow('Invalid')
  })
  it('rejects a queued overlay when the same Source commits newer state while another serialization is blocked', async () => {
    const blocked = deferred<Buffer>()
    let hold = false
    let captures = 0
    const f = await fixture({
      capture: (_owner, pending) => {
        captures++
        return hold ? () => blocked.promise : async () => Buffer.from(JSON.stringify(pending))
      },
    })
    await f.controller.snapshot(
      1,
      f.request(1, { notes: { slideIndex: 0, text: 'last good', baseline: '' } }),
    )
    hold = true
    const first = f.controller.snapshot(1, f.request(2))
    await turn()
    const queued = f.controller.snapshot(
      1,
      f.request(3, { notes: { slideIndex: 0, text: 'stale queued overlay', baseline: '' } }),
    )
    // The Session object and path survive, but a committed operation or
    // replacement parse changed the model revision while this request waited.
    f.setRevision('2:1')
    const refused = expect(queued).rejects.toThrow('presentation changed')
    blocked.done(Buffer.from('superseded'))
    expect(await first).toBe(false)
    await refused
    expect(captures).toBe(2)
    expect((await readDraftJournal(f.root, f.token)).bytes.toString()).toContain('last good')
    hold = false
    expect(await f.controller.snapshot(1, f.request(4))).toBe(true)
  })
  it('refuses a source edit made during serialization and keeps the earlier complete journal', async () => {
    const blocked = deferred<Buffer>()
    let hold = false
    const f = await fixture({
      capture: () => (hold ? () => blocked.promise : async () => Buffer.from('last complete')),
    })
    await f.controller.snapshot(1, f.request(1))
    hold = true
    const pending = f.controller.snapshot(1, f.request(2))
    await turn()
    f.setRevision('2:0')
    const refused = expect(pending).rejects.toThrow('presentation changed')
    blocked.done(Buffer.from('old revision'))
    await refused
    expect((await readDraftJournal(f.root, f.token)).bytes.toString()).toBe('last complete')
  })
  it('writes the shared bounded journal and clears only its saved caller watermark', async () => {
    const f = await fixture()
    expect(
      await f.controller.snapshot(
        1,
        f.request(1, { notes: { slideIndex: 0, text: 'pending', baseline: '' } }),
      ),
    ).toBe(true)
    const [entry] = await listDraftJournal(f.root)
    expect(entry).toMatchObject({
      id: f.token,
      module: 'slides',
      extension: '.pptx',
      documentPath: f.source.path,
    })
    expect((await readDraftJournal(f.root, f.token)).bytes.toString()).toContain('pending')
    await f.controller.acknowledgeSaved(1, {
      token: f.token,
      throughSequence: 1,
      documentPath: f.source.path,
      clean: true,
    })
    expect(await listDraftJournal(f.root)).toEqual([])
    expect(await f.controller.snapshot(1, f.request(1))).toBe(false)
    expect(await f.controller.snapshot(1, f.request(2))).toBe(true)
  })
  it('rejects stale/out-of-order sequences and copies pending input before awaiting', async () => {
    const capture = deferred<Buffer>()
    const captured: unknown[] = []
    let first = true
    const f = await fixture({
      capture: (_owner, pending) => {
        captured.push(structuredClone(pending))
        if (first) {
          first = false
          return () => capture.promise
        }
        return async () => Buffer.from(JSON.stringify(pending))
      },
    })
    const old = f.controller.snapshot(1, f.request(1))
    await turn()
    const pending = { notes: { slideIndex: 0, text: 'original request', baseline: '' } }
    const next = f.controller.snapshot(1, f.request(2, pending))
    pending.notes.text = 'mutated by caller'
    capture.done(Buffer.from('old'))
    expect(await old).toBe(false)
    expect(await next).toBe(true)
    expect(captured.at(-1)).toEqual({
      notes: { slideIndex: 0, text: 'original request', baseline: '' },
    })
    expect(await f.controller.snapshot(1, f.request(2))).toBe(false)
  })
  it('fences a snapshot still serializing when a real save is acknowledged', async () => {
    const prepared = deferred<Buffer>()
    const f = await fixture({ capture: () => () => prepared.promise })
    const pending = f.controller.snapshot(1, f.request(1))
    await turn()
    await f.controller.acknowledgeSaved(1, {
      token: f.token,
      throughSequence: 1,
      documentPath: f.source.path,
      clean: true,
    })
    prepared.done(Buffer.from('older than saved'))
    expect(await pending).toBe(false)
    expect(await listDraftJournal(f.root)).toEqual([])
  })
  it('keeps a newer dirty journal when an older save finishes', async () => {
    const f = await fixture()
    await f.controller.snapshot(
      1,
      f.request(2, { notes: { slideIndex: 0, text: 'newer', baseline: '' } }),
    )
    await f.controller.acknowledgeSaved(1, {
      token: f.token,
      throughSequence: 1,
      documentPath: f.source.path,
      clean: true,
    })
    expect((await readDraftJournal(f.root, f.token)).bytes.toString()).toContain('newer')
    await f.controller.acknowledgeSaved(1, {
      token: f.token,
      throughSequence: 2,
      documentPath: f.source.path,
      clean: false,
    })
    expect(await listDraftJournal(f.root)).toHaveLength(1)
  })
  it('preserves peer overlays across aliases, caller save, retirement and path changes', async () => {
    const f = await fixture()
    const peer = f.controller.activate(2, f.source.path)
    await f.controller.snapshot(
      1,
      f.request(1, { notes: { slideIndex: 0, text: 'first view', baseline: '' } }),
    )
    await f.controller.snapshot(
      2,
      f.request(1, { notes: { slideIndex: 0, text: 'peer view', baseline: '' } }, peer),
    )
    await f.controller.acknowledgeSaved(1, {
      token: f.token,
      throughSequence: 1,
      documentPath: f.source.path,
      clean: true,
    })
    expect((await listDraftJournal(f.root)).map((entry) => entry.id)).toEqual([peer])
    f.controller.retire(1)
    const oldPath = f.source.path
    f.source.path = join(f.root, 'renamed.pptx')
    f.controller.rename(f.source, oldPath, f.source.path)
    expect(
      await f.controller.snapshot(2, { ...f.request(2, {}, peer), documentPath: oldPath }),
    ).toBe(false)
    expect(
      await f.controller.snapshot(
        2,
        f.request(2, { notes: { slideIndex: 0, text: 'peer after rename', baseline: '' } }, peer),
      ),
    ).toBe(true)
    expect((await readDraftJournal(f.root, peer)).entry.documentPath).toBe(f.source.path)
  })
  it('binds activation to the successful Session identity, even if a replacement uses the same path', async () => {
    const f = await fixture()
    f.sources.set(1, { path: f.source.path })
    expect(await f.controller.snapshot(1, f.request(1))).toBe(false)
    expect(f.controller.tokenFor(1)).toBe(null)
    expect(() => f.controller.activate(1, join(f.root, 'not-open.pptx'))).toThrow('different')
    const token = f.controller.activate(1, f.source.path)
    expect(token).not.toBe(f.token)
    expect(await f.controller.snapshot(1, f.request(1, {}, token))).toBe(true)
  })
  it('Root discard invalidates an active preparation before storage awaits', async () => {
    const prepared = deferred<Buffer>()
    const f = await fixture({ capture: () => () => prepared.promise })
    const pending = f.controller.snapshot(1, f.request(1))
    await turn()
    const decision = f.controller.discardCurrent(1)
    expect(f.controller.tokenFor(1)).toBe(null)
    prepared.done(Buffer.from('must not return'))
    await decision
    expect(await pending).toBe(false)
    expect(await listDraftJournal(f.root)).toEqual([])
  })
  it('a refused discard restores the active producer while rejecting pre-decision snapshots', async () => {
    const f = await fixture({
      discard: vi
        .fn()
        .mockRejectedValueOnce(new Error('disk refused deletion'))
        .mockImplementation(discardDraftJournal),
    })
    await f.controller.snapshot(1, f.request(1))
    await expect(f.controller.discardCurrent(1)).rejects.toThrow('refused')
    expect(f.controller.tokenFor(1)).toBe(f.token)
    expect(await f.controller.snapshot(1, f.request(1))).toBe(false)
    expect(await f.controller.snapshot(1, f.request(2))).toBe(true)
  })
  it('serializes captures and bounds the queued work without replacing the prior draft', async () => {
    const prepared = deferred<Buffer>()
    let captures = 0
    const f = await fixture({
      capture: () => {
        captures++
        return captures === 1 ? () => prepared.promise : async () => Buffer.from('latest')
      },
    })
    const requests = [f.controller.snapshot(1, f.request(1))]
    await turn()
    for (let sequence = 2; sequence <= 16; sequence++)
      requests.push(f.controller.snapshot(1, f.request(sequence)))
    await expect(f.controller.snapshot(1, f.request(17))).rejects.toThrow('busy')
    expect(captures).toBe(1)
    prepared.done(Buffer.from('superseded'))
    await Promise.all(requests)
    expect(captures).toBe(2)
    expect((await readDraftJournal(f.root, f.token)).bytes.toString()).toBe('latest')
  })
  it('preserves the previous journal on oversized payloads or failed serialization', async () => {
    let fail = false
    const f = await fixture({
      capture: () => async () => {
        if (fail) throw new Error('serialization failed')
        return Buffer.from('last good package')
      },
    })
    await f.controller.snapshot(1, f.request(1))
    fail = true
    await expect(f.controller.snapshot(1, f.request(2))).rejects.toThrow('serialization failed')
    await expect(
      f.controller.snapshot(
        1,
        f.request(3, { notes: { slideIndex: 0, text: 'x'.repeat(1024 * 1024 + 1), baseline: '' } }),
      ),
    ).rejects.toThrow('budget')
    expect((await readDraftJournal(f.root, f.token)).bytes.toString()).toBe('last good package')
  })
})
