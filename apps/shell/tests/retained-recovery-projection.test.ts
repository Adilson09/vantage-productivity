import { describe, expect, it } from 'vitest'
import { readRetainedRecoveryList } from '../src/shared/retained-recovery'

const row = () => ({ id: 'docs:one', updatedAt: '2026-10-30T07:00:00.000Z', module: 'docs', fileName: 'Report.docx', originalPath: null, state: 'needs-review', detail: 'A copy needs review.', canRestore: true, canRemove: true, canRetry: false })

describe('retained recovery display boundary', () => {
  it('copies only display data and does not retain mutable output objects', () => {
    const pendingOutput = { id: 'output:one', path: '/user/Copy.docx' }
    const result = readRetainedRecoveryList({ items: [{ ...row(), token: 'secret', pendingOutput }], truncated: false })
    pendingOutput.path = '/changed'
    expect(result.items[0].pendingOutput?.path).toBe('/user/Copy.docx')
    expect(result.items[0]).not.toHaveProperty('token')
  })
  it('refuses oversized lists and duplicate identifiers', () => {
    expect(() => readRetainedRecoveryList({ items: Array(257).fill(row()), truncated: false })).toThrow()
    expect(() => readRetainedRecoveryList({ items: [row(), row()], truncated: false })).toThrow()
  })
  it('refuses invalid timestamps, null outputs and non-string identifiers', () => {
    for (const change of [{ updatedAt: 'not-a-date' }, { pendingOutput: null }, { id: 123 }, { pendingOutput: { id: 1, path: '/user/file' } }])
      expect(() => readRetainedRecoveryList({ items: [{ ...row(), ...change }], truncated: false })).toThrow()
  })
  it('refuses unbounded paths, arbitrary states and missing capability flags', () => {
    for (const change of [{ originalPath: 'x'.repeat(4097) }, { state: 'erase-everything' }, { canRemove: undefined }])
      expect(() => readRetainedRecoveryList({ items: [{ ...row(), ...change }], truncated: false })).toThrow()
  })
})
