import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const mockedRename = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rename: mockedRename,
}))

import { atomicWriteFile } from '../src/main/atomic-write'

const root = join(__dirname, '../../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const section = (source: string, start: string, end: string) =>
  source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))

describe('atomic export destinations', () => {
  it('keeps an existing destination intact when a temporary write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vantage-export-atomic-'))
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'old')
    try {
      await expect(
        atomicWriteFile(target, { byteLength: -1 } as unknown as Uint8Array),
      ).rejects.toThrow()
      expect(readFileSync(target, 'utf8')).toBe('old')
      expect(readdirSync(dir)).toEqual(['report.docx'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Vantage Productivity: publication failure must retain both the original and completed rescue copy.
  it('keeps the destination and completed rescue copy when publication fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vantage-export-rename-'))
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'old')
    mockedRename.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EPERM' }))
    try {
      let failure: { recoveryPath: string } | undefined
      await expect(
        atomicWriteFile(target, Buffer.from('new')).catch((error) => {
          failure = error
          throw error
        }),
      ).rejects.toMatchObject({
        code: 'EPERM',
        vantageCode: 'SAVE_NOT_PUBLISHED',
        targetPath: target,
      })
      expect(readFileSync(target, 'utf8')).toBe('old')
      expect(failure?.recoveryPath).toMatch(/report\.docx\.[a-f0-9]{12}\.tmp$/)
      expect(readFileSync(failure!.recoveryPath, 'utf8')).toBe('new')
      expect(readdirSync(dir)).toHaveLength(2)
    } finally {
      mockedRename.mockReset()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not contain a direct destination-write fallback', () => {
    const source = read('apps/shell/src/main/atomic-write.ts')
    expect(source).not.toContain('await writeFile(filePath, data)')
  })

  it('publishes every Docs export through a temporary file', () => {
    const source = read('apps/docs/src/main/docs-main.ts')
    const pdf = section(source, "'docs:export-pdf'", "'docs:save-image-as'")
    const image = section(source, "'docs:write-export-image'", "'docs:export-html'")
    const html = section(source, "'docs:export-html'", "'docs:print-pdf-buffer'")
    const merged = section(source, "'docs:save-merged-pdf'", "'win:new'")

    expect(pdf).toContain('await atomicWriteFile(filePath, data)')
    expect(image).toMatch(/await atomicWriteFile\(\s*filePath,/)
    expect(html).toMatch(/await atomicWriteFile\(\s*filePath,/)
    expect(merged).toMatch(/await atomicWriteFile\(\s*filePath,/)
    expect(`${pdf}${image}${html}${merged}`).not.toMatch(/writeFile(?:Sync)?\(filePath/)
  })

  it('publishes Sheets PDF exports through a temporary file', () => {
    const source = read('apps/sheets/src/main/pdf-export.ts')
    const pdf = section(
      source,
      'export async function exportPdf',
      'export async function printWorkbook',
    )

    expect(pdf).toContain('await atomicWriteFile(selection.filePath, pdf)')
    expect(pdf).not.toContain('writeFile(selection.filePath')
  })

  it('publishes Shell PDF conversions through a temporary file', () => {
    const source = read('apps/shell/src/main/index.ts')
    const docx = section(
      source,
      'async function exportPdfAsDocxLocal',
      'async function exportPdfAsPptxLocal',
    )
    const pptx = section(
      source,
      'async function exportPdfAsPptxLocal',
      'async function exportPdfAsXlsxLocal',
    )
    const xlsx = section(
      source,
      'async function exportPdfAsXlsxLocal',
      'ipcMain.handle(PDF_CHANNELS.convertOffice',
    )

    expect(docx).toContain('await atomicWriteFile(picked.filePath, result.docx)')
    expect(pptx).toContain('await atomicWriteFile(picked.filePath, result.pptx)')
    expect(xlsx).toContain('await atomicWriteFile(picked.filePath, result.xlsx)')
    expect(`${docx}${pptx}${xlsx}`).not.toMatch(/writeFileSync\(picked\.filePath/)
  })
})
