import { describe, expect, it, vi } from 'vitest'
import {
  completeHtmlSaveAcknowledgment,
  type HtmlSaveLiveState,
  type HtmlSavedTicket,
} from '../src/renderer/document/html-save-acknowledgment'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const ticket: HtmlSavedTicket = {
  token: 'current-activation',
  activation: 4,
  revision: 12,
  representedClean: true,
}
const live = (): HtmlSaveLiveState => ({
  token: ticket.token,
  activation: ticket.activation,
  revision: ticket.revision,
  text: 'saved bytes',
  savedText: 'saved bytes',
  sourceText: 'saved bytes',
  sourceComposing: false,
  composing: false,
  panelPending: false,
  visualPending: false,
  stylesPending: false,
})
describe('HTML delayed recovery acknowledgment after a normal Save', () => {
  it('keeps typing during the await dirty and refuses close while preserving the represented saved text', async () => {
    const ack = deferred(),
      current = live(),
      publish = vi.fn(),
      read = vi.fn(() => current)
    const complete = completeHtmlSaveAcknowledgment(ack.promise, ticket, read, publish)
    expect(read).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    current.revision++
    current.text = 'saved bytes plus new typing'
    current.sourceText = current.text
    ack.resolve()
    expect(await complete).toBe(false)
    expect(publish).toHaveBeenCalledWith({ clean: false, dirty: true, revision: 13 })
    expect(current.savedText).toBe('saved bytes')
  })
  it.each([
    'stylesPending',
    'panelPending',
    'visualPending',
    'sourceComposing',
    'composing',
  ] as const)(
    'keeps a new %s edit dirty even while source text still matches saved text',
    async (field) => {
      const ack = deferred(),
        current = live(),
        publish = vi.fn(),
        complete = completeHtmlSaveAcknowledgment(ack.promise, ticket, () => current, publish)
      current.revision++
      current[field] = true
      ack.resolve()
      expect(await complete).toBe(false)
      expect(publish).toHaveBeenCalledWith({ clean: false, dirty: true, revision: 13 })
    },
  )
  it('detects a current source buffer ahead of the last renderer state', async () => {
    const ack = deferred(),
      current = live(),
      publish = vi.fn(),
      complete = completeHtmlSaveAcknowledgment(ack.promise, ticket, () => current, publish)
    current.sourceText = 'pending source transaction'
    ack.resolve()
    expect(await complete).toBe(false)
    expect(publish).toHaveBeenCalledWith({ clean: false, dirty: true, revision: 12 })
  })
  it('cannot mark a replacement activation clean or publish old preview state', async () => {
    const ack = deferred(),
      current = live(),
      publish = vi.fn(),
      complete = completeHtmlSaveAcknowledgment(ack.promise, ticket, () => current, publish)
    current.activation++
    current.token = 'new-activation'
    current.text = 'new document'
    current.savedText = 'new document'
    current.sourceText = current.text
    ack.resolve()
    expect(await complete).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })
  it('does not mark newer revisions saved merely because an older acknowledgment completed', async () => {
    const ack = deferred(),
      current = live(),
      publish = vi.fn(),
      complete = completeHtmlSaveAcknowledgment(ack.promise, ticket, () => current, publish)
    current.revision++
    ack.resolve()
    expect(await complete).toBe(false)
    expect(publish).toHaveBeenCalledWith({ clean: false, dirty: false, revision: 13 })
  })
  it('closes only for the same clean represented revision after acknowledgment', async () => {
    const ack = deferred(),
      current = live(),
      publish = vi.fn(),
      complete = completeHtmlSaveAcknowledgment(ack.promise, ticket, () => current, publish)
    ack.resolve()
    expect(await complete).toBe(true)
    expect(publish).toHaveBeenCalledWith({ clean: true, dirty: false, revision: 12 })
  })
})
