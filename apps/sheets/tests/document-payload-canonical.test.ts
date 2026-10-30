import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalDocumentPayload } from '../src/main/workbook-document-recovery'
import { emptyDocumentPayload, documentPayloadFromSave } from '../src/shared/document-checkpoint'
import { canonicalWorkbookDocumentPayload, hashWorkbookDocumentPayload } from '../src/shared/document-payload-canonical'
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { vi.unstubAllGlobals() })

describe('renderer full workbook fingerprint matches the real native checkpoint content contract', () => {
  it('uses the same ordering, UTF8 bytes and operational exclusions as native recovery', async () => {
    const payload = { ...emptyDocumentPayload(),
      edits: [{ sheetId: 'sheet-1', row: 0, column: 0, value: 'Olá 世界' }],
      pageSetupStates: [{ sheetId: 'sheet-1', orientation: 'landscape' }],
      redactionStates: [{ sheetName: 'Plan', marks: [{ startRow: 1, endRow: 1, startColumn: 0, endColumn: 0,
        label: 'Private', previousFill: null }] }],
      sessionId: 'old-reader', mode: 'save', targetPath: '/not/content.xlsx', overwrite: true,
    }
    const expected = JSON.stringify(canonicalDocumentPayload(payload))
    expect(JSON.stringify(canonicalWorkbookDocumentPayload(payload))).toBe(expected)
    const actual = await hashWorkbookDocumentPayload(payload)
    expect(actual.json).toBe(expected)
    expect(actual.sha256).toBe(createHash('sha256').update(expected, 'utf8').digest('hex'))
  })

  it('does not collapse same-count metadata changes or omit any of the28 checkpoint families', () => {
    const base = emptyDocumentPayload()
    expect(Object.keys(base)).toHaveLength(28)
    for (const family of Object.keys(base)) {
      const changed = { ...base, [family]: { sameCount: 'changed', family } }
      expect(JSON.stringify(canonicalWorkbookDocumentPayload(changed))).not.toBe(JSON.stringify(canonicalWorkbookDocumentPayload(base)))
    }
    const request = { ...base, sessionId: 'reader', mode: 'save-as' as const }
    expect(canonicalWorkbookDocumentPayload(request)).toEqual(canonicalDocumentPayload(documentPayloadFromSave(request)))
  })

  it('rejects cycles and non-finite data instead of hashing a truncated substitute', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => canonicalWorkbookDocumentPayload(cyclic)).toThrow('finite JSON')
    expect(() => canonicalWorkbookDocumentPayload({ value: Number.NaN })).toThrow('finite JSON')
  })
})
