// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HtmlDraftController, type HtmlDraftDependencies } from '../src/main/html-draft-controller'
import {
  captureDraftJournalCustody,
  discardDraftJournal,
  readDraftJournal,
  writeDraftJournal,
} from '../../../packages/electron-utils/src/draft-journal'
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function fixture(overrides: Partial<HtmlDraftDependencies> = {}) {
  const directory = await mkdtemp(
    join(process.env.VANTAGE_VALIDATION_TEMP || tmpdir(), 'html-main-binding-'),
  )
  directories.push(directory)
  const root = join(directory, 'recovery'),
    first = join(directory, 'first.html'),
    second = join(directory, 'second.html'),
    live = new Set([1])
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
    revision: number,
    text: string,
    documentPath: string | null = null,
  ) =>
    controller.snapshot(1, {
      token,
      sequence,
      revision,
      documentPath,
      data: Uint8Array.from(Buffer.from(text)).buffer,
    })
  const stage = (
    token: string,
    revision: number,
    throughSequence: number,
    documentPath: string | null = null,
  ) => controller.stageClose(1, { token, revision, throughSequence, documentPath, clean: false })
  return { directory, root, first, second, live, controller, snapshot, stage }
}
const expected = (
  attest: { expectedDocumentPath: string | null; expectedSha256: string } | null,
) =>
  attest
    ? { module: 'html', documentPath: attest.expectedDocumentPath, sha256: attest.expectedSha256 }
    : null
describe('HTML main-owned journal write binding', () => {
  it('attests only the verified main writer receipt for an untitled document', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 1, 'complete')
    const stage = f.stage(token, 1, 1)
    await stage.drain
    expect(stage.attest()).toEqual({ expectedDocumentPath: null, expectedSha256: hash('complete') })
    const captured = await captureDraftJournalCustody(
      f.root,
      token,
      join(f.directory, 'custody'),
      undefined,
      expected(stage.attest()),
    )
    expect(captured).toMatchObject({ module: 'html', documentPath: null, sha256: hash('complete') })
  })
  it('includes an accepted actual write settling during the captured drain', async () => {
    const gate = deferred(),
      entered = deferred()
    let delay = false
    const f = await fixture({
        write: async (...args) => {
          if (delay) {
            entered.resolve()
            await gate.promise
          }
          return writeDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 1, 'first complete')
    delay = true
    const writing = f.snapshot(token, 2, 2, 'second complete')
    await entered.promise
    const stage = f.stage(token, 2, 2)
    expect(() => stage.attest()).toThrow('drain is unfinished')
    let drained = false
    void stage.drain.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    gate.resolve()
    await writing
    await stage.drain
    expect(stage.attest()?.expectedSha256).toBe(hash('second complete'))
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('second complete')
  })
  it('a failed write preserves the previous complete main binding', async () => {
    let fail = false
    const f = await fixture({
        write: async (...args) => {
          if (fail) throw new Error('owned storage refused write')
          return writeDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 1, 'good prior')
    fail = true
    await expect(f.snapshot(token, 2, 2, 'failed later')).rejects.toThrow('storage refused')
    const stage = f.stage(token, 2, 2)
    await stage.drain
    expect(stage.attest()?.expectedSha256).toBe(hash('good prior'))
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('good prior')
  })
  it('does not replace a valid binding with a forged internal writer result', async () => {
    let forged = false
    const f = await fixture({
        write: async (...args) => {
          if (forged) {
            const { entry } = await readDraftJournal(args[0], args[1].id)
            return { ...entry, sha256: '0'.repeat(64) }
          }
          return writeDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 1, 'verified prior')
    forged = true
    await expect(f.snapshot(token, 2, 2, 'unverified next')).rejects.toThrow('unverified receipt')
    const stage = f.stage(token, 2, 2)
    await stage.drain
    expect(stage.attest()?.expectedSha256).toBe(hash('verified prior'))
  })
  it('keeps active Save As path separate from the older last-good stored path and seals it across cancel/resume', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, 1, 'old complete', f.first)
    f.controller.changed(1, { token, revision: 2, dirty: true })
    expect(
      await f.controller.acknowledgeSaved(1, {
        token,
        revision: 1,
        throughSequence: 1,
        documentPath: f.second,
        clean: false,
      }),
    ).toBe(false)
    const old = f.stage(token, 2, 2, f.second)
    await old.drain
    expect(old.documentPath).toBe(f.second)
    expect(old.attest()).toEqual({
      expectedDocumentPath: f.first,
      expectedSha256: hash('old complete'),
    })
    expect(
      await captureDraftJournalCustody(
        f.root,
        token,
        join(f.directory, 'old-custody'),
        undefined,
        expected(old.attest()),
      ),
    ).toMatchObject({ documentPath: f.first, sha256: hash('old complete') })
    old.cancel()
    await f.snapshot(token, 3, 3, 'new resumed complete', f.second)
    expect(old.attest()?.expectedSha256).toBe(hash('old complete'))
    const current = f.stage(token, 3, 3, f.second)
    await current.drain
    expect(current.attest()).toEqual({
      expectedDocumentPath: f.second,
      expectedSha256: hash('new resumed complete'),
    })
    await expect(
      discardDraftJournal(f.root, token, { expectedSha256: old.attest()!.expectedSha256 }),
    ).rejects.toThrow('changed')
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('new resumed complete')
  })
  it('late old writer/ack/cancel cannot attest or clear a replacement UUID', async () => {
    const gate = deferred(),
      entered = deferred()
    let delayedToken: string | undefined
    const f = await fixture({
        write: async (...args) => {
          if (args[1].id === delayedToken) {
            entered.resolve()
            await gate.promise
          }
          return writeDraftJournal(...args)
        },
      }),
      oldToken = f.controller.activate(1, null)
    delayedToken = oldToken
    const writing = f.snapshot(oldToken, 1, 1, 'old delayed complete')
    await entered.promise
    const old = f.stage(oldToken, 1, 1)
    const currentToken = f.controller.activate(1, f.second)
    await f.snapshot(currentToken, 1, 1, 'replacement complete', f.second)
    gate.resolve()
    await writing
    await old.drain
    old.cancel()
    await expect(
      f.controller.acknowledgeSaved(1, {
        token: oldToken,
        revision: 1,
        throughSequence: 1,
        documentPath: null,
        clean: true,
      }),
    ).rejects.toThrow('different document activation')
    const current = f.stage(currentToken, 1, 1, f.second)
    await current.drain
    expect(old.attest()).toEqual({
      expectedDocumentPath: null,
      expectedSha256: hash('old delayed complete'),
    })
    expect(current.attest()).toEqual({
      expectedDocumentPath: f.second,
      expectedSha256: hash('replacement complete'),
    })
  })
  it('a queued old clean ACK does not erase a replacement producer binding', async () => {
    const gate = deferred(),
      entered = deferred()
    let delayed: string | undefined
    const f = await fixture({
        write: async (...args) => {
          if (args[1].id === delayed) {
            entered.resolve()
            await gate.promise
          }
          return writeDraftJournal(...args)
        },
      }),
      old = f.controller.activate(1, null)
    delayed = old
    const writing = f.snapshot(old, 1, 1, 'old accepted')
    await entered.promise
    const acknowledgment = f.controller.acknowledgeSaved(1, {
      token: old,
      revision: 1,
      throughSequence: 1,
      documentPath: null,
      clean: true,
    })
    const current = f.controller.activate(1, f.second)
    await f.snapshot(current, 1, 1, 'current verified', f.second)
    gate.resolve()
    await writing
    await acknowledgment
    const stage = f.stage(current, 1, 1, f.second)
    await stage.drain
    expect(stage.attest()?.expectedSha256).toBe(hash('current verified'))
    expect((await readDraftJournal(f.root, current)).bytes.toString()).toBe('current verified')
  })
  it('represents genuine absence without inventing a hash or creating a custody payload', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, null),
      stage = f.stage(token, 0, 0)
    await stage.drain
    expect(stage.attest()).toBeNull()
    expect(
      await captureDraftJournalCustody(
        f.root,
        token,
        join(f.directory, 'absent'),
        undefined,
        expected(stage.attest()),
      ),
    ).toBeNull()
  })
  it('refuses an existing complete journal which this main producer never wrote', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, null)
    await writeDraftJournal(f.root, {
      id: token,
      module: 'html',
      documentPath: null,
      extension: '.html',
      bytes: Buffer.from('unattested external entry'),
    })
    const stage = f.stage(token, 0, 0)
    await stage.drain
    expect(stage.attest()).toBeNull()
    await expect(
      captureDraftJournalCustody(
        f.root,
        token,
        join(f.directory, 'refused'),
        undefined,
        expected(stage.attest()),
      ),
    ).rejects.toThrow('corroborating')
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe(
      'unattested external entry',
    )
  })
})
