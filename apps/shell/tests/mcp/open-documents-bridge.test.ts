import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { OpenDocumentTab } from '../../src/shared/tabs-api'
import {
  createOpenDocumentsControl as createRealOpenDocumentsControl,
  createOpenTargetResolver,
} from '../../src/main/mcp/open-documents-bridge'
import type { OpenDocumentsBridgeDeps } from '../../src/main/mcp/open-documents-bridge'
import { createOpenDocumentTools } from '../../src/main/mcp/tools/open-documents-tools'

type FixtureFamily = {
  read: (contents: WebContents) => Promise<string>
  save: (contents: WebContents, path: string, options?: { requireClean?: boolean }) => Promise<void>
  discard: (contents: WebContents) => Promise<void>
  prepareClose?: NonNullable<OpenDocumentsBridgeDeps['markdown']>['prepareClose']
  completeClose?: NonNullable<OpenDocumentsBridgeDeps['markdown']>['completeClose']
  cancelClose?: NonNullable<OpenDocumentsBridgeDeps['markdown']>['cancelClose']
}
type FixtureDeps = Omit<OpenDocumentsBridgeDeps, 'markdown' | 'html'> & {
  markdown?: FixtureFamily
  html?: FixtureFamily
}
/** Legacy writer spies remain simple; held-permission behavior has dedicated real-coordinator cases. */
function createOpenDocumentsControl(deps: FixtureDeps) {
  const adapt = (base: FixtureFamily | undefined, kind: 'markdown' | 'html') =>
    base
      ? {
          ...base,
          prepareClose:
            base.prepareClose ??
            (async (
              contents: WebContents,
              path: string | undefined,
              intent: 'save' | 'discard' | 'clean',
            ) => {
              if (intent === 'discard') await base.discard(contents)
              else if (kind === 'markdown') await base.save(contents, path!, { requireClean: true })
              else await base.save(contents, path!)
              return {
                requestId: 'fixture',
                published: intent === 'save',
                current: true,
                clean: true,
              }
            }),
          completeClose: base.completeClose ?? ((_contents, _receipt, remove) => remove()),
          cancelClose: base.cancelClose ?? (async () => {}),
        }
      : undefined
  const normalized = {
    ...deps,
    markdown: adapt(deps.markdown, 'markdown'),
    html: adapt(deps.html, 'html'),
  } as OpenDocumentsBridgeDeps
  return createRealOpenDocumentsControl(normalized)
}

/**
 * `open_documents` close/read through the shell-side control.
 *
 * These exercise the wiring the tool-level tests stub out: which family writer a
 * close-save reaches, and what a discard is expected to clean up. The point is
 * the per-family branching, which is where the untitled-html crash and the
 * slides recovery leak lived.
 */

function tab(overrides: Partial<OpenDocumentTab> & { id: string }): OpenDocumentTab {
  return { kind: 'markdown', title: 'notes.md', active: false, dirty: true, ...overrides } as never
}

/** minimal stand-in for the WebContents the bridges address */
function contentsFor(): WebContents {
  return { id: 7, isDestroyed: () => false } as unknown as WebContents
}

async function controlWith(
  documents: OpenDocumentTab[],
  overrides: Partial<FixtureDeps> = {},
): Promise<{
  call: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  deps: OpenDocumentsBridgeDeps
}> {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-mcp-bridge-'))
  const contents = contentsFor()
  const deps: FixtureDeps = {
    list: async () => documents,
    webContentsFor: () => contents,
    closeTab: () => true,
    defaultSaveDir: () => dir,
    ...overrides,
  }
  const control = createOpenDocumentsControl(deps)
  const [tool] = createOpenDocumentTools({ control, defaultSaveDir: () => dir })
  return {
    deps: deps as OpenDocumentsBridgeDeps,
    call: async (args) => {
      const result = await tool!.handler(args)
      return result as Record<string, unknown>
    },
  }
}

const docsLease = {
  ticket: { id: 'docs-close', sequence: 1, source: 'main-A' },
  stamp: { source: 'renderer-A', revision: '1' },
}
function heldDocs(
  runCommand: NonNullable<OpenDocumentsBridgeDeps['docs']>['runCommand'],
): NonNullable<OpenDocumentsBridgeDeps['docs']> {
  return {
    openBlankTab: async () => 7,
    runCommand,
    prepareDiscardClose: async () => docsLease,
    completeSaveClose: (_id, _lease, remove) => remove(),
    cancelSaveClose: () => {},
  }
}
describe('Docs final-save close contract', () => {
  it.each([
    { ok: true, published: true, current: true, clean: false },
    { ok: true, published: true, current: false, clean: false },
    { ok: true },
  ])('keeps a tab open without a current clean renderer receipt: %o', async (receipt) => {
    const document = tab({
      id: 'docs-close',
      kind: 'docs',
      title: 'source.docx',
      filePath: 'C:/private/source.docx',
      dirty: false,
    })
    const runCommand = vi.fn(async () => receipt),
      closeTab = vi.fn(() => true)
    const control = createOpenDocumentsControl({
      list: async () => [document],
      webContentsFor: contentsFor,
      closeTab,
      defaultSaveDir: () => 'C:/private',
      docs: { openBlankTab: async () => 7, runCommand },
    })
    await expect(control.close(document, { unsaved: 'save' })).rejects.toThrow(
      'document remains open',
    )
    expect(runCommand).toHaveBeenCalledWith(7, 'save_document', {
      path: document.filePath,
      overwrite: true,
      requireClean: true,
      sourcePath: document.filePath,
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('does not claim a saved file for a genuinely clean unnamed document', async () => {
    const document = tab({
      id: 'clean-untitled-docs',
      kind: 'docs',
      title: 'Untitled',
      dirty: false,
    })
    const runCommand = vi.fn(async () => ({
      ok: true,
      published: false,
      current: true,
      clean: true,
      closeLease: docsLease,
    }))
    const closeTab = vi.fn(() => true),
      contents = contentsFor()
    const control = createOpenDocumentsControl({
      list: async () => [document],
      webContentsFor: () => contents,
      closeTab,
      defaultSaveDir: () => 'C:/private',
      docs: heldDocs(runCommand),
    })
    await expect(control.close(document, { unsaved: 'save' })).resolves.toEqual({})
    expect(runCommand).toHaveBeenCalledWith(
      7,
      'save_document',
      expect.objectContaining({
        requireClean: true,
        sourcePath: null,
      }),
    )
    expect(closeTab).toHaveBeenCalledWith(document.id)
  })

  it('retains ordinary tool Save publication success without requiring close permission', async () => {
    const document = tab({
      id: 'docs-ordinary-save',
      kind: 'docs',
      title: 'source.docx',
      filePath: 'C:/private/source.docx',
    })
    const runCommand = vi.fn(async () => ({
      ok: true,
      published: true,
      current: false,
      clean: false,
    }))
    const control = createOpenDocumentsControl({
      list: async () => [document],
      webContentsFor: contentsFor,
      closeTab: () => true,
      defaultSaveDir: () => 'C:/private',
      docs: { openBlankTab: async () => 7, runCommand },
    })
    await expect(control.save(document)).resolves.toEqual({ savedPath: document.filePath })
    expect(runCommand).toHaveBeenCalledWith(7, 'save_document', {
      path: document.filePath,
      overwrite: true,
    })
  })
})

describe('Markdown final-save close contract', () => {
  it('requires a clean renderer completion before closing and preserves the tab when refused', async () => {
    const document = tab({ id: 'markdown-close-fence', filePath: 'C:/private/note.md' })
    const closeTab = vi.fn(() => true)
    const save = vi.fn(
      async (_contents: WebContents, _path: string, options?: { requireClean?: boolean }) => {
        if (options?.requireClean)
          throw new Error('An earlier revision was saved; newer edits remain.')
      },
    )
    const control = createOpenDocumentsControl({
      list: async () => [document],
      webContentsFor: contentsFor,
      closeTab,
      defaultSaveDir: () => 'C:/private',
      markdown: { read: async () => '', save, discard: async () => {} },
    })
    await expect(control.close(document, { unsaved: 'save' })).rejects.toThrow('newer edits remain')
    expect(save).toHaveBeenCalledWith(expect.anything(), 'C:/private/note.md', {
      requireClean: true,
    })
    expect(closeTab).not.toHaveBeenCalled()
    await expect(control.save(document)).resolves.toEqual({ savedPath: 'C:/private/note.md' })
    expect(save).toHaveBeenLastCalledWith(expect.anything(), 'C:/private/note.md', {
      requireClean: false,
    })
  })
})

describe('open_documents close: untitled documents', () => {
  // Regression: an untitled html document threw "family \"html\" has no MCP
  // generation format" because the target extension was asked of the generation
  // registry, which only covers the three headless create_* families.
  it.each([
    ['docs', '.docx'],
    ['sheets', '.xlsx'],
    ['slides', '.pptx'],
    ['markdown', '.md'],
    ['html', '.html'],
  ] as const)('saves an untitled dirty %s tab before closing it', async (kind, ext) => {
    const doc = tab({ id: 't1', kind, title: `untitled ${kind}` })
    const { call } = await controlWith([doc], {
      docs: heldDocs(async () => ({
        ok: true,
        published: true,
        current: true,
        clean: true,
        closeLease: docsLease,
      })),
      sheets: { openBlankTab: async () => 1, runCommand: async () => ({ ok: true }) },
      slides: {
        openBlankTab: async () => 1,
        runTxn: async () => ({}),
        readDeck: async () => ({}),
        saveDeck: async (_wcId, path) => ({ path }),
      },
      markdown: {
        read: async () => '',
        save: async () => undefined,
        discard: async () => undefined,
      },
      html: { read: async () => '', save: async () => undefined, discard: async () => undefined },
    })

    const result = await call({ action: 'close', target: 't1' })
    expect(result.closed).toBe(true)
    expect(String(result.savedTo).endsWith(ext)).toBe(true)
  })
})

describe('open_documents close: discard cleanup', () => {
  // Regression: discard cleaned markdown/html staged assets only. slides keeps
  // its own crash-recovery copy, so a discarded deck was offered back on the
  // next open.
  it('clears a slides document\u2019s recovery copies on discard', async () => {
    const discards: number[] = []
    const doc = tab({ id: 't3', kind: 'slides', title: 'deck.pptx', filePath: 'C:/docs/deck.pptx' })
    const { call } = await controlWith([doc], {
      slidesDiscard: () => discards.push(1),
    })

    const result = await call({ action: 'close', target: 't3', unsaved: 'discard' })
    expect(result.closed).toBe(true)
    expect(result.discardedUnsavedChanges).toBe(true)
    expect(discards).toHaveLength(1)
  })

  it('does not touch the recovery copy when the close saves instead', async () => {
    const discards: number[] = []
    const saved: string[] = []
    const doc = tab({ id: 't4', kind: 'slides', title: 'deck.pptx', filePath: 'C:/docs/deck.pptx' })
    const { call } = await controlWith([doc], {
      slidesDiscard: () => discards.push(1),
      slides: {
        openBlankTab: async () => 1,
        runTxn: async () => ({}),
        readDeck: async () => ({}),
        saveDeck: async (_wcId, path) => {
          saved.push(path)
          return { path }
        },
      },
    })

    const result = await call({ action: 'close', target: 't4' })
    expect(result.savedTo).toBe('C:/docs/deck.pptx')
    expect(saved).toEqual(['C:/docs/deck.pptx'])
    expect(discards).toEqual([])
  })

  it('still releases markdown staged assets on discard', async () => {
    const discard = vi.fn(async () => undefined)
    const doc = tab({ id: 't5', kind: 'markdown', title: 'notes.md', filePath: 'C:/docs/notes.md' })
    const { call } = await controlWith([doc], {
      markdown: { read: async () => '', save: async () => undefined, discard },
    })

    await call({ action: 'close', target: 't5', unsaved: 'discard' })
    expect(discard).toHaveBeenCalledTimes(1)
  })
})

describe('open_documents close: PDF guard', () => {
  it('closes a clean PDF tab by default (there is nothing to save)', async () => {
    const closed: string[] = []
    const doc = tab({
      id: 't6',
      kind: 'pdf',
      title: 'six.pdf',
      filePath: 'C:/docs/six.pdf',
      dirty: false,
    })
    const { call } = await controlWith([doc], {
      closeTab: (id) => {
        closed.push(id)
        return true
      },
    })

    const result = await call({ action: 'close', target: 't6' })
    expect(result.closed).toBe(true)
    expect(closed).toEqual(['t6'])
  })

  it('closes a PDF with unsaved annotations when the caller discards them', async () => {
    const closed: string[] = []
    const doc = tab({ id: 't6', kind: 'pdf', title: 'six.pdf', filePath: 'C:/docs/six.pdf' })
    const { call } = await controlWith([doc], {
      closeTab: (id) => {
        closed.push(id)
        return true
      },
    })

    const result = await call({ action: 'close', target: 't6', unsaved: 'discard' })
    expect(result.closed).toBe(true)
    expect(result.discardedUnsavedChanges).toBe(true)
    expect(closed).toEqual(['t6'])
  })

  it('refuses a save-close of a dirty PDF, since a PDF cannot be saved here', async () => {
    const doc = tab({ id: 't6', kind: 'pdf', title: 'six.pdf', filePath: 'C:/docs/six.pdf' })
    const { call } = await controlWith([doc])
    await expect(call({ action: 'close', target: 't6' })).rejects.toThrow(/unsaved:"discard"/)
  })
})

describe('open_documents save: writes without closing', () => {
  it('writes a document back to its own file and leaves the tab open', async () => {
    const saved: string[] = []
    const doc = tab({ id: 't1', kind: 'slides', title: 'deck.pptx', filePath: 'C:/docs/deck.pptx' })
    const { call } = await controlWith([doc], {
      slides: {
        openBlankTab: async () => 1,
        runTxn: async () => ({}),
        readDeck: async () => ({}),
        saveDeck: async (_wcId, path) => {
          saved.push(path)
          return { path }
        },
      },
    })

    const result = await call({ action: 'save', target: 't1' })
    expect(result.saved).toBe(true)
    expect(result.savedTo).toBe('C:/docs/deck.pptx')
    expect(result.closed).toBeUndefined()
    expect(saved).toEqual(['C:/docs/deck.pptx'])
  })

  it('refuses to save a PDF, naming the reason', async () => {
    const doc = tab({ id: 't6', kind: 'pdf', title: 'six.pdf', filePath: 'C:/docs/six.pdf' })
    const { call } = await controlWith([doc])
    await expect(call({ action: 'save', target: 't6' })).rejects.toThrow(/viewer/)
  })
})

describe('open target resolver: focusing the document the agent edits', () => {
  it('activates the named tab and reveals the window', async () => {
    const activate = vi.fn()
    const revealWindow = vi.fn()
    const doc = tab({
      id: 't9',
      kind: 'sheets',
      title: 'book.xlsx',
      filePath: 'C:/docs/book.xlsx',
      active: false,
    })
    const resolve = createOpenTargetResolver({
      list: async () => [doc],
      webContentsFor: () => contentsFor(),
      activate,
      revealWindow,
    })

    await expect(resolve('t9', 'xlsx', { focus: true })).resolves.toBe(7)
    expect(activate).toHaveBeenCalledWith('t9')
    expect(revealWindow).toHaveBeenCalledTimes(1)
  })

  it('leaves the UI alone for a read, and for a tab already in front', async () => {
    const activate = vi.fn()
    const revealWindow = vi.fn()
    const back = tab({ id: 't1', kind: 'sheets', title: 'back.xlsx', active: false })
    const front = tab({ id: 't2', kind: 'sheets', title: 'front.xlsx', active: true })
    const resolve = createOpenTargetResolver({
      list: async () => [back, front],
      webContentsFor: () => contentsFor(),
      activate,
      revealWindow,
    })

    // read tools pass no focus option
    await resolve('t1', 'xlsx')
    expect(activate).not.toHaveBeenCalled()

    // an already-active tab needs no switch
    await resolve('t2', 'xlsx', { focus: true })
    expect(activate).not.toHaveBeenCalled()
    expect(revealWindow).not.toHaveBeenCalled()
  })

  it('still resolves the edit when the UI call fails', async () => {
    const doc = tab({ id: 't3', kind: 'xlsx' as never, title: 'x.xlsx', active: false })
    const resolve = createOpenTargetResolver({
      list: async () => [{ ...doc, kind: 'sheets' }],
      webContentsFor: () => contentsFor(),
      activate: () => {
        throw new Error('no such tab')
      },
    })
    // showing the tab is a courtesy: the caller's edit must still go through
    await expect(resolve('t3', 'xlsx', { focus: true })).resolves.toBe(7)
  })

  it('refuses a document of the wrong family', async () => {
    const doc = tab({ id: 't4', kind: 'docs', title: 'doc.docx', active: false })
    const resolve = createOpenTargetResolver({
      list: async () => [doc],
      webContentsFor: () => contentsFor(),
    })
    await expect(resolve('t4', 'xlsx', { focus: true })).rejects.toThrow(/Word document/)
  })
})

describe('Docs held MCP removal', () => {
  it('keeps the editor if the final lease expired after a successful publication', async () => {
    const document = tab({ id: 'd', kind: 'docs', filePath: 'C:/private/a.docx' }),
      contents = contentsFor(),
      closeTab = vi.fn(() => true),
      cancel = vi.fn()
    const docs = heldDocs(async () => ({
      ok: true,
      published: true,
      current: true,
      clean: true,
      closeLease: docsLease,
    }))
    docs.completeSaveClose = () => false
    docs.cancelSaveClose = cancel
    const control = createOpenDocumentsControl({
      list: async () => [document],
      webContentsFor: () => contents,
      closeTab,
      defaultSaveDir: () => 'C:/private',
      docs,
    })
    await expect(control.close(document, { unsaved: 'save' })).rejects.toThrow('lease expired')
    expect(closeTab).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalled()
  })
  it('will not remove a replacement view which reused the same tab id', async () => {
    const document = tab({ id: 'd', kind: 'docs', filePath: 'C:/private/a.docx' }),
      old = contentsFor(),
      replacement = contentsFor(),
      closeTab = vi.fn(() => true)
    let current = old
    const docs = heldDocs(async () => {
      current = replacement
      return { ok: true, published: true, current: true, clean: true, closeLease: docsLease }
    })
    const control = createOpenDocumentsControl({
      list: async () => [document],
      webContentsFor: () => current,
      closeTab,
      defaultSaveDir: () => 'C:/private',
      docs,
    })
    await expect(control.close(document, { unsaved: 'save' })).rejects.toThrow(
      'removal was refused',
    )
    expect(closeTab).not.toHaveBeenCalled()
  })
  it('uses a held discard permission without inventing a clean/save publication', async () => {
    const document = tab({ id: 'd', kind: 'docs' }),
      contents = contentsFor(),
      closeTab = vi.fn(() => true),
      docs = heldDocs(async () => ({}))
    const discard = vi.fn(async () => docsLease)
    docs.prepareDiscardClose = discard
    const control = createOpenDocumentsControl({
      list: async () => [document],
      webContentsFor: () => contents,
      closeTab,
      defaultSaveDir: () => 'C:/private',
      docs,
    })
    await expect(control.close(document, { unsaved: 'discard' })).resolves.toEqual({})
    expect(discard).toHaveBeenCalledWith(contents.id, null)
    expect(closeTab).toHaveBeenCalledTimes(1)
  })
  it('keeps an unresponsive or incomplete discard open', async () => {
    const document = tab({ id: 'd', kind: 'docs' }),
      contents = contentsFor(),
      closeTab = vi.fn(() => true),
      docs = heldDocs(async () => ({}))
    docs.prepareDiscardClose = async () => null
    const control = createOpenDocumentsControl({
      list: async () => [document],
      webContentsFor: () => contents,
      closeTab,
      defaultSaveDir: () => 'C:/private',
      docs,
    })
    await expect(control.close(document, { unsaved: 'discard' })).rejects.toThrow(
      'approved discard revision',
    )
    expect(closeTab).not.toHaveBeenCalled()
  })
})
