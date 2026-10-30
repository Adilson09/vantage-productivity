import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reserveFileMutation,
  withAttestedFilePublication,
  withFilePublication,
} from '../../../packages/electron-utils/src/file-publication-exclusion'

const controls = vi.hoisted(() => ({
  afterCopy: undefined as (() => Promise<void>) | undefined,
  beforeVerify: undefined as ((path: string) => Promise<void>) | undefined,
}))
vi.mock('../../../packages/electron-utils/src/publish-exclusive', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../packages/electron-utils/src/publish-exclusive')>()
  return {
    ...actual,
    publishExclusiveCopy: async (...args: Parameters<typeof actual.publishExclusiveCopy>) => {
      const result = await actual.publishExclusiveCopy(...args)
      await controls.afterCopy?.()
      return result
    },
  }
})
vi.mock('../src/main/workbook-relocation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/workbook-relocation')>()
  return {
    ...actual,
    verifyRelocatedWorkbook: async (...args: Parameters<typeof actual.verifyRelocatedWorkbook>) => {
      await controls.beforeVerify?.(args[0])
      return actual.verifyRelocatedWorkbook(...args)
    },
  }
})
import { moveWorkbookExclusively } from '../src/main/workbook-exclusive-move'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
let root: string, source: string, destination: string, expected: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vantage-exclusive-sheet-move-'))
  source = join(root, 'untitled.xlsx')
  destination = join(root, 'named.xlsx')
  await writeFile(source, 'loaded workbook bytes')
  expected = createHash('sha256').update('loaded workbook bytes').digest('hex')
  controls.afterCopy = undefined
  controls.beforeVerify = undefined
})
afterEach(async () => {
  controls.afterCopy = undefined
  controls.beforeVerify = undefined
  await rm(root, { recursive: true, force: true })
})

describe('exclusive Sheets automatic move (private successor sources)', () => {
  it('waits for prior actual publication and keeps the mutation through full checkpoint and renderer finalizer', async () => {
    const publisher = deferred<void>(),
      moved = deferred<void>(),
      checkpoint = deferred<void>(),
      rendererActual = deferred<void>()
    await expect(
      withAttestedFilePublication({ targetPath: source }, () => ({
        result: Promise.reject(new Error('bounded publisher result timed out')),
        actualSettled: publisher.promise,
      })),
    ).rejects.toThrow('timed out')
    const mutation = reserveFileMutation([
      { path: source, kind: 'file' },
      { path: destination, kind: 'file' },
    ])
    const actual = mutation.run(async () => {
      await moveWorkbookExclusively(source, destination, expected)
      moved.resolve()
      await checkpoint.promise
      await rendererActual.promise
    })
    await flush()
    expect(existsSync(source)).toBe(true)
    expect(existsSync(destination)).toBe(false)
    publisher.resolve()
    await moved.promise
    expect(existsSync(source)).toBe(false)
    expect(() => withFilePublication({ targetPath: destination }, async () => undefined)).toThrow(
      'file move is pending',
    )
    checkpoint.resolve()
    await flush()
    expect(() => reserveFileMutation([{ path: destination, kind: 'file' }])).toThrow(
      'file move is pending',
    )
    rendererActual.resolve()
    await actual
    const next = reserveFileMutation([{ path: destination, kind: 'file' }])
    await next.ready
    next.cancelPending()
    expect(await readFile(destination, 'utf8')).toBe('loaded workbook bytes')
  })

  it('never adopts a fresh digest when the loaded source changed before moving', async () => {
    await writeFile(source, 'external replacement')
    await expect(moveWorkbookExclusively(source, destination, expected)).rejects.toThrow()
    expect(await readFile(source, 'utf8')).toBe('external replacement')
    expect(existsSync(destination)).toBe(false)
  })

  it('an exclusive destination collision preserves both the original and the unrelated destination', async () => {
    await writeFile(destination, 'unrelated existing file')
    await expect(moveWorkbookExclusively(source, destination, expected)).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(await readFile(source, 'utf8')).toBe('loaded workbook bytes')
    expect(await readFile(destination, 'utf8')).toBe('unrelated existing file')
  })

  it('source replacement after exclusive copy preserves both paths instead of unlinking or rolling back either', async () => {
    controls.afterCopy = async () => {
      await rm(source)
      await writeFile(source, 'external replacement after copy')
    }
    await expect(moveWorkbookExclusively(source, destination, expected)).rejects.toThrow()
    expect(await readFile(source, 'utf8')).toBe('external replacement after copy')
    expect(await readFile(destination, 'utf8')).toBe('loaded workbook bytes')
  })

  it('a source replacement during destination verification survives the final source recheck', async () => {
    controls.beforeVerify = async (path) => {
      if (path !== destination) return
      await rm(source)
      await writeFile(source, 'replacement during destination hash')
    }
    await expect(moveWorkbookExclusively(source, destination, expected)).rejects.toThrow()
    expect(await readFile(source, 'utf8')).toBe('replacement during destination hash')
    expect(await readFile(destination, 'utf8')).toBe('loaded workbook bytes')
  })
})
