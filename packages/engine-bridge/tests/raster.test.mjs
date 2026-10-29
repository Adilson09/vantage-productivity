import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { compareRenderedPages } from '../../../tools/compare-rendered-pages.mjs'

test('raster gate compares page counts, pixel threshold and dimensions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-raster-'))
  try {
    const a = join(dir, 'reference'),
      b = join(dir, 'candidate')
    await mkdir(a)
    await mkdir(b)
    const image = new PNG({ width: 100, height: 100 })
    image.data.fill(255)
    await writeFile(join(a, 'page-1.png'), PNG.sync.write(image))
    await writeFile(join(b, 'page-1.png'), PNG.sync.write(image))
    assert.equal((await compareRenderedPages(a, b)).passed, true)
    for (let y = 20; y < 50; y += 1)
      for (let x = 20; x < 50; x += 1) {
        const p = (y * 100 + x) * 4
        image.data[p] = 0
        image.data[p + 1] = 0
        image.data[p + 2] = 0
      }
    await writeFile(join(b, 'page-1.png'), PNG.sync.write(image))
    assert.equal((await compareRenderedPages(a, b)).passed, false)
    const different = new PNG({ width: 30, height: 30 })
    different.data.fill(255)
    await writeFile(join(b, 'page-1.png'), PNG.sync.write(different))
    assert.equal((await compareRenderedPages(a, b)).pages[0].reason, 'Page dimensions differ')
    await writeFile(join(b, 'page-2.png'), PNG.sync.write(different))
    assert.equal((await compareRenderedPages(a, b)).passed, false)
    await assert.rejects(compareRenderedPages(a, b, 0.5), /1 percent/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
