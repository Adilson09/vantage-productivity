import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { parseDocText, stripLegacyFencedDivs, type DocEnvelope } from '../src/renderer/markdown/docText'
import { buildSourceMap, spliceMarkdown } from '../src/renderer/markdown/sourceSplice'
import { captureMarkdownSource, roundTripMarkdownEnabled, serializeMarkdownForSave } from '../src/renderer/markdown/roundtripSerializer'
import { prepareAssetsForSaveAs } from '../src/main/asset-lifecycle'

const editors: Editor[] = []
const roots: string[] = []
afterEach(async () => {
  for (const editor of editors.splice(0)) editor.destroy()
  localStorage.clear()
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'vantage-source-retention-'))) throw new Error('Unexpected test folder')
    await rm(root, { recursive: true, force: true })
  }
})
function open(source: string) {
  const editor = new Editor({ content: '', extensions: buildExtensions({
    slashController: { onOpen() {}, onUpdate() {}, onClose() {}, onKeyDown: () => false }, slashItems: () => [],
  }) })
  editors.push(editor)
  const envelope = parseDocText(source), body = stripLegacyFencedDivs(envelope.body)
  editor.chain().setMeta('addToHistory', false).setContent(body, { contentType: 'markdown' }).run()
  const map = buildSourceMap(editor, editor.state.doc, body)
  const original = captureMarkdownSource(source, envelope, editor.state.doc)
  const serializeBody = vi.fn(() => map ? spliceMarkdown(editor, editor.state.doc, map) : editor.getMarkdown())
  const save = (clean: boolean) => serializeMarkdownForSave(envelope, editor.state.doc, serializeBody, { original, clean, experimental: false })
  return { editor, envelope, original, serializeBody, save }
}

describe('default-off retention for provably unchanged Markdown', () => {
  it.each([
    'Title\n=====\n\n[Manual][ref]\n\n[ref]: https://example.com  "Keep quote"\n',
    '---\r\ntitle: Задача\r\n---\r\n\r\n# Note\r\n\r\nEditable paragraph.\r\n',
    '\uFEFF---\r\ntitle: Keep me\n---\r\n\nTitle\n=====\r\n\r\n<div data-kind="retain">Raw HTML</div>\n\n[Manual][ref]\r\n\n[ref]: https://example.com  "Keep quote"\n',
  ])('retains all original UTF-8 bytes with the experimental preference off: %j', (source) => {
    expect(roundTripMarkdownEnabled()).toBe(false)
    const opened = open(source)
    expect(Buffer.from(opened.save(true), 'utf8')).toEqual(Buffer.from(source, 'utf8'))
    expect(opened.serializeBody).not.toHaveBeenCalled()
    expect(roundTripMarkdownEnabled()).toBe(false)
  })

  it('requires the clean flag even if the model matches the original after an undo', () => {
    const opened = open('Title\n=====\n')
    opened.save(false)
    expect(opened.serializeBody).toHaveBeenCalledOnce()
  })

  it('does not trust a clean flag when the document fingerprint changed', () => {
    const opened = open('# Title\n\nOriginal paragraph.\n')
    opened.editor.commands.insertContentAt(2, 'verified edit ')
    const result = opened.save(true)
    expect(result).toContain('verified edit')
    expect(result).not.toBe(opened.original.source)
    expect(opened.serializeBody).toHaveBeenCalledOnce()
  })

  it.each(['frontmatter', 'eol', 'bom', 'trailingNewline'] as const)(
    'rejects raw-source reuse when envelope %s changed', (key) => {
      const opened = open('---\ntitle: Original\n---\n\nTitle\n=====\n')
      if (key === 'frontmatter') opened.envelope.frontmatter = '---\ntitle: Changed\n---\n\n'
      else if (key === 'eol') opened.envelope.eol = '\r\n'
      else opened.envelope[key] = !opened.envelope[key]
      expect(opened.save(true)).not.toBe(opened.original.source)
      expect(opened.serializeBody).toHaveBeenCalledOnce()
    },
  )

  it('saves a real edit, retains untouched raw syntax, and reopens with a clean exact-source baseline', () => {
    const source = '---\ntitle: Preserve\n---\n\nTitle\n=====\n\n<div data-kind="retain">Raw HTML</div>\n\n[Manual][ref]\n\n[ref]: https://example.com  "Keep quote"\n'
    const opened = open(source)
    opened.editor.commands.insertContentAt(2, 'edited ')
    const written = opened.save(false)
    expect(written).toContain('edited')
    expect(written).toContain('<div data-kind="retain">Raw HTML</div>')
    expect(written).toContain('[ref]: https://example.com  "Keep quote"')
    const reopened = open(written)
    expect(reopened.editor.getText()).toContain('edited')
    expect(reopened.save(true)).toBe(written)
    expect(roundTripMarkdownEnabled()).toBe(false)
  })

  it('retains original raw source before SaveAs asset relocation and rebases on the legitimate rewritten source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vantage-source-retention-'))
    roots.push(root)
    const sourceDir = join(root, 'source'), targetDir = join(root, 'target')
    await mkdir(join(sourceDir, 'images'), { recursive: true }); await mkdir(targetDir)
    const sourcePath = join(sourceDir, 'note.md'), targetPath = join(targetDir, 'copy.md')
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64')
    await writeFile(join(sourceDir, 'images', 'photo.png'), image)
    const source = '---\r\ntitle: Keep\n---\r\n\n# Picture\r\n\r\n![sample](images/photo.png)\n\n<IMG data-kind="keep" SRC="images/photo.png">\r\n'
    await writeFile(sourcePath, source)
    const opened = open(source)
    const rawForSave = opened.save(true)
    expect(rawForSave).toBe(source)
    const prepared = await prepareAssetsForSaveAs(sourcePath, targetPath, rawForSave, ['images/photo.png'])
    expect(prepared.rewrites).toEqual([{ from: 'images/photo.png', to: 'assets/photo.png' }])
    const written = source.replaceAll('images/photo.png', 'assets/photo.png')
    expect(prepared.text).toBe(written)
    await writeFile(targetPath, prepared.text)
    expect(await readFile(join(targetDir, 'assets', 'photo.png'))).toEqual(image)
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    const reopened = open(prepared.text)
    expect(reopened.save(true)).toBe(written)
    expect(reopened.save(true)).not.toContain('images/photo.png')
    expect(roundTripMarkdownEnabled()).toBe(false)
  })
})
