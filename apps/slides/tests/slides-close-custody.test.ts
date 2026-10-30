// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  writeDraftJournal,
  readDraftJournal,
  listDraftJournal,
  discardDraftJournal,
} from '../../../packages/electron-utils/src/draft-journal'
import {
  SlidesDraftController,
  type SlidesDraftDependencies,
} from '../src/main/slides-draft-controller'
const roots: string[] = []
function deferred() {
  let done!: () => void
  const promise = new Promise<void>((resolve) => {
    done = resolve
  })
  return { promise, done }
}
async function fixture(overrides: Partial<SlidesDraftDependencies> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vantage-slides-close-'))
  roots.push(root)
  const source = { path: join(root, 'A.pptx') },
    sources = new Map([
      [1, source],
      [2, source],
    ])
  const controller = new SlidesDraftController({
    recoveryRoot: () => root,
    sourceFor: (owner) => sources.get(owner),
    isLive: (owner) => sources.has(owner),
    revisionFor: () => '1',
    capture: (_owner, pending) => async () => Buffer.from(JSON.stringify(pending)),
    ...overrides,
  })
  const token = controller.activate(1, source.path)
  const request = (sequence: number, tokenValue = token, text = 'kept') => ({
    token: tokenValue,
    sequence,
    expectedRevision: '1',
    documentPath: source.path,
    pending: { notes: { slideIndex: 0, text, baseline: '' } },
  })
  return { root, source, sources, controller, token, request }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('vantage-slides-close-')
    )
      throw new Error('Unexpected fixture cleanup')
    await rm(target, { recursive: true, force: true })
  }
})
describe('actual per-view captured journal custody', () => {
  it('keeps durable bytes before removal and cancel restores only the same producer with retained floors', async () => {
    const f = await fixture()
    await f.controller.snapshot(1, f.request(1))
    const staged = f.controller.stageClose(1, 4)
    expect(f.controller.tokenFor(1)).toBe(null)
    await staged.ready
    expect((await readDraftJournal(f.root, f.token)).bytes.toString()).toContain('kept')
    expect(staged.attest()?.expectedSha256).toHaveLength(64)
    staged.cancel()
    expect(f.controller.tokenFor(1)).toBe(f.token)
    expect(await f.controller.snapshot(1, f.request(4))).toBe(false)
    expect(await f.controller.snapshot(1, f.request(5))).toBe(true)
  })
  it('attests an accepted main write which actually settles during retirement drain', async () => {
    const written = deferred(),
      release = deferred()
    const f = await fixture({
      write: async (...args) => {
        const entry = await writeDraftJournal(...args)
        written.done()
        await release.promise
        return entry
      },
    })
    const writing = f.controller.snapshot(1, f.request(1))
    await written.promise
    const staged = f.controller.stageClose(1, 1)
    let settled = false
    void staged.ready.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.done()
    expect(await writing).toBe(true)
    await staged.ready
    expect(staged.attest()).toEqual({
      expectedDocumentPath: f.source.path,
      expectedSha256: (await readDraftJournal(f.root, f.token)).entry.sha256,
    })
  })
  it('preserves peer pending-note journals when the caller is removed and cleaned', async () => {
    const f = await fixture(),
      peer = f.controller.activate(2, f.source.path)
    await f.controller.snapshot(1, f.request(1))
    await f.controller.snapshot(2, f.request(1, peer, 'peer pending notes'))
    const staged = f.controller.stageClose(1, 1)
    await staged.ready
    staged.removed()
    f.sources.delete(1)
    await staged.cleanup(new AbortController().signal)
    expect((await listDraftJournal(f.root)).map((entry) => entry.id)).toEqual([peer])
    expect((await readDraftJournal(f.root, peer)).bytes.toString()).toContain('peer pending notes')
  })
  it('never rearms or deletes a new activation while the captured old cleanup runs', async () => {
    const entered = deferred(),
      release = deferred()
    const f = await fixture({
      discard: async (...args) => {
        entered.done()
        await release.promise
        await discardDraftJournal(...args)
      },
    })
    await f.controller.snapshot(1, f.request(1))
    const old = f.controller.stageClose(1, 1)
    await old.ready
    old.removed()
    const replacement = f.controller.activate(1, f.source.path)
    await f.controller.snapshot(1, f.request(1, replacement, 'new activation'))
    const cleaning = old.cleanup(new AbortController().signal)
    await entered.promise
    old.cancel()
    expect(f.controller.tokenFor(1)).toBe(replacement)
    release.done()
    await cleaning
    expect((await readDraftJournal(f.root, replacement)).bytes.toString()).toContain(
      'new activation',
    )
  })
  it('keeps active SaveAs path separate from last-good stored path', async () => {
    const f = await fixture()
    await f.controller.snapshot(1, f.request(1))
    const oldPath = f.source.path
    f.source.path = join(f.root, 'B.pptx')
    f.controller.rename(f.source, oldPath, f.source.path)
    const staged = f.controller.stageClose(1)
    await staged.ready
    expect(staged.documentPath).toBe(f.source.path)
    expect(staged.attest()?.expectedDocumentPath).toBe(oldPath)
  })
  it('retains the verified main binding after a failed newer write', async () => {
    let fail = false
    const f = await fixture({
      write: async (...args) => {
        if (fail) throw new Error('disk refused')
        return writeDraftJournal(...args)
      },
    })
    await f.controller.snapshot(1, f.request(1))
    const hash = (await readDraftJournal(f.root, f.token)).entry.sha256
    fail = true
    await expect(f.controller.snapshot(1, f.request(2))).rejects.toThrow('disk refused')
    const staged = f.controller.stageClose(1)
    await staged.ready
    expect(staged.attest()?.expectedSha256).toBe(hash)
  })
  it('distinguishes genuine absence from an imported/unattested existing entry', async () => {
    const f = await fixture(),
      staged = f.controller.stageClose(1)
    await staged.ready
    expect(staged.attest()).toBe(null)
    await staged.cleanup(new AbortController().signal)
    expect(await listDraftJournal(f.root)).toEqual([])
  })
  it('retains a newer same-UUID payload when old conditional cleanup no longer matches', async () => {
    const f = await fixture()
    await f.controller.snapshot(1, f.request(1))
    const staged = f.controller.stageClose(1)
    await staged.ready
    staged.cancel()
    await f.controller.snapshot(1, f.request(2, f.token, 'new current edits'))
    await expect(staged.cleanup(new AbortController().signal)).rejects.toThrow('changed')
    expect((await readDraftJournal(f.root, f.token)).bytes.toString()).toContain(
      'new current edits',
    )
  })
  it('a canceled/resumed lifecycle cannot replace the retired stage attestation with a later successful write', async () => {
    const f = await fixture()
    await f.controller.snapshot(1, f.request(1))
    const oldHash = (await readDraftJournal(f.root, f.token)).entry.sha256
    const staged = f.controller.stageClose(1, 1)
    staged.cancel()
    await f.controller.snapshot(1, f.request(2, f.token, 'post-cancel current write'))
    await staged.ready
    expect(staged.attest()?.expectedSha256).toBe(oldHash)
    expect((await readDraftJournal(f.root, f.token)).entry.sha256).not.toBe(oldHash)
  })
  it('a close-save acknowledgment fences old snapshots but keeps last complete bytes', async () => {
    const f = await fixture({ retaining: () => true })
    await f.controller.snapshot(1, f.request(1))
    await f.controller.acknowledgeSaved(1, {
      token: f.token,
      documentPath: f.source.path,
      throughSequence: 1,
      clean: true,
    })
    expect(await listDraftJournal(f.root)).toHaveLength(1)
    expect(await f.controller.snapshot(1, f.request(1))).toBe(false)
  })
})
