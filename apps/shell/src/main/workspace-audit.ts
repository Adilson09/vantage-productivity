// Vantage Productivity addition: bounded local structural/accessibility spot checks.
import { open } from 'node:fs/promises'
import { basename, extname, resolve, posix } from 'node:path'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { assertZipInflatesWithinLimits } from '../../../../packages/zip-gate/src/index'
import type {
  AuditedFormat,
  WorkspaceAuditCheck,
  WorkspaceAuditResult,
} from '../shared/vantage-api'
import { inspectPdfStructure } from './pdf-structure-audit'

export const AUDIT_MAX_FILE_BYTES = 32 * 1024 * 1024
const XML_INSPECTION_LIMIT = 4 * 1024 * 1024
const TEXT_INSPECTION_LIMIT = 2 * 1024 * 1024
const ZIP_LIMITS = {
  maxParts: 4000,
  maxPartBytes: 12 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
}
const SCOPE =
  'Local structural and accessibility spot checks only. No AI or network requests. ' +
  'This does not certify rendering fidelity, accessibility, formula results or Microsoft Office compatibility.'

const count = (text: string, expression: RegExp) => Array.from(text.matchAll(expression)).length
const attribute = (tag: string, name: string): string => {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(
    `(?:^|\\s)(?:[\\w.-]+:)?${safe}\\s*=\\s*(?:(["'])([\\s\\S]*?)\\1|([^\\s"'=<>\\x60]+))`,
    'i',
  ).exec(tag)
  return (match?.[2] ?? match?.[3] ?? '').trim()
}
const unescapeXml = (value: string) =>
  value.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]!,
  )

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true
  }
  return false
}

function add(
  checks: WorkspaceAuditCheck[],
  id: string,
  title: string,
  status: WorkspaceAuditCheck['status'],
  detail: string,
  count?: number,
) {
  checks.push({ id, title, status, detail, ...(count === undefined ? {} : { count }) })
}

/** Bound nested-tag work before invoking the XML validator; DTD/entity declarations are not inspected. */
function xmlSafety(text: string): void {
  let depth = 0,
    tags = 0
  let cursor = 0
  while ((cursor = text.indexOf('<', cursor)) !== -1) {
    // Markup-looking examples inside comments/CDATA are text, not nested tags.
    const special = text.startsWith('<!--', cursor)
      ? ['<!--', '-->']
      : text.startsWith('<![CDATA[', cursor)
        ? ['<![CDATA[', ']]>']
        : text.startsWith('<?', cursor)
          ? ['<?', '?>']
          : null
    if (special) {
      const end = text.indexOf(special[1]!, cursor + special[0]!.length)
      if (end === -1)
        throw new Error(
          'XML contains an unterminated comment, CDATA section or processing instruction',
        )
      cursor = end + special[1]!.length
      continue
    }
    if (/^<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text.slice(cursor, cursor + 24))) {
      throw new Error('DTD/entity declarations are outside this inspection policy')
    }
    const closing = text[cursor + 1] === '/'
    const nameStart = cursor + (closing ? 2 : 1)
    // XML names can start with non-ASCII letters too. Count candidates broadly;
    // the validator below decides whether the actual name is well formed.
    if (!text[nameStart] || /[\s!?<>/]/.test(text[nameStart]!)) {
      cursor += 1
      continue
    }
    if (++tags > 100000) throw new Error('XML exceeds the inspection tag budget')
    let quote = '',
      end = nameStart
    for (; end < text.length; end += 1) {
      const char = text[end]!
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (end === text.length) throw new Error('XML contains an unterminated tag')
    if (closing) depth -= 1
    else if (text[end - 1] !== '/' && ++depth > 128)
      throw new Error('XML exceeds the inspection nesting budget')
    cursor = end + 1
  }
  const valid = XMLValidator.validate(text)
  if (valid !== true) throw new Error(`XML is not well formed: ${valid.err.msg}`)
}

async function xmlPart(
  zip: JSZip,
  name: string,
  checks: WorkspaceAuditCheck[],
  required = false,
): Promise<string | null> {
  const part = zip.file(name)
  if (!part) {
    if (required)
      add(checks, `missing:${name}`, 'Required package part', 'fail', `${name} is missing.`)
    return null
  }
  const bytes = await part.async('uint8array')
  if (bytes.byteLength > XML_INSPECTION_LIMIT) {
    add(
      checks,
      `limit:${name}`,
      'Detailed XML inspection limit',
      'warning',
      `${name} exceeds the 4 MiB per-part inspection limit; its detailed content was not inspected.`,
    )
    return null
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    xmlSafety(text)
  } catch (error) {
    add(checks, `invalid:${name}`, 'Package XML', 'fail', `${name}: ${(error as Error).message}`)
    return null
  }
  return text
}

async function officeChecks(
  bytes: Buffer,
  kind: AuditedFormat,
  checks: WorkspaceAuditCheck[],
): Promise<void> {
  let zip: JSZip
  try {
    // Meter actual inflation before JSZip allocates decoded entry contents.
    await assertZipInflatesWithinLimits(bytes, ZIP_LIMITS)
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  } catch (error) {
    add(
      checks,
      'package',
      'Office package integrity',
      'fail',
      `The package could not be inspected safely: ${(error as Error).message}`,
    )
    return
  }
  add(
    checks,
    'package',
    'Office package integrity',
    'pass',
    'ZIP inflation stayed within the inspection budget and entry CRC checks completed.',
  )
  const contentTypes = await xmlPart(zip, '[Content_Types].xml', checks, true)
  const main =
    kind === 'docx'
      ? 'word/document.xml'
      : kind === 'xlsx'
        ? 'xl/workbook.xml'
        : 'ppt/presentation.xml'
  const xml = await xmlPart(zip, main, checks, true)
  if (contentTypes && xml)
    add(
      checks,
      'required-parts',
      'Core Office parts',
      'pass',
      'Content types and the format’s main XML part are present and well formed.',
    )

  const names = Object.keys(zip.files)
  const active = names.filter((name) => /(?:vbaProject\.bin$|(?:^|\/)activeX\/)/i.test(name))
  add(
    checks,
    'active-content',
    'Embedded active content',
    active.length ? 'warning' : 'pass',
    active.length
      ? `${active.length} macro/ActiveX parts are present. This check does not execute or validate them.`
      : 'No VBA/ActiveX part names were found.',
    active.length,
  )
  let external = 0,
    internal = 0,
    missingTargets = 0
  const missingTargetNames: string[] = []
  for (const name of names.filter((name) => name.endsWith('.rels'))) {
    const rels = await xmlPart(zip, name, checks)
    if (rels) {
      for (const [tag] of rels.matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g)) {
        if (attribute(tag, 'TargetMode').toLowerCase() === 'external') {
          external += 1
          continue
        }
        const target = unescapeXml(attribute(tag, 'Target'))
        internal += 1
        // A relationship belongs to the source part beside its _rels directory.
        const sourceDir = name === '_rels/.rels' ? '' : posix.dirname(posix.dirname(name))
        let resolvedTarget = ''
        try {
          const decoded = decodeURIComponent(target.split('#')[0]!)
          if (
            !decoded ||
            decoded.includes('\\') ||
            hasAsciiControlCharacter(decoded) ||
            /^[a-z][a-z0-9+.-]*:/i.test(decoded)
          )
            throw new Error('Invalid internal target')
          resolvedTarget = posix.normalize(
            decoded.startsWith('/') ? decoded.slice(1) : posix.join(sourceDir, decoded),
          )
        } catch {
          /* Invalid internal URI counts as a missing target below. */
        }
        if (!resolvedTarget || resolvedTarget.startsWith('../') || !zip.file(resolvedTarget)) {
          missingTargets += 1
          if (missingTargetNames.length < 8)
            missingTargetNames.push(`${name} → ${target.slice(0, 160)}`)
        }
      }
    }
  }
  add(
    checks,
    'external-links',
    'External relationships',
    external ? 'warning' : 'pass',
    external
      ? `${external} relationships point outside the file. They were not fetched; review them before sharing.`
      : 'No external relationships were found in the inspected relationship parts.',
    external,
  )
  const incompleteRels = checks.some(
    (check) =>
      (check.id.startsWith('limit:') || check.id.startsWith('invalid:')) &&
      check.id.endsWith('.rels'),
  )
  add(
    checks,
    'relationship-targets',
    'Internal package relationships',
    missingTargets ? 'fail' : incompleteRels ? 'warning' : 'pass',
    `${internal} internal relationships checked; ${missingTargets} missing, invalid or out-of-package targets.${missingTargetNames.length ? ` ${missingTargetNames.join('; ')}` : ''}${incompleteRels ? ' Some relationship parts were invalid or exceeded the inspection limit; coverage is incomplete.' : ''}`,
    missingTargets,
  )
  const core = await xmlPart(zip, 'docProps/core.xml', checks)
  const title = core
    ? /<(?:[\w.-]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?title\s*>/i.exec(core)?.[1]?.trim()
    : ''
  add(
    checks,
    'document-title',
    'Document title metadata',
    title ? 'pass' : 'warning',
    title
      ? 'Title metadata is present.'
      : 'No nonempty title metadata was found. Add a meaningful title before publishing.',
  )

  if (kind === 'docx' && xml) {
    const styles = await xmlPart(zip, 'word/styles.xml', checks)
    const language = /<(?:[\w.-]+:)?lang\b[^>]*\b(?:[\w.-]+:)?val\s*=\s*["'][^"']+["']/i.test(
      `${xml}${styles ?? ''}`,
    )
    add(
      checks,
      'language',
      'Document language',
      language ? 'pass' : 'warning',
      language
        ? 'A language declaration was found.'
        : 'No language declaration was found in the main document/styles parts.',
    )
    const drawings = Array.from(xml.matchAll(/<(?:[\w.-]+:)?docPr\b[^>]*>/g))
    const missing = drawings.filter(
      ([tag]) => !attribute(tag, 'descr') && !attribute(tag, 'title'),
    ).length
    add(
      checks,
      'alt-text',
      'Drawing descriptions',
      missing ? 'warning' : 'pass',
      missing
        ? `${missing} drawing properties lack a description/title. Review alt text; decorative objects may intentionally omit it.`
        : `${drawings.length} drawing properties inspected; no missing descriptions were found.`,
      missing,
    )
    const revisions = count(xml, /<(?:[\w.-]+:)?(?:ins|del)\b/g)
    add(
      checks,
      'revisions',
      'Tracked revisions',
      revisions ? 'warning' : 'pass',
      revisions
        ? `${revisions} insertion/deletion revision elements are present. Review tracked changes before sharing.`
        : 'No insertion/deletion revision elements were found.',
      revisions,
    )
  }
  if (kind === 'xlsx' && xml) {
    const sheets = Array.from(xml.matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*>/g)).map(([tag]) =>
      unescapeXml(attribute(tag, 'name')),
    )
    const duplicates =
      sheets.length - new Set(sheets.map((name) => name.toLocaleLowerCase('en-US'))).size
    const invalid = sheets.filter(
      (name) => !name || name.length > 31 || /[\\/*?:[\]]/.test(name),
    ).length
    add(
      checks,
      'sheet-names',
      'Worksheet names',
      invalid || duplicates ? 'warning' : 'pass',
      `${sheets.length} sheet declarations; ${invalid} empty/overlength/invalid names and ${duplicates} case-insensitive duplicates.`,
      invalid + duplicates,
    )
    let errors = 0,
      formulas = 0
    for (const name of names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) {
      const sheet = await xmlPart(zip, name, checks)
      if (!sheet) continue
      errors += count(sheet, /<(?:[\w.-]+:)?c\b[^>]*\bt\s*=\s*["']e["']/g)
      formulas += count(sheet, /<(?:[\w.-]+:)?f(?:\s|>)/g)
    }
    add(
      checks,
      'cached-errors',
      'Cached spreadsheet error cells',
      errors ? 'warning' : 'pass',
      errors
        ? `${errors} cached error cells were found. Recalculate and inspect their formulas.`
        : 'No cached error cells were found in the inspected worksheets.',
      errors,
    )
    add(
      checks,
      'formula-scope',
      'Formula calculation scope',
      'info',
      `${formulas} formula elements inspected. Formulas were not recalculated or compared with Excel.`,
      formulas,
    )
  }
  if (kind === 'pptx') {
    const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    let untitled = 0,
      missing = 0,
      pictures = 0,
      inspected = 0
    for (const name of slides) {
      const slide = await xmlPart(zip, name, checks)
      if (!slide) continue
      inspected += 1
      if (!/<(?:[\w.-]+:)?ph\b[^>]*\btype\s*=\s*["'](?:title|ctrTitle)["']/i.test(slide))
        untitled += 1
      for (const [picture] of slide.matchAll(
        /<(?:[\w.-]+:)?pic\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?pic\s*>/g,
      )) {
        pictures += 1
        const tag = /<(?:[\w.-]+:)?cNvPr\b[^>]*>/.exec(picture)?.[0] ?? ''
        if (!attribute(tag, 'descr') && !attribute(tag, 'title')) missing += 1
      }
    }
    add(
      checks,
      'slide-titles',
      'Slide title placeholders',
      untitled ? 'warning' : inspected < slides.length ? 'info' : 'pass',
      `${inspected} of ${slides.length} slide parts inspected; ${untitled} lack a title placeholder. They may still have visually authored titles.`,
      untitled,
    )
    add(
      checks,
      'alt-text',
      'Picture descriptions',
      missing ? 'warning' : inspected < slides.length ? 'info' : 'pass',
      `${pictures} pictures in ${inspected} inspected slides; ${missing} lack description/title metadata. Review decorative exceptions manually.`,
      missing,
    )
  }
}

function textChecks(text: string, kind: AuditedFormat, checks: WorkspaceAuditCheck[]): void {
  if (kind === 'html') {
    const html = /<html\b[^>]*>/i.exec(text)?.[0] ?? ''
    add(
      checks,
      'language',
      'Page language',
      attribute(html, 'lang') ? 'pass' : 'warning',
      attribute(html, 'lang')
        ? 'The html element declares a language.'
        : 'No html lang attribute was found.',
    )
    const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text)?.[1]?.trim()
    add(
      checks,
      'title',
      'Page title',
      title ? 'pass' : 'warning',
      title ? 'A nonempty title element is present.' : 'No nonempty title element was found.',
    )
    const images = Array.from(text.matchAll(/<img\b[^>]*>/gi))
    const missing = images.filter(
      ([tag]) =>
        !attribute(tag, 'alt') &&
        attribute(tag, 'role') !== 'presentation' &&
        attribute(tag, 'aria-hidden') !== 'true',
    ).length
    add(
      checks,
      'alt-text',
      'Image descriptions',
      missing ? 'warning' : 'pass',
      `${images.length} images inspected; ${missing} need alt-text/decorative-role review.`,
      missing,
    )
    const scripts = count(text, /<script\b/gi)
    add(
      checks,
      'scripts',
      'Script elements',
      scripts ? 'warning' : 'pass',
      `${scripts} script elements found. This local audit does not execute HTML or scripts.`,
      scripts,
    )
  } else {
    let fence = ''
    const lines = text.split(/\r?\n/).filter((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (marker) {
        if (!fence && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) fence = marker[1]!
        else if (
          fence &&
          fence[0] === marker[1]![0] &&
          marker[1]!.length >= fence.length &&
          !marker[2]!.trim()
        )
          fence = ''
        return false
      }
      return !fence
    })
    const headings = lines
      .map((line) => /^ {0,3}(#{1,6})\s+/.exec(line)?.[1]?.length)
      .filter((level): level is number => !!level)
    const h1s = headings.filter((level) => level === 1).length
    add(
      checks,
      'title',
      'Top-level heading',
      h1s === 1 ? 'pass' : 'warning',
      `${h1s} level-one headings found outside fenced code; one clear document title is recommended.`,
      h1s,
    )
    let skipped = 0,
      previous = 0
    for (const level of headings) {
      if (previous && level > previous + 1) skipped += 1
      previous = level
    }
    add(
      checks,
      'heading-order',
      'Heading sequence',
      skipped ? 'warning' : 'pass',
      `${skipped} heading-level jumps found outside fenced code.`,
      skipped,
    )
    const missing = count(lines.join('\n'), /!\[\s*\]\([^\n]*?\)/g)
    add(
      checks,
      'alt-text',
      'Markdown image descriptions',
      missing ? 'warning' : 'pass',
      `${missing} images have empty alt-text syntax; review decorative intent.`,
      missing,
    )
  }
}

export async function auditFile(filePath: string): Promise<WorkspaceAuditResult> {
  const extension = extname(filePath).toLowerCase()
  const kind = (
    {
      '.docx': 'docx',
      '.xlsx': 'xlsx',
      '.pptx': 'pptx',
      '.pdf': 'pdf',
      '.md': 'md',
      '.markdown': 'md',
      '.html': 'html',
      '.htm': 'html',
    } as Record<string, AuditedFormat>
  )[extension]
  if (!kind)
    throw new Error('Choose a DOCX, XLSX, PPTX, PDF, Markdown or HTML file for inspection.')
  const descriptor = await open(filePath, 'r')
  let bytes: Buffer
  try {
    const info = await descriptor.stat()
    if (!info.isFile() || info.size > AUDIT_MAX_FILE_BYTES)
      throw new Error('Inspection supports regular files up to 32 MiB. The file was not changed.')
    bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await descriptor.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead)
        throw new Error('The file changed during inspection. Try again after saving it.')
      offset += read.bytesRead
    }
    const after = await descriptor.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error('The file changed during inspection. Try again after saving it.')
  } finally {
    await descriptor.close()
  }
  const checks: WorkspaceAuditCheck[] = []
  if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx')
    await officeChecks(bytes!, kind, checks)
  else if (kind === 'pdf') {
    const signature = /^%PDF-\d\.\d/.test(bytes!.subarray(0, 16).toString('latin1'))
    add(
      checks,
      'pdf-header',
      'PDF file signature',
      signature ? 'pass' : 'fail',
      signature
        ? 'A PDF header is present.'
        : 'The file does not begin with a recognized PDF header.',
    )
    const eof = /%%EOF/.test(bytes!.subarray(Math.max(0, bytes!.length - 1024)).toString('latin1'))
    add(
      checks,
      'pdf-eof',
      'PDF end marker',
      eof ? 'pass' : 'warning',
      eof
        ? 'An end marker is present near the end of the file.'
        : 'No end marker was found in the last 1 KiB. Check for a truncated file.',
    )
    const parsed = await inspectPdfStructure(bytes!)
    add(
      checks,
      'pdf-structure',
      'PDF object tree and pages',
      parsed.status,
      parsed.detail,
      parsed.pages,
    )
    add(
      checks,
      'pdf-scope',
      'PDF inspection scope',
      'info',
      'PDF object/page parsing runs separately with a heap budget and deadline. Page rendering, tags, accessibility and PDF/A or PDF/UA conformance are not parsed or certified by this spot check.',
    )
  } else if (bytes!.length > TEXT_INSPECTION_LIMIT)
    add(
      checks,
      'text-limit',
      'Detailed text inspection limit',
      'warning',
      'Detailed Markdown/HTML checks are limited to 2 MiB. The file was not changed.',
    )
  else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes!)
    textChecks(text, kind, checks)
  }
  return {
    fileName: basename(filePath),
    filePath: resolve(filePath),
    kind,
    scannedAt: new Date().toISOString(),
    bytes: bytes!.length,
    checks,
    summary: {
      passed: checks.filter((check) => check.status === 'pass').length,
      warnings: checks.filter((check) => check.status === 'warning').length,
      failed: checks.filter((check) => check.status === 'fail').length,
      informational: checks.filter((check) => check.status === 'info').length,
    },
    scope: SCOPE,
  }
}
