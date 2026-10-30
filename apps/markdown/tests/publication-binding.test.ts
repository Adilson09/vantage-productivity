// @vitest-environment node
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarkdownCloseCoordinator } from '../src/main/markdown-close-lease'
import {
  PublicationReadRegistry,
  observePublicationTarget,
  absentPublicationTarget,
} from '../../../packages/electron-utils/src/document-publication'
let root = '',
  previousVault: string | undefined,
  coordinator: MarkdownCloseCoordinator | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'markdown-publication-'))
  previousVault = process.env.VANTAGE_RECOVERY_ROOT
  process.env.VANTAGE_RECOVERY_ROOT = join(root, 'history')
})
afterEach(async () => {
  coordinator?.destroy(1)
  coordinator = undefined
  if (previousVault === undefined) delete process.env.VANTAGE_RECOVERY_ROOT
  else process.env.VANTAGE_RECOVERY_ROOT = previousVault
  if (!root.startsWith(join(tmpdir(), 'markdown-publication-')))
    throw new Error('Unexpected fixture ownership')
  await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const path = join(root, 'source.md'),
    journal = join(root, 'previous.complete')
  await writeFile(path, 'LOADED BODY')
  await writeFile(journal, 'PREVIOUS COMPLETE JOURNAL')
  let sent: any
  coordinator = new MarkdownCloseCoordinator({
    alive: () => true,
    pathAllowed: () => true,
    send: (_owner, _mode, value) => {
      sent = value
    },
    release: () => {},
  })
  coordinator.open(1)
  const state = {
    stamp: { source: 'renderer:1', revision: '1' },
    path,
    ready: true,
    dirty: true,
    pending: false,
    busy: false,
    composing: false,
  }
  coordinator.observe(1, state)
  const registry = new PublicationReadRegistry<number>(),
    session = coordinator.session(1),
    read = await registry.read(
      1,
      session,
      path,
      () => readFile(path),
      () => true,
    )
  expect(registry.adopt(1, session, state.stamp.source, path, read.publicationId)).toBe(true)
  return { path, journal, state, registry, session, read, coordinator, sent: () => sent }
}
describe('Markdown actual main request/version handoff', () => {
  it('captures an explicit overwrite destination before renderer preparation and refuses a later replacement', async () => {
    const f = await fixture(),
      target = join(root, 'target.md')
    await writeFile(target, 'EXPLICITLY SELECTED VERSION')
    const selected = await observePublicationTarget(target),
      pending = f.coordinator.request(1, 'save', target, false, 'save', undefined, {}, selected),
      request = f.sent()
    let liveEditor = 'FULL CURRENT UNSAVED BODY'
    await rename(target, join(root, 'selected-original'))
    await writeFile(target, 'LATER EXTERNAL REPLACEMENT')
    const work = f.coordinator.beginMutation(1, request.requestId, f.state.stamp),
      entry = f.registry.select(1, f.session, f.state.stamp.source, f.read.publicationId, f.path),
      before = entry.publication.snapshot()
    try {
      const ticket = entry.publication.pin(
        target,
        f.coordinator.publicationTarget(1, request.requestId),
        before,
      )
      await expect(
        entry.publication.publishBytes(ticket, async () => Buffer.from(liveEditor)),
      ).rejects.toBeTruthy()
    } finally {
      f.coordinator.finishMutation(work)
    }
    f.coordinator.receive(1, {
      requestId: request.requestId,
      published: false,
      current: true,
      clean: false,
      error: 'Version conflict retained',
    })
    expect((await pending).published).toBe(false)
    expect(liveEditor).toBe('FULL CURRENT UNSAVED BODY')
    expect(entry.publication.snapshot()).toBe(before)
    expect(await readFile(target, 'utf8')).toBe('LATER EXTERNAL REPLACEMENT')
    expect(await readFile(f.journal, 'utf8')).toBe('PREVIOUS COMPLETE JOURNAL')
  })
  it('keeps an old prepared write from recreating the path after an actual verified Root move', async () => {
    const f = await fixture(),
      moved = join(root, 'moved.md'),
      pending = f.coordinator.request(1, 'save', undefined, false),
      request = f.sent()
    f.coordinator.cancel(1, undefined, 'Root move')
    await rename(f.path, moved)
    await f.registry.rebind(1, f.session, f.path, moved, () => true)
    expect(() => f.coordinator.beginMutation(1, request.requestId, f.state.stamp)).toThrow()
    expect((await pending).published).toBe(false)
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(moved, 'utf8')).toBe('LOADED BODY')
    expect(await readFile(f.journal, 'utf8')).toBe('PREVIOUS COMPLETE JOURNAL')
  })
  it('preserves a fresh explicit SaveAs absence receipt through renderer delay without adopting a new live baseline', async () => {
    const f = await fixture(),
      target = join(root, 'new-copy.md'),
      absence = absentPublicationTarget(target),
      pending = f.coordinator.request(1, 'save', target, false, 'save', undefined, {}, absence),
      request = f.sent(),
      entry = f.registry.select(1, f.session, f.state.stamp.source, f.read.publicationId, f.path),
      ticket = entry.publication.pin(target, f.coordinator.publicationTarget(1, request.requestId))
    await writeFile(target, 'OTHER PROCESS NEW FILE')
    await expect(
      entry.publication.publishBytes(ticket, () => Buffer.from('FULL COPY')),
    ).rejects.toBeTruthy()
    f.coordinator.receive(1, {
      requestId: request.requestId,
      published: false,
      current: true,
      clean: false,
      error: 'Destination appeared',
    })
    await pending
    expect(await readFile(target, 'utf8')).toBe('OTHER PROCESS NEW FILE')
    expect(await readFile(f.path, 'utf8')).toBe('LOADED BODY')
  })
})
