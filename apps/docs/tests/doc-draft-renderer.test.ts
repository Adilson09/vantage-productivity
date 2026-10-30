import { docCloseBarrier } from '../src/renderer/doc-close-lease'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Editor } from '@tiptap/core'
import { readDocxRecoveryData } from '@vantage/docx-engine'
import {
  captureCommentDraftRecovery,
  commentDraftSnapshot,
  putCommentDraft,
  removeCommentDraft,
} from '../src/renderer/comment-draft-recovery'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocx, readSections, saveDocx, type SaveBlock } from '@vantage/docx-engine'
import {
  buildDocx,
  IMAGE_PARAGRAPH_XML,
  NESTED_TABLE_XML,
} from '../../../packages/docx-engine/tests/helpers/build-docx'
import {
  listDraftJournal,
  readDraftJournal,
  restoreDraftCopy,
} from '../../../packages/electron-utils/src/draft-journal'
import { DocDraftController } from '../src/main/doc-draft-controller'
import type { DocDraftWriteRequest } from '../src/shared/doc-draft'
import { blocksToPmDoc, pmDocOptions, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  captureRecoverySurfaces,
  markRecoveryPending,
  RECOVERY_SNAPSHOT_EVENT,
  recoverySnapshotListener,
} from '../src/renderer/editor/recovery-snapshot'
import { addCommentToSelection } from '../src/renderer/editor/comments'
import { mountHfEditor, type HfEditorHandle } from '../src/renderer/editor/hf-editor'
import { EMPTY_HF_VARIANTS } from '../src/renderer/doc-state'
import { editKey } from '../src/renderer/hf-sections'
import {
  noteDocumentSwapped,
  buildDocBytes,
  noteRecoveryDiscarded,
  setRecoveryComposing,
  writeRecoveryCopy,
  save as saveDocument,
  canCloseSavedDocument,
  currentDocGeneration,
  captureDocWriteContext,
  docReplacementIsCurrent,
  loadFile as loadDocument,
  type FileActionContext,
} from '../src/renderer/file-actions'
import { cancelPhasedContent, setContentPhased } from '../src/renderer/phased-content'

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (text: string) => text }
const directories: string[] = [],
  editors: Editor[] = [],
  headers: HfEditorHandle[] = []
afterEach(async () => {
  cancelPhasedContent()
  setRecoveryComposing(false)
  for (const header of headers.splice(0)) if (!header.editor.isDestroyed) header.exit()
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.replaceChildren()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture(rich = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vantage-doc-draft-renderer-'))
  directories.push(directory)
  const root = join(directory, 'recovery')
  const source = await buildDocx({
    bodyXml:
      '<w:p><w:r><w:t>Draft opening.</w:t></w:r></w:p>' +
      (rich ? NESTED_TABLE_XML + IMAGE_PARAGRAPH_XML : ''),
    withImage: rich,
  })
  const initial = await parseDocx(source)
  const original = rich
    ? await saveDocx(initial, [
        ...initial.blocks.map((block): SaveBlock => ({
          kind: 'original',
          docxIndex: block.docxIndex!,
        })),
        {
          kind: 'chart',
          chart: {
            kind: 'bar',
            title: 'Draft chart',
            categories: ['Q1', 'Q2'],
            series: [{ name: 'Series', values: [10, 20] }],
          },
        },
      ])
    : source
  const parsed = await parseDocx(original)
  const host = document.createElement('div')
  document.body.append(host)
  const editor = new Editor({
    element: host,
    extensions: editorExtensions,
    editorProps: { handleScrollToSelection: () => true },
    content: blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed)),
  })
  editors.push(editor)
  const state = {
    editor,
    doc: { parsed, filePath: null, fileName: 'Untitled.docx', hash: 'draft' },
    dirtyRef: { current: true },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    inkAnnotations: [],
    sections: readSections(parsed),
    sectionsDirty: [],
    pgNumDirtySections: [],
    hfVariants: EMPTY_HF_VARIANTS,
    hfVariantsDirty: [],
    sectionHfEdits: {},
    hfLinks: {},
    styleUpserts: {},
    pendingNumbering: { newDefs: [], restartNums: [] },
    comments: [],
    commentsDirty: false,
  }
  const setStatus = vi.fn()
  const context: FileActionContext = new Proxy(state, {
    get(target, property) {
      if (property === 'currentContext') return () => context
      if (property === 'setStatus') return setStatus
      if (property in target) return Reflect.get(target, property)
      if (typeof property === 'string' && (/^set[A-Z]/.test(property) || /^on[A-Z]/.test(property)))
        return () => {}
      return undefined
    },
  }) as unknown as FileActionContext
  const controller = new DocDraftController({
    recoveryRoot: () => root,
    isLive: (owner) => owner === 1,
    canWritePath: () => true,
    prepare: (_owner, _path, bytes) => bytes,
  })
  const normalSave = vi.fn()
  const write = vi.fn(async (request: DocDraftWriteRequest) => {
    try {
      return { ok: true, skipped: !(await controller.snapshot(1, request)) }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
  window.desktop = {
    activateDocDraft: async (path: string | null) => ({
      ok: true,
      token: controller.activate(1, path),
    }),
    writeRecoveryCopy: write,
    saveDocx: normalSave,
    saveDocxAs: normalSave,
    saveNewDocx: normalSave,
  } as unknown as typeof window.desktop
  noteDocumentSwapped()
  return { directory, root, context, state, editor, controller, normalSave, write, setStatus }
}

function deferredValue<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function closeSaveFixture() {
  const f = await fixture()
  const state = f.state as unknown as Record<string, unknown>
  Object.assign(state, {
    sectionDirty: false,
    trailingStartType: null,
    pageColorDirty: false,
    headerDirty: false,
    footerDirty: false,
    pgNumEdit: null,
    numberingDirty: false,
    titlePgDirty: false,
    evenOddHfDirty: false,
    mirrorMarginsDirty: false,
    watermarkDirty: false,
    inksDirty: false,
    notesDirty: false,
    sourcesDirty: false,
    zoteroDocumentDataDirty: false,
    themeFontsDirty: false,
    themeColorsDirty: false,
    protectionDirty: false,
    writeProtectionDirty: false,
    removePersonalInfoDirty: false,
  })
  ;(f.state.doc as { filePath: string | null }).filePath = '/private/source.docx'
  const context: FileActionContext = new Proxy(f.context, {
    get(target, property) {
      if (property === 'currentContext') return () => context
      if (property === 'setStatus') return f.setStatus
      if (typeof property === 'string' && /^set[A-Z]/.test(property)) {
        return (value: unknown) => {
          const key = property[3].toLowerCase() + property.slice(4)
          state[key] = typeof value === 'function' ? value(state[key]) : value
        }
      }
      return Reflect.get(target, property)
    },
  })
  f.editor.on('update', () => {
    f.state.dirtyRef.current = true
  })
  const entered = deferredValue<void>(),
    acknowledgment = deferredValue<void>()
  const requests: { throughSequence: number; clean: boolean }[] = []
  const written: Uint8Array[] = []
  Object.assign(window.desktop, {
    saveDocx: vi.fn(async (_path: string, bytes: ArrayBuffer) => {
      written.push(new Uint8Array(bytes))
      return { ok: true }
    }),
    acknowledgeDocDraftSave: vi.fn(async (request: { throughSequence: number; clean: boolean }) => {
      requests.push(request)
      entered.resolve()
      await acknowledgment.promise
      await f.controller.acknowledgeSaved(1, request)
      return { ok: true }
    }),
  })
  noteDocumentSwapped('/private/source.docx')
  return { ...f, context, state, entered, acknowledgment, requests, written }
}

describe('production save completion after recovery acknowledgment', () => {
  it.each(['main document', 'composite state', 'pending surface'] as const)(
    'keeps newer %s edits dirty while reporting the older publication accurately',
    async (kind) => {
      const f = await closeSaveFixture(),
        generation = currentDocGeneration()
      let pending = false
      const listener = recoverySnapshotListener((event) => {
        if (pending) markRecoveryPending(event)
      })
      window.addEventListener(RECOVERY_SNAPSHOT_EVENT, listener)
      const publication = saveDocument(f.context, false)
      try {
        await f.entered.promise
        if (kind === 'main document')
          f.editor.commands.insertContent('Newer typing after publication.')
        if (kind === 'composite state') f.state.headerDirty = true
        if (kind === 'pending surface') pending = true
        f.acknowledgment.resolve()
        await expect(publication).resolves.toBe(true)
        expect(f.context.saveIncompleteRef.current).toBe(true)
        expect(f.context.dirtyRef.current).toBe(true)
        expect(canCloseSavedDocument(f.context, generation)).toBe(false)
        const zip = await JSZip.loadAsync(f.written[0])
        expect(await zip.file('word/document.xml')!.async('string')).not.toContain('Newer typing')
      } finally {
        pending = false
        window.removeEventListener(RECOVERY_SNAPSHOT_EVENT, listener)
        f.acknowledgment.resolve()
        await publication
      }
    },
  )

  it('does not acknowledge an uncommitted surface as represented by earlier file bytes', async () => {
    const f = await closeSaveFixture(),
      generation = currentDocGeneration()
    const publishing = deferredValue<void>(),
      finishWrite = deferredValue<void>()
    let pending = false
    const listener = recoverySnapshotListener((event) => {
      if (pending) markRecoveryPending(event)
    })
    window.addEventListener(RECOVERY_SNAPSHOT_EVENT, listener)
    Object.assign(window.desktop, {
      saveDocx: vi.fn(async (_path: string, bytes: ArrayBuffer) => {
        f.written.push(new Uint8Array(bytes))
        publishing.resolve()
        await finishWrite.promise
        return { ok: true }
      }),
    })
    const publication = saveDocument(f.context, false)
    try {
      await publishing.promise
      pending = true
      finishWrite.resolve()
      await f.entered.promise
      expect(f.requests[0].clean).toBe(false)
      f.acknowledgment.resolve()
      await expect(publication).resolves.toBe(true)
      expect(f.context.dirtyRef.current).toBe(true)
      expect(canCloseSavedDocument(f.context, generation)).toBe(false)
    } finally {
      pending = false
      window.removeEventListener(RECOVERY_SNAPSHOT_EVENT, listener)
      finishWrite.resolve()
      f.acknowledgment.resolve()
      await publication
    }
  })

  it('allows a fully persisted current document to close after the acknowledgment', async () => {
    const f = await closeSaveFixture(),
      generation = currentDocGeneration()
    const publication = saveDocument(f.context, false)
    try {
      await f.entered.promise
      f.acknowledgment.resolve()
      await expect(publication).resolves.toBe(true)
      expect(f.context.saveIncompleteRef.current).toBe(false)
      expect(canCloseSavedDocument(f.context, generation)).toBe(true)
    } finally {
      f.acknowledgment.resolve()
      await publication
    }
  })

  it('does not grant close permission for a replacement activation after an old save completes', async () => {
    const f = await closeSaveFixture(),
      generation = currentDocGeneration()
    const publication = saveDocument(f.context, false)
    try {
      await f.entered.promise
      noteDocumentSwapped('/private/replacement.docx')
      f.acknowledgment.resolve()
      await expect(publication).resolves.toBe(true)
      expect(canCloseSavedDocument(f.context, generation)).toBe(false)
    } finally {
      f.acknowledgment.resolve()
      await publication
    }
  })

  it('retains a newer draft captured after font settlement, even when its request began before Save', async () => {
    const f = await closeSaveFixture()
    const settled = deferredValue<FileActionContext>()
    const recovery = writeRecoveryCopy({ ...f.context, settleFontSettings: () => settled.promise })
    const publication = saveDocument(f.context, false)
    try {
      await f.entered.promise
      f.editor.commands.insertContent('Newer journal content must survive.')
      settled.resolve(f.context)
      await recovery
      expect(f.requests[0]).toEqual(expect.objectContaining({ clean: true, throughSequence: 0 }))
      expect(f.write).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }))
      f.acknowledgment.resolve()
      await expect(publication).resolves.toBe(true)
      const [entry] = await listDraftJournal(f.root)
      expect(entry).toBeDefined()
      const zip = await JSZip.loadAsync((await readDraftJournal(f.root, entry.id)).bytes)
      expect(await zip.file('word/document.xml')!.async('string')).toContain(
        'Newer journal content',
      )
      expect(f.context.saveIncompleteRef.current).toBe(true)
    } finally {
      settled.resolve(f.context)
      f.acknowledgment.resolve()
      await Promise.all([publication, recovery])
    }
  })
})

describe('production renderer full-document draft snapshots', () => {
  it('keeps an active pending chart discarded until its content actually changes', async () => {
    const f = await fixture(true)
    const value = f.editor.view.dom.querySelector('.doc-chart-val') as HTMLElement
    value.textContent = '901'
    await writeRecoveryCopy(f.context)
    const token = f.controller.tokenFor(1)!
    await f.controller.discardCurrent(1)
    noteRecoveryDiscarded(f.context, token)
    await Promise.resolve()
    await writeRecoveryCopy(f.context)
    expect(await listDraftJournal(f.root)).toHaveLength(0)
    value.textContent = '902'
    await writeRecoveryCopy(f.context)
    const [entry] = await listDraftJournal(f.root)
    expect(entry.id).not.toBe(token)
    expect(
      (await parseDocx((await readDraftJournal(f.root, entry.id)).bytes)).blocks.find(
        (block) => block.label === 'Chart',
      )?.chartDisplay?.series[0].values[0],
    ).toBe(902)
    expect(f.normalSave).not.toHaveBeenCalled()
  })

  it('cancels a renderer snapshot still waiting to settle when Recovery discards its activation', async () => {
    const f = await fixture()
    let release!: (context: FileActionContext) => void
    const settled = new Promise<FileActionContext>((done) => {
      release = done
    })
    f.context.settleFontSettings = () => settled
    const old = writeRecoveryCopy(f.context)
    const token = f.controller.tokenFor(1)!
    await f.controller.discardCurrent(1)
    noteRecoveryDiscarded(f.context, token)
    await Promise.resolve()
    release(f.context)
    await old
    expect(f.write).not.toHaveBeenCalled()
    expect(await listDraftJournal(f.root)).toHaveLength(0)
  })
  it('journals typed unnamed content without a normal save, path assignment, or dirty reset', async () => {
    const f = await fixture()
    f.editor.commands.insertContent('Typed unnamed content. ')
    await writeRecoveryCopy(f.context)
    expect(f.normalSave).not.toHaveBeenCalled()
    expect(f.state.doc.filePath).toBeNull()
    expect(f.state.dirtyRef.current).toBe(true)
    expect(await readdir(f.directory)).toEqual(['recovery'])
    const [entry] = await listDraftJournal(f.root)
    const recovered = await parseDocx((await readDraftJournal(f.root, entry.id)).bytes)
    expect(
      recovered.blocks.map((block) => block.runs?.map((run) => run.text).join('')).join('\n'),
    ).toContain('Typed unnamed content.')
  })

  it('captures pending table/chart edits, header, comments, pictures, section settings and embedded workbook without changing the live editors', async () => {
    const f = await fixture(true)
    f.editor.commands.setTextSelection({ from: 1, to: 6 })
    addCommentToSelection(f.editor, '1')
    Object.assign(f.state, {
      comments: [
        {
          id: '1',
          author: 'Draft author',
          date: '2026-10-29T12:00:00Z',
          text: 'Draft comment survives',
        },
      ],
      commentsDirty: true,
      section: { ...f.state.sections.at(-1)!.settings, marginLeft: 2000 },
      sectionDirty: true,
      sectionHfEdits: {
        [editKey(f.state.sections.at(-1)!.lastBlockIndex, 'header', 'default')]: {
          text: 'Draft header survives',
          pageNumber: false,
        },
      },
    })
    const chart = f.editor.view.dom.querySelector('.doc-protected-chart')!
    const value = chart.querySelector('.doc-chart-val') as HTMLElement
    value.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    value.textContent = '901'
    // Table and chart cells remain actively edited; no blur or normal commit.
    const cell = f.editor.view.dom.querySelector('.doc-nested-table td') as HTMLElement
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    cell.textContent = 'Pending table draft'
    cell.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    const before = f.editor.getJSON(),
      selection = f.editor.state.selection.toJSON()
    await writeRecoveryCopy(f.context)
    expect(f.editor.getJSON()).toEqual(before)
    expect(f.editor.state.selection.toJSON()).toEqual(selection)
    expect(value.isConnected).toBe(true)
    expect(value.textContent).toBe('901')
    expect(f.normalSave).not.toHaveBeenCalled()
    const [entry] = await listDraftJournal(f.root)
    const target = join(f.directory, 'rich-recovered.docx')
    await restoreDraftCopy(f.root, entry.id, target)
    const recovered = (await readDraftJournal(f.root, entry.id)).bytes
    const parsed = await parseDocx(recovered),
      zip = await JSZip.loadAsync(recovered)
    expect(
      parsed.blocks.find((block) => block.label === 'Chart')?.chartDisplay?.series[0].values[0],
    ).toBe(901)
    expect(await zip.file('word/document.xml')!.async('string')).toContain('Pending table draft')
    expect(readSections(parsed).at(-1)!.settings.marginLeft).toBe(2000)
    expect(await zip.file('word/comments.xml')!.async('string')).toContain('Draft comment survives')
    expect(
      (
        await Promise.all(
          Object.keys(zip.files)
            .filter((name) => /^word\/header\d+\.xml$/.test(name))
            .map((name) => zip.file(name)!.async('string')),
        )
      ).join(''),
    ).toContain('Draft header survives')
    expect(zip.file('word/media/image1.png')).toBeTruthy()
    const workbookPath = Object.keys(zip.files).find((name) => name.endsWith('.xlsx'))!
    const workbook = await JSZip.loadAsync(await zip.file(workbookPath)!.async('uint8array'))
    expect(await workbook.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<v>901</v>')
  })

  it('flushes pending header text while keeping its editor open and caret unchanged', async () => {
    const f = await fixture()
    const host = document.createElement('div')
    document.body.append(host)
    const onCommit = vi.fn()
    const header = mountHfEditor(host, {
      value: { text: 'Header', pageNumber: false },
      pageNo: '1',
      pageTotal: '1',
      spellcheck: false,
      onCommit,
      onExit: () => host.remove(),
    })
    headers.push(header)
    header.editor.commands.insertContent('Pending ')
    const selection = header.editor.state.selection.toJSON()
    expect(captureRecoverySurfaces(f.editor).changed).toBe(true)
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Pending') }),
    )
    expect(header.editor.isDestroyed).toBe(false)
    expect(header.editor.state.selection.toJSON()).toEqual(selection)
    expect(host.isConnected).toBe(true)
  })

  it('defers composing and phased loading, then records the complete model', async () => {
    const f = await fixture()
    setRecoveryComposing(true)
    await writeRecoveryCopy(f.context)
    expect(f.write).not.toHaveBeenCalled()
    setRecoveryComposing(false)
    const scheduled: (() => void)[] = []
    const content: PmNode = {
      type: 'doc',
      content: Array.from({ length: 200 }, (_, i) => ({
        type: 'docParagraph',
        content: [{ type: 'text', text: `Paragraph ${i}` }],
      })),
    }
    setContentPhased(
      {
        setContent: (doc) => {
          f.editor.commands.setContent(doc)
        },
        appendNodes: () => {},
        isDestroyed: () => false,
        resetHistory: () => {},
        setLoading: () => {},
        getDirty: () => true,
        setDirty: () => {},
      },
      content,
      (callback) => scheduled.push(callback),
    )
    await writeRecoveryCopy(f.context)
    expect(f.write).not.toHaveBeenCalled()
    cancelPhasedContent()
    f.editor.commands.setContent(content)
    await writeRecoveryCopy(f.context)
    expect(f.write).toHaveBeenCalledOnce()
    const [entry] = await listDraftJournal(f.root)
    expect(
      (await parseDocx((await readDraftJournal(f.root, entry.id)).bytes)).blocks
        .map((block) => block.runs?.map((run) => run.text).join(''))
        .join('\n'),
    ).toContain('Paragraph 199')
  })
})

describe('coherent authored write and replacement snapshots', () => {
  it('freezes serialization sidecars while a live canonical view advances', async () => {
    const f = await closeSaveFixture()
    const comments = [{ id: 'one', text: 'represented', author: 'Author' }]
    f.state.comments = comments as never
    const represented = captureDocWriteContext(f.context)
    comments[0]!.text = 'mutated outside the writer'
    f.state.comments = [{ id: 'two', text: 'newer', author: 'Author' }] as never
    expect(represented.comments[0]!.text).toBe('represented')
    expect(represented.comments).not.toBe(f.context.comments)
    expect(represented.currentContext).toBeUndefined()
  })
  it('refuses a replacement approved before newer typing, preserving the original source and journal activation', async () => {
    const f = await closeSaveFixture()
    const oldDoc = f.context.doc,
      oldGeneration = currentDocGeneration(),
      oldToken = f.controller.tokenFor(1)
    const approval = { stamp: docCloseBarrier.snapshot(), intent: 'discard' as const }
    expect(docReplacementIsCurrent(f.context, approval)).toBe(true)
    f.editor.commands.insertContent('Newer accepted work')
    expect(docReplacementIsCurrent(f.context, approval)).toBe(false)
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t>Replacement candidate</w:t></w:r></w:p>',
    })
    const candidate = {
      path: '/private/new.docx',
      name: 'new.docx',
      hash: 'new',
      dataUrl: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
    }
    expect(await loadDocument(f.context, candidate, approval)).toBe('failed')
    expect(currentDocGeneration()).toBe(oldGeneration)
    expect(f.context.doc).toBe(oldDoc)
    expect(f.editor.getText()).toContain('Newer accepted work')
    // A canceled discard resumes recovery under a fresh producer; it cannot
    // delete or acknowledge the newer accepted state as the old publication.
    expect(f.controller.tokenFor(1)).not.toBe(oldToken)
  })
  it('does not certify unsubmitted comment text as fully persisted', async () => {
    const f = await closeSaveFixture()
    Object.assign(f.state, { hasPendingAuthorInput: () => true })
    const publication = saveDocument(f.context, false)
    f.acknowledgment.resolve()
    expect(await publication).toBe(true)
    expect(f.requests).toEqual([])
    expect(canCloseSavedDocument(f.context, currentDocGeneration())).toBe(false)
    expect(f.context.dirtyRef.current).toBe(true)
  })
})

describe('production recovery keeps comments as unsent UI data', () => {
  it('records compose, reply and edit text without publishing comments or changing ordinary document bytes', async () => {
    const f = await fixture(),
      source = commentDraftSnapshot().source
    putCommentDraft(source, {
      id: 'new',
      kind: 'new',
      text: 'Unsent new comment',
      anchor: { from: 1, to: 6, quote: 'Draft', before: '', after: ' opening.' },
    })
    putCommentDraft(source, {
      id: 'reply:7',
      kind: 'reply',
      text: 'Unsent reply',
      target: {
        id: '7',
        parentId: null,
        author: 'A',
        date: '2026-10-30',
        text: 'Published thread',
        anchor: 'Draft',
      },
    })
    putCommentDraft(source, {
      id: 'edit:8',
      kind: 'edit',
      text: 'Unsent replacement',
      target: {
        id: '8',
        parentId: '7',
        author: 'B',
        date: '2026-10-30',
        text: 'Published reply',
        anchor: 'Draft',
      },
    })
    await writeRecoveryCopy(f.context)
    const [entry] = await listDraftJournal(f.root),
      saved = await readDraftJournal(f.root, entry.id)
    expect(await readDocxRecoveryData(saved.bytes)).toEqual(captureCommentDraftRecovery())
    expect((await parseDocx(saved.bytes)).comments).toHaveLength(0)
    const ordinary = await buildDocBytes(f.context)
    expect(await readDocxRecoveryData(ordinary!)).toBeUndefined()
    expect(f.normalSave).not.toHaveBeenCalled()
  })
  it('retains the previous complete journal and full visible draft when the next unsent text exceeds its recovery bound', async () => {
    const f = await fixture(),
      source = commentDraftSnapshot().source
    putCommentDraft(source, { id: 'new', kind: 'new', text: 'Previous complete unsent text' })
    await writeRecoveryCopy(f.context)
    const [before] = await listDraftJournal(f.root)
    const full = 'x'.repeat(65 * 1024)
    putCommentDraft(source, { id: 'new', kind: 'new', text: full })
    await writeRecoveryCopy(f.context)
    const [after] = await listDraftJournal(f.root)
    expect(after.sha256).toBe(before.sha256)
    expect(commentDraftSnapshot().drafts[0].text).toBe(full)
    expect(commentDraftSnapshot().error).toBeTruthy()
  })
  it('rejects a retired source callback without adding its text to the replacement source recovery', async () => {
    const f = await fixture(),
      sourceA = commentDraftSnapshot().source
    putCommentDraft(sourceA, { id: 'new', kind: 'new', text: 'Source A only' })
    noteDocumentSwapped()
    expect(putCommentDraft(sourceA, { id: 'new', kind: 'new', text: 'Late A callback' })).toBe(
      false,
    )
    const sourceB = commentDraftSnapshot().source
    putCommentDraft(sourceB, { id: 'new', kind: 'new', text: 'Source B only' })
    await writeRecoveryCopy(f.context)
    const [entry] = await listDraftJournal(f.root),
      saved = await readDraftJournal(f.root, entry.id)
    expect(JSON.stringify(await readDocxRecoveryData(saved.bytes))).toContain('Source B only')
    expect(JSON.stringify(await readDocxRecoveryData(saved.bytes))).not.toContain('Source A')
  })
})

it('does not recreate discarded unsent recovery until its text changes, then starts a fresh activation', async () => {
  const f = await fixture(),
    source = commentDraftSnapshot().source
  putCommentDraft(source, { id: 'new', kind: 'new', text: 'Discarded unsent text' })
  await writeRecoveryCopy(f.context)
  const token = f.controller.tokenFor(1)!
  await f.controller.discardCurrent(1)
  noteRecoveryDiscarded(f.context, token)
  await Promise.resolve()
  await writeRecoveryCopy(f.context)
  expect(await listDraftJournal(f.root)).toHaveLength(0)
  putCommentDraft(source, { id: 'new', kind: 'new', text: 'Changed unsent text' })
  await writeRecoveryCopy(f.context)
  const [entry] = await listDraftJournal(f.root)
  expect(entry.id).not.toBe(token)
  expect(
    JSON.stringify(await readDocxRecoveryData((await readDraftJournal(f.root, entry.id)).bytes)),
  ).toContain('Changed unsent text')
})

it('replaces canceled last-comment metadata even when the document body is clean', async () => {
  const f = await fixture(),
    source = commentDraftSnapshot().source
  f.state.dirtyRef.current = false
  putCommentDraft(source, { id: 'new', kind: 'new', text: 'Canceled text must not return' })
  await writeRecoveryCopy(f.context)
  const [before] = await listDraftJournal(f.root)
  removeCommentDraft(source, 'new')
  await writeRecoveryCopy(f.context)
  const [after] = await listDraftJournal(f.root)
  expect(after.id).toBe(before.id)
  expect(after.sha256).not.toBe(before.sha256)
  expect(await readDocxRecoveryData((await readDraftJournal(f.root, after.id)).bytes)).toEqual({
    version: 1,
    drafts: [],
  })
  expect(commentDraftSnapshot().recordedRevision).toBe(commentDraftSnapshot().revision)
})
