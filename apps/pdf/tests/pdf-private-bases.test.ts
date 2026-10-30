// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { PdfPrivateBaseRegistry, type PdfPrivateRecord } from '../src/main/pdf-private-bases'

const roots: string[] = []
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-owned-bases-'))
  roots.push(root)
  const privateRoot = join(root, 'private'),
    retained: PdfPrivateRecord[] = []
  let inUse = false
  const dependencies = {
    digest,
    read: async (path: string, maximum: number) => {
      const bytes = await readFile(path)
      if (bytes.length > maximum) throw new Error('bounded read')
      return bytes
    },
    inUse: () => inUse,
    retained: (record: PdfPrivateRecord) => retained.push(record),
  }
  const registry = new PdfPrivateBaseRegistry(privateRoot, dependencies),
    bytes = Buffer.from('%PDF-1.7\nreserved-test-base')
  const reserved = await registry.reserve(17, bytes)
  await writeFile(reserved.path, bytes, { flag: 'wx' })
  await registry.ready(reserved.path)
  return {
    root,
    privateRoot,
    registry,
    bytes,
    reserved,
    retained,
    dependencies,
    inUse: (value: boolean) => {
      inUse = value
    },
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('durable app-owned private PDF checkpoint registry', () => {
  it('persists exact generated ownership and captured lineage without imported path authority', async () => {
    const f = await fixture(),
      lineage = {
        ownerKey: '17',
        source: 'main-read-A',
        generation: 3,
        token: 'd1157884-8ed7-4f8f-92cb-44467db408e0',
        documentPath: join(f.root, 'User-owned.vpdfdraft'),
      }
    f.registry.bind(f.reserved.path, lineage)
    await f.registry.drain()
    const marker = JSON.parse(await readFile(join(dirname(f.reserved.path), 'owner.json'), 'utf8'))
    expect(marker.lineage).toEqual(lineage)
    expect(marker.sha256).toBe(digest(f.bytes))
    expect(marker.directory).toBe(f.reserved.record.directory)
    expect(marker).not.toHaveProperty('path')
    expect(marker).not.toHaveProperty('originalPath')
  })
  it('refuses live readers and leaves a durable retained marker that a later checked retry can remove', async () => {
    const f = await fixture()
    f.inUse(true)
    await expect(f.registry.remove(f.reserved.path)).rejects.toThrow(/live editor/)
    expect(await readFile(f.reserved.path)).toEqual(f.bytes)
    expect(
      JSON.parse(await readFile(join(dirname(f.reserved.path), 'owner.json'), 'utf8')).phase,
    ).toBe('retained')
    expect(f.retained.at(-1)?.id).toBe(f.reserved.record.id)
    f.inUse(false)
    await f.registry.retry(f.reserved.record.id)
    await expect(readFile(f.reserved.path)).rejects.toThrow()
  })
  it('lists old instances without deleting them and refuses an alive or uncertain previous owner', async () => {
    const f = await fixture(),
      another = new PdfPrivateBaseRegistry(f.privateRoot, {
        ...f.dependencies,
        ownerAlive: () => true,
      })
    expect((await another.discoverRetained())[0]!.id).toBe(f.reserved.record.id)
    expect(await readFile(f.reserved.path)).toEqual(f.bytes)
    await expect(another.retry(f.reserved.record.id)).rejects.toThrow(/still alive|proven stopped/)
    expect(await readFile(f.reserved.path)).toEqual(f.bytes)
  })
  it('a main-confirmed stopped-owner retry deletes only the exact bounded generated file', async () => {
    const f = await fixture(),
      original = join(f.root, 'Keep-original.pdf')
    await writeFile(original, f.bytes)
    const restarted = new PdfPrivateBaseRegistry(f.privateRoot, {
      ...f.dependencies,
      ownerAlive: () => false,
    })
    await restarted.discoverRetained()
    await restarted.retry(f.reserved.record.id)
    await expect(readFile(f.reserved.path)).rejects.toThrow()
    expect(await readFile(original)).toEqual(f.bytes)
    await expect(restarted.remove(original)).rejects.toThrow(/not reserved/)
  })
  it('never deletes changed bytes, changed metadata, or unexpected sibling files recursively', async () => {
    const f = await fixture(),
      changed = Buffer.from('external replacement')
    await writeFile(f.reserved.path, changed)
    await expect(f.registry.remove(f.reserved.path)).rejects.toThrow(/changed/)
    expect(await readFile(f.reserved.path)).toEqual(changed)
    await writeFile(f.reserved.path, f.bytes)
    const sibling = join(dirname(f.reserved.path), 'keep-external.txt')
    await writeFile(sibling, 'keep')
    await expect(f.registry.remove(f.reserved.path)).rejects.toThrow(/Unexpected files/)
    expect(await readFile(sibling, 'utf8')).toBe('keep')
    expect(
      JSON.parse(await readFile(join(dirname(f.reserved.path), 'owner.json'), 'utf8')).phase,
    ).toBe('retained')
  })
  it('rejects ownership-directory traversal before following any imported location', async () => {
    const f = await fixture(),
      markerPath = join(dirname(f.reserved.path), 'owner.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    marker.directory = '../outside'
    await writeFile(markerPath, JSON.stringify(marker))
    const restarted = new PdfPrivateBaseRegistry(f.privateRoot, f.dependencies)
    await expect(restarted.discoverRetained()).rejects.toThrow(/ownership metadata/)
    expect(await readFile(f.reserved.path)).toEqual(f.bytes)
  })
})
