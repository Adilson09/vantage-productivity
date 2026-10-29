// Vantage Productivity: audit real files without opening viewers, networking or modifying source bytes.
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditFile, AUDIT_MAX_FILE_BYTES } from '../src/main/workspace-audit'
import type { WorkspaceAuditResult } from '../src/shared/vantage-api'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vantage-audit-'))
})
afterEach(async () => {
  if (!dir.startsWith(join(tmpdir(), 'vantage-audit-'))) throw new Error('Unexpected test folder')
  await rm(dir, { recursive: true, force: true })
})
const check = (result: WorkspaceAuditResult, id: string) =>
  result.checks.find((item) => item.id === id)
async function textFile(name: string, content: string | Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}
async function officeFile(name: string, parts: Record<string, string | Buffer>): Promise<string> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file(
    'docProps/core.xml',
    '<cp:coreProperties xmlns:cp="urn:cp" xmlns:dc="urn:dc"><dc:title>Useful title</dc:title></cp:coreProperties>',
  )
  for (const [part, bytes] of Object.entries(parts)) zip.file(part, bytes)
  return textFile(name, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

describe('local workspace inspection', () => {
  it('finds Markdown heading jumps and missing descriptions outside code fences', async () => {
    const path = await textFile(
      'notes.md',
      '# Title\n### Jump\n![](image.png)\n````md\n# Example\n```\n# Still code\n![](example.png)\n````',
    )
    const before = await readFile(path)
    const result = await auditFile(path)
    expect(check(result, 'title')).toMatchObject({ status: 'pass', count: 1 })
    expect(check(result, 'heading-order')).toMatchObject({ status: 'warning', count: 1 })
    expect(check(result, 'alt-text')).toMatchObject({ count: 1 })
    expect(result.scope).toContain('does not certify')
    expect(result).not.toHaveProperty('score')
    expect(await readFile(path)).toEqual(before)
  })

  it('inspects HTML metadata and reports scripts without executing them', async () => {
    const path = await textFile(
      'page.html',
      '<html lang=en><head><title>Page</title></head><body><img data-alt="not actual alt text" src="a"><img role="presentation" src="b"><script>throw new Error("must not run")</script></body></html>',
    )
    const result = await auditFile(path)
    expect(check(result, 'language')?.status).toBe('pass')
    expect(check(result, 'title')?.status).toBe('pass')
    expect(check(result, 'alt-text')).toMatchObject({ status: 'warning', count: 1 })
    expect(check(result, 'scripts')).toMatchObject({ status: 'warning', count: 1 })
  })

  it('rejects a PDF with plausible markers but no object/page tree', async () => {
    const result = await auditFile(
      await textFile('sample.pdf', '%PDF-1.7\nThis is not a real PDF object tree.\n%%EOF'),
    )
    expect(check(result, 'pdf-header')?.status).toBe('pass')
    expect(check(result, 'pdf-eof')?.status).toBe('pass')
    expect(check(result, 'pdf-structure')?.status).toBe('fail')
    expect(check(result, 'pdf-scope')?.detail).toContain('not parsed or certified')
    expect(result.summary.informational).toBe(1)
    const truncated = await auditFile(await textFile('truncated.pdf', 'not a PDF'))
    expect(check(truncated, 'pdf-header')?.status).toBe('fail')
    expect(check(truncated, 'pdf-eof')?.status).toBe('warning')
  })

  it('parses real PDF pages in a bounded worker without changing the source', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([612, 792])
    pdf.addPage([400, 300])
    const path = await textFile('real.pdf', Buffer.from(await pdf.save()))
    const before = await readFile(path)
    const result = await auditFile(path)
    expect(check(result, 'pdf-structure')).toMatchObject({ status: 'pass', count: 2 })
    expect(check(result, 'pdf-structure')?.detail).toContain('not rendered')
    expect(await readFile(path)).toEqual(before)
  })

  it.each([
    '',
    'not-pdf',
    '%PDF-1.7',
    '%PDF-1.7\n%%EOF',
    '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF',
    '%PDF-1.7\n1 0 obj << /Type /Pages /Count 1 /Kids [7 0 R] >> endobj\n%%EOF',
    '%PDF-1.7\n1 0 obj << /Type /Page /MediaBox [0 0 1 1] >> endobj\n%%EOF',
    '%PDF-1.7\ntrailer << /Root 99 0 R >>\n%%EOF',
    '%PDF-1.7\nxref\n0 2\n0000000000 65535 f\n0000000010 00000 n\n%%EOF',
    '%PDF-1.7\n1 0 obj << /Length 999999999 >> stream\nbad\n%%EOF',
  ])('does not pass an incomplete or malformed PDF object tree (%#)', async (body) => {
    const path = await textFile('malformed.pdf', body)
    const before = await readFile(path)
    const result = await auditFile(path)
    expect(check(result, 'pdf-structure')?.status).not.toBe('pass')
    expect(await readFile(path)).toEqual(before)
  })

  it('resolves internal relationship targets relative to their source parts', async () => {
    const result = await auditFile(
      await officeFile('targets.docx', {
        'word/document.xml': '<document/>',
        'word/media/image 1.png': Buffer.from('image bytes'),
        'word/_rels/document.xml.rels':
          '<Relationships><Relationship Id="r1" Target="media/image%201.png"/><Relationship Id="r2" Target="/word/document.xml#bookmark"/></Relationships>',
      }),
    )
    expect(check(result, 'relationship-targets')).toMatchObject({ status: 'pass', count: 0 })
  })

  it.each([
    'missing.png',
    '../../../escape.xml',
    'https://example.invalid/file',
    '%ZZ',
    'C:/file.xml',
    'media\\file.png',
    '',
    '%2e%2e/%2e%2e/file.xml',
  ])('reports broken or unsafe internal relationship %s', async (target) => {
    const result = await auditFile(
      await officeFile('broken-target.docx', {
        'word/document.xml': '<document/>',
        'word/_rels/document.xml.rels': `<Relationships><Relationship Id="r1" Target="${target}"/></Relationships>`,
      }),
    )
    expect(check(result, 'relationship-targets')).toMatchObject({ status: 'fail', count: 1 })
  })

  it('finds DOCX revisions, image descriptions, language and external relationships', async () => {
    const path = await officeFile('review.docx', {
      'word/document.xml':
        '<w:document xmlns:w="urn:w" xmlns:wp="urn:wp"><w:lang w:val="en-US"/><wp:docPr id="1"/><w:ins><w:t>new</w:t></w:ins></w:document>',
      'word/_rels/document.xml.rels':
        '<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>',
    })
    const before = await readFile(path)
    const result = await auditFile(path)
    expect(check(result, 'package')?.status).toBe('pass')
    expect(check(result, 'required-parts')?.status).toBe('pass')
    expect(check(result, 'document-title')?.status).toBe('pass')
    expect(check(result, 'language')?.status).toBe('pass')
    expect(check(result, 'external-links')).toMatchObject({ status: 'warning', count: 1 })
    expect(check(result, 'alt-text')).toMatchObject({ count: 1 })
    expect(check(result, 'revisions')).toMatchObject({ count: 1 })
    expect(await readFile(path)).toEqual(before)
  })

  it('reports cached XLSX errors and sheet-name issues without pretending to recalculate', async () => {
    const result = await auditFile(
      await officeFile('book.xlsx', {
        'xl/workbook.xml':
          '<workbook><sheets><sheet name="Data"/><sheet name="data"/><sheet name="Bad/Name"/></sheets></workbook>',
        'xl/worksheets/sheet1.xml':
          '<worksheet><c t="e"><f>1/0</f><v>#DIV/0!</v></c><c><f>2+2</f><v>4</v></c></worksheet>',
      }),
    )
    expect(check(result, 'sheet-names')).toMatchObject({ status: 'warning', count: 2 })
    expect(check(result, 'cached-errors')).toMatchObject({ status: 'warning', count: 1 })
    expect(check(result, 'formula-scope')).toMatchObject({ status: 'info', count: 2 })
    expect(check(result, 'formula-scope')?.detail).toContain('not recalculated')
  })

  it('flags PPTX title placeholders and picture descriptions for manual review', async () => {
    const result = await auditFile(
      await officeFile('deck.pptx', {
        'ppt/presentation.xml': '<presentation/>',
        'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p"><p:pic><p:cNvPr id="1"/></p:pic></p:sld>',
        'ppt/slides/slide2.xml':
          '<p:sld xmlns:p="urn:p"><p:ph type="title"/><p:pic><p:cNvPr descr="Lake"/></p:pic></p:sld>',
      }),
    )
    expect(check(result, 'slide-titles')).toMatchObject({ status: 'warning', count: 1 })
    expect(check(result, 'alt-text')).toMatchObject({ status: 'warning', count: 1 })
  })

  it('rejects corrupt ZIPs and reports missing required package parts', async () => {
    const corrupt = await auditFile(await textFile('broken.docx', 'not a ZIP'))
    expect(check(corrupt, 'package')?.status).toBe('fail')
    const missing = await auditFile(await officeFile('missing.docx', {}))
    expect(check(missing, 'missing:word/document.xml')?.status).toBe('fail')
  })

  it('refuses DTDs, malformed XML and invalid UTF-8 parts', async () => {
    for (const xml of [
      '<!DOCTYPE document [<!ENTITY x "expanded">]><document>&x;</document>',
      '<document><bad></document>',
      Buffer.from([0xff, 0xfe, 0x00]),
    ]) {
      const result = await auditFile(await officeFile('invalid.docx', { 'word/document.xml': xml }))
      expect(check(result, 'invalid:word/document.xml')?.status).toBe('fail')
      expect(check(result, 'required-parts')).toBeUndefined()
    }
  })

  it('does not count quoted text, comments or CDATA as nested XML markup', async () => {
    const examples = '<example>'.repeat(140)
    const xml = `<document><!-- ${examples} --><![CDATA[<!DOCTYPE example>${examples}]]><node value="a > b"/></document>`
    const result = await auditFile(await officeFile('examples.docx', { 'word/document.xml': xml }))
    expect(check(result, 'required-parts')?.status).toBe('pass')
    expect(check(result, 'invalid:word/document.xml')).toBeUndefined()
  })

  it('applies the nesting budget to Unicode XML element names too', async () => {
    const xml = '<é>'.repeat(129) + '</é>'.repeat(129)
    const result = await auditFile(await officeFile('deep.docx', { 'word/document.xml': xml }))
    expect(check(result, 'invalid:word/document.xml')?.detail).toContain('nesting budget')
  })

  it('does not pass picture/title checks for PPTX slide parts that were skipped by the size limit', async () => {
    const xml = '<sld>' + 'x'.repeat(4 * 1024 * 1024) + '</sld>'
    const result = await auditFile(
      await officeFile('partial.pptx', {
        'ppt/presentation.xml': '<presentation/>',
        'ppt/slides/slide1.xml': xml,
      }),
    )
    expect(check(result, 'limit:ppt/slides/slide1.xml')?.status).toBe('warning')
    expect(check(result, 'slide-titles')).toMatchObject({ status: 'info' })
    expect(check(result, 'slide-titles')?.detail).toContain('0 of 1')
    expect(check(result, 'alt-text')?.status).toBe('info')
  })

  it('bounds expansion before decoding a compressed Office part', async () => {
    const result = await auditFile(
      await officeFile('oversized.docx', { 'word/document.xml': 'x'.repeat(12 * 1024 * 1024 + 1) }),
    )
    expect(check(result, 'package')?.status).toBe('fail')
    expect(check(result, 'required-parts')).toBeUndefined()
  })

  it('reports detailed inspection limits honestly', async () => {
    const xml = '<document>' + 'x'.repeat(4 * 1024 * 1024) + '</document>'
    const docx = await auditFile(await officeFile('large.docx', { 'word/document.xml': xml }))
    expect(check(docx, 'limit:word/document.xml')?.status).toBe('warning')
    expect(check(docx, 'required-parts')).toBeUndefined()
    const md = await auditFile(
      await textFile('large.md', '# Title\n' + 'a'.repeat(2 * 1024 * 1024)),
    )
    expect(check(md, 'text-limit')?.status).toBe('warning')
    expect(check(md, 'title')).toBeUndefined()
  })

  it('rejects unsupported extensions and files above the input cap', async () => {
    await expect(auditFile(await textFile('settings.json', '{}'))).rejects.toThrow('Choose a DOCX')
    const path = await textFile('huge.md', '')
    await truncate(path, AUDIT_MAX_FILE_BYTES + 1)
    await expect(auditFile(path)).rejects.toThrow('32 MiB')
    expect((await readFile(path)).length).toBe(AUDIT_MAX_FILE_BYTES + 1)
  })
})
