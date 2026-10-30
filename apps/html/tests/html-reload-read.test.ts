// @vitest-environment node
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readHtmlReloadSource } from '../src/main/html-reload-read'
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function file() {
  const directory = await mkdtemp(
    join(process.env.VANTAGE_VALIDATION_TEMP || tmpdir(), 'vantage-html-reload-'),
  )
  directories.push(directory)
  return join(directory, 'page.html')
}
describe('bounded HTML Reload source read', () => {
  it('preserves BOM, CRLF and missing trailing newline bytes after strict UTF-8 decode', async () => {
    const path = await file(),
      source = '\uFEFF<html>\r\n<p>café</p>\r\n</html>'
    await writeFile(path, source)
    expect(await readHtmlReloadSource(path)).toBe(source)
  })
  it('fails invalid UTF-8 rather than changing current document text', async () => {
    const path = await file()
    await writeFile(path, Buffer.from([0xc0, 0x80]))
    await expect(readHtmlReloadSource(path)).rejects.toThrow()
  })
  it('checks size before allocating and refuses a file beyond the 16 MiB bound', async () => {
    const path = await file(),
      handle = await open(path, 'w')
    await handle.truncate(16 * 1024 * 1024 + 1)
    await handle.close()
    await expect(readHtmlReloadSource(path)).rejects.toThrow(/16 MiB/)
  })
})
