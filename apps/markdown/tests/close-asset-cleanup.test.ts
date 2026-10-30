import { createHash } from 'node:crypto'
import * as draftJournal from '../../../packages/electron-utils/src/draft-journal'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  registerCloseCleanupRuntime,
  awaitCloseCleanup,
  queryCloseCleanupCustody,
} from '../../../packages/electron-utils/src/close-cleanup-runtime'
import {
  listDraftJournal,
  readDraftJournal,
} from '../../../packages/electron-utils/src/draft-journal'

type IpcHandler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown

interface FakeWebContents {
  id: number
  listeners: Map<string, () => void>
  isDestroyed: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}

const handlers = new Map<string, IpcHandler>()
const showMessageBox = vi.fn()
const showSaveDialogWithMemory = vi.fn()
const webContents: FakeWebContents[] = []
let nextWebContentsId = 1
let runtimeProfileRoot = ''
const originalRecoveryRoot = process.env.VANTAGE_RECOVERY_ROOT

function makeWebContents(): FakeWebContents {
  const listeners = new Map<string, () => void>()
  const contents: FakeWebContents = {
    id: nextWebContentsId++,
    listeners,
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }
  webContents.push(contents)
  return contents
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => runtimeProfileRoot || tmpdir()),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
    static getFocusedWindow() {
      return null
    }
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...args),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  WebContentsView: class {
    webContents = makeWebContents()
  },
}))

vi.mock('@vantage/electron-utils', () => ({
  configuredDefaultSaveDir: vi.fn(() => tmpdir()),
  contextMenuLabels: vi.fn(() => ({})),
  installContextMenu: vi.fn(),
  installNavigationGuard: vi.fn(),
  rendererUrl: vi.fn(() => 'vantage-app://markdown/index.html'),
  safeExternalUrl: vi.fn(() => null),
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory: (...args: unknown[]) => showSaveDialogWithMemory(...args),
}))

import {
  readOwnedAssetManifest,
  reconcileOwnedAssets,
  writeImageIntoOwnedAssets,
} from '../src/main/asset-lifecycle'
import {
  createMarkdownView,
  prepareMarkdownClose,
  prepareMarkdownNativeClose,
  completeMarkdownClose,
  cancelMarkdownClose,
  markdownSaveToPath,
  requestMarkdownSave,
  markdownFilePath,
} from '../src/main/markdown-main'
import { MARKDOWN_CHANNELS } from '../src/shared/ipc'
import type { MarkdownSaveTicket } from '../src/shared/ipc'

const temporaryDirectories: string[] = []
beforeAll(async () => {
  runtimeProfileRoot = await mkdtemp(join(tmpdir(), 'markdown-close-runtime-'))
  process.env.VANTAGE_RECOVERY_ROOT = join(runtimeProfileRoot, 'recovery')
  registerCloseCleanupRuntime({
    app: { on: vi.fn(), quit: vi.fn(), whenReady: async () => {} },
    userDataRoot: runtimeProfileRoot,
    warning: vi.fn(),
  })
})
afterAll(async () => {
  if (originalRecoveryRoot === undefined) delete process.env.VANTAGE_RECOVERY_ROOT
  else process.env.VANTAGE_RECOVERY_ROOT = originalRecoveryRoot
  await rm(runtimeProfileRoot, { recursive: true, force: true })
})

async function createDocument(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-close-assets-'))
  temporaryDirectories.push(directory)
  const documentPath = join(directory, 'note.md')
  await writeFile(documentPath, '# Saved document')
  return documentPath
}

function observe(contents: FakeWebContents, dirty: boolean, revision = '1', pending = false) {
  const stamp = { source: 'renderer:' + contents.id, revision }
  handlers.get(MARKDOWN_CHANNELS.closeSourceState)?.(
    { sender: contents },
    {
      stamp,
      path: markdownFilePath(contents.id) ?? null,
      ready: true,
      dirty,
      pending,
      busy: false,
      composing: false,
    },
  )
  handlers.get(MARKDOWN_CHANNELS.dirtyChanged)?.({ sender: contents }, dirty, stamp)
  return stamp
}
function markDirty(contents: FakeWebContents): void {
  observe(contents, true)
}
function acknowledge(
  contents: FakeWebContents,
  ticket: MarkdownSaveTicket,
  clean: boolean,
  published: boolean,
  revision = '1',
) {
  const stamp = observe(contents, !clean, revision)
  handlers.get(MARKDOWN_CHANNELS.saveRequestAck)?.(
    { sender: contents },
    {
      requestId: ticket.requestId,
      published,
      current: true,
      clean,
      ...(ticket.closeLease ? { closeLease: { ticket: ticket.closeLease, stamp } } : {}),
    },
  )
}

afterEach(async () => {
  vi.restoreAllMocks()
  showMessageBox.mockReset()
  showSaveDialogWithMemory.mockReset()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function latestSaveTicket(contents: FakeWebContents): MarkdownSaveTicket {
  return contents.send.mock.calls
    .filter(([channel]) => channel === MARKDOWN_CHANNELS.saveRequest)
    .at(-1)![2]
}

describe('held Markdown close with real file and asset publication', () => {
  it('returns physical Save promptly, ignores obsolete ACK, then holds close until synchronous removal', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    markDirty(contents)
    let settled = false
    const preparing = prepareMarkdownClose(contents as never, path)
    void preparing.then(() => {
      settled = true
    })
    const ticket = latestSaveTicket(contents)
    expect(
      await handlers.get(MARKDOWN_CHANNELS.closeLeaseClaim)?.(
        { sender: contents },
        ticket.closeLease,
      ),
    ).toBe(true)
    expect(
      await handlers.get(MARKDOWN_CHANNELS.save)?.(
        { sender: contents },
        {
          requestId: ticket.requestId,
          closeSource: { source: 'renderer:' + contents.id, revision: '1' },
          text: '# Published A',
          imageSources: [],
          mode: 'save',
          overwrite: true,
        },
      ),
    ).toMatchObject({ ok: true, path })
    expect(await readFile(path, 'utf8')).toBe('# Published A')
    expect(settled).toBe(false)
    handlers.get(MARKDOWN_CHANNELS.saveRequestAck)?.(
      { sender: contents },
      { requestId: 'wrong', published: true, current: true, clean: true },
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    acknowledge(contents, ticket, true, true)
    const receipt = await preparing,
      remove = vi.fn(() => true)
    expect(receipt.published).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    expect(completeMarkdownClose(contents as never, receipt, remove)).toBe(true)
    expect(remove).toHaveBeenCalledOnce()
  })
  it.each(['newer typing', 'replacement source'])(
    'retains actual published bytes when %s refuses close',
    async (reason) => {
      const path = await createDocument(),
        target = join(dirname(path), 'copy.md'),
        contents = createMarkdownView(path).webContents as unknown as FakeWebContents
      markDirty(contents)
      const preparing = prepareMarkdownClose(contents as never, target),
        rejected = expect(preparing).rejects.toThrow(),
        ticket = latestSaveTicket(contents)
      await handlers.get(MARKDOWN_CHANNELS.save)?.(
        { sender: contents },
        {
          requestId: ticket.requestId,
          text: '# Real earlier publication',
          imageSources: [],
          mode: 'save',
          overwrite: true,
        },
      )
      if (reason === 'replacement source')
        handlers.get(MARKDOWN_CHANNELS.closeSourceState)?.(
          { sender: contents },
          {
            stamp: { source: 'replacement:' + contents.id, revision: '2' },
            path: target,
            ready: true,
            dirty: true,
            pending: false,
            busy: false,
            composing: false,
          },
        )
      else observe(contents, true, '2')
      handlers.get(MARKDOWN_CHANNELS.saveRequestAck)?.(
        { sender: contents },
        {
          requestId: ticket.requestId,
          published: true,
          current: reason !== 'replacement source',
          clean: false,
        },
      )
      await rejected
      expect(await readFile(target, 'utf8')).toBe('# Real earlier publication')
      expect(markdownFilePath(contents.id)).toBe(target)
    },
  )
  it('ordinary menu Save reports real publication while newer typing remains unsaved', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    markDirty(contents)
    const saving = requestMarkdownSave(contents as never, 'save'),
      ticket = latestSaveTicket(contents)
    await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        requestId: ticket.requestId,
        text: '# Published',
        imageSources: [],
        mode: 'save',
        overwrite: true,
      },
    )
    observe(contents, true, '2')
    acknowledge(contents, ticket, false, false, '2')
    await expect(saving).resolves.toBe(true)
  })
  it('does not replace an outstanding request or its save target', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    markDirty(contents)
    const first = markdownSaveToPath(contents as never, path),
      ticket = latestSaveTicket(contents)
    await expect(
      markdownSaveToPath(contents as never, join(dirname(path), 'other.md')),
    ).rejects.toThrow('finishing')
    expect(markdownFilePath(contents.id)).toBe(path)
    await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        requestId: ticket.requestId,
        text: '# Published',
        imageSources: [],
        mode: 'save',
        overwrite: true,
      },
    )
    acknowledge(contents, ticket, true, true)
    await first
  })
  it("explicit Don't Save retains ambiguous pending assets and reports the cleanup boundary", async () => {
    const path = await createDocument(),
      saved = await writeImageIntoOwnedAssets(path, 'saved.png', Buffer.from('saved'))
    await reconcileOwnedAssets(path, [saved])
    const pending = await writeImageIntoOwnedAssets(path, 'pending.png', Buffer.from('pending')),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    markDirty(contents)
    showMessageBox.mockResolvedValue({ response: 1 })
    const preparing = prepareMarkdownNativeClose(contents as never)
    await vi.waitFor(() =>
      expect(
        contents.send.mock.calls.some(([channel]) => channel === MARKDOWN_CHANNELS.saveRequest),
      ).toBe(true),
    )
    const ticket = latestSaveTicket(contents)
    expect(ticket.intent).toBe('discard')
    acknowledge(contents, ticket, false, false)
    const receipt = await preparing
    expect(receipt?.cleanup).toEqual({ journal: 'staged', assets: 'retained', retainedAssets: 1 })
    expect(receipt?.warnings?.[0]).toContain('exclusive ownership')
    expect(existsSync(join(dirname(path), saved))).toBe(true)
    expect(existsSync(join(dirname(path), pending))).toBe(true)
    expect(completeMarkdownClose(contents as never, receipt!, () => true)).toBe(true)
    expect((await awaitCloseCleanup(receipt!.journalCleanup!.id))?.phase).toBe('complete')
  })
  it('indexes captured close lineage while an accepted journal writer is still draining', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    markDirty(contents)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      entry = new Promise<void>((resolve) => {
        entered = resolve
      }),
      realWrite = draftJournal.writeDraftJournal
    vi.spyOn(draftJournal, 'writeDraftJournal').mockImplementation(async (...args) => {
      entered()
      await gate
      return realWrite(...args)
    })
    const writing = Promise.resolve(
      handlers.get(MARKDOWN_CHANNELS.writeDraft)?.(
        { sender: contents },
        {
          text: 'accepted complete draft',
          stamp: { source: 'renderer:' + contents.id, revision: '1' },
        },
      ),
    )
    let preparing: ReturnType<typeof prepareMarkdownClose> | undefined
    try {
      await entry
      preparing = prepareMarkdownClose(contents as never, undefined, 'discard', {
        source: 'renderer:' + contents.id,
        revision: '1',
      })
      const ticket = latestSaveTicket(contents)
      acknowledge(contents, ticket, false, false)
      // This status must exist BEFORE gate is released. Awaiting the producer
      // before stage registration lets a privacy purge miss this old source.
      await vi.waitFor(() =>
        expect(queryCloseCleanupCustody({ module: 'markdown', documentPath: path })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ phase: 'preparing', source: 'renderer:' + contents.id }),
          ]),
        ),
      )
    } finally {
      release()
      await writing
    }
    const receipt = await preparing!
    expect(completeMarkdownClose(contents as never, receipt, () => false)).toBe(false)
    expect((await awaitCloseCleanup(receipt.journalCleanup!.id))?.phase).toBe('canceled')
  })
  it('keeps the last complete journal when final outer removal is refused after approved discard', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    markDirty(contents)
    expect(
      await handlers.get(MARKDOWN_CHANNELS.writeDraft)?.(
        { sender: contents },
        {
          text: 'last complete draft',
          stamp: { source: 'renderer:' + contents.id, revision: '1' },
        },
      ),
    ).toEqual({ ok: true })
    const old = (await listDraftJournal(join(runtimeProfileRoot, 'recovery'))).find(
      (entry) => entry.documentPath === path,
    )!
    observe(contents, true, '2', true)
    const preparing = prepareMarkdownClose(contents as never, undefined, 'discard', {
        source: 'renderer:' + contents.id,
        revision: '2',
      }),
      ticket = latestSaveTicket(contents)
    acknowledge(contents, ticket, false, false, '2')
    const receipt = await preparing
    expect(
      (await readDraftJournal(join(runtimeProfileRoot, 'recovery'), old.id)).bytes.toString(),
    ).toBe('last complete draft')
    expect(completeMarkdownClose(contents as never, receipt, () => false)).toBe(false)
    expect((await awaitCloseCleanup(receipt.journalCleanup!.id))?.phase).toBe('canceled')
    expect(
      (await readDraftJournal(join(runtimeProfileRoot, 'recovery'), old.id)).bytes.toString(),
    ).toBe('last complete draft')
  })
  it('a cancelled native decision preserves the document and every pending asset', async () => {
    const path = await createDocument(),
      pending = await writeImageIntoOwnedAssets(path, 'pending.png', Buffer.from('pending')),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    markDirty(contents)
    showMessageBox.mockResolvedValue({ response: 2 })
    await expect(prepareMarkdownNativeClose(contents as never)).resolves.toBeNull()
    expect(existsSync(join(dirname(path), pending))).toBe(true)
  })
  it('Save-close preserves referenced staged assets after they become saved ownership', async () => {
    const path = await createDocument(),
      pending = await writeImageIntoOwnedAssets(path, 'pending.png', Buffer.from('pending')),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    markDirty(contents)
    const preparing = prepareMarkdownClose(contents as never, path),
      ticket = latestSaveTicket(contents)
    await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        requestId: ticket.requestId,
        text: '![pending](' + pending + ')',
        imageSources: [pending],
        mode: 'save',
        overwrite: true,
      },
    )
    acknowledge(contents, ticket, true, true)
    const receipt = await preparing
    expect(completeMarkdownClose(contents as never, receipt, () => true)).toBe(true)
    expect(existsSync(join(dirname(path), pending))).toBe(true)
    expect(await readOwnedAssetManifest(path)).toMatchObject({
      documents: { 'note.md': ['pending.png'] },
      pending: { 'note.md': ['pending.png'] },
    })
  })
})

describe('Save As source pending ownership', () => {
  it('retains filename-owned pending assets across same-directory Save As', async () => {
    const sourcePath = await createDocument()
    const saved = await writeImageIntoOwnedAssets(
      sourcePath,
      'saved.png',
      Buffer.from('saved image'),
    )
    await reconcileOwnedAssets(sourcePath, [saved])
    await writeFile(sourcePath, `![saved](${saved})`)
    const pending = await writeImageIntoOwnedAssets(
      sourcePath,
      'pending.png',
      Buffer.from('pending image'),
    )
    const targetPath = join(dirname(sourcePath), 'copy.md')
    showSaveDialogWithMemory.mockResolvedValue({ canceled: false, filePath: targetPath })
    const view = createMarkdownView(sourcePath)
    const contents = view.webContents as unknown as FakeWebContents

    const saveResult = await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        text: `![saved](${saved})\n![pending](${pending})`,
        imageSources: [saved, pending],
        mode: 'saveAs',
      },
    )

    expect(saveResult).toMatchObject({ ok: true, path: targetPath })
    expect(existsSync(join(dirname(sourcePath), pending))).toBe(true)
    expect(await readFile(sourcePath, 'utf8')).toBe(`![saved](${saved})`)
    expect(await readOwnedAssetManifest(targetPath)).toMatchObject({
      files: [{ name: 'pending.png' }, { name: 'saved.png' }],
      documents: {
        'copy.md': ['pending.png', 'saved.png'],
        'note.md': ['saved.png'],
      },
      pending: { 'note.md': ['pending.png'] },
    })
    expect(saveResult).toMatchObject({
      assetCleanup: { assets: 'retained' },
      warnings: expect.arrayContaining([expect.stringContaining('saved version')]),
    })
  })

  it('retains cross-directory source candidates and publishes independent destination assets', async () => {
    const sourcePath = await createDocument()
    const saved = await writeImageIntoOwnedAssets(
      sourcePath,
      'saved.png',
      Buffer.from('saved image'),
    )
    await reconcileOwnedAssets(sourcePath, [saved])
    await writeFile(sourcePath, `![saved](${saved})`)
    const pending = await writeImageIntoOwnedAssets(
      sourcePath,
      'pending.png',
      Buffer.from('pending image'),
    )
    const targetDirectory = await mkdtemp(join(tmpdir(), 'markdown-save-as-target-'))
    temporaryDirectories.push(targetDirectory)
    const targetPath = join(targetDirectory, 'copy.md')
    showSaveDialogWithMemory.mockResolvedValue({ canceled: false, filePath: targetPath })
    const view = createMarkdownView(sourcePath)
    const contents = view.webContents as unknown as FakeWebContents

    const saveResult = await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        text: `![saved](${saved})\n![pending](${pending})`,
        imageSources: [saved, pending],
        mode: 'saveAs',
      },
    )

    expect(saveResult).toMatchObject({
      ok: true,
      path: targetPath,
      imageRewrites: [
        { from: saved, to: 'assets/saved.png' },
        { from: pending, to: 'assets/pending.png' },
      ],
    })
    expect(existsSync(join(dirname(sourcePath), pending))).toBe(true)
    expect(await readFile(join(dirname(sourcePath), saved), 'utf8')).toBe('saved image')
    expect(await readFile(sourcePath, 'utf8')).toBe(`![saved](${saved})`)
    expect(await readOwnedAssetManifest(sourcePath)).toMatchObject({
      files: [{ name: 'pending.png' }, { name: 'saved.png' }],
      documents: { 'note.md': ['saved.png'] },
      pending: { 'note.md': ['pending.png'] },
    })
    expect(await readOwnedAssetManifest(targetPath)).toMatchObject({
      files: [{ name: 'pending.png' }, { name: 'saved.png' }],
      documents: { 'copy.md': ['pending.png', 'saved.png'] },
      pending: { 'copy.md': ['pending.png', 'saved.png'] },
    })
  })

  it.skipIf(process.platform === 'win32')(
    'retains source candidates even when destination reconciliation reports an error',
    async () => {
      const sourcePath = await createDocument()
      const keep = await writeImageIntoOwnedAssets(
        sourcePath,
        'keep.png',
        Buffer.from('keep image'),
      )
      const orphan = await writeImageIntoOwnedAssets(
        sourcePath,
        'orphan.png',
        Buffer.from('orphan image'),
      )
      // Simulate a source file that already references one still-pending asset.
      await writeFile(sourcePath, `![keep](${keep})`)

      const targetDirectory = await mkdtemp(join(tmpdir(), 'markdown-save-as-error-target-'))
      temporaryDirectories.push(targetDirectory)
      const targetPath = join(targetDirectory, 'copy.md')
      const blocked = await writeImageIntoOwnedAssets(
        targetPath,
        'blocked.png',
        Buffer.from('unrelated target asset'),
      )
      const blockedPath = join(targetDirectory, blocked)
      await chmod(blockedPath, 0)
      showSaveDialogWithMemory.mockResolvedValue({ canceled: false, filePath: targetPath })
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const view = createMarkdownView(sourcePath)
      const contents = view.webContents as unknown as FakeWebContents

      let saveResult: unknown
      try {
        saveResult = await handlers.get(MARKDOWN_CHANNELS.save)?.(
          { sender: contents },
          {
            text: `![keep](${keep})\n![orphan](${orphan})`,
            imageSources: [keep, orphan],
            mode: 'saveAs',
          },
        )
      } finally {
        await chmod(blockedPath, 0o600)
      }

      expect(saveResult).toMatchObject({ ok: true, path: targetPath })
      expect(warning).toHaveBeenCalledWith(
        '[markdown] asset reconciliation incomplete:',
        expect.arrayContaining([expect.stringContaining('blocked.png')]),
      )
      expect(existsSync(join(dirname(sourcePath), keep))).toBe(true)
      expect(existsSync(join(dirname(sourcePath), orphan))).toBe(true)
      expect(await readOwnedAssetManifest(sourcePath)).toMatchObject({
        files: [{ name: 'keep.png' }, { name: 'orphan.png' }],
        pending: { 'note.md': ['keep.png', 'orphan.png'] },
      })
      expect(existsSync(join(targetDirectory, 'assets', 'keep.png'))).toBe(true)
      expect(existsSync(join(targetDirectory, 'assets', 'orphan.png'))).toBe(true)
    },
  )

  it('retains source and copied candidates when Save As publication fails', async () => {
    const sourcePath = await createDocument()
    const pending = await writeImageIntoOwnedAssets(
      sourcePath,
      'pending.png',
      Buffer.from('pending image'),
    )
    const targetDirectory = await mkdtemp(join(tmpdir(), 'markdown-save-as-failure-'))
    temporaryDirectories.push(targetDirectory)
    const targetPath = join(targetDirectory, 'copy.md')
    // A directory at the picked file path makes the final atomic rename fail
    // after destination assets have already been prepared.
    await mkdir(targetPath)
    showSaveDialogWithMemory.mockResolvedValue({ canceled: false, filePath: targetPath })
    const view = createMarkdownView(sourcePath)
    const contents = view.webContents as unknown as FakeWebContents

    const saveResult = await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        text: `![pending](${pending})`,
        imageSources: [pending],
        mode: 'saveAs',
      },
    )

    expect(saveResult).toMatchObject({ ok: false })
    expect(existsSync(join(dirname(sourcePath), pending))).toBe(true)
    expect(await readOwnedAssetManifest(sourcePath)).toMatchObject({
      files: [{ name: 'pending.png' }],
      pending: { 'note.md': ['pending.png'] },
    })
    expect(existsSync(join(targetDirectory, 'assets', 'pending.png'))).toBe(true)
    expect(saveResult).toMatchObject({
      assetCleanup: { assets: 'retained' },
      warnings: expect.arrayContaining([expect.stringContaining('saved version')]),
    })
  })
})

const boundHash = (text: string) => createHash('sha256').update(text).digest('hex')
function boundState(contents: FakeWebContents, source = 'renderer:' + contents.id, revision = '1') {
  const stamp = { source, revision }
  handlers.get(MARKDOWN_CHANNELS.closeSourceState)?.(
    { sender: contents },
    {
      stamp,
      path: markdownFilePath(contents.id) ?? null,
      ready: true,
      dirty: true,
      pending: true,
      busy: false,
      composing: false,
    },
  )
  handlers.get(MARKDOWN_CHANNELS.dirtyChanged)?.({ sender: contents }, true, stamp)
  return stamp
}
async function boundDiscard(
  contents: FakeWebContents,
  source = 'renderer:' + contents.id,
  revision = '1',
) {
  const stamp = boundState(contents, source, revision),
    preparing = prepareMarkdownClose(contents as never, undefined, 'discard', stamp),
    ticket = latestSaveTicket(contents)
  expect(
    await handlers.get(MARKDOWN_CHANNELS.closeLeaseClaim)?.(
      { sender: contents },
      ticket.closeLease,
    ),
  ).toBe(true)
  handlers.get(MARKDOWN_CHANNELS.saveRequestAck)?.(
    { sender: contents },
    {
      requestId: ticket.requestId,
      published: false,
      current: true,
      clean: false,
      closeLease: { ticket: ticket.closeLease, stamp },
    },
  )
  return await preparing
}
async function writeBoundMain(
  contents: FakeWebContents,
  text: string,
  stamp = { source: 'renderer:' + contents.id, revision: '1' },
) {
  return await handlers.get(MARKDOWN_CHANNELS.writeDraft)?.({ sender: contents }, { text, stamp })
}

describe('Markdown captured main-only journal attestation', () => {
  it('uses the successful verified writer hash and preserves it after a failed write', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    boundState(contents)
    expect(await writeBoundMain(contents, 'main verified prior')).toEqual({ ok: true })
    vi.spyOn(draftJournal, 'writeDraftJournal').mockRejectedValueOnce(
      new Error('owned writer refused'),
    )
    expect(await writeBoundMain(contents, 'failed later')).toMatchObject({
      ok: false,
      error: expect.stringContaining('owned writer refused'),
    })
    const receipt = await boundDiscard(contents)
    expect(receipt.journalCleanup?.capturedEntry).toEqual({
      module: 'markdown',
      documentPath: path,
      sha256: boundHash('main verified prior'),
    })
    expect(
      (
        await readDraftJournal(join(runtimeProfileRoot, 'recovery'), receipt.journalCleanup!.token)
      ).bytes.toString(),
    ).toBe('main verified prior')
    await cancelMarkdownClose(contents as never, receipt)
  })
  it('includes a verified accepted write which finishes while custody is waiting for its drain', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    boundState(contents)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      entry = new Promise<void>((resolve) => {
        entered = resolve
      }),
      realWrite = draftJournal.writeDraftJournal
    vi.spyOn(draftJournal, 'writeDraftJournal').mockImplementation(async (...args) => {
      entered()
      await gate
      return realWrite(...args)
    })
    const writing = writeBoundMain(contents, 'accepted late complete')
    await entry
    const closing = boundDiscard(contents)
    await vi.waitFor(() =>
      expect(queryCloseCleanupCustody({ module: 'markdown', documentPath: path })).toEqual(
        expect.arrayContaining([expect.objectContaining({ phase: 'preparing' })]),
      ),
    )
    release()
    await writing
    const receipt = await closing
    expect(receipt.journalCleanup?.capturedEntry?.sha256).toBe(boundHash('accepted late complete'))
    await cancelMarkdownClose(contents as never, receipt)
  })
  it('keeps active Save As path separate from old stored path and seals old custody across cancel/resume', async () => {
    const source = await createDocument(),
      target = join(dirname(source), 'copy.md'),
      contents = createMarkdownView(source).webContents as unknown as FakeWebContents
    boundState(contents)
    await writeBoundMain(contents, 'old complete before Save As')
    showSaveDialogWithMemory.mockResolvedValue({ canceled: false, filePath: target })
    expect(
      await handlers.get(MARKDOWN_CHANNELS.save)?.(
        { sender: contents },
        { text: '# Published copy', imageSources: [], mode: 'saveAs' },
      ),
    ).toMatchObject({ ok: true, path: target })
    const old = await boundDiscard(contents, 'renderer:' + contents.id, '2'),
      oldBinding = old.journalCleanup!.capturedEntry!
    expect(old.journalCleanup?.documentPath).toBe(target)
    expect(oldBinding).toEqual({
      module: 'markdown',
      documentPath: source,
      sha256: boundHash('old complete before Save As'),
    })
    await cancelMarkdownClose(contents as never, old)
    const stamp = boundState(contents, 'renderer:' + contents.id, '3')
    await writeBoundMain(contents, 'new resumed copy', stamp)
    const current = await boundDiscard(contents, 'renderer:' + contents.id, '3')
    expect(current.journalCleanup?.token).toBe(old.journalCleanup?.token)
    expect(current.journalCleanup?.capturedEntry).toEqual({
      module: 'markdown',
      documentPath: target,
      sha256: boundHash('new resumed copy'),
    })
    expect(old.journalCleanup?.capturedEntry).toEqual(oldBinding)
    await expect(
      draftJournal.discardDraftJournal(
        join(runtimeProfileRoot, 'recovery'),
        current.journalCleanup!.token,
        { expectedSha256: oldBinding.sha256 },
      ),
    ).rejects.toThrow('changed')
    await cancelMarkdownClose(contents as never, current)
  })
  it('late old writer/clean ACK cannot replace the binding of a new UUID', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    const oldStamp = boundState(contents)
    let release!: () => void, entered!: () => void, oldId: string | undefined
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      entry = new Promise<void>((resolve) => {
        entered = resolve
      }),
      realWrite = draftJournal.writeDraftJournal
    vi.spyOn(draftJournal, 'writeDraftJournal').mockImplementation(async (...args) => {
      if (!oldId) {
        oldId = args[1].id
        entered()
        await gate
      }
      return realWrite(...args)
    })
    const oldWrite = writeBoundMain(contents, 'old delayed', oldStamp)
    await entry
    const navigate = contents.listeners.get('did-start-navigation') as unknown as (details: {
      isMainFrame: boolean
    }) => void
    navigate({ isMainFrame: true })
    const currentStamp = boundState(contents, 'replacement:' + contents.id, '1')
    expect(await writeBoundMain(contents, 'new UUID complete', currentStamp)).toEqual({ ok: true })
    handlers.get(MARKDOWN_CHANNELS.dirtyChanged)?.({ sender: contents }, false, oldStamp)
    handlers.get(MARKDOWN_CHANNELS.saveRequestAck)?.(
      { sender: contents },
      { requestId: 'obsolete', published: true, current: true, clean: true },
    )
    release()
    await oldWrite
    const receipt = await boundDiscard(contents, 'replacement:' + contents.id, '1')
    expect(receipt.journalCleanup?.token).not.toBe(oldId)
    expect(receipt.journalCleanup?.capturedEntry?.sha256).toBe(boundHash('new UUID complete'))
    await cancelMarkdownClose(contents as never, receipt)
  })
  it('treats a genuinely absent journal as custody:false without inventing a binding', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents,
      receipt = await boundDiscard(contents)
    expect(receipt.journalCleanup?.custody).toBe(false)
    expect(receipt.journalCleanup).not.toHaveProperty('capturedEntry')
    await cancelMarkdownClose(contents as never, receipt)
  })
  it('refuses an existing journal lacking this main producer write receipt', async () => {
    const path = await createDocument(),
      contents = createMarkdownView(path).webContents as unknown as FakeWebContents
    boundState(contents)
    const realWrite = draftJournal.writeDraftJournal
    let id: string | undefined
    vi.spyOn(draftJournal, 'writeDraftJournal').mockImplementation(async (_root, request) => {
      id = request.id
      return null
    })
    await writeBoundMain(contents, 'not actually written by main')
    await realWrite(join(runtimeProfileRoot, 'recovery'), {
      id: id!,
      module: 'markdown',
      documentPath: path,
      extension: '.md',
      bytes: Buffer.from('unattested existing bytes'),
    })
    await expect(boundDiscard(contents)).rejects.toThrow('corroborating')
    expect(
      (await readDraftJournal(join(runtimeProfileRoot, 'recovery'), id!)).bytes.toString(),
    ).toBe('unattested existing bytes')
  })
})
