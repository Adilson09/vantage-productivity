import { describe, expect, it } from 'vitest'
import { buildParseMap } from '../src/renderer/document/parse-map'
import {
  captureHtmlRecoveryText,
  readHtmlRecoveryState,
} from '../src/renderer/document/html-recovery-snapshot'
describe('pure pending HTML recovery capture', () => {
  it('captures inline text, panel alt text and pending styles on a private string', () => {
    const source =
        '<!doctype html><html><body><p>before</p><img src="data:image/png;base64,AA==" alt="before"></body></html>',
      map = buildParseMap(source, 7)
    const paragraph = map.elements.find((entry) => entry.tag === 'p')!,
      image = map.elements.find((entry) => entry.tag === 'img')!
    const snapshot = captureHtmlRecoveryText(source, map, [
      [{ op: 'set_text_node', sid: paragraph.sid, index: 0, text: 'typed without blur' }],
      [{ op: 'set_attr', sid: image.sid, name: 'alt', value: 'pending alt' }],
      [{ op: 'set_style', sid: paragraph.sid, styles: { color: 'red' } }],
    ])
    expect(snapshot).toContain('typed without blur')
    expect(snapshot).toContain('alt="pending alt"')
    expect(snapshot).toContain('color: red')
    expect(source).toContain('<p>before</p>')
    expect(map.version).toBe(7)
  })
  it('preserves rich inline content and the raw unfinished CSS field for the same element path', () => {
    const source = '<main><p>before <strong>bold</strong></p></main>',
      map = buildParseMap(source, 1),
      paragraph = map.elements.find((entry) => entry.tag === 'p')!
    const css = 'color: red; background: url("unfinished-->'
    const snapshot = captureHtmlRecoveryText(
      source,
      map,
      [[{ op: 'set_inner_html', sid: paragraph.sid, html: 'pending <strong>rich</strong>' }]],
      { path: paragraph.path, css },
    )
    const restored = readHtmlRecoveryState(snapshot)
    expect(restored.text).toBe('<main><p>pending <strong>rich</strong></p></main>')
    expect(restored.ui).toEqual({ version: 1, path: paragraph.path, css })
    expect(snapshot).not.toContain(css)
  })
  it('fails stale pending element targets instead of claiming a partial snapshot', () => {
    const source = '<p>current</p>',
      map = buildParseMap(source, 1)
    expect(() =>
      captureHtmlRecoveryText(source, map, [
        [{ op: 'set_text_node', sid: 999, index: 0, text: 'old target' }],
      ]),
    ).toThrow(/Pending visual edits/)
  })
  it('reads and removes the remote dependence disclosure before restoring panel state', () => {
    const source = '<p>x</p>',
      map = buildParseMap(source, 0),
      path = map.elements[0]!.path
    const withUi = captureHtmlRecoveryText(source, map, [], { path, css: 'color:' })
    const restored = readHtmlRecoveryState(
      '<!--vantage-html-recovery-remote-resources:3-->\n' + withUi,
    )
    expect(restored.remoteReferences).toBe(3)
    expect(restored.text).toBe(source)
    expect(restored.ui?.css).toBe('color:')
  })
})
