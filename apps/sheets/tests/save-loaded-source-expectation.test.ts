import { createHash, webcrypto } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertWorkbookTargetUnchanged } from '../src/main/workbook-source-expectation'
import {
  hashWorkbookDocumentPayload,
  serializeWorkbookDocumentPayload,
} from '../src/shared/document-payload-canonical'
import { createEditJournal, recordSetRangeValues } from '../src/renderer/edit-journal'
import {
  handleSave,
  collectWorkbookDocumentPayload,
  type SaveContext,
} from '../src/renderer/save-actions'

const temporary: string[] = []
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'loaded-workbook-expectation-'))
  temporary.push(directory)
  const target = join(directory, 'book.xlsx')
  const original = Buffer.from('opaque opened package bytes')
  const ownPublished = Buffer.from('opaque own-publication bytes')
  await writeFile(target, original)
  const expected = createHash('sha256').update(original).digest('hex')
  const journal = createEditJournal()
  recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'accepted' } } })
  const state = {
    editJournal: journal,
    flags: { preloadComplete: true },
    file: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      path: target,
      sha256: expected,
      needsSaveAs: false,
      restoredFromRecovery: false,
    },
    recalc: { overlay: new Map(), formulaCells: new Map() },
  }
  const reference = { current: state }
  const open = vi.fn(async () => {
    reference.current = {
      ...state,
      editJournal: createEditJournal(),
      file: {
        ...state.file,
        sessionId: '22222222-2222-4222-8222-222222222222',
        sha256: createHash('sha256').update(ownPublished).digest('hex'),
      },
    }
    return true
  })
  const ctx: SaveContext = {
    lazyWorkbookRef: reference as never,
    univerRef: { current: null },
    setMessage: () => {},
    stashViewRestore: () => {},
    openLazyWorkbook: open,
    requireOwnedAdoption: true,
  }
  const fingerprint = await hashWorkbookDocumentPayload(collectWorkbookDocumentPayload(ctx).payload)
  const loadedSource = {
    lineage: 'owned-loaded-document',
    sessionId: state.file.sessionId,
    openedSha256: expected,
    documentPath: target,
  }
  ctx.publicationFence = {
    source: loadedSource,
    stamp: { source: 'renderer-source', revision: '1' },
    payloadSha256: fingerprint.sha256,
    canAdopt: () =>
      reference.current === state &&
      serializeWorkbookDocumentPayload(collectWorkbookDocumentPayload(ctx).payload) ===
        fingerprint.json,
  }
  const publish = vi.fn(async () => {
    // This is the same real guard called immediately before main publication.
    // The package writer is stubbed; this case does not assert OOXML validity.
    await assertWorkbookTargetUnchanged(
      target,
      loadedSource.openedSha256,
      'external source conflict',
    )
    await writeFile(target, ownPublished)
    const next = {
      ...loadedSource,
      sessionId: '22222222-2222-4222-8222-222222222222',
      openedSha256: createHash('sha256').update(ownPublished).digest('hex'),
    }
    return {
      canceled: false,
      file: { ...state.file, sessionId: next.sessionId, sha256: next.openedSha256 },
      ownedPublication: { id: 'actual-owned-offer', source: next },
    }
  })
  vi.stubGlobal('window', {
    desktopApi: {
      saveWorkbookEdits: publish,
      checkpointWorkbookDocument: vi.fn(),
      rejectWorkbookPublication: vi.fn(),
    },
  })
  return {
    target,
    original,
    ownPublished,
    expected,
    loadedSource,
    ctx,
    reference,
    state,
    open,
    publish,
  }
}

describe('normal Save keeps loaded source expectation across full-payload refresh', () => {
  it('positive control: unchanged source publishes and adopts a clean replacement', async () => {
    const f = await fixture()
    await expect(handleSave(f.ctx, 'save', true)).resolves.toMatchObject({
      ok: true,
      published: true,
      adopted: true,
      clean: true,
    })
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect(f.open).toHaveBeenCalledTimes(1)
    expect(await readFile(f.target)).toEqual(f.ownPublished)
    expect(f.loadedSource.openedSha256).toBe(f.expected)
  })

  it('rejects external replacement after model refresh and preserves both external bytes and pending edits', async () => {
    const f = await fixture()
    const replacement = Buffer.from('external replacement after payload fingerprint refresh')
    await writeFile(f.target, replacement)
    await expect(handleSave(f.ctx, 'save', true)).resolves.toMatchObject({
      ok: false,
      error: 'external source conflict',
    })
    expect(await readFile(f.target)).toEqual(replacement)
    expect(f.reference.current).toBe(f.state)
    expect(f.open).not.toHaveBeenCalled()
    expect(f.state.editJournal.cells.get('sheet-1')?.get('0:0')?.value).toBe('accepted')
    expect(f.loadedSource.openedSha256).toBe(f.expected)
  })

  it('does not mistake an unreadable source for a missing source', async () => {
    const denied = Object.assign(new Error('read denied'), { code: 'EACCES' })
    await expect(
      assertWorkbookTargetUnchanged('/owned/source.xlsx', 'a'.repeat(64), 'conflict', async () => {
        throw denied
      }),
    ).rejects.toBe(denied)
  })
})
