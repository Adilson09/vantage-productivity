import { describe, expect, it, vi } from 'vitest'
import { SheetsSourceLineages } from '../src/main/sheets-source-lineage'

const reader = (sessionId: string, digit = 'a') => ({
  sessionId, openedSha256: digit.repeat(64), documentPath: `C:/work/${sessionId}.xlsx`,
})

describe('main-owned Sheets source lineage', () => {
  it('invalidates close at source-open admission and refuses an older successful open', () => {
    const invalidate = vi.fn()
    const sources = new SheetsSourceLineages<number>(invalidate)
    const first = sources.beginOpen(1)
    const second = sources.beginOpen(1)
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(sources.busy(1)).toBe(true)
    expect(sources.commitOpen(1, first, reader('first'))).toBe(false)
    expect(sources.commitOpen(1, second, reader('second'))).toBe(true)
    expect(sources.current(1)?.sessionId).toBe('second')
    expect(sources.busy(1)).toBe(false)
  })

  it('keeps the old reader selected until an owned publication is coherently adopted', () => {
    const sources = new SheetsSourceLineages<number>(() => {})
    const opened = sources.beginOpen(1)
    sources.commitOpen(1, opened, reader('old'))
    const old = sources.current(1)!
    const offer = sources.offerOwnedPublication(1, old, reader('saved', 'b'))
    expect(sources.current(1)).toEqual(old)
    expect(sources.adoptOwnedPublication(1, offer)).toEqual(old)
    expect(sources.current(1)).toEqual({ ...reader('saved', 'b'), lineage: old.lineage })
    expect(sources.adoptOwnedPublication(1, offer)).toBeNull()
  })

  it('refuses adoption after even a cancelled intervening source-open request', () => {
    const sources = new SheetsSourceLineages<number>(() => {})
    sources.commitOpen(1, sources.beginOpen(1), reader('old'))
    const old = sources.current(1)!
    const offer = sources.offerOwnedPublication(1, old, reader('saved', 'b'))
    const newer = sources.beginOpen(1)
    sources.cancelOpen(1, newer)
    expect(sources.adoptOwnedPublication(1, offer)).toBeNull()
    expect(sources.current(1)).toEqual(old)
  })

  it('does not accept copied or cross-owner capabilities', () => {
    const sources = new SheetsSourceLineages<number>(() => {})
    const open = sources.beginOpen(1)
    expect(sources.commitOpen(2, open, reader('cross'))).toBe(false)
    expect(sources.commitOpen(1, { ...open }, reader('copy'))).toBe(false)
    expect(sources.commitOpen(1, open, reader('valid'))).toBe(true)
  })

  it('refuses a publication which would release the still-selected reader', () => {
    const sources = new SheetsSourceLineages<number>(() => {})
    sources.commitOpen(1, sources.beginOpen(1), reader('old'))
    const old = sources.current(1)!
    expect(() => sources.offerOwnedPublication(1, old, reader('old', 'b'))).toThrow('distinct replacement')
    expect(sources.current(1)).toEqual(old)
  })
})
