import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbeddedFont } from '@vantage/docx-engine'
const metrics = vi.hoisted(() => ({ changed: vi.fn(), set: vi.fn() }))
vi.mock('../src/renderer/line-metrics', () => ({
  noteEmbeddedFontsChanged: metrics.changed,
  setEmbeddedLineMetrics: metrics.set,
}))
import { adoptEmbeddedFonts, prepareEmbeddedFonts } from '../src/renderer/embedded-fonts'
class Face {
  constructor(readonly family: string) {}
  async load() {
    return this
  }
}
let original: PropertyDescriptor | undefined
let faces: Set<unknown>
const font = (family: string) =>
  ({ family, data: new Uint8Array([0]), bold: false, italic: false }) as EmbeddedFont
beforeEach(() => {
  faces = new Set()
  original = Object.getOwnPropertyDescriptor(document, 'fonts')
  vi.stubGlobal('FontFace', Face)
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: (face: unknown) => faces.add(face),
      delete: (face: unknown) => faces.delete(face),
      dispatchEvent: vi.fn(),
    },
  })
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (original) Object.defineProperty(document, 'fonts', original)
  else Reflect.deleteProperty(document, 'fonts')
})
describe('replacement font staging', () => {
  it('keeps old document faces until synchronous source adoption commits the prepared candidate', async () => {
    await adoptEmbeddedFonts([font('Old')])
    const old = [...faces][0]
    vi.clearAllMocks()
    const candidate = await prepareEmbeddedFonts([font('New')])
    expect(faces.has(old)).toBe(true)
    expect(faces.size).toBe(1)
    expect(metrics.changed).not.toHaveBeenCalled()
    expect(candidate.commit()).toBe(true)
    expect(faces.has(old)).toBe(false)
    expect([...faces]).toEqual([expect.objectContaining({ family: 'New' })])
    expect(candidate.commit()).toBe(false)
  })
  it('does not revoke the old source when a parsed candidate is refused after approval becomes stale', async () => {
    await adoptEmbeddedFonts([font('Old')])
    const old = [...faces][0]
    await prepareEmbeddedFonts([font('Refused')])
    expect(faces.has(old)).toBe(true)
    expect([...faces]).toEqual([old])
  })
  it('a later candidate invalidates a slower prepared adoption without touching current faces', async () => {
    await adoptEmbeddedFonts([font('Old')])
    const old = [...faces][0]
    const first = await prepareEmbeddedFonts([font('First')]),
      second = await prepareEmbeddedFonts([font('Second')])
    expect(first.commit()).toBe(false)
    expect(faces.has(old)).toBe(true)
    expect(second.commit()).toBe(true)
    expect([...faces]).toEqual([expect.objectContaining({ family: 'Second' })])
  })
})
