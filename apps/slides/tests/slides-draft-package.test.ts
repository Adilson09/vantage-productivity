// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  commitSaved,
  createBlankPptx,
  duplicateSlide,
  getSlideNotes,
  listMasterParts,
  moveSlide,
  openPptx,
  parseMasterPart,
  savePptx,
  savePptxBounded,
  type OpenedPptx,
  type TextElement,
} from '@vantage/pptx-engine'
import { runTxn, type Op } from '@vantage/pptx-ops'
import { notesDraftAfterOwnFlush } from '../src/shared/notes-draft'
import { notesPartIndex, writeNotesPart } from '../src/shared/notes-target'
import {
  freezeSlidesDraft,
  inspectDraftBudget,
  serializeSlidesDraft,
  slidesDraftRevision,
} from '../src/main/slides-draft-package'

const paragraphs = (text: string) => [{ runs: [{ text }] }]
function apply(opened: OpenedPptx, op: Op) {
  const result = runTxn(opened, { ops: [op] })
  expect(result.applied, result.failures?.[0]?.error).toBe(true)
  return result
}
async function fixture() {
  const opened = await openPptx(await createBlankPptx())
  apply(opened, {
    op: 'addElement',
    target: { slide: 0 },
    kind: 'textbox',
    offset: { x: 1000, y: 1000, cx: 2000000, cy: 500000 },
    paragraphs: paragraphs('before'),
  })
  const source = { opened: await openPptx(await savePptx(opened)) }
  const element = source.opened.deck.slides[0]!.elements.find(
    (element) => element.type === 'text' || element.type === 'shape',
  )!
  return { source, id: element.id, slidePath: source.opened.deck.slides[0]!.path }
}

describe('complete immutable PPTX draft packages', () => {
  it('binds notes writes and reads to the correct real deck part after reorder, and refuses missing parts', async () => {
    const f = await fixture()
    const firstPath = f.source.opened.deck.slides[0]!.path
    const second = duplicateSlide(f.source.opened, 0)!
    expect(second).toBeTruthy()
    apply(f.source.opened, { op: 'setNotes', target: { slide: 0 }, text: 'first original notes' })
    apply(f.source.opened, { op: 'setNotes', target: { slide: 1 }, text: 'second original notes' })
    moveSlide(f.source.opened, 0, 1)
    expect(f.source.opened.deck.slides[0]!.path).toBe(second.path)
    const write = vi.fn(
      (index: number) =>
        runTxn(f.source.opened, {
          ops: [
            {
              op: 'setNotes',
              target: { slide: index },
              text: 'new notes for the moved first part',
            },
          ],
        }).applied,
    )
    expect(
      writeNotesPart(f.source.opened.deck.slides, { slideIndex: 0, partPath: firstPath }, write),
    ).toBe(true)
    expect(write).toHaveBeenCalledWith(1)
    expect(notesPartIndex(f.source.opened.deck.slides, 0, firstPath)).toBe(1)
    expect(
      writeNotesPart(
        f.source.opened.deck.slides,
        { slideIndex: 0, partPath: 'ppt/slides/missing.xml' },
        write,
      ),
    ).toBe(false)
    expect(
      writeNotesPart(
        f.source.opened.deck.slides,
        { slideIndex: 0, partPath: 'x'.repeat(4097) },
        write,
      ),
    ).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(notesPartIndex(f.source.opened.deck.slides, 0)).toBe(0)
    const reopened = await openPptx(await serializeSlidesDraft(freezeSlidesDraft(f.source, {})))
    expect(getSlideNotes(reopened.archive, firstPath)).toBe('new notes for the moved first part')
    expect(getSlideNotes(reopened.archive, second.path)).toBe('second original notes')
  })
  it('recovers notes resumed during an acknowledged own flush while still refusing a peer replacement', async () => {
    const f = await fixture()
    apply(f.source.opened, { op: 'setNotes', target: { slide: 0 }, text: 'first submitted words' })
    const flushed = { index: 0, partPath: f.slidePath, base: '', text: 'first submitted words' }
    const newer = { ...flushed, text: 'first submitted words plus still-focused typing' }
    const stored = getSlideNotes(f.source.opened.archive, f.slidePath)
    const rebased = notesDraftAfterOwnFlush(newer, flushed, stored)!
    const recovered = await openPptx(
      await serializeSlidesDraft(
        freezeSlidesDraft(f.source, {
          notes: {
            slideIndex: rebased.index,
            partPath: f.slidePath,
            text: rebased.text,
            baseline: rebased.base,
          },
        }),
      ),
    )
    expect(getSlideNotes(recovered.archive, f.slidePath)).toBe(newer.text)
    apply(f.source.opened, {
      op: 'setNotes',
      target: { slide: 0 },
      text: 'peer changed these notes',
    })
    const unchanged = notesDraftAfterOwnFlush(
      newer,
      flushed,
      getSlideNotes(f.source.opened.archive, f.slidePath),
    )!
    expect(unchanged).toBe(newer)
    expect(() =>
      freezeSlidesDraft(f.source, {
        notes: {
          slideIndex: 0,
          partPath: f.slidePath,
          text: unchanged.text,
          baseline: unchanged.base,
        },
      }),
    ).toThrow('changed in another view')
  })
  it('fences a real save/reparse installed into the same Session while preserving stable save identities', async () => {
    const f = await fixture()
    const source = { ...f.source, opSeq: 4, metaRev: 2 }
    const before = slidesDraftRevision(source)
    const bytes = await savePptx(source.opened)
    commitSaved(source.opened)
    expect(slidesDraftRevision(source)).toBe(before)
    source.opened = await openPptx(bytes)
    expect(slidesDraftRevision(source)).not.toBe(before)
    const reparsed = slidesDraftRevision(source)
    source.opSeq++
    expect(slidesDraftRevision(source)).not.toBe(reparsed)
  })
  it.each(['master', 'layout'] as const)(
    'preserves committed %s fill and geometry with no pending text overlay',
    async (kind) => {
      const f = await fixture()
      const info = listMasterParts(f.source.opened.archive).find((part) => part.kind === kind)!
      const part = parseMasterPart(f.source.opened.archive, info.partPath)!
      const added = runTxn(f.source.opened, {
        parts: new Map([[info.partPath, part]]),
        ops: [
          {
            op: 'addElement',
            target: { part: info.partPath },
            kind: 'textbox',
            offset: { x: 123456, y: 223456, cx: 2000000, cy: 500000 },
            paragraphs: paragraphs('committed style target'),
          },
        ],
      })
      expect(added.applied, added.failures?.[0]?.error).toBe(true)
      const element = part.elements.at(-1)!
      const styled = runTxn(f.source.opened, {
        parts: new Map([[info.partPath, part]]),
        ops: [
          {
            op: 'setFill',
            target: { part: info.partPath, el: element.id },
            fill: '#27A4B8',
          },
        ],
      })
      expect(styled.applied, styled.failures?.[0]?.error).toBe(true)
      const committed = f.source.opened.archive.readText(info.partPath)!
      expect(committed).toContain('123456')
      expect(committed).toContain('27A4B8')
      const source = { ...f.source, masterEdit: { partPath: info.partPath, slide: part } }
      const reopened = await openPptx(await serializeSlidesDraft(freezeSlidesDraft(source, {})))
      expect(reopened.archive.readText(info.partPath)).toBe(committed)
      expect(source.masterEdit.slide).toBe(part)
    },
  )
  it('captures uncommitted rich text and notes without changing live state or identities', async () => {
    const f = await fixture()
    const originalSlide = f.source.opened.deck.slides[0]
    const originalEntries = new Map(
      [...f.source.opened.archive.entries].map(([path, bytes]) => [path, Buffer.from(bytes)]),
    )
    const pending = {
      text: {
        kind: 'text' as const,
        slideIndex: 0,
        sourceId: f.id,
        paragraphs: [{ runs: [{ text: 'pending A & B', bold: true }] }],
      },
      notes: { slideIndex: 0, text: 'not yet blurred', baseline: '' },
    }
    const frozen = freezeSlidesDraft(f.source, pending)
    pending.text.paragraphs[0]!.runs[0]!.text = 'mutated after capture'
    const reopened = await openPptx(await serializeSlidesDraft(frozen))
    expect(reopened.archive.readText(f.slidePath)).toContain('pending A &amp; B')
    expect(reopened.archive.readText(f.slidePath)).toContain('b="1"')
    expect(getSlideNotes(reopened.archive, reopened.deck.slides[0]!.path)).toBe('not yet blurred')
    expect(f.source.opened.deck.slides[0]).toBe(originalSlide)
    expect(f.source.opened.deck.slides[0]!.elements[0]!.id).toBe(f.id)
    for (const [path, bytes] of originalEntries)
      expect(Buffer.from(f.source.opened.archive.entries.get(path)!)).toEqual(bytes)
    expect(f.source.opened.deck.slides[0]!.elements.some((element) => element.dirty)).toBe(false)
  })
  it('keeps media, relationships and unknown package parts byte-identical in the independent package', async () => {
    const f = await fixture()
    const media = Buffer.from([0, 1, 2, 255, 7])
    f.source.opened.archive.entries.set('ppt/media/opaque-original.bin', media)
    f.source.opened.archive.entries.set(
      'customXml/private-extension.xml',
      Buffer.from('<extension preserve="yes">unmodeled</extension>'),
    )
    const expected = new Map(
      [...f.source.opened.archive.entries].map(([path, bytes]) => [path, Buffer.from(bytes)]),
    )
    const frozen = freezeSlidesDraft(f.source, {})
    media[0] = 99
    const reopened = await openPptx(await serializeSlidesDraft(frozen))
    for (const [path, bytes] of expected)
      expect(Buffer.from(reopened.archive.entries.get(path)!)).toEqual(bytes)
  })
  it('captures a pending table cell using the canonical edit operation', async () => {
    const f = await fixture()
    apply(f.source.opened, {
      op: 'addTable',
      target: { slide: 0 },
      rows: 2,
      cols: 2,
      offset: { x: 5000, y: 5000, cx: 3000000, cy: 1500000 },
    })
    const table = f.source.opened.deck.slides[0]!.elements.find(
      (element) => element.type === 'table',
    )!
    const frozen = freezeSlidesDraft(f.source, {
      text: {
        kind: 'table',
        slideIndex: 0,
        sourceId: table.id,
        row: 1,
        col: 0,
        paragraphs: paragraphs('pending table cell'),
      },
    })
    const reopened = await openPptx(await serializeSlidesDraft(frozen))
    expect(reopened.archive.readText(f.slidePath)).toContain('pending table cell')
    expect(f.source.opened.archive.readText(f.slidePath)).not.toContain('pending table cell')
  })
  it.each(['master', 'layout'] as const)(
    'includes committed and pending %s edits without leaving master view',
    async (kind) => {
      const f = await fixture()
      const info = listMasterParts(f.source.opened.archive).find((part) => part.kind === kind)!
      expect(info).toBeTruthy()
      const part = parseMasterPart(f.source.opened.archive, info.partPath)!
      const result = runTxn(f.source.opened, {
        parts: new Map([[info.partPath, part]]),
        ops: [
          {
            op: 'addElement',
            target: { part: info.partPath },
            kind: 'textbox',
            offset: { x: 1000, y: 1000, cx: 2000000, cy: 500000 },
            paragraphs: paragraphs(`committed ${kind}`),
          },
        ],
      })
      expect(result.applied, result.failures?.[0]?.error).toBe(true)
      const element = part.elements.find(
        (element) => element.type === 'text' || element.type === 'shape',
      )!
      const source = { ...f.source, masterEdit: { partPath: info.partPath, slide: part } }
      const frozen = freezeSlidesDraft(source, {
        text: {
          kind: 'master',
          partPath: info.partPath,
          sourceId: element.id,
          paragraphs: paragraphs(`pending ${kind}`),
        },
      })
      const reopened = await openPptx(await serializeSlidesDraft(frozen))
      expect(reopened.archive.readText(info.partPath)).toContain(`pending ${kind}`)
      expect(f.source.opened.archive.readText(info.partPath)).toContain(`committed ${kind}`)
      expect(source.masterEdit.slide).toBe(part)
    },
  )
  it('recovery serialization cannot acknowledge a newer edit on an in-flight real save', async () => {
    const f = await fixture()
    apply(f.source.opened, {
      op: 'setText',
      target: { slide: 0, el: f.id },
      paragraphs: paragraphs('first disk snapshot'),
    })
    const realSave = savePptx(f.source.opened)
    const live = f.source.opened.deck.slides[0]!.elements.find(
      (element) => element.id === f.id,
    ) as TextElement
    live.text!.paragraphs = paragraphs('newer unsaved edit')
    live.dirty = true
    const draft = freezeSlidesDraft(f.source, {})
    await serializeSlidesDraft(draft)
    const disk = await openPptx(await realSave)
    commitSaved(f.source.opened)
    expect(disk.archive.readText(f.slidePath)).toContain('first disk snapshot')
    expect(live.dirty).toBe(true)
    expect(
      (await openPptx(await savePptx(f.source.opened))).archive.readText(f.slidePath),
    ).toContain('newer unsaved edit')
  })
  it('refuses changed note baselines and vanished targets instead of producing a partial draft', async () => {
    const f = await fixture()
    apply(f.source.opened, { op: 'setNotes', target: { slide: 0 }, text: 'peer notes' })
    expect(() =>
      freezeSlidesDraft(f.source, {
        notes: { slideIndex: 0, text: 'stale overlay', baseline: '' },
      }),
    ).toThrow('changed in another view')
    expect(() =>
      freezeSlidesDraft(f.source, {
        text: { kind: 'text', slideIndex: 999, sourceId: f.id, paragraphs: paragraphs('bad') },
      }),
    ).toThrow('slide being edited changed')
    expect(getSlideNotes(f.source.opened.archive, f.slidePath)).toBe('peer notes')
  })
  it('enforces serialization and capture budgets before publishing any partial package', async () => {
    const f = await fixture()
    await expect(savePptxBounded(freezeSlidesDraft(f.source, {}), 100)).rejects.toThrow('exceeds')
    expect(() => inspectDraftBudget({ text: 'x'.repeat(65) }, 64)).toThrow('budget')
    expect(() =>
      freezeSlidesDraft(f.source, {
        notes: { slideIndex: 0, text: 'x'.repeat(1024 * 1024 + 1), baseline: '' },
      }),
    ).toThrow('budget')
    const reopened = await openPptx(await savePptx(f.source.opened))
    expect(reopened.archive.readText(f.slidePath)).toContain('before')
  })
})
