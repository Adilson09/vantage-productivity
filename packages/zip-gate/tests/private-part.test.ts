import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { assertZipPartInflatesWithinLimit } from '../src/index'
const NAME = 'customXml/vantage-unsent-comments.xml'
async function archive(real: number, declared = real, name = NAME) {
  const zip = new JSZip()
  zip.file(name, Buffer.alloc(real), { compression: 'DEFLATE' })
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  bytes.writeUInt32LE(declared, bytes.lastIndexOf(Buffer.from(name)) - 46 + 24)
  return bytes
}
describe('tight actual inflation budget for private recovery data', () => {
  it('rejects an honest oversized private part before extraction', async () => {
    await expect(assertZipPartInflatesWithinLimit(await archive(8192), NAME, 1024)).rejects.toThrow(
      'limit',
    )
  })
  it('rejects a compressed payload forged to claim a small permitted size', async () => {
    await expect(
      assertZipPartInflatesWithinLimit(await archive(1024 * 1024, 300), NAME, 1024),
    ).rejects.toThrow('inflates past')
  })
  it('also meters a dot-segment alias exposed under the private filename', async () => {
    await expect(
      assertZipPartInflatesWithinLimit(
        await archive(1024 * 1024, 300, 'extra/../' + NAME),
        NAME,
        1024,
      ),
    ).rejects.toThrow('inflates past')
  })
  it('accepts bounded private data alongside a larger ordinary document part', async () => {
    const zip = new JSZip()
    zip.file(NAME, 'small')
    zip.file('word/document.xml', 'x'.repeat(8192))
    await expect(
      assertZipPartInflatesWithinLimit(await zip.generateAsync({ type: 'uint8array' }), NAME, 1024),
    ).resolves.toBeUndefined()
  })
})
