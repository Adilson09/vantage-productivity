import { compileOps, type HtmlOp } from './ops'
import { applyPatches } from './patch'
import { buildParseMap, type ParseMap } from './parse-map'
import { HTML_DRAFT_MAX_BYTES, HTML_DRAFT_REMOTE_MARKER } from '../../shared/html-draft'

export interface HtmlPanelRecoveryState {
  text: string | null
  alt: string | null
  css: string
  dirty: boolean
}
export interface HtmlRecoveryUi {
  version: 1
  path: string
  css: string
}
const UI_MARKER = 'vantage-html-recovery-ui'
const encode = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let from = 0; from < bytes.length; from += 8192)
    binary += String.fromCharCode(...bytes.subarray(from, from + 8192))
  return btoa(binary)
}
export function readHtmlRecoveryState(text: string): {
  text: string
  remoteReferences: number
  ui: HtmlRecoveryUi | null
} {
  let remoteReferences = 0,
    ui: HtmlRecoveryUi | null = null
  text = text.replace(
    new RegExp('^<!--' + HTML_DRAFT_REMOTE_MARKER + ':([0-9]+)-->\\r?\\n?'),
    (_all, value: string) => {
      remoteReferences = Math.min(10000, Number(value))
      return ''
    },
  )
  text = text.replace(
    new RegExp('^<!--' + UI_MARKER + ':([A-Za-z0-9+/=]+)-->\\r?\\n?'),
    (all, encoded: string) => {
      if (encoded.length > 100000) throw new Error('Recovery panel state exceeds its limit.')
      const binary = atob(encoded),
        bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as HtmlRecoveryUi
      if (
        !value ||
        value.version !== 1 ||
        typeof value.path !== 'string' ||
        value.path.length > 8192 ||
        typeof value.css !== 'string' ||
        value.css.length > 65536
      )
        throw new Error('Invalid recovered panel state.')
      ui = value
      return ''
    },
  )
  return { text, remoteReferences, ui }
}
/** Materialize edits on a private string. Never dispatch, blur, commit or clear any live editor. */
export function captureHtmlRecoveryText(
  source: string,
  map: ParseMap,
  batches: readonly (readonly HtmlOp[])[],
  panel?: { path: string; css: string },
): string {
  let text = source,
    current = map
  for (const ops of batches) {
    if (!ops.length) continue
    const compiled = compileOps(text, current, [...ops])
    const failures = compiled.errors.filter((error) => error.kind !== 'noop')
    if (failures.length)
      throw new Error('Pending visual edits cannot be captured: ' + failures[0]!.message)
    text = applyPatches(text, compiled.patches)
    current = buildParseMap(text, current.version + 1, current)
  }
  if (panel?.css) {
    if (panel.path.length > 8192 || panel.css.length > 65536)
      throw new Error('The open CSS field exceeds the recovery limit.')
    const state: HtmlRecoveryUi = { version: 1, path: panel.path, css: panel.css }
    text = '<!--' + UI_MARKER + ':' + encode(JSON.stringify(state)) + '-->\n' + text
  }
  if (new TextEncoder().encode(text).byteLength > HTML_DRAFT_MAX_BYTES)
    throw new Error('The document and pending edits exceed the 16 MiB recovery limit.')
  return text
}
