// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocDraftController, type DocDraftDependencies } from '../src/main/doc-draft-controller'
import {
  listDraftJournal,
  discardDraftJournal,
  readDraftJournal,
  writeDraftJournal,
} from '../../../packages/electron-utils/src/draft-journal'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(join(tmpdir(), 'vantage-doc-draft-controller-'))))
      throw new Error('Unexpected fixture cleanup')
    await rm(directory, { recursive: true, force: true })
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function data(text: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(text)).buffer
}

async function fixture(overrides: Partial<DocDraftDependencies> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vantage-doc-draft-controller-'))
  directories.push(directory)
  const root = join(directory, 'recovery')
  const paths = new Set([join(directory, 'first.docx'), join(directory, 'second.docx')])
  const live = new Set([1, 2])
  const controller = new DocDraftController({
    recoveryRoot: () => root,
    isLive: (owner) => live.has(owner),
    canWritePath: (_owner, path) => paths.has(path),
    prepare: (_owner, _path, bytes) => bytes,
    ...overrides,
  })
  const [first, second] = [...paths]
  const snapshot = (
    token: string,
    sequence: number,
    text: string,
    documentPath: string | null = null,
  ) => controller.snapshot(1, { token, sequence, documentPath, encrypted: false, data: data(text) })
  return { controller, directory, root, live, first, second, snapshot }
}

describe('DOCX draft activation and save/discard ordering', () => {
  it('keeps a refused discard retryable without reviving an already-started snapshot', async () => {
    let fail = true
    const f = await fixture({
      discard: async (...args) => {
        if (fail) throw new Error('Storage cannot discard')
        await discardDraftJournal(...args)
      },
    })
    const token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'good draft')
    await expect(f.controller.discardCurrent(1)).rejects.toThrow(/cannot discard/)
    expect(await f.snapshot(token, 1, 'late old snapshot')).toBe(false)
    expect(await f.snapshot(token, 2, 'new edit after refused close')).toBe(true)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe(
      'new edit after refused close',
    )
    fail = false
    await f.controller.discardCurrent(1)
    expect(await listDraftJournal(f.root)).toHaveLength(0)
  })
  it('journals an unnamed document without publishing any normal document file', async () => {
    const f = await fixture()
    const token = f.controller.activate(1, null)
    expect(await f.snapshot(token, 1, 'unnamed draft bytes')).toBe(true)
    expect(await readdir(f.directory)).toEqual(['recovery'])
    const { entry, bytes } = await readDraftJournal(f.root, token)
    expect(entry).toMatchObject({ module: 'docs', documentPath: null, extension: '.docx' })
    expect(bytes.toString()).toBe('unnamed draft bytes')
  })

  it('keeps the active draft when an opened candidate is only granted, then canceled', async () => {
    const f = await fixture()
    const token = f.controller.activate(1, f.first)
    expect(await f.snapshot(token, 1, 'current document', f.first)).toBe(true)
    // The picker has granted both paths; only successful activation may change ownership.
    expect(await f.snapshot(token, 2, 'not activated', f.second)).toBe(false)
    expect(await f.snapshot(token, 3, 'current later edit', f.first)).toBe(true)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('current later edit')
    expect((await listDraftJournal(f.root))[0].documentPath).toBe(f.first)
  })

  it('rejects old serialization that arrives after a clean save acknowledgment', async () => {
    const preparation = deferred<Buffer>()
    const entered = deferred<void>()
    const f = await fixture({
      prepare: () => {
        entered.resolve()
        return preparation.promise
      },
    })
    const token = f.controller.activate(1, null)
    const old = f.snapshot(token, 1, 'pre-save snapshot')
    await entered.promise
    await f.controller.acknowledgeSaved(1, {
      token,
      throughSequence: 1,
      documentPath: f.first,
      clean: true,
    })
    preparation.resolve(Buffer.from('pre-save snapshot'))
    expect(await old).toBe(false)
    expect(await listDraftJournal(f.root)).toHaveLength(0)
  })

  it('does not delete a newer dirty snapshot that committed before save cleanup arrived', async () => {
    const f = await fixture()
    const token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, 'saved snapshot', f.first)
    await f.snapshot(token, 2, 'new edits during save', f.first)
    await f.controller.acknowledgeSaved(1, {
      token,
      throughSequence: 1,
      documentPath: f.first,
      clean: true,
    })
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('new edits during save')
  })

  it('orders a new dirty commit after cleanup behind an older in-flight disk commit', async () => {
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
    })
    const token = f.controller.activate(1, f.first)
    const older = f.snapshot(token, 1, 'older', f.first)
    await entered.promise
    const clean = f.controller.acknowledgeSaved(1, {
      token,
      throughSequence: 1,
      documentPath: f.first,
      clean: true,
    })
    const newer = f.snapshot(token, 2, 'newer survives', f.first)
    release.resolve()
    await Promise.all([older, clean, newer])
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('newer survives')
  })

  it('never overwrites a newer completed serialization with a slower older one', async () => {
    const old = deferred<Buffer>()
    const f = await fixture({
      prepare: (_owner, _path, bytes) => (bytes.toString() === 'old' ? old.promise : bytes),
    })
    const token = f.controller.activate(1, null)
    const pending = f.snapshot(token, 1, 'old')
    await f.snapshot(token, 2, 'new')
    old.resolve(Buffer.from('old'))
    expect(await pending).toBe(false)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('new')
  })

  it('waits for an in-flight write before completing explicit discard', async () => {
    const entered = deferred<void>(),
      release = deferred<void>()
    const f = await fixture({
      write: async (...args) => {
        entered.resolve()
        await release.promise
        return writeDraftJournal(...args)
      },
    })
    const token = f.controller.activate(1, null)
    const pending = f.snapshot(token, 1, 'discarded')
    await entered.promise
    const discarded = f.controller.discardCurrent(1)
    release.resolve()
    await Promise.all([pending, discarded])
    expect(await listDraftJournal(f.root)).toHaveLength(0)
    await expect(f.snapshot(token, 2, 'cannot resurrect')).rejects.toThrow('activation')
  })

  it('keeps separate generations and view owners isolated', async () => {
    const old = deferred<Buffer>()
    const f = await fixture({
      prepare: (_owner, _path, bytes) => (bytes.toString() === 'slow' ? old.promise : bytes),
    })
    const first = f.controller.activate(1, f.first)
    await f.snapshot(first, 1, 'last good first', f.first)
    const pending = f.snapshot(first, 2, 'slow', f.first)
    const second = f.controller.activate(1, f.second)
    await f.snapshot(second, 1, 'second document', f.second)
    old.resolve(Buffer.from('slow'))
    expect(await pending).toBe(false)
    await expect(
      f.controller.snapshot(2, {
        token: second,
        sequence: 2,
        documentPath: f.second,
        encrypted: false,
        data: data('other view'),
      }),
    ).rejects.toThrow('activation')
    expect((await readDraftJournal(f.root, first)).bytes.toString()).toBe('last good first')
    expect((await readDraftJournal(f.root, second)).bytes.toString()).toBe('second document')
  })

  it('preserves the last valid draft when materialization or storage fails', async () => {
    let materializeFailure = false,
      writeFailure = false
    const f = await fixture({
      prepare: (_owner, _path, bytes) => {
        if (materializeFailure) throw new Error('missing media')
        return bytes
      },
      write: async (...args) => {
        if (writeFailure) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        return writeDraftJournal(...args)
      },
    })
    const token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'known good')
    materializeFailure = true
    await expect(f.snapshot(token, 2, 'missing media update')).rejects.toThrow('missing media')
    materializeFailure = false
    writeFailure = true
    await expect(f.snapshot(token, 3, 'storage update')).rejects.toThrow('disk full')
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('known good')
  })

  it('checks the complete protected size without replacing a prior entry', async () => {
    const f = await fixture({
      prepare: (_owner, _path, bytes) =>
        bytes.toString() === 'oversized' ? Buffer.alloc(16 * 1024 * 1024 + 1) : bytes,
    })
    const token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'known good')
    await expect(f.snapshot(token, 2, 'oversized')).rejects.toThrow('16 MiB')
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('known good')
  })

  it('preserves the last committed journal when a view crashes', async () => {
    const f = await fixture()
    const token = f.controller.activate(1, f.first)
    await f.snapshot(token, 1, 'crash recovery', f.first)
    f.live.delete(1)
    f.controller.retire(1)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('crash recovery')
    await expect(f.snapshot(token, 2, 'dead view', f.first)).rejects.toThrow('no longer active')
  })
})

describe('captured DOCX close producer custody', () => {
  it('retains the last good journal when newer pending content cannot serialize and the outer close cancels', async () => {
    let fail = false
    const f = await fixture({
        prepare: (_owner, _path, bytes) => {
          if (fail) throw new Error('unrepresentable pending media')
          return bytes
        },
      }),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'last complete package')
    fail = true
    await expect(f.snapshot(token, 2, 'new pending UI')).rejects.toThrow('pending media')
    const stage = f.controller.stageClose(1, 2)!
    await stage.drained
    expect(f.controller.tokenFor(1)).toBeNull()
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('last complete package')
    stage.cancel()
    expect(f.controller.tokenFor(1)).toBe(token)
    fail = false
    expect(await f.snapshot(token, 2, 'old pre-cutover snapshot')).toBe(false)
    expect(await f.snapshot(token, 3, 'new corrected package')).toBe(true)
  })
  it('rejects pre-cutover serialization even when same-UUID journaling resumes after cancellation', async () => {
    const pending = deferred<Buffer>(),
      entered = deferred<void>()
    const f = await fixture({
        prepare: (_o, _p, bytes) => {
          if (bytes.toString() === 'slow') {
            entered.resolve()
            return pending.promise
          }
          return bytes
        },
      }),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'good')
    const older = f.snapshot(token, 2, 'slow')
    await entered.promise
    const stage = f.controller.stageClose(1, 2)!
    await stage.drained
    stage.cancel()
    pending.resolve(Buffer.from('slow'))
    expect(await older).toBe(false)
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('good')
    expect(await f.snapshot(token, 3, 'after canceled close')).toBe(true)
  })
  it('drains a real accepted writer and binds its receipt on the captured object after retirement', async () => {
    const entered = deferred<void>(),
      release = deferred<void>()
    const f = await fixture({
        write: async (...args) => {
          entered.resolve()
          await release.promise
          return writeDraftJournal(...args)
        },
      }),
      token = f.controller.activate(1, f.first)
    const writing = f.snapshot(token, 1, 'accepted package', f.first)
    await entered.promise
    f.controller.rename(1, f.first, f.second)
    const stage = f.controller.stageClose(1, 1)!
    expect(stage.binding()).toBeNull()
    expect(stage.documentPath).toBe(f.second)
    let drained = false
    void stage.drained.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    expect(await writing).toBe(true)
    await stage.drained
    const entry = (await readDraftJournal(f.root, token)).entry
    expect(stage.binding()).toEqual({ expectedDocumentPath: f.first, expectedSha256: entry.sha256 })
    expect(entry.documentPath).toBe(f.first)
  })
  it('cannot rearm a staged old activation after a newer activation is itself retired', async () => {
    const f = await fixture(),
      old = f.controller.activate(1, null),
      stage = f.controller.stageClose(1, 0)!
    const newer = f.controller.activate(1, f.first)
    expect(newer).not.toBe(old)
    f.controller.retire(1)
    stage.cancel()
    expect(f.controller.tokenFor(1)).toBeNull()
  })
  it('does not rearm on owner retirement even while the webcontents ID remains live', async () => {
    const f = await fixture()
    f.controller.activate(1, null)
    const stage = f.controller.stageClose(1, 0)!
    f.controller.retire(1)
    stage.cancel()
    expect(f.controller.tokenFor(1)).toBeNull()
  })
  it('authorizes deletion only of the captured UUID and keeps a newer activation intact', async () => {
    const f = await fixture(),
      old = f.controller.activate(1, null)
    await f.snapshot(old, 1, 'old complete')
    const stage = f.controller.stageClose(1, 1)!
    await stage.drained
    const newer = f.controller.activate(1, f.first)
    await f.snapshot(newer, 1, 'new complete', f.first)
    await stage.discardCaptured(new AbortController().signal)
    stage.cancel()
    expect(f.controller.tokenFor(1)).toBe(newer)
    expect((await readDraftJournal(f.root, newer)).bytes.toString()).toBe('new complete')
    expect((await listDraftJournal(f.root)).some((entry) => entry.id === old)).toBe(false)
  })
  it('rejects an actual write receipt which does not corroborate its captured package', async () => {
    const f = await fixture({
        write: async (...args) => {
          const entry = await writeDraftJournal(...args)
          return entry ? { ...entry, sha256: '0'.repeat(64) } : entry
        },
      }),
      token = f.controller.activate(1, null)
    await expect(f.snapshot(token, 1, 'complete')).rejects.toThrow('captured document binding')
    const stage = f.controller.stageClose(1, 1)!
    await stage.drained
    expect(stage.binding()).toBeNull()
    stage.cancel()
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('complete')
  })
})

describe('sealed captured DOCX write binding', () => {
  it('does not re-read a resumed producer while its canceled custody task later requests attestation', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'captured complete')
    const stage = f.controller.stageClose(1, 1)!
    await stage.drained
    const captured = stage.binding()!
    stage.cancel()
    await f.snapshot(token, 2, 'newer resumed complete')
    expect(stage.binding()).toEqual(captured)
    expect((await readDraftJournal(f.root, token)).entry.sha256).not.toBe(captured.expectedSha256)
    expect(() => stage.discardCaptured(new AbortController().signal)).toThrow(
      'canceled captured producer',
    )
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('newer resumed complete')
  })
  it('retains an independently changed same-UUID entry rather than deleting a newer journal head', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'captured complete')
    const stage = f.controller.stageClose(1, 1)!
    await stage.drained
    await writeDraftJournal(f.root, {
      id: token,
      module: 'docs',
      documentPath: null,
      extension: '.docx',
      bytes: Buffer.from('changed current entry'),
    })
    await expect(stage.discardCaptured(new AbortController().signal)).rejects.toThrow(
      'changed after restoration',
    )
    expect((await readDraftJournal(f.root, token)).bytes.toString()).toBe('changed current entry')
  })
  it('deletes the sealed known entry only after its matching actual payload hash remains valid', async () => {
    const f = await fixture(),
      token = f.controller.activate(1, null)
    await f.snapshot(token, 1, 'captured complete')
    const stage = f.controller.stageClose(1, 1)!
    await stage.drained
    await stage.discardCaptured(new AbortController().signal)
    expect(await listDraftJournal(f.root)).toEqual([])
    stage.cancel()
    expect(f.controller.tokenFor(1)).toBeNull()
  })
})
