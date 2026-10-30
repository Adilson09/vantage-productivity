// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { FromInspector } from '../src/renderer/preview/inspector-protocol'
const inspector = readFileSync(
  new URL('../src/renderer/preview/inspector.js', import.meta.url),
  'utf8',
).replace('__GX_VERSION__', '1')
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
})
function fixture() {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const child = frame.contentWindow! as Window & typeof globalThis,
    doc = child.document
  doc.body.innerHTML = '<p data-gx-sid="1">original</p>'
  const posted: FromInspector[] = []
  vi.spyOn(window, 'postMessage').mockImplementation((message) => {
    posted.push(message as FromInspector)
  })
  Object.defineProperty(child.Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }),
  })
  Object.defineProperty(child.Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  })
  child.scrollTo = () => {}
  child.eval(inspector)
  const send = (data: unknown, source: Window = window) =>
    child.dispatchEvent(new child.MessageEvent('message', { source, data }))
  const ticket = { id: 'owner-close', sequence: 1, source: 'main-document' }
  send({ type: 'gx:beginTextEdit', sid: 1 })
  const paragraph = doc.querySelector('p')!
  paragraph.textContent = 'pending inline text'
  paragraph.dispatchEvent(new child.Event('input', { bubbles: true }))
  const state = (nonce: number) =>
    posted.findLast(
      (message): message is Extract<FromInspector, { type: 'gx:closeState' }> =>
        message.type === 'gx:closeState' && message.nonce === nonce,
    )!
  cleanup.push(() => frame.remove())
  return { child, doc, posted, paragraph, ticket, send, state }
}
describe('owned inspector close participant (no arbitrary-page-script attestation claimed)', () => {
  it('captures pending inline text without blur, locks input, and holds until correlated release', () => {
    const f = fixture()
    f.send({ type: 'gx:closePrepare', ticket: f.ticket, nonce: 1 })
    expect(f.state(1).ops).toEqual([
      { op: 'set_text_node', sid: 1, index: 0, text: 'pending inline text' },
    ])
    expect(f.paragraph.getAttribute('contenteditable')).toBe('false')
    expect(f.posted.some((message) => message.type === 'gx:textEditCommit')).toBe(false)
    const input = new f.child.Event('beforeinput', { bubbles: true, cancelable: true })
    f.paragraph.dispatchEvent(input)
    expect(input.defaultPrevented).toBe(true)
    f.send({ type: 'gx:closeRelease', ticket: f.ticket })
    expect(f.paragraph.getAttribute('contenteditable')).toBe('true')
  })
  it('acknowledges a captured edit only after the parent committed it and retains that baseline on later cancel', () => {
    const f = fixture()
    f.send({ type: 'gx:closePrepare', ticket: f.ticket, nonce: 1 })
    f.send({ type: 'gx:closeCommit', ticket: f.ticket, nonce: 2 })
    expect(f.state(2).ops).toEqual([])
    f.send({ type: 'gx:closeRelease', ticket: f.ticket })
    f.paragraph.textContent = 'later unsaved input'
    f.paragraph.dispatchEvent(
      new f.child.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(f.paragraph.textContent).toBe('pending inline text')
  })
  it('does not unlock a newer participant on an old release', () => {
    const f = fixture()
    f.send({ type: 'gx:closePrepare', ticket: f.ticket, nonce: 1 })
    f.send({ type: 'gx:closeRelease', ticket: f.ticket })
    const newer = { ...f.ticket, id: 'new-close', sequence: 2 }
    f.send({ type: 'gx:closePrepare', ticket: newer, nonce: 2 })
    f.send({ type: 'gx:closeRelease', ticket: f.ticket })
    expect(f.paragraph.getAttribute('contenteditable')).toBe('false')
    f.send({ type: 'gx:closeRelease', ticket: newer })
    expect(f.paragraph.getAttribute('contenteditable')).toBe('true')
  })
  it('refuses an in-progress IME without consuming its draft', () => {
    const f = fixture()
    f.paragraph.dispatchEvent(new f.child.CompositionEvent('compositionstart', { bubbles: true }))
    f.send({ type: 'gx:closePrepare', ticket: f.ticket, nonce: 1 })
    expect(f.state(1).composing).toBe(true)
    expect(f.state(1).error).toContain('composition')
    expect(f.paragraph.getAttribute('contenteditable')).toBe('true')
    expect(f.paragraph.textContent).toBe('pending inline text')
  })
  it('records a release-before-prepare tombstone', () => {
    const f = fixture()
    f.send({ type: 'gx:closeRelease', ticket: f.ticket })
    f.send({ type: 'gx:closePrepare', ticket: f.ticket, nonce: 1 })
    expect(f.state(1).error).toContain('already released')
    expect(f.paragraph.getAttribute('contenteditable')).toBe('true')
  })
  it('refuses the wrong commit identity and preserves the pending text', () => {
    const f = fixture()
    f.send({ type: 'gx:closePrepare', ticket: f.ticket, nonce: 1 })
    f.send({ type: 'gx:closeCommit', ticket: { ...f.ticket, id: 'other' }, nonce: 2 })
    expect(f.state(2).error).toContain('Another')
    expect(f.state(2).ops[0]).toMatchObject({ text: 'pending inline text' })
  })
  it('invalidates a held capture rather than accepting a new inspector mutation', () => {
    const f = fixture()
    f.send({ type: 'gx:closePrepare', ticket: f.ticket, nonce: 1 })
    f.send({ type: 'gx:previewStyle', sid: 1, styles: { color: 'red' } })
    expect(f.paragraph.style.color).toBe('')
    expect(
      f.posted.some(
        (message) => message.type === 'gx:closeInvalidated' && message.ticket.id === f.ticket.id,
      ),
    ).toBe(true)
  })
  it('ignores a message sent by the frame itself instead of its parent', () => {
    const f = fixture()
    f.send({ type: 'gx:closePrepare', ticket: f.ticket, nonce: 1 }, f.child)
    expect(f.state(1)).toBeUndefined()
    expect(f.paragraph.getAttribute('contenteditable')).toBe('true')
  })
})
