import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import { materializeHtmlDraft } from '../src/main/html-draft-assets'
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const empty = { documentPath: null, directory: null, realDirectory: null, files: [] }
describe('actual loaded preview executable seal boundary', () => {
  it('exposes local recursive data modules as unsealed historical references while preserving independent recovery', async () => {
    const directory = await mkdtemp(
      join(process.env.VANTAGE_VALIDATION_TEMP || tmpdir(), 'html-executable-seal-'),
    )
    directories.push(directory)
    const documentPath = join(directory, 'page.html'),
      grant = { documentPath, directory, realDirectory: await realpath(directory), files: [] }
    await writeFile(join(directory, 'constants.js'), "export const label='data';")
    await writeFile(
      join(directory, 'module.js'),
      "import {label} from './constants.js';export {label};",
    )
    const source = Buffer.from('<script type="module" src="./module.js"></script>')
    const loaded = await materializeHtmlDraft(source, grant, { reportExecutableSeals: true })
    expect(loaded.unsealedExecutableReferences).toBe(true)
    const recovered = await materializeHtmlDraft(source, grant)
    expect(recovered.bytes.toString()).toContain('data:text/javascript;base64,')
    expect(recovered).not.toHaveProperty('unsealedExecutableReferences')
    const sealed = await materializeHtmlDraft(recovered.bytes, grant, {
      reportExecutableSeals: true,
    })
    expect(sealed.unsealedExecutableReferences).toBe(false)
  })
  it('allows immutable inline data and inert JSON without executing either', async () => {
    const result = await materializeHtmlDraft(
      Buffer.from(
        '<script>const data={title:"saved"};</script><script type="application/json">{"x":2}</script>',
      ),
      empty,
      { reportExecutableSeals: true },
    )
    expect(result.unsealedExecutableReferences).toBe(false)
  })
  it('refuses opaque active embedded documents even though ordinary recovery discloses remote dependence', async () => {
    const result = await materializeHtmlDraft(
      Buffer.from('<iframe src="https://example.invalid/page"></iframe>'),
      empty,
      { reportExecutableSeals: true },
    )
    expect(result.unsealedExecutableReferences).toBe(true)
    expect(result.remoteReferences).toBe(1)
  })
  it('refuses a data embedded document rather than certifying only its root frame', async () => {
    const result = await materializeHtmlDraft(
      Buffer.from('<iframe srcdoc="&lt;p&gt;embedded&lt;/p&gt;"></iframe>'),
      empty,
      { reportExecutableSeals: true },
    )
    expect(result.unsealedExecutableReferences).toBe(true)
  })
  it('does not accept a runtime script merely because its current HTML is immutable', async () => {
    await expect(
      materializeHtmlDraft(
        Buffer.from(
          '<script>Object.assign(document.createElement("img"),{src:"file.png"})</script>',
        ),
        empty,
        { reportExecutableSeals: true },
      ),
    ).rejects.toThrow()
  })
})
