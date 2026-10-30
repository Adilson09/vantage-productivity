import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { atomicWriteFile } from '../src/main/atomic-write'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})

let dir = ''

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile)
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const epermError = () =>
  Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

describe('atomicWriteFile', () => {
  it('replaces the target and leaves no temp file behind', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sheets-aw-'))
    const target = join(dir, 'data.csv')
    writeFileSync(target, 'old')

    await atomicWriteFile(target, Buffer.from('new'))

    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['data.csv'])
  })

  it('retries transient Windows rename locks', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sheets-aw-'))
    const target = join(dir, 'data.csv')
    writeFileSync(target, 'old')
    vi.mocked(rename).mockRejectedValueOnce(epermError()).mockRejectedValueOnce(epermError())

    await atomicWriteFile(target, Buffer.from('new'))

    expect(vi.mocked(rename)).toHaveBeenCalledTimes(3)
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['data.csv'])
  })

  it('keeps the original and completed rescue file when the rename stays locked', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sheets-aw-'))
    const target = join(dir, 'data.csv')
    writeFileSync(target, 'old')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      vi.mocked(rename).mockRejectedValueOnce(epermError())
    }

    await expect(atomicWriteFile(target, Buffer.from('new'))).rejects.toThrow(
      'The existing destination was not overwritten',
    )

    expect(readFileSync(target, 'utf8')).toBe('old')
    const files = readdirSync(dir)
    expect(files).toHaveLength(2)
    const temp = files.find((file) => file !== 'data.csv')
    expect(temp).toMatch(/^data\.csv\.[^.]+\.tmp$/)
    expect(readFileSync(join(dir, temp!), 'utf8')).toBe('new')
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeFile).mock.calls[0]?.[0]).not.toBe(target)
  })

  it('preserves the original and removes an incomplete temp when writing fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sheets-aw-'))
    const target = join(dir, 'data.csv')
    writeFileSync(target, 'old')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const incompleteError = Object.assign(new Error('EIO: incomplete temp write'), { code: 'EIO' })
    vi.mocked(writeFile).mockImplementationOnce(async (file, _data, options) => {
      await actual.writeFile(file, Buffer.from('partial'), options)
      throw incompleteError
    })

    await expect(atomicWriteFile(target, Buffer.from('new'))).rejects.toThrow(
      'incomplete temp write',
    )

    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['data.csv'])
    expect(vi.mocked(rename)).not.toHaveBeenCalled()
  })

  it('uses distinct temp files for concurrent writes to one target', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sheets-aw-'))
    const target = join(dir, 'data.csv')

    await Promise.all([
      atomicWriteFile(target, Buffer.from('first')),
      atomicWriteFile(target, Buffer.from('second')),
    ])

    expect(['first', 'second']).toContain(readFileSync(target, 'utf8'))
    expect(readdirSync(dir)).toEqual(['data.csv'])
  })
})
