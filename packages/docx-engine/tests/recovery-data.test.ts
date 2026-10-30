import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildBlankDocx } from '../src/blank'
import { parseDocx } from '../src/parse'
import { readDocxRecoveryData, writeDocxRecoveryData } from '../src/recovery-data'

describe('inert recovery-only unsent comment part', () => {
  it('round-trips private unsent text and context without creating a published comment', async () => {
    const original = await buildBlankDocx(),
      value = {
        version: 1,
        drafts: [
          {
            id: 'new',
            kind: 'new',
            text: '<private>& unsent',
            anchor: { from: 1, to: 4, quote: 'one', before: '', after: ' two' },
          },
        ],
      }
    const recovery = await writeDocxRecoveryData(original, value)
    expect(await readDocxRecoveryData(recovery)).toEqual(value)
    expect((await parseDocx(recovery)).comments).toHaveLength(0)
  })
  it('removes the recovery part before ordinary output while retaining document content', async () => {
    const original = await buildBlankDocx(),
      recovery = await writeDocxRecoveryData(original, {
        version: 1,
        drafts: [{ id: 'edit:7', kind: 'edit', text: 'Private replacement' }],
      })
    const published = await writeDocxRecoveryData(recovery)
    expect(await readDocxRecoveryData(published)).toBeUndefined()
    expect((await parseDocx(published)).blocks).toEqual((await parseDocx(original)).blocks)
  })
  it('refuses oversized metadata instead of replacing it with truncated text', async () => {
    await expect(
      writeDocxRecoveryData(await buildBlankDocx(), { text: 'x'.repeat(257 * 1024) }),
    ).rejects.toThrow('limit')
  })
  it('rejects forged large private data through both actual reader and ordinary-output stripping paths', async () => {
    const name = 'customXml/vantage-unsent-comments.xml',
      zip = new JSZip()
    zip.file(name, 'x'.repeat(2 * 1024 * 1024), { compression: 'DEFLATE' })
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    bytes.writeUInt32LE(300, bytes.lastIndexOf(Buffer.from(name)) - 46 + 24)
    await expect(readDocxRecoveryData(bytes)).rejects.toThrow('inflates past')
    await expect(writeDocxRecoveryData(bytes)).rejects.toThrow('inflates past')
  })
})
