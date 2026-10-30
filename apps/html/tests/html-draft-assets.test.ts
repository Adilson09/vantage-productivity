// @vitest-environment node
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeHtmlDraft, type HtmlDraftAssetGrant } from '../src/main/html-draft-assets'
import { HtmlDraftController } from '../src/main/html-draft-controller'
import { readDraftJournal } from '../../../packages/electron-utils/src/draft-journal'
import { readHtmlRecoveryState } from '../src/renderer/document/html-recovery-snapshot'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(
    join(process.env.VANTAGE_VALIDATION_TEMP || tmpdir(), 'vantage-html-assets-'),
  )
  directories.push(directory)
  const documentPath = join(directory, 'page.html')
  await writeFile(documentPath, '<!doctype html>')
  await mkdir(join(directory, 'assets'))
  await writeFile(join(directory, 'assets', 'logo.png'), PNG)
  await writeFile(join(directory, 'assets', 'photo'), PNG)
  const grant: HtmlDraftAssetGrant = {
    documentPath,
    directory,
    realDirectory: await realpath(directory),
    files: [],
  }
  return {
    directory,
    documentPath,
    grant,
    capture: (text: string) => materializeHtmlDraft(Buffer.from(text), grant),
  }
}
function decodedData(source: string): string[] {
  return [
    ...source.matchAll(
      /data:(?:text\/css|text\/javascript|image\/svg\+xml);base64,([A-Za-z0-9+/=]+)/g,
    ),
  ].map((match) => Buffer.from(match[1]!, 'base64').toString())
}
describe('complete bounded HTML local asset capture', () => {
  it('captures CSS imports, fonts, responsive images, SVG images and JavaScript modules', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, 'assets', 'font.woff2'), Buffer.from('wOF2test-font'))
    await writeFile(
      join(f.directory, 'assets', 'nested.css'),
      '@font-face{font-family:Demo;src:url(font.woff2)}',
    )
    await writeFile(
      join(f.directory, 'assets', 'main.css'),
      '@import "nested.css"; .hero{background:url(logo.png)}',
    )
    await writeFile(join(f.directory, 'assets', 'dep.mjs'), 'export const number=7')
    await writeFile(
      join(f.directory, 'assets', 'main.mjs'),
      'import { number } from "./dep.mjs"; export const data={number}',
    )
    await writeFile(
      join(f.directory, 'assets', 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="logo.png"/></svg>',
    )
    const result = await f.capture(
      '<!doctype html><link rel="stylesheet" href="assets/main.css"><script type="module" src="assets/main.mjs"></script><img src="assets/icon.svg" srcset="assets/logo.png 1x, assets/photo 2x">',
    )
    const html = result.bytes.toString(),
      decoded = decodedData(html)
    expect(html).not.toContain('assets/')
    expect(html).toContain('data:image/png;base64,')
    expect(result.remoteReferences).toBe(0)
    expect(decoded.some((value) => value.includes('data:text/css;base64,'))).toBe(true)
    expect(decoded.some((value) => value.includes('data:text/javascript;base64,'))).toBe(true)
    expect(decoded.some((value) => value.includes('data:image/png;base64,'))).toBe(true)
    const independent = join(f.directory, 'recovered.html')
    await writeFile(independent, result.bytes)
    await rename(join(f.directory, 'assets'), join(f.directory, 'assets-moved'))
    const next = await materializeHtmlDraft(await readFile(independent), {
      ...f.grant,
      documentPath: independent,
    })
    expect(next.bytes.equals(result.bytes)).toBe(true)
  })
  it('preserves source comments and image fragments and handles escaped CSS URL tokens', async () => {
    const f = await fixture(),
      source =
        '<!-- author -->\n<style>/* keep */ .x{background:u\\72l("assets/logo.png#frag")}</style>'
    const result = await f.capture(source)
    expect(result.bytes.toString()).toContain('<!-- author -->')
    expect(result.bytes.toString()).toContain('/* keep */')
    expect(result.bytes.toString()).toContain('#frag')
  })
  it('preserves remote references without fetching and discloses their dependence', async () => {
    const f = await fixture(),
      source =
        '<base href="https://example.invalid/site/"><img src="image.png"><link rel="stylesheet" href="https://example.invalid/site.css">'
    const result = await f.capture(source),
      recovered = readHtmlRecoveryState(result.bytes.toString())
    expect(result.remoteReferences).toBe(2)
    expect(recovered.remoteReferences).toBe(2)
    expect(recovered.text).toContain('https://example.invalid/site/image.png')
  })
  it('rejects missing media and ungranted private neighbours instead of silently dropping them', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, 'secret.json'), '{"secret":"must not enter recovery"}')
    await expect(f.capture('<img src="assets/missing.png">')).rejects.toThrow()
    await expect(f.capture('<script src="secret.json"></script>')).rejects.toThrow(
      /allowed|granted/,
    )
    await expect(f.capture('<img src="../outside.png">')).rejects.toThrow(/outside/)
  })
  it('rejects directory escapes through a real junction', async () => {
    const f = await fixture(),
      outside = await fixture()
    await symlink(
      join(outside.directory, 'assets'),
      join(f.directory, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(f.capture('<img src="escape/logo.png">')).rejects.toThrow(/stable|grant|escaped/)
  })
  it('captures explicitly selected external resources but grants no neighbours', async () => {
    const f = await fixture(),
      external = await fixture(),
      path = join(external.directory, 'assets', 'logo.png')
    const grant = { ...f.grant, files: [{ path, realPath: await realpath(path) }] }
    expect(
      (
        await materializeHtmlDraft(
          Buffer.from('<img src="' + pathToFileURL(path).href + '">'),
          grant,
        )
      ).bytes.toString(),
    ).toContain('data:image/png;base64,')
    await expect(
      materializeHtmlDraft(
        Buffer.from(
          '<img src="' + pathToFileURL(join(external.directory, 'assets', 'photo')).href + '">',
        ),
        grant,
      ),
    ).rejects.toThrow(/outside/)
  })
  it('captures data-only untitled pages while refusing unresolved relative or temporary resources', async () => {
    const grant: HtmlDraftAssetGrant = {
      documentPath: null,
      directory: null,
      realDirectory: null,
      files: [],
    }
    expect(
      (
        await materializeHtmlDraft(
          Buffer.from(
            '<p>unnamed</p><img src="data:image/png;base64,' + PNG.toString('base64') + '">',
          ),
          grant,
        )
      ).bytes.toString(),
    ).toContain('unnamed')
    for (const source of ['relative.png', 'blob:old-renderer-id', 'html-asset://missing/logo.png'])
      await expect(
        materializeHtmlDraft(Buffer.from('<img src="' + source + '">'), grant),
      ).rejects.toThrow()
  })
  it('bounds aggregate raw media and encoded result before replacing a prior draft', async () => {
    const f = await fixture()
    await writeFile(
      join(f.directory, 'assets', 'huge.png'),
      Buffer.concat([PNG, Buffer.alloc(13 * 1024 * 1024)]),
    )
    await expect(f.capture('<img src="assets/huge.png">')).rejects.toThrow(/budget|16 MiB/)
  })
  it('rejects cyclic local imports and dynamically unresolved local resource construction', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, 'assets', 'a.css'), '@import "b.css";')
    await writeFile(join(f.directory, 'assets', 'b.css'), '@import "a.css";')
    await expect(f.capture('<link rel="stylesheet" href="assets/a.css">')).rejects.toThrow(/Cyclic/)
    await expect(
      f.capture('<script>const image=new Image(); image.src=someComputedPath;</script>'),
    ).rejects.toThrow(/Scripted-page|static data/)
    await expect(
      f.capture('<script type="module">import(someComputedPath)</script>'),
    ).rejects.toThrow(/Scripted-page|static data/)
  })
  it('accepts inert API names in strings and comments inside static data modules', async () => {
    const f = await fixture(),
      source =
        '<script type="module">/* fetch() */ const text=' +
        JSON.stringify('fetch("missing")') +
        '; const pattern="XMLHttpRequest"; export const data={text,pattern}</script>'
    expect((await f.capture(source)).bytes.toString()).toBe(source)
  })
  it('refuses unsupported integrity or content policies instead of claiming a broken independent page', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, 'assets', 'page.css'), 'body{color:red}')
    await expect(
      f.capture('<link rel="stylesheet" href="assets/page.css" integrity="sha256-stale">'),
    ).rejects.toThrow(/integrity/)
    await expect(
      f.capture(
        '<meta http-equiv="Content-Security-Policy" content="default-src self"><img src="assets/logo.png">',
      ),
    ).rejects.toThrow(/content policy/)
  })
  it('rejects invalid UTF-8 rather than silently changing source text', async () => {
    const f = await fixture()
    await expect(materializeHtmlDraft(Buffer.from([0xc0, 0x80]), f.grant)).rejects.toThrow()
  })
  it('refuses remote and opaque executable scripts, event handlers and javascript URLs', async () => {
    const f = await fixture()
    for (const source of [
      '<script src="https://example.invalid/opaque.js"></script>',
      '<script type="module">import data from "https://example.invalid/opaque.mjs"; export default data</script>',
      '<button onclick="Object.assign(img,{src:local})">run</button>',
      '<a href="java&#x09;script:load()">run</a>',
      '<script src="data:application/javascript;base64,' +
        Buffer.from('new Audio("other.mp3")').toString('base64') +
        '"></script>',
      '<script type="text/jscript">new Audio("other.mp3")</script>',
      '<iframe src="data:text/html,' +
        encodeURIComponent('<script>Object.assign(img,{src:"other.png"})</script>') +
        '"></iframe>',
    ])
      await expect(f.capture(source)).rejects.toThrow(
        /Scripted-page|static data|executable|Event-handler/i,
      )
  })
  it('keeps inert JSON and JSON-LD blocks as document data', async () => {
    const f = await fixture(),
      source =
        '<script type="application/ld+json">{"text":"fetch(local.png)","url":"https://example.invalid"}</script><script type="application/json">{"src":"local.png"}</script>'
    expect((await f.capture(source)).bytes.toString()).toBe(source)
  })
  it.each([
    'const img=document.images[0];img["src"]="assets/other.png";',
    'Object.assign(img,{src:"assets/other.png"});',
    'const sound=new Audio("assets/other.mp3");',
    'const alias=fetch;alias("assets/other.png");',
  ])('fails closed for runtime dependency construction: %s', async (script) => {
    const f = await fixture()
    await expect(f.capture('<script>' + script + '</script>')).rejects.toThrow(
      /Scripted-page|static data/,
    )
  })
  it('refuses SVG animation/set dependencies and preserves the previous committed journal', async () => {
    const f = await fixture(),
      recoveryRoot = join(f.directory, 'recovery')
    const controller = new HtmlDraftController({
      recoveryRoot: () => recoveryRoot,
      isLive: () => true,
      canWritePath: (_owner, path) => path === f.documentPath,
      prepare: (_owner, _path, bytes) => materializeHtmlDraft(bytes, f.grant),
    })
    const token = controller.activate(1, f.documentPath)
    const snapshot = (sequence: number, text: string) =>
      controller.snapshot(1, {
        token,
        sequence,
        revision: sequence,
        documentPath: f.documentPath,
        data: Uint8Array.from(Buffer.from(text)).buffer,
      })
    await snapshot(1, '<p>known good recovery</p><img src="assets/logo.png">')
    const good = (await readDraftJournal(recoveryRoot, token)).bytes
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg"><image id="picture" href="assets/logo.png"/><set href="#picture" attributeName="href" to="assets/later.png"/></svg>'
    await expect(snapshot(2, source)).rejects.toThrow(/Dynamic SVG/)
    expect((await readDraftJournal(recoveryRoot, token)).bytes).toEqual(good)
    await expect(
      f.capture('<svg><animate attributeName="fill" values="url(assets/later.svg);red"/></svg>'),
    ).rejects.toThrow(/Dynamic SVG/)
  })
})
