// Aster Office addition (2026): command discovery and untrusted bridge response checks.
import { describe, expect, it, vi } from 'vitest'
import type { AsterMailLaunchResult } from '../src/shared/aster-api'
import {
  launchAsterMail,
  matchesAsterCommand,
  readAsterQualityReport,
  readAsterRecoveryEntries,
} from '../src/renderer/src/AsterWorkspace'

describe('Aster mail native-window handoff', () => {
  it('requests only a native launch without inventing inbox or account state', async () => {
    const openMail = vi.fn(async () => ({ opened: true }))
    const result = await launchAsterMail({ openMail })
    expect(openMail).toHaveBeenCalledTimes(1)
    expect(openMail).toHaveBeenCalledWith()
    expect(result).toEqual({ opened: true })
    expect(result).not.toHaveProperty('inbox')
    expect(result).not.toHaveProperty('unread')
  })
  it('surfaces a refused launch instead of presenting a successful handoff', async () => {
    await expect(
      launchAsterMail({
        openMail: async () => ({
          opened: false,
          error: 'The mail component is missing from this build.',
        }),
      }),
    ).rejects.toThrow('The mail component is missing from this build.')
  })
  it.each([undefined, '   '])(
    'provides a useful failure when the launcher has no error detail: %j',
    async (error) => {
      await expect(
        launchAsterMail({
          openMail: async () =>
            error === undefined ? { opened: false } : { opened: false, error },
        }),
      ).rejects.toThrow('Aster Mail could not be opened. Please try again.')
    },
  )
  it('explains an unavailable bridge in an older build or browser preview', async () => {
    await expect(launchAsterMail(undefined)).rejects.toThrow(
      'Aster Mail is unavailable in this build.',
    )
  })
  it.each([null, {}, { opened: 'true' }, { opened: true, error: 5 }])(
    'rejects a malformed native response: %j',
    async (value) => {
      await expect(
        launchAsterMail({ openMail: async () => value as AsterMailLaunchResult }),
      ).rejects.toThrow('Aster Mail launch result could not be read')
    },
  )
  it('retains a launch transport failure for the workspace error state', async () => {
    const reason = new Error('The mail launch was refused.')
    await expect(launchAsterMail({ openMail: vi.fn().mockRejectedValue(reason) })).rejects.toBe(
      reason,
    )
  })
})

describe('Aster command discovery', () => {
  const sheet = {
    title: 'New spreadsheet',
    detail: 'Spreadsheet · .xlsx',
    keywords: 'create new workbook table calculate',
  }
  it('finds a task using words from both the visible label and a supported alias', () => {
    expect(matchesAsterCommand(sheet, '  NEW   WORKBOOK ')).toBe(true)
    expect(matchesAsterCommand(sheet, '.xlsx')).toBe(true)
    expect(matchesAsterCommand(sheet, 'new presentation')).toBe(false)
  })
  it('preserves discoverability for localized labels without requiring an English title', () => {
    expect(
      matchesAsterCommand({ title: '新建文档', detail: '.docx', keywords: 'new document' }, '文档'),
    ).toBe(true)
    expect(
      matchesAsterCommand(
        { title: '新建文档', detail: '.docx', keywords: 'new document' },
        'document',
      ),
    ).toBe(true)
  })
  it('lists commands before a query is entered', () => {
    expect(matchesAsterCommand(sheet, '   ')).toBe(true)
  })
})

describe('Aster inspection bridge boundary', () => {
  it('retains the real filename, path and warning details without adding a quality score', () => {
    const report = {
      fileName: 'Résumé & review.docx',
      filePath: 'C:\\Work\\Résumé & review.docx',
      kind: 'docx',
      scannedAt: '2026-10-28T18:00:00Z',
      bytes: 12345,
      scope: 'Structural checks; not a compatibility certification.',
      summary: { passed: 0, warnings: 1, failed: 0, informational: 0 },
      checks: [
        {
          id: 'alt-text',
          title: 'Image descriptions',
          status: 'warning',
          detail: 'Two images have no description.',
        },
      ],
    }
    const result = readAsterQualityReport(report)
    expect(result).toBe(report)
    expect(result.checks[0]?.detail).toBe('Two images have no description.')
    expect(result).not.toHaveProperty('score')
  })
  it.each([
    null,
    {},
    { fileName: 'test.docx', filePath: 'C:\\test.docx', kind: 'docx' },
    {
      fileName: 'test.docx',
      filePath: 'C:\\test.docx',
      kind: 'docx',
      scannedAt: '2026-10-28T18:00:00Z',
      bytes: 12345,
      scope: 'Structural checks.',
      summary: { passed: 0, warnings: 0, failed: 0, informational: 0 },
      checks: [{ id: 'one', title: 'Unknown', status: 'perfect', detail: 'Unsupported status' }],
    },
  ])('rejects an incomplete or unknown response instead of rendering a false pass: %j', (value) => {
    expect(() => readAsterQualityReport(value)).toThrow('inspection result could not be read')
  })
})

describe('Aster recovery bridge boundary', () => {
  const snapshot = {
    id: 'snapshot-1',
    fileName: 'Budget.xlsx',
    originalPath: 'C:\\Work\\Budget.xlsx',
    createdAt: '2026-10-28T18:00:00Z',
    bytes: 45872,
    sha256: 'a'.repeat(64),
  }
  it('preserves snapshot identifiers and locations for recovery of a separate copy', () => {
    const records = [snapshot]
    expect(readAsterRecoveryEntries(records)).toBe(records)
    expect(readAsterRecoveryEntries([])).toEqual([])
  })
  it('fails visibly if one snapshot is malformed, rather than silently hiding recovery records', () => {
    expect(() => readAsterRecoveryEntries([snapshot, { ...snapshot, id: 5 }])).toThrow(
      'recovery list could not be read',
    )
    expect(() => readAsterRecoveryEntries({ entries: [snapshot] })).toThrow(
      'recovery list could not be read',
    )
  })
  it.each([-1, NaN, Infinity])('does not display an invalid recorded size %s', (bytes) => {
    expect(() => readAsterRecoveryEntries([{ ...snapshot, bytes }])).toThrow(
      'recovery list could not be read',
    )
  })
})
