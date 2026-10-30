// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteFile, readAtomicFileVersion } from '@vantage/electron-utils/atomic-write'
import {
  PdfFileBindings,
  observePublishedPdf,
  publishPinnedPdf,
  readPinnedPdf,
  type PdfLoadedFile,
} from '../src/main/pdf-publication'

const directories: string[] = []
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-publication-'))
  directories.push(directory)
  const source = join(directory, 'source.pdf'),
    target = join(directory, 'copy.pdf')
  const original = Buffer.from('%PDF-1.7\nexact loaded test input\n%%EOF')
  await writeFile(source, original)
  const files = new PdfFileBindings(),
    pinned = await readPinnedPdf(source)
  files.remember(1, {
    path: source,
    readId: 'read-A',
    session: 'main-A',
    version: pinned.version,
    sha256: pinned.sha256,
  })
  files.activate(1, files.candidate(1, 'main-A', 'read-A'), 'main-A')
  const loaded = files.loaded(1, 'main-A', source)
  return { directory, source, target, original, files, loaded }
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('actual PDF serializer publication with loaded/granted fingerprints', () => {
  it('positive ordinary Save publishes with the original loaded fingerprint and permits the next own Save', async () => {
    const f = await fixture(),
      written = Buffer.from('%PDF-1.7\nfirst own publication\n%%EOF')
    const result = await publishPinnedPdf({
      source: f.loaded,
      target: { path: f.source, version: f.loaded.version },
      input: f.original,
      serialize: async () => written,
      output: (bytes) => bytes,
      verify: async () => {},
      current: () => {},
      publish: (bytes, expectedVersion) => atomicWriteFile(f.source, bytes, { expectedVersion }),
    })
    expect(await readFile(f.source)).toEqual(written)
    const observed = await readAtomicFileVersion(f.source)
    expect(observed).not.toBeNull()
    f.files.ownPublication(1, f.loaded, observed!, result.bytes)
    const next = f.files.loaded(1, 'main-A', f.source),
      second = Buffer.from('%PDF-1.7\nsecond own publication\n%%EOF')
    expect(next.sha256).not.toBe(f.loaded.sha256)
    await publishPinnedPdf({
      source: next,
      target: { path: f.source, version: next.version },
      input: written,
      serialize: async () => second,
      output: (bytes) => bytes,
      verify: async () => {},
      current: () => {},
      publish: (bytes, expectedVersion) => atomicWriteFile(f.source, bytes, { expectedVersion }),
    })
    expect(await readFile(f.source)).toEqual(second)
  })
  it.each(['move', 'delete', 'replacement'])(
    'a real paused serializer refuses source %s without recreating/overwriting it',
    async (action) => {
      const f = await fixture(),
        entered = deferred(),
        resume = deferred(),
        publish = vi.fn(async () => {})
      const saving = publishPinnedPdf({
        source: f.loaded,
        target: { path: f.source, version: f.loaded.version },
        input: f.original,
        serialize: async () => {
          entered.resolve()
          await resume.promise
          return Buffer.from('pending serialized bytes')
        },
        output: (bytes) => bytes,
        verify: async () => {},
        current: () => {},
        publish,
      })
      const rejected = expect(saving).rejects.toThrow(/changed, moved or was removed/)
      await entered.promise
      const moved = join(f.directory, 'moved.pdf'),
        replacement = Buffer.from('external replacement, preserve exactly')
      if (action === 'move') await rename(f.source, moved)
      if (action === 'delete') await rm(f.source)
      if (action === 'replacement') {
        await rm(f.source)
        await writeFile(f.source, replacement)
      }
      resume.resolve()
      await rejected
      expect(publish).not.toHaveBeenCalled()
      if (action === 'replacement') expect(await readFile(f.source)).toEqual(replacement)
      else await expect(readFile(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
      if (action === 'move') expect(await readFile(moved)).toEqual(f.original)
    },
  )
  it('refuses an external replacement made before Save dispatch instead of adopting a fresh late baseline', async () => {
    const f = await fixture(),
      serialize = vi.fn(async () => Buffer.from('unsafe output'))
    await writeFile(f.source, Buffer.from('external replacement before Save'))
    await expect(
      publishPinnedPdf({
        source: f.loaded,
        target: { path: f.source, version: f.loaded.version },
        input: f.original,
        serialize,
        output: (bytes) => bytes,
        verify: async () => {},
        current: () => {},
        publish: async () => {},
      }),
    ).rejects.toThrow(/outside this view/)
    expect(serialize).not.toHaveBeenCalled()
    expect(await readFile(f.source)).toEqual(Buffer.from('external replacement before Save'))
  })
  it.each([
    'new destination appeared',
    'existing destination replaced',
    'existing destination removed',
  ])('the real atomic publisher preserves picker-grant authority when %s', async (action) => {
    const f = await fixture(),
      old = Buffer.from('old destination selected by user')
    if (action !== 'new destination appeared') await writeFile(f.target, old)
    const grant = await readAtomicFileVersion(f.target),
      entered = deferred(),
      resume = deferred()
    const saving = publishPinnedPdf({
      source: f.loaded,
      target: { path: f.target, version: grant },
      input: f.original,
      serialize: async () => {
        entered.resolve()
        await resume.promise
        return Buffer.from('new pending copy')
      },
      output: (bytes) => bytes,
      verify: async () => {},
      current: () => {},
      publish: (bytes, expectedVersion) => atomicWriteFile(f.target, bytes, { expectedVersion }),
    })
    const rejected = expect(saving).rejects.toThrow()
    await entered.promise
    const external = Buffer.from('external destination, preserve exactly')
    if (action === 'existing destination removed') await rm(f.target)
    else {
      if (action === 'existing destination replaced') await rm(f.target)
      await writeFile(f.target, external)
    }
    resume.resolve()
    await rejected
    expect(await readFile(f.source)).toEqual(f.original)
    if (action === 'existing destination removed')
      await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(f.target)).toEqual(external)
  })
  it('positive Save As writes a genuinely absent granted target while preserving its source', async () => {
    const f = await fixture(),
      grant = await readAtomicFileVersion(f.target),
      output = Buffer.from('represented new PDF copy')
    expect(grant).toBeNull()
    await publishPinnedPdf({
      source: f.loaded,
      target: { path: f.target, version: grant },
      input: f.original,
      serialize: async () => output,
      output: (bytes) => bytes,
      verify: async () => {},
      current: () => {},
      publish: (bytes, expectedVersion) => atomicWriteFile(f.target, bytes, { expectedVersion }),
    })
    expect(await readFile(f.target)).toEqual(output)
    expect(await readFile(f.source)).toEqual(f.original)
  })
  it('refuses late source-A publication after source-B activation without mutating B or its active binding', async () => {
    const f = await fixture(),
      entered = deferred(),
      resume = deferred(),
      publish = vi.fn(async () => {})
    let current = true
    const saving = publishPinnedPdf({
      source: f.loaded,
      target: { path: f.source, version: f.loaded.version },
      input: f.original,
      serialize: async () => {
        entered.resolve()
        await resume.promise
        return Buffer.from('late A')
      },
      output: (bytes) => bytes,
      verify: async () => {},
      current: () => {
        if (!current) throw new Error('source B replaced A')
      },
      publish,
    })
    const rejected = expect(saving).rejects.toThrow(/source B/)
    await entered.promise
    await writeFile(f.target, Buffer.from('source B'))
    const b = await readPinnedPdf(f.target)
    f.files.remember(1, {
      path: f.target,
      session: 'main-A',
      readId: 'read-B',
      version: b.version,
      sha256: b.sha256,
    })
    f.files.activate(1, f.files.candidate(1, 'main-A', 'read-B'), 'main-B')
    current = false
    resume.resolve()
    await rejected
    expect(publish).not.toHaveBeenCalled()
    f.files.ownPublication(1, f.loaded, b.version, Buffer.from('late A')) // old asynchronous receipt cannot replace B
    expect(f.files.loaded(1, 'main-B', f.target).sha256).toBe(b.sha256)
    expect(await readFile(f.target)).toEqual(Buffer.from('source B'))
  })
  it('does not replace an active loaded source with a failed/abandoned candidate and supports same-read reactivation', async () => {
    const f = await fixture(),
      candidate: PdfLoadedFile = { ...f.loaded, path: f.target, readId: 'failed-read' }
    f.files.remember(1, candidate)
    expect(f.files.loaded(1, 'main-A', f.source)).toBe(f.loaded)
    expect(f.files.candidate(1, 'main-A', 'read-A')).toBe(f.loaded)
    expect(() => f.files.candidate(1, 'different-session', 'failed-read')).toThrow(
      /current main-owned/,
    )
    expect(() => f.files.loaded(1, 'main-A', f.target)).toThrow(/loaded-file/)
  })
  it('cannot serialize freshly read replacement bytes against an older loaded content receipt', async () => {
    const f = await fixture(),
      serialize = vi.fn(async () => Buffer.from('output'))
    await expect(
      publishPinnedPdf({
        source: f.loaded,
        target: { path: f.source, version: f.loaded.version },
        input: Buffer.from('new unapproved source bytes'),
        serialize,
        output: (bytes) => bytes,
        verify: async () => {},
        current: () => {},
        publish: async () => {},
      }),
    ).rejects.toThrow(/serializer input differs/)
    expect(serialize).not.toHaveBeenCalled()
  })
  it('post-publication fingerprint attests actual output bytes rather than an arbitrary fresh replacement', async () => {
    const f = await fixture()
    expect((await observePublishedPdf(f.source, f.original)).sha256).toBe(f.loaded.sha256)
    await writeFile(f.source, Buffer.from('externally replaced after publication'))
    await expect(observePublishedPdf(f.source, f.original)).rejects.toThrow(
      /published PDF changed|replaced before/,
    )
  })
})
