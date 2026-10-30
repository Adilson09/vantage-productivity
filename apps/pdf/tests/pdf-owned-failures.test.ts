// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PdfOwnedFailureMarkers, type PdfFailureMarker } from '../src/main/pdf-owned-failures'

const roots: string[] = []
const token = '66959647-a295-4db7-9f19-1108cd4ed012'
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-owned-failures-'))
  roots.push(root)
  const directory = join(root, 'markers'),
    path = join(root, 'Original.pdf'),
    bytes = Buffer.from('user-owned original bytes')
  await writeFile(path, bytes)
  const value: PdfFailureMarker = {
    id: `pdf-checkpoint:${token}`,
    ownerKey: '1',
    source: 'main-captured-read',
    generation: 7,
    token,
    documentPath: path,
    error: 'Earlier complete journal cleanup failed',
  }
  return { root, directory, path, bytes, value, markers: new PdfOwnedFailureMarkers(directory) }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('independent metadata fallback when shared cleanup admission fails', () => {
  it('survives main replacement and preserves exact captured lineage without any PDF bytes', async () => {
    const f = await fixture()
    f.markers.record(f.value)
    expect(new PdfOwnedFailureMarkers(f.directory).inspect()).toEqual([f.value])
    expect(JSON.stringify(f.markers.inspect())).not.toContain(f.bytes.toString())
    expect(await readFile(f.path)).toEqual(f.bytes)
  })
  it('clears only resolved metadata and grants no deletion authority over its displayed document path', async () => {
    const f = await fixture()
    f.markers.record(f.value)
    f.markers.clearResolved(f.value.id)
    expect(f.markers.inspect()).toEqual([])
    expect(await readFile(f.path)).toEqual(f.bytes)
  })
  it('retains the last complete marker when an oversized or malformed replacement is refused', async () => {
    const f = await fixture()
    f.markers.record(f.value)
    expect(() => f.markers.record({ ...f.value, error: 'x'.repeat(4097) })).toThrow()
    expect(() => f.markers.record({ ...f.value, token: 'arbitrary-imported-token' })).toThrow()
    expect(f.markers.inspect()).toEqual([f.value])
  })
  it('refuses changed or oversized on-disk metadata without reading or deleting its document path', async () => {
    const f = await fixture()
    f.markers.record(f.value)
    const file = join(f.directory, createHash('sha256').update(f.value.id).digest('hex') + '.json')
    await writeFile(file, Buffer.alloc(16 * 1024 + 1, 0x78))
    expect(() => f.markers.inspect()).toThrow(/oversized/)
    expect(await readFile(f.path)).toEqual(f.bytes)
  })
})
