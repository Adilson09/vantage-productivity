// @vitest-environment node
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { HtmlDraftMaterializer } from '../src/main/html-draft-isolated'
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
const grant = { documentPath: null, directory: null, realDirectory: null, files: [] }
async function directory() {
  const path = await mkdtemp(
    join(process.env.VANTAGE_VALIDATION_TEMP || tmpdir(), 'vantage-html-worker-'),
  )
  directories.push(path)
  return path
}
async function fixture(source: string) {
  const path = join(await directory(), 'fixture.cjs')
  await writeFile(path, source)
  return path
}
describe('HTML recovery off-main bounded worker', () => {
  it('captures real materialized assets in a worker while the parent stays responsive', async () => {
    const dir = await directory(),
      worker = join(dir, 'html-draft-worker.cjs'),
      documentPath = join(dir, 'page.html'),
      image = join(dir, 'logo.png')
    await build({
      entryPoints: [resolve('src/main/html-draft-worker.ts')],
      outfile: worker,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      logLevel: 'silent',
    })
    await writeFile(documentPath, '<img src="logo.png">')
    await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'))
    let ticks = 0
    const heartbeat = setInterval(() => ticks++, 5)
    try {
      const result = await new HtmlDraftMaterializer(worker).prepare(await readFile(documentPath), {
        documentPath,
        directory: dir,
        realDirectory: await realpath(dir),
        files: [],
      })
      expect(result.bytes.toString()).toContain('data:image/png;base64,')
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(heartbeat)
    }
  })
  it('bounds a synchronous parser stall and frees capacity only after owned worker exit', async () => {
    const worker = await fixture('while(true){}'),
      materializer = new HtmlDraftMaterializer(worker, 100)
    const started = Date.now()
    await expect(materializer.prepare(Buffer.from('x'), grant)).rejects.toThrow(/deadline/)
    expect(Date.now() - started).toBeLessThan(3000)
  })
  it('rejects malformed/oversized worker responses and excessive diagnostics', async () => {
    const responses = [
      "require('node:worker_threads').parentPort.postMessage({bytes:'wrong',remoteReferences:0})",
      "require('node:worker_threads').parentPort.postMessage({bytes:new ArrayBuffer(16*1024*1024+1),remoteReferences:0})",
      "process.stdout.write('x'.repeat(128*1024));setInterval(()=>{},1000)",
    ]
    for (const source of responses) {
      const worker = await fixture(source)
      await expect(
        new HtmlDraftMaterializer(worker).prepare(Buffer.from('x'), grant),
      ).rejects.toThrow(/response|diagnostics/)
    }
  })
  it('caps queued work and expires it without unbounded worker creation', async () => {
    const worker = await fixture('while(true){}'),
      materializer = new HtmlDraftMaterializer(worker, 100)
    const work = Array.from({ length: 6 }, () => materializer.prepare(Buffer.from('x'), grant))
    await expect(materializer.prepare(Buffer.from('overflow'), grant)).rejects.toThrow(/busy/)
    const result = await Promise.allSettled(work)
    expect(result.every((value) => value.status === 'rejected')).toBe(true)
  })
  it('requires explicit bounded executable-seal metadata only for close-proof jobs', async () => {
    const oldWire = await fixture(
      "require('node:worker_threads').parentPort.postMessage({bytes:new ArrayBuffer(0),remoteReferences:0})",
    )
    await expect(
      new HtmlDraftMaterializer(oldWire).prepare(Buffer.from('x'), grant, {
        purpose: 'close-proof',
      }),
    ).rejects.toThrow(/response/)
    const sealed = await fixture(
      "require('node:worker_threads').parentPort.postMessage({bytes:new ArrayBuffer(0),remoteReferences:0,unsealedExecutableReferences:false})",
    )
    await expect(
      new HtmlDraftMaterializer(sealed).prepare(Buffer.from('x'), grant, {
        purpose: 'close-proof',
      }),
    ).resolves.toMatchObject({ unsealedExecutableReferences: false })
    const invalid = await fixture(
      "require('node:worker_threads').parentPort.postMessage({bytes:new ArrayBuffer(0),remoteReferences:0,unsealedExecutableReferences:'false'})",
    )
    await expect(
      new HtmlDraftMaterializer(invalid).prepare(Buffer.from('x'), grant, {
        purpose: 'close-proof',
      }),
    ).rejects.toThrow(/response/)
  })
})
