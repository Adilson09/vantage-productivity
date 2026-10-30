import { tokenize as cssTokenize, tokenTypes as cssTokenTypes } from 'css-tree/tokenizer'
import { ident as cssIdent, string as cssString, url as cssUrl } from 'css-tree/utils'
import { HTML_DRAFT_MAX_BYTES } from '../shared/html-draft'

export interface RecoveryTextPatch {
  from: number
  to: number
  text: string
}
export type RecoveryResourceKind = 'style' | 'script' | 'image' | 'font' | 'media' | 'other'
export type RecoveryResourceResolver = (
  source: string,
  kind: RecoveryResourceKind,
) => Promise<string>

/** Check the complete UTF-8 result before allocating its joined string. */
export function applyRecoveryPatches(
  source: string,
  patches: readonly RecoveryTextPatch[],
  maximum = HTML_DRAFT_MAX_BYTES,
): string {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > HTML_DRAFT_MAX_BYTES)
    throw new Error('Invalid recovery text budget.')
  const ordered = [...patches].sort((a, b) => a.from - b.from || a.to - b.to)
  let end = 0,
    bytes = Buffer.byteLength(source)
  if (bytes > maximum) throw new Error('The complete HTML recovery copy exceeds 16 MiB.')
  const unique: RecoveryTextPatch[] = []
  for (const patch of ordered) {
    if (
      !Number.isSafeInteger(patch.from) ||
      !Number.isSafeInteger(patch.to) ||
      patch.from < 0 ||
      patch.to < patch.from ||
      patch.to > source.length
    )
      throw new Error('Invalid recovery source range.')
    const previous = unique.at(-1)
    if (previous && previous.from === patch.from && previous.to === patch.to) {
      if (previous.text !== patch.text) throw new Error('Ambiguous recovery source ranges.')
      continue
    }
    if (patch.from < end) throw new Error('Overlapping recovery source ranges.')
    bytes += Buffer.byteLength(patch.text) - Buffer.byteLength(source.slice(patch.from, patch.to))
    if (bytes > maximum) throw new Error('The complete HTML recovery copy exceeds 16 MiB.')
    unique.push(patch)
    end = patch.to
  }
  const parts: string[] = []
  let cursor = 0
  for (const patch of unique) {
    parts.push(source.slice(cursor, patch.from), patch.text)
    cursor = patch.to
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}
interface CssToken {
  type: number
  start: number
  end: number
}
const ignored = (type: number) =>
  type === cssTokenTypes.WhiteSpace || type === cssTokenTypes.Comment

/** Tokenize rather than regenerate CSS: comments, unfinished declarations and quoting outside URLs survive. */
export async function rewriteRecoveryCss(
  source: string,
  resolve: RecoveryResourceResolver,
): Promise<string> {
  const tokens: CssToken[] = []
  cssTokenize(source, (type, start, end) => {
    if (tokens.length >= 200000)
      throw new Error('The stylesheet exceeds the recovery token budget.')
    tokens.push({ type, start, end })
  })
  const patches: RecoveryTextPatch[] = []
  const functions: string[] = []
  let atPrelude: string | null = null,
    importCandidate = false
  const replacement = async (
    from: number,
    to: number,
    value: string,
    kind: RecoveryResourceKind,
    asUrl: boolean,
  ) => {
    const next = await resolve(value, kind)
    if (next !== value)
      patches.push({
        from,
        to,
        text: asUrl ? 'url(' + JSON.stringify(next) + ')' : JSON.stringify(next),
      })
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (ignored(token.type)) continue
    const raw = source.slice(token.start, token.end)
    if (token.type === cssTokenTypes.AtKeyword) {
      atPrelude = cssIdent.decode(raw.slice(1)).toLowerCase()
      importCandidate = atPrelude === 'import'
      continue
    }
    if (token.type === cssTokenTypes.LeftCurlyBracket || token.type === cssTokenTypes.Semicolon) {
      atPrelude = null
      importCandidate = false
    }
    const isImport = importCandidate
    if (importCandidate) importCandidate = false
    // At-rule conditions and namespaces contain URL-shaped values that do not load resources.
    const resourceContext = atPrelude === null || atPrelude === 'import'
    if (token.type === cssTokenTypes.Url) {
      if (resourceContext)
        await replacement(
          token.start,
          token.end,
          cssUrl.decode('url' + raw.slice(raw.indexOf('('))),
          isImport ? 'style' : 'other',
          true,
        )
      continue
    }
    if (token.type === cssTokenTypes.Function) {
      const name = cssIdent.decode(raw.slice(0, -1)).toLowerCase()
      if (name === 'url' || name === 'src') {
        let close = i + 1,
          depth = 1
        for (; close < tokens.length; close++) {
          const t = tokens[close]!
          if (t.type === cssTokenTypes.Function || t.type === cssTokenTypes.LeftParenthesis) depth++
          else if (t.type === cssTokenTypes.RightParenthesis && --depth === 0) break
        }
        if (close >= tokens.length)
          throw new Error('An unfinished local resource URL cannot be captured yet.')
        if (resourceContext) {
          const contents = tokens.slice(i + 1, close).filter((t) => !ignored(t.type))
          let value: string
          if (contents.length === 1 && contents[0]!.type === cssTokenTypes.String)
            value = cssString.decode(source.slice(contents[0]!.start, contents[0]!.end))
          else {
            const argument = source.slice(token.end, tokens[close]!.start).trim()
            if (
              contents.some(
                (t) =>
                  t.type === cssTokenTypes.Function ||
                  t.type === cssTokenTypes.BadString ||
                  t.type === cssTokenTypes.BadUrl,
              ) ||
              /\s/.test(argument)
            )
              throw new Error('The local stylesheet resource URL is not resolvable.')
            value = cssUrl.decode('url(' + argument + ')')
          }
          await replacement(
            token.start,
            tokens[close]!.end,
            value,
            isImport ? 'style' : 'other',
            true,
          )
        }
        i = close
        continue
      }
      functions.push(name)
      continue
    }
    if (token.type === cssTokenTypes.RightParenthesis) {
      functions.pop()
      continue
    }
    if (token.type === cssTokenTypes.String && resourceContext) {
      const imageSet =
        functions.at(-1) === 'image-set' ||
        functions.at(-1) === '-webkit-image-set' ||
        functions.at(-1) === 'image'
      if (isImport || imageSet)
        await replacement(
          token.start,
          token.end,
          cssString.decode(raw),
          isImport ? 'style' : 'image',
          false,
        )
    }
    if (token.type === cssTokenTypes.BadUrl)
      throw new Error('A malformed stylesheet resource URL cannot be captured yet.')
  }
  return applyRecoveryPatches(source, patches)
}
