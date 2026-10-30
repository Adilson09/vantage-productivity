import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWriteFile, atomicWriteVia, readAtomicFileVersion } from '../src/atomic-write'
import {
  reserveFileMutation,
  withAttestedFilePublication,
  withFilePublication,
  withSynchronousFilePublication,
} from '../src/file-publication-exclusion'

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, rename: vi.fn(real.rename) }
})
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const prefix = join(tmpdir(), 'vantage-publication-exclusion-')
let dir: string
beforeEach(async () => {
  dir = mkdtempSync(prefix)
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementation(real.rename)
})
afterEach(() => {
  if (!dir.startsWith(prefix)) throw new Error('Refusing cleanup outside the test-owned directory')
  rmSync(dir, { recursive: true, force: true })
})

describe('actual publisher and physical-move exclusion', () => {
  it('waits a final async rename already in flight, then holds exclusion through source refresh', async () => {
    const old = join(dir, 'source.docx'),
      moved = join(dir, 'renamed.docx'),
      recovery = join(dir, 'recovery.json')
    writeFileSync(old, 'original')
    const expectedVersion = await readAtomicFileVersion(old)
    const atRename = deferred(),
      permitRename = deferred(),
      atRefresh = deferred(),
      permitRefresh = deferred()
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (resolve(String(to)) === old) {
        atRename.resolve()
        await permitRename.promise
      }
      return real.rename(from, to)
    })
    const save = atomicWriteFile(old, Buffer.from('complete saved bytes'), { expectedVersion })
    await atRename.promise
    const mutation = reserveFileMutation([
      { path: old, kind: 'file' },
      { path: moved, kind: 'file' },
    ])
    let physicallyMoved = false
    const move = mutation.run(async () => {
      renameSync(old, moved)
      physicallyMoved = true
      atRefresh.resolve()
      await permitRefresh.promise
    })
    await Promise.resolve()
    expect(physicallyMoved).toBe(false)
    expect(mutation.isReady()).toBe(false)
    await expect(atomicWriteFile(old, Buffer.from('late writer'))).rejects.toMatchObject({
      code: 'VANTAGE_FILE_MUTATION_PENDING',
    })
    permitRename.resolve()
    await save
    await atRefresh.promise
    expect(readFileSync(moved, 'utf8')).toBe('complete saved bytes')
    expect(existsSync(old)).toBe(false)
    await expect(atomicWriteFile(moved, Buffer.from('during refresh'))).rejects.toMatchObject({
      code: 'VANTAGE_FILE_MUTATION_PENDING',
    })
    // Recovery outside the moved paths remains live; a global lock would fail
    // or deadlock this exact awaited refresh-time write.
    await atomicWriteFile(recovery, Buffer.from('recovery checkpoint'))
    expect(readFileSync(recovery, 'utf8')).toBe('recovery checkpoint')
    permitRefresh.resolve()
    await move
    expect(existsSync(old)).toBe(false)
  })

  it('matches directory aliases and segment boundaries while a streaming temp is still being written', async () => {
    const source = join(dir, 'source'),
      sibling = join(dir, 'source-two'),
      alias = join(dir, 'alias'),
      destination = join(dir, 'destination')
    mkdirSync(source)
    mkdirSync(sibling)
    symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const target = join(alias, 'report.pptx'),
      atWrite = deferred(),
      finishWrite = deferred()
    const save = atomicWriteVia(target, async (temp) => {
      await writeFile(temp, 'streamed complete deck')
      atWrite.resolve()
      await finishWrite.promise
    })
    await atWrite.promise
    const mutation = reserveFileMutation([
      { path: source, kind: 'directory' },
      { path: destination, kind: 'directory' },
    ])
    expect(mutation.isReady()).toBe(false)
    await atomicWriteFile(join(sibling, 'unrelated.pptx'), Buffer.from('different path segment'))
    const move = mutation.run(async () => {
      renameSync(source, destination)
    })
    finishWrite.resolve()
    await save
    await move
    expect(readFileSync(join(destination, 'report.pptx'), 'utf8')).toBe('streamed complete deck')
    expect(existsSync(source)).toBe(false)
  })

  it('caller cancellation does not settle native publication and cancelPending only releases its own intent', async () => {
    const target = join(dir, 'native.xlsx'),
      result = deferred<string>(),
      actual = deferred()
    const call = withAttestedFilePublication({ targetPath: target }, () => ({
      result: result.promise,
      actualSettled: actual.promise,
    }))
    result.reject(new Error('caller canceled'))
    await expect(call).rejects.toThrow('caller canceled')
    const first = reserveFileMutation([{ path: target, kind: 'file' }])
    expect(first.isReady()).toBe(false)
    expect(first.cancelPending()).toBe(true)
    const second = reserveFileMutation([{ path: target, kind: 'file' }])
    expect(second.isReady()).toBe(false)
    actual.resolve()
    await second.ready
    let ran = false
    await second.run(async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('lets an already-admitted owner reach its nested same-target atomic publisher while the move drains it', async () => {
    const source = join(dir, 'nested.docx'),
      destination = join(dir, 'nested-moved.docx'),
      continueOwner = deferred()
    writeFileSync(source, 'old')
    const expectedVersion = await readAtomicFileVersion(source)
    const owner = withFilePublication({ targetPath: source }, async () => {
      await continueOwner.promise
      await atomicWriteFile(source, Buffer.from('nested completed save'), { expectedVersion })
    })
    const mutation = reserveFileMutation([
      { path: source, kind: 'file' },
      { path: destination, kind: 'file' },
    ])
    const move = mutation.run(async () => {
      renameSync(source, destination)
    })
    continueOwner.resolve()
    await owner
    await move
    expect(readFileSync(destination, 'utf8')).toBe('nested completed save')
    expect(existsSync(source)).toBe(false)
  })

  it('shares ownership across independently evaluated module copies', async () => {
    const target = join(dir, 'bundled-copy.xlsx'),
      actual = deferred()
    const owner = withFilePublication({ targetPath: target }, () => actual.promise)
    vi.resetModules()
    const otherBundle = await import('../src/file-publication-exclusion')
    const mutation = otherBundle.reserveFileMutation([{ path: target, kind: 'file' }])
    expect(mutation.isReady()).toBe(false)
    actual.resolve()
    await owner
    await mutation.run(async () => undefined)
  })

  it('captures physical aliases of a not-yet-created output beneath an existing junction', async () => {
    const source = join(dir, 'physical'),
      alias = join(dir, 'physical-alias')
    mkdirSync(source)
    symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const mutation = reserveFileMutation([{ path: source, kind: 'directory' }])
    expect(() =>
      withFilePublication(
        { targetPath: join(alias, 'new-folder', 'new.xlsx') },
        async () => undefined,
      ),
    ).toThrow('file move')
    expect(mutation.cancelPending()).toBe(true)
  })

  it('keeps a missing native settlement attestation fail closed even if caller result resolves', async () => {
    const target = join(dir, 'unattested-native.xlsx')
    const call = withAttestedFilePublication({ targetPath: target }, () => ({
      result: Promise.resolve('caller done'),
      actualSettled: undefined as unknown as Promise<void>,
    }))
    await expect(call).rejects.toMatchObject({ code: 'VANTAGE_FILE_PUBLICATION_UNATTESTED' })
    const mutation = reserveFileMutation([{ path: target, kind: 'file' }])
    expect(mutation.isReady()).toBe(false)
    expect(mutation.cancelPending()).toBe(true)
    await withFilePublication({ targetPath: join(dir, 'other.xlsx') }, async () => undefined)
  })

  it('prevents an overlapping synchronous metadata publication while permitting unrelated recovery storage', async () => {
    const target = join(dir, 'moving.json'),
      other = join(dir, 'recovery', 'status.json')
    const mutation = reserveFileMutation([{ path: target, kind: 'file' }])
    expect(() =>
      withSynchronousFilePublication({ targetPath: target }, () => writeFileSync(target, '{}')),
    ).toThrow('file move')
    mkdirSync(join(dir, 'recovery'))
    withSynchronousFilePublication({ targetPath: other }, () => writeFileSync(other, '{}'))
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(other, 'utf8')).toBe('{}')
    mutation.cancelPending()
  })
})
