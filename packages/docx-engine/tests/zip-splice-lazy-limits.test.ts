import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DOCX_ZIP_LIMITS } from '../src/zip-load'
import { lazyMediaPlaceholder } from '../src/lazy-media'
import {
  bufferSource,
  lazyMediaHashesIn,
  openZipFile,
  readZipEntries,
  slimDocx,
  writeZip,
} from '../src/zip-splice'

const KB = 1024
const MB = 1024 * KB

/** Small budgets so the tests stay fast; the shape of the check is the point. */
const LIMITS = { maxParts: 8, maxPartBytes: 2 * MB, maxTotalBytes: 4 * MB } as const

interface MetaOptions {
  usize?: number
}

function entry(name: string, data: Buffer, options: MetaOptions = {}) {
  return {
    meta: {
      name,
      nameBytes: Buffer.from(name),
      flags: 0,
      method: 0,
      time: 0,
      date: 0,
      crc: crc32(data),
      csize: data.length,
      usize: options.usize ?? data.length,
      verMade: 20,
      verNeed: 20,
      intAttr: 0,
      extAttr: 0,
    },
    data,
  }
}

const docXml = Buffer.from('<w:document/>')
const docEntry = (name = 'word/document.xml') => entry(name, docXml)
const pngEntry = (name: string, bytes: number) => entry(name, Buffer.alloc(bytes))

async function tempDocx(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zip-lazy-limits-'))
  const path = join(dir, 'doc.docx')
  await writeFile(path, bytes)
  return path
}

describe('the lazy-media entry reader inherits the shared zip limits', () => {
  it('bounds actual inflation when a media part lies about its placeholder size', async () => {
    const payload = Buffer.alloc(8 * MB, 65)
    const compressed = deflateRawSync(payload)
    const forged = entry('word/media/image1.png', compressed, {
      usize: Buffer.byteLength(lazyMediaPlaceholder('c'.repeat(64))),
    })
    forged.meta.method = 8
    // Placeholder detection used to trust usize and inflate the entire payload.
    await expect(lazyMediaHashesIn(writeZip([docEntry(), forged]))).rejects.toThrow()
  })

  it.each([0, 8])(
    'rejects a short placeholder claiming a different actual size (method %s)',
    async (method) => {
      const placeholder = Buffer.from(lazyMediaPlaceholder('c'.repeat(64)))
      const short = placeholder.subarray(0, placeholder.length - 1)
      const part = entry('word/media/image1.png', method === 8 ? deflateRawSync(short) : short, {
        usize: placeholder.length,
      })
      part.meta.method = method
      await expect(lazyMediaHashesIn(writeZip([docEntry(), part]))).rejects.toThrow(/size mismatch/)
    },
  )

  it.each([0, 8])(
    'accepts an honest placeholder and ordinary media (method %s)',
    async (method) => {
      const placeholder = Buffer.from(lazyMediaPlaceholder('c'.repeat(64)))
      const part = entry(
        'word/media/image1.png',
        method === 8 ? deflateRawSync(placeholder) : placeholder,
        {
          usize: placeholder.length,
        },
      )
      part.meta.method = method
      expect(
        await lazyMediaHashesIn(
          writeZip([docEntry(), part, pngEntry('word/media/ordinary.png', 1024)]),
        ),
      ).toEqual(new Set(['c'.repeat(64)]))
    },
  )
  it('rejects a central directory declaring too many parts', async () => {
    const archive = writeZip(
      Array.from({ length: LIMITS.maxParts + 1 }, (_, i) => docEntry(`word/p${i}.xml`)),
    )
    await expect(readZipEntries(bufferSource(archive), LIMITS)).rejects.toThrow(
      new RegExp(`${LIMITS.maxParts + 1} parts exceeds the ${LIMITS.maxParts} limit`),
    )
  })

  it('rejects a part declaring more uncompressed bytes than the per-part cap', async () => {
    // 12 bytes of real payload declaring 3 MB: nothing is read, the claim is refused
    const archive = writeZip([entry('word/document.xml', docXml, { usize: 3 * MB })])
    await expect(readZipEntries(bufferSource(archive), LIMITS)).rejects.toThrow(
      /declares 3145728 uncompressed bytes \(limit 2097152\)/,
    )
  })

  it('rejects an archive whose declared total exceeds the total cap', async () => {
    // three honest 1.5 MB parts: each is under the 2 MB per-part cap, so only
    // the 4 MB total can stop it
    const archive = writeZip([
      pngEntry('word/media/a.png', 1536 * KB),
      pngEntry('word/media/b.png', 1536 * KB),
      pngEntry('word/media/c.png', 1536 * KB),
    ])
    await expect(readZipEntries(bufferSource(archive), LIMITS)).rejects.toThrow(
      /total uncompressed size \d+ exceeds the 4194304 limit/,
    )
  })

  it('accepts an archive inside the limits and reads it whole', async () => {
    const archive = writeZip([docEntry(), pngEntry('word/media/a.png', 16 * KB)])
    const entries = await readZipEntries(bufferSource(archive), LIMITS)
    expect(entries.map((e) => e.name)).toEqual(['word/document.xml', 'word/media/a.png'])
  })

  it('does not count directory entries against the part limit', async () => {
    const archive = writeZip([
      docEntry(),
      ...Array.from({ length: LIMITS.maxParts }, (_, i) => docEntry(`word/d${i}/`)),
    ])
    const entries = await readZipEntries(bufferSource(archive), LIMITS)
    expect(entries.length).toBe(LIMITS.maxParts + 1)
  })

  it('refuses a file-backed archive the default limits reject', async () => {
    // the openLazyDocx sequence starts at openZipFile; an over-declaring media
    // part must be refused there, before the media is stripped or concatenated
    const path = await tempDocx(
      writeZip([
        docEntry(),
        entry('word/media/image1.png', Buffer.alloc(64), {
          usize: DOCX_ZIP_LIMITS.maxPartBytes + 1,
        }),
      ]),
    )
    await expect(openZipFile(path)).rejects.toThrow(/zip rejected: part word\/media\/image1\.png/)
  })

  it('still opens and strips a normal media-heavy document', async () => {
    const path = await tempDocx(writeZip([docEntry(), pngEntry('word/media/image1.png', 2 * MB)]))
    const zip = await openZipFile(path)
    try {
      const slim = await slimDocx(zip, 'c'.repeat(64), 1)
      expect(slim!.lazyParts).toEqual(['word/media/image1.png'])
      const slimEntries = await readZipEntries(bufferSource(slim!.bytes))
      const media = slimEntries.find((e) => e.name === 'word/media/image1.png')!
      expect(media.usize).toBe(Buffer.byteLength(lazyMediaPlaceholder('c'.repeat(64))))
    } finally {
      await zip.close()
    }
  })
})
