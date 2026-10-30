import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, type DefaultTreeAdapterTypes as T } from 'parse5'
import { assertStaticHtmlRecoveryScript } from './html-draft-script'
import { init as initializeModules, parse as moduleImports } from 'es-module-lexer'
import {
  ASSET_SNIFF_BYTES,
  PREVIEW_ASSET_EXTS,
  extensionlessAssetMime,
  sniffBinaryAssetMime,
} from './asset-mime'
import {
  applyRecoveryPatches,
  rewriteRecoveryCss,
  type RecoveryResourceKind,
  type RecoveryTextPatch,
} from './html-draft-css'
import {
  HTML_DRAFT_MAX_ASSETS,
  HTML_DRAFT_MAX_BYTES,
  HTML_DRAFT_REMOTE_MARKER,
  type HtmlDraftMaterialization,
} from '../shared/html-draft'

export interface HtmlDraftAssetGrant {
  documentPath: string | null
  directory: string | null
  realDirectory: string | null
  files: readonly { path: string; realPath: string }[]
}
const UNSUPPORTED_DYNAMIC_SVG = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'discard',
])
const MAX_DEPTH = 8,
  MAX_NODES = 100000,
  MAX_CACHED_BYTES = HTML_DRAFT_MAX_BYTES * 2
const canonical = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const within = (root: string, path: string) => {
  const part = relative(canonical(root), canonical(path))
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))
}
const isElement = (node: T.Node): node is T.Element => 'tagName' in node
const isText = (node: T.Node): node is T.TextNode => node.nodeName === '#text'
const attribute = (node: T.Element, name: string) =>
  node.attrs.find((a) => (a.prefix ? a.prefix + ':' : '') + a.name === name)?.value
const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const utf8 = (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
// JavaScript MIME type essence list: https://mimesniff.spec.whatwg.org/#javascript-mime-type
const SCRIPT_MIMES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])
const scriptMime = (mime: string) => SCRIPT_MIMES.has(mime.split(';')[0]!.trim().toLowerCase())
const textMime = (mime: string) =>
  mime === 'text/css' ||
  scriptMime(mime) ||
  mime === 'image/svg+xml' ||
  mime === 'text/html' ||
  mime === 'application/xhtml+xml'
function remote(source: string): boolean {
  return /^(?:https?|ftp|wss?):/i.test(source) || source.startsWith('//')
}
function recoveredMarker(source: string): string {
  return source.replace(new RegExp('^<!--' + HTML_DRAFT_REMOTE_MARKER + ':[0-9]+-->\\r?\\n?'), '')
}

interface SrcsetCandidate {
  url: string
  descriptor: string
}
function srcset(source: string): SrcsetCandidate[] {
  const result: SrcsetCandidate[] = []
  let i = 0
  while (i < source.length) {
    while (i < source.length && /[\s,]/.test(source[i]!)) i++
    const start = i
    while (i < source.length && !/\s/.test(source[i]!)) i++
    let url = source.slice(start, i),
      descriptor = ''
    if (!url) break
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '')
    } else {
      const from = i
      let brackets = 0
      for (; i < source.length; i++) {
        const c = source[i]!
        if (c === '(') brackets++
        else if (c === ')') brackets--
        if (c === ',' && brackets <= 0) break
      }
      descriptor = source.slice(from, i).trim()
      if (i < source.length) i++
      if (
        descriptor &&
        !/^(?:[0-9]+(?:\.[0-9]+)?[wxh])(?:\s+[0-9]+(?:\.[0-9]+)?[wxh])*$/.test(descriptor)
      )
        throw new Error('An image candidate list cannot be captured without changing its meaning.')
    }
    if (url) result.push({ url, descriptor })
    if (result.length > HTML_DRAFT_MAX_ASSETS)
      throw new Error('Too many responsive image candidates for recovery.')
  }
  return result
}

/** No scripts are executed and no remote URL is fetched. Run this parser only in the bounded worker. */
export async function materializeHtmlDraft(
  input: Buffer,
  grant: HtmlDraftAssetGrant,
  options: { reportExecutableSeals?: boolean } = {},
): Promise<HtmlDraftMaterialization> {
  if (!Buffer.isBuffer(input) || input.length > HTML_DRAFT_MAX_BYTES)
    throw new Error('The HTML document exceeds its recovery limit.')
  if (!grant || !Array.isArray(grant.files) || grant.files.length > HTML_DRAFT_MAX_ASSETS)
    throw new Error('Invalid HTML recovery grants.')
  if (
    grant.documentPath !== null &&
    (!isAbsolute(grant.documentPath) ||
      grant.documentPath.includes('\0') ||
      grant.directory === null ||
      canonical(dirname(grant.documentPath)) !== canonical(grant.directory) ||
      grant.realDirectory === null ||
      !isAbsolute(grant.realDirectory))
  )
    throw new Error('The HTML recovery base is not the active document.')
  if (grant.documentPath === null && (grant.directory !== null || grant.realDirectory !== null))
    throw new Error('An untitled draft has no implicit filesystem grant.')
  for (const file of grant.files)
    if (
      !file ||
      !isAbsolute(file.path) ||
      !isAbsolute(file.realPath) ||
      file.path.includes('\0') ||
      file.realPath.includes('\0')
    )
      throw new Error('Invalid explicit HTML asset grant.')
  const collector = new HtmlRecoveryAssets(
    { ...grant, files: grant.files.map((file) => ({ ...file })) },
    input.length,
  )
  const base = grant.documentPath ? pathToFileURL(grant.documentPath).href : null
  const decoded = utf8(input),
    bom = decoded.startsWith('\uFEFF')
  let source = await collector.html(recoveredMarker(bom ? decoded.slice(1) : decoded), base, 0)
  if (collector.remotes.size) {
    source = '<!--' + HTML_DRAFT_REMOTE_MARKER + ':' + collector.remotes.size + '-->\n' + source
  }
  if (bom) source = '\uFEFF' + source
  if (Buffer.byteLength(source) > HTML_DRAFT_MAX_BYTES)
    throw new Error('The self-contained HTML recovery copy exceeds 16 MiB.')
  return {
    bytes: Buffer.from(source, 'utf8'),
    remoteReferences: collector.remotes.size,
    ...(options.reportExecutableSeals
      ? { unsealedExecutableReferences: collector.unsealedExecutableReferences }
      : {}),
  }
}

class HtmlRecoveryAssets {
  unsealedExecutableReferences = false
  readonly remotes = new Set<string>()
  private readonly encoded = new Map<string, string>()
  private readonly active = new Set<string>()
  private readonly reads = new Map<string, Buffer>()
  private readonly authorized = new Map<string, { path: string; bytes: Buffer }>()
  private readonly targets = new Set<string>()
  private readonly imports = new Map<string, string>()
  private rawBytes: number
  private encodedBytes = 0
  private resources = 0
  private nodes = 0
  private embeddedLocal = 0
  constructor(
    private readonly grant: HtmlDraftAssetGrant,
    inputBytes: number,
  ) {
    this.rawBytes = inputBytes
  }

  private async file(target: string): Promise<{ path: string; bytes: Buffer }> {
    const prior = this.authorized.get(canonical(target))
    if (prior) return prior
    const exact = this.grant.files.find((file) => canonical(file.path) === canonical(target))
    let physical: string
    if (exact) {
      if (!isAbsolute(exact.realPath)) throw new Error('The selected asset grant is invalid.')
      physical = resolve(exact.realPath)
    } else {
      const directory = this.grant.directory,
        realDirectory = this.grant.realDirectory
      if (!directory || !realDirectory || !within(directory, target))
        throw new Error('A local resource is outside this document’s granted folder.')
      const rootInfo = await lstat(realDirectory)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error('The document asset folder changed.')
      const parts = relative(canonical(directory), canonical(target)).split(sep).filter(Boolean)
      physical = realDirectory
      for (let i = 0; i < parts.length; i++) {
        physical = join(physical, parts[i]!)
        const info = await lstat(physical)
        if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
          throw new Error('A local resource is not a stable file inside the document folder.')
      }
    }
    const info = await lstat(physical)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('A local resource is not a regular file.')
    const actual = await realpath(physical)
    if (
      exact
        ? canonical(actual) !== canonical(exact.realPath)
        : !this.grant.realDirectory || !within(this.grant.realDirectory, actual)
    )
      throw new Error('A local resource escaped its grant.')
    const cached = this.reads.get(canonical(actual))
    if (cached) return { path: actual, bytes: cached }
    if (info.size > HTML_DRAFT_MAX_BYTES || this.rawBytes + info.size > HTML_DRAFT_MAX_BYTES)
      throw new Error('The document and local resources exceed the recovery byte budget.')
    const file = await open(actual, 'r')
    try {
      const before = await file.stat()
      if (
        !before.isFile() ||
        before.size !== info.size ||
        before.ino !== info.ino ||
        before.dev !== info.dev ||
        this.rawBytes + before.size > HTML_DRAFT_MAX_BYTES
      )
        throw new Error('A local resource changed before it could be captured.')
      this.rawBytes += before.size
      const bytes = Buffer.alloc(before.size)
      let offset = 0
      while (offset < bytes.length) {
        const part = await file.read(
          bytes,
          offset,
          Math.min(1024 * 1024, bytes.length - offset),
          offset,
        )
        if (!part.bytesRead) throw new Error('A local resource was truncated during recovery.')
        offset += part.bytesRead
      }
      const after = await file.stat()
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.ino !== after.ino ||
        before.dev !== after.dev
      )
        throw new Error('A local resource changed during recovery.')
      this.reads.set(canonical(actual), bytes)
      const captured = { path: actual, bytes }
      this.authorized.set(canonical(target), captured)
      return captured
    } finally {
      await file.close()
    }
  }

  private mime(path: string, bytes: Buffer, kind: RecoveryResourceKind): string {
    const extension = extname(path).toLowerCase()
    if (extension && !PREVIEW_ASSET_EXTS.has(extension))
      throw new Error('This neighbouring file type is not granted as an HTML asset.')
    const binary = sniffBinaryAssetMime(bytes.subarray(0, ASSET_SNIFF_BYTES))
    let mime =
      binary ??
      (extension === '.css'
        ? 'text/css'
        : extension === '.js' || extension === '.mjs'
          ? 'text/javascript'
          : extension === '.svg'
            ? 'image/svg+xml'
            : null)
    if (!mime && !extension) {
      const accept = kind === 'style' ? 'text/css' : kind === 'image' ? 'image/*' : '*/*'
      mime =
        extensionlessAssetMime(path, bytes.subarray(0, ASSET_SNIFF_BYTES), accept)?.split(';')[0] ??
        null
      if (kind === 'other' && (mime === 'text/javascript' || mime === 'text/css'))
        throw new Error('An untyped local text file is not an image, font or media asset.')
    }
    if (!mime) throw new Error('A local asset has an unsupported or unrecognizable media type.')
    if (
      (kind === 'style' && mime !== 'text/css') ||
      (kind === 'script' && mime !== 'text/javascript') ||
      (kind === 'image' && !mime.startsWith('image/')) ||
      (kind === 'font' && !mime.startsWith('font/')) ||
      (kind === 'media' && !/^(?:audio|video)\//.test(mime))
    )
      throw new Error('A local asset does not match the resource type requested by the page.')
    return mime
  }

  private data(mime: string, bytes: Buffer): string {
    const estimated =
      'data:'.length + mime.length + ';base64,'.length + 4 * Math.ceil(bytes.length / 3)
    if (estimated > HTML_DRAFT_MAX_BYTES || this.encodedBytes + estimated > MAX_CACHED_BYTES)
      throw new Error('Encoded local resources exceed the recovery budget.')
    this.encodedBytes += estimated
    return 'data:' + mime + ';base64,' + bytes.toString('base64')
  }

  private async inlineData(
    source: string,
    kind: RecoveryResourceKind,
    depth: number,
  ): Promise<string> {
    const comma = source.indexOf(',')
    if (comma < 0) throw new Error('An embedded resource has no data payload.')
    const header = source.slice(5, comma),
      mime = header.split(';')[0]?.toLowerCase() || 'text/plain'
    if (kind === 'script' && !scriptMime(mime))
      throw new Error('An embedded executable script has an unsupported media type.')
    if (!textMime(mime)) return source
    const payload = source.slice(comma + 1)
    let bytes: Buffer
    if (/;base64(?:;|$)/i.test(header)) {
      const clean = payload.replace(/\s/g, '')
      if (
        !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) ||
        Math.floor((clean.length * 3) / 4) > HTML_DRAFT_MAX_BYTES
      )
        throw new Error(
          'An embedded text resource exceeds its recovery budget or has invalid encoding.',
        )
      bytes = Buffer.from(clean, 'base64')
    } else {
      const decoded = decodeURIComponent(payload)
      if (Buffer.byteLength(decoded) > HTML_DRAFT_MAX_BYTES)
        throw new Error('An embedded text resource exceeds its recovery budget.')
      bytes = Buffer.from(decoded, 'utf8')
    }
    const original = utf8(bytes)
    const rewritten = await this.text(original, mime, source, depth + 1)
    return rewritten === original ? source : this.data(mime, Buffer.from(rewritten, 'utf8'))
  }

  async resource(
    source: string,
    kind: RecoveryResourceKind,
    base: string | null,
    depth: number,
  ): Promise<string> {
    if (depth > MAX_DEPTH)
      throw new Error('The local resource dependency graph is too deep for recovery.')
    if (/^javascript:/i.test(source.replace(/[\u0000-\u0020]/g, '')))
      throw new Error(
        'Executable javascript URLs cannot be captured independently; the previous recovery copy is retained.',
      )
    // Re-reading a mutable executable file cannot prove what an already loaded frame executed.
    if (kind === 'script' && !/^data:/i.test(source)) this.unsealedExecutableReferences = true
    if (!source || source.startsWith('#') || /^about:/i.test(source)) {
      if (kind === 'script')
        throw new Error('An opaque executable script URL cannot be captured independently.')
      return source
    }
    if (remote(source)) {
      if (kind === 'script')
        throw new Error(
          'Remote executable scripts cannot be inspected without fetching; the previous recovery copy is retained.',
        )
      let absolute = source
      if (source.startsWith('//')) {
        if (base && /^https?:/i.test(base)) absolute = new URL(source, base).href
        else if (depth > 0)
          throw new Error('A scheme-relative nested resource has no independent network base.')
      }
      this.remotes.add(absolute)
      if (this.remotes.size > 10000) throw new Error('Too many remote references for recovery.')
      return absolute
    }
    if (/^data:/i.test(source)) return this.inlineData(source, kind, depth)
    if (/^(?:blob|cid|filesystem|html-asset):/i.test(source))
      throw new Error('A temporary or unresolved local resource cannot survive a restart.')
    let url: URL
    try {
      url =
        isAbsolute(source) && (!base || base.startsWith('file:'))
          ? pathToFileURL(source)
          : base
            ? new URL(source, base)
            : new URL(source)
    } catch {
      throw new Error('A local resource has no resolvable document base.')
    }
    if (url.protocol !== 'file:') {
      if (kind === 'script')
        throw new Error('Opaque executable module dependencies cannot be captured independently.')
      this.remotes.add(url.href)
      if (this.remotes.size > 10000) throw new Error('Too many remote references for recovery.')
      return url.href
    }
    const fragment = url.hash
    url.hash = ''
    url.search = ''
    let target: string
    try {
      target = fileURLToPath(url)
    } catch {
      throw new Error('A local resource path is not supported on this computer.')
    }
    // Reject disallowed extensions before opening or resolving any neighbouring file.
    const extension = extname(target).toLowerCase()
    if (extension && !PREVIEW_ASSET_EXTS.has(extension))
      throw new Error('A local resource is not an allowed HTML asset type.')
    if (!this.targets.has(canonical(target))) {
      if (++this.resources > HTML_DRAFT_MAX_ASSETS)
        throw new Error('The page has too many local resources for recovery.')
      this.targets.add(canonical(target))
    }
    const file = await this.file(target)
    const mime = this.mime(file.path, file.bytes, kind)
    const key = canonical(file.path) + '\0' + mime
    const cached = this.encoded.get(key)
    if (cached) return cached + fragment
    if (this.active.has(key))
      throw new Error(
        'Cyclic local resource imports cannot yet be recovered as one independent file.',
      )
    this.active.add(key)
    try {
      let bytes = file.bytes
      if (textMime(mime))
        bytes = Buffer.from(
          await this.text(utf8(bytes), mime, pathToFileURL(file.path).href, depth + 1),
          'utf8',
        )
      const encoded = this.data(mime, bytes)
      this.embeddedLocal++
      this.encoded.set(key, encoded)
      return encoded + fragment
    } finally {
      this.active.delete(key)
    }
  }

  private async text(source: string, mime: string, base: string, depth: number): Promise<string> {
    if (depth > MAX_DEPTH)
      throw new Error('The local resource dependency graph is too deep for recovery.')
    if (mime === 'text/css')
      return rewriteRecoveryCss(source, (value, kind) => this.resource(value, kind, base, depth))
    if (scriptMime(mime)) return this.script(source, base, depth)
    if (mime === 'image/svg+xml' || mime === 'text/html' || mime === 'application/xhtml+xml')
      return this.html(source, base, depth)
    return source
  }

  private async script(source: string, base: string | null, depth: number): Promise<string> {
    assertStaticHtmlRecoveryScript(source)
    await initializeModules
    const [imports] = moduleImports(source)
    const patches: RecoveryTextPatch[] = []
    for (const item of imports) {
      if (item.d === -2)
        throw new Error(
          'A script depends on its original module URL and cannot be made independent yet.',
        )
      if (item.n === undefined)
        throw new Error(
          'A dynamic module dependency cannot be resolved without executing the page.',
        )
      let name = item.n
      if (!/^(?:[./\\]|[a-z][a-z0-9+.-]*:)/i.test(name)) {
        const mapped = this.imports.get(name)
        if (!mapped)
          throw new Error('A bare local module dependency has no complete import mapping.')
        name = mapped
      }
      const next = await this.resource(name, 'script', base, depth)
      if (next === item.n) continue
      const range = source.slice(item.s, item.e)
      const quoted = range.startsWith('"') || range.startsWith("'") || range.charCodeAt(0) === 96
      let replacement = quoted ? JSON.stringify(next) : JSON.stringify(next).slice(1, -1)
      if (!quoted && source[item.s - 1] === "'") replacement = replacement.replace(/'/g, "\\'")
      patches.push({ from: item.s, to: item.e, text: replacement })
    }
    return applyRecoveryPatches(source, patches)
  }

  async html(source: string, initialBase: string | null, depth: number): Promise<string> {
    if (depth > MAX_DEPTH)
      throw new Error('The HTML resource dependency graph is too deep for recovery.')
    const inheritedImports = new Map(this.imports)
    if (depth > 0) this.imports.clear()
    try {
      const document = parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: true })
      const stack: T.Node[] = [document],
        elements: T.Element[] = []
      while (stack.length) {
        const node = stack.pop()!
        if (++this.nodes > MAX_NODES)
          throw new Error('The HTML document exceeds its recovery structure budget.')
        if (isElement(node)) elements.push(node)
        if ('childNodes' in node)
          for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!)
        if (isElement(node) && node.tagName === 'template') stack.push((node as T.Template).content)
      }
      let base = initialBase
      const authoredBase = elements.find(
        (node) => node.tagName === 'base' && attribute(node, 'href') !== undefined,
      )
      if (authoredBase) {
        try {
          base = new URL(attribute(authoredBase, 'href')!, base ?? undefined).href
        } catch {
          throw new Error('The document base URL cannot be resolved for recovery.')
        }
      }
      const patches: RecoveryTextPatch[] = []
      const attrPatch = (node: T.Element, name: string, value: string) => {
        const location = node.sourceCodeLocation?.attrs?.[name]
        if (!location) throw new Error('A resource attribute has no stable source range.')
        const raw = source.slice(location.startOffset, location.endOffset)
        const spelling = /^[^\s=]+/.exec(raw)?.[0] ?? name
        patches.push({
          from: location.startOffset,
          to: location.endOffset,
          text: spelling + '="' + escapeAttribute(value) + '"',
        })
      }
      const replaceAttribute = async (
        node: T.Element,
        name: string,
        kind: RecoveryResourceKind,
      ) => {
        const value = attribute(node, name)
        if (value === undefined) return
        const next = await this.resource(value, kind, base, depth)
        if (next !== value) {
          if (attribute(node, 'integrity'))
            throw new Error(
              'A rewritten local resource has an integrity policy that cannot yet be preserved.',
            )
          attrPatch(node, name, next)
        }
      }
      // Only remote/data import maps can remain independent without recreating a directory namespace.
      for (const node of elements) {
        if (node.tagName !== 'script' || attribute(node, 'type')?.toLowerCase() !== 'importmap')
          continue
        const text = node.childNodes
          .filter(isText)
          .map((n) => n.value)
          .join('')
        const mapping = JSON.parse(text) as { imports?: Record<string, unknown>; scopes?: unknown }
        if (mapping.scopes !== undefined)
          throw new Error('Scoped module imports cannot yet be captured as one independent file.')
        if (mapping.imports) {
          for (const [name, target] of Object.entries(mapping.imports)) {
            if (
              this.imports.size >= HTML_DRAFT_MAX_ASSETS ||
              typeof target !== 'string' ||
              (!remote(target) && !/^data:/i.test(target))
            )
              throw new Error(
                'A local or unbounded import map cannot yet be captured independently.',
              )
            this.imports.set(name, target)
            if (remote(target)) this.remotes.add(target)
          }
        }
      }
      for (const node of elements) {
        const tag = node.tagName
        if (
          node.namespaceURI === 'http://www.w3.org/2000/svg' &&
          UNSUPPORTED_DYNAMIC_SVG.has(tag.toLowerCase())
        )
          throw new Error(
            'Dynamic SVG animation/set dependencies cannot be captured independently; the previous recovery copy is retained.',
          )
        if (tag === 'html' && attribute(node, 'manifest'))
          throw new Error('A legacy application cache cannot be made independent for recovery.')
        for (const attr of node.attrs) {
          if (/^on/i.test(attr.name) && attr.value.trim())
            throw new Error(
              'Event-handler scripts cannot be captured independently; the previous recovery copy is retained.',
            )
          if (/^javascript:/i.test(attr.value.replace(/[\u0000-\u0020]/g, '')))
            throw new Error(
              'Executable javascript URLs cannot be captured independently; the previous recovery copy is retained.',
            )
        }
        if (['body', 'table', 'td', 'th'].includes(tag))
          await replaceAttribute(node, 'background', 'image')
        if (tag === 'track') await replaceAttribute(node, 'src', 'other')
        if (tag === 'feImage') {
          await replaceAttribute(node, 'href', 'image')
          await replaceAttribute(node, 'xlink:href', 'image')
        }
        for (const name of [
          'fill',
          'stroke',
          'filter',
          'mask',
          'clip-path',
          'marker-start',
          'marker-mid',
          'marker-end',
        ]) {
          const value = attribute(node, name)
          if (value !== undefined && /url\s*\(/i.test(value)) {
            const next = await rewriteRecoveryCss(value, (resource, kind) =>
              this.resource(resource, kind, base, depth),
            )
            if (next !== value) attrPatch(node, name, next)
          }
        }
        const style = attribute(node, 'style')
        if (style !== undefined) {
          const next = await rewriteRecoveryCss(style, (value, kind) =>
            this.resource(value, kind, base, depth),
          )
          if (next !== style) attrPatch(node, 'style', next)
        }
        if (
          tag === 'img' ||
          tag === 'image' ||
          (tag === 'input' && attribute(node, 'type')?.toLowerCase() === 'image')
        ) {
          if (tag === 'image') {
            await replaceAttribute(node, 'href', 'image')
            await replaceAttribute(node, 'xlink:href', 'image')
          } else await replaceAttribute(node, 'src', 'image')
        }
        if (tag === 'use') {
          const href = attribute(node, 'href') ?? attribute(node, 'xlink:href')
          if (href && !href.startsWith('#'))
            throw new Error(
              'An external SVG symbol cannot yet be restored without its original file.',
            )
        }
        if ((tag === 'img' || tag === 'source') && attribute(node, 'srcset') !== undefined) {
          const value = attribute(node, 'srcset')!,
            candidates = srcset(value),
            next: string[] = []
          let changed = false
          for (const candidate of candidates) {
            const captured = await this.resource(candidate.url, 'image', base, depth)
            changed ||= captured !== candidate.url
            next.push(captured + (candidate.descriptor ? ' ' + candidate.descriptor : ''))
          }
          if (changed) attrPatch(node, 'srcset', next.join(', '))
        }
        if (tag === 'link') {
          const rel = (attribute(node, 'rel') ?? '').toLowerCase().split(/\s+/)
          if (rel.includes('stylesheet')) await replaceAttribute(node, 'href', 'style')
          else if (rel.some((value) => ['icon', 'apple-touch-icon', 'mask-icon'].includes(value)))
            await replaceAttribute(node, 'href', 'image')
          else if (rel.includes('modulepreload')) await replaceAttribute(node, 'href', 'script')
          else if (rel.includes('preload'))
            await replaceAttribute(
              node,
              'href',
              attribute(node, 'as') === 'font'
                ? 'font'
                : attribute(node, 'as') === 'script'
                  ? 'script'
                  : attribute(node, 'as') === 'style'
                    ? 'style'
                    : attribute(node, 'as') === 'image'
                      ? 'image'
                      : 'other',
            )
        }
        if (tag === 'video' || tag === 'audio') {
          await replaceAttribute(node, 'src', 'media')
          if (tag === 'video') await replaceAttribute(node, 'poster', 'image')
        }
        if (tag === 'source' && attribute(node, 'src') !== undefined)
          await replaceAttribute(node, 'src', 'media')
        if (tag === 'iframe' || tag === 'object' || tag === 'embed') {
          // The root-frame inspector cannot attest an active embedded document,
          // even when its URL happens to be an immutable data URL.
          this.unsealedExecutableReferences = true
          const name = tag === 'object' ? 'data' : 'src'
          const value = attribute(node, name)
          if (value !== undefined) await replaceAttribute(node, name, 'other')
          if (attribute(node, 'srcdoc') !== undefined) {
            const original = attribute(node, 'srcdoc')!
            const next = await this.html(original, base, depth + 1)
            if (next !== original) attrPatch(node, 'srcdoc', next)
          }
        }
        if (tag === 'style' || tag === 'script') {
          const type = (attribute(node, 'type') ?? '').trim().toLowerCase()
          if (tag === 'script') {
            if (type === 'speculationrules')
              throw new Error(
                'Executable speculation rules cannot be captured as static recovery data.',
              )
            if (type !== 'module' && type !== '' && !scriptMime(type)) continue
            if (attribute(node, 'src') !== undefined) {
              await replaceAttribute(node, 'src', 'script')
              continue
            }
          }
          for (const text of node.childNodes.filter(isText)) {
            const location = text.sourceCodeLocation
            if (!location) continue
            const next =
              tag === 'style'
                ? await rewriteRecoveryCss(text.value, (value, kind) =>
                    this.resource(value, kind, base, depth),
                  )
                : await this.script(text.value, base, depth)
            if (next !== text.value)
              patches.push({ from: location.startOffset, to: location.endOffset, text: next })
          }
        }
      }
      if (
        this.embeddedLocal > 0 &&
        elements.some(
          (node) =>
            node.tagName === 'meta' &&
            attribute(node, 'http-equiv')?.toLowerCase() === 'content-security-policy',
        )
      )
        throw new Error(
          'An authored content policy may block embedded recovery resources; the previous copy is retained.',
        )
      return applyRecoveryPatches(source, patches)
    } finally {
      this.imports.clear()
      for (const [name, target] of inheritedImports) this.imports.set(name, target)
    }
  }
}
