// Aster Office modification: fault tests for original preservation and rescue bytes.
import {
  fsyncSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, open, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AtomicSaveError,
  atomicCopyFile,
  atomicWriteFile,
  atomicWriteVia,
  writeJsonAtomic,
} from '../src/atomic-write'
import { listRecoveryEntries } from '../src/recovery-vault'

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: vi.fn(real.rename),
    open: vi.fn(real.open),
    writeFile: vi.fn(real.writeFile),
    copyFile: vi.fn(real.copyFile),
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    writeFileSync: vi.fn(real.writeFileSync),
    renameSync: vi.fn(real.renameSync),
    fsyncSync: vi.fn(real.fsyncSync),
  }
})

const prefix = join(tmpdir(), 'aster-save-')
let dir = ''
let previousVault: string | undefined
const error = (code: string) => Object.assign(new Error(`${code}: injected`), { code })

beforeEach(async () => {
  const asyncReal = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const syncReal = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(rename).mockImplementation(asyncReal.rename)
  vi.mocked(open).mockImplementation(asyncReal.open)
  vi.mocked(writeFile).mockImplementation(asyncReal.writeFile)
  vi.mocked(copyFile).mockImplementation(asyncReal.copyFile)
  vi.mocked(writeFileSync).mockImplementation(syncReal.writeFileSync)
  vi.mocked(renameSync).mockImplementation(syncReal.renameSync)
  vi.mocked(fsyncSync).mockImplementation(syncReal.fsyncSync)
  previousVault = process.env.ASTER_RECOVERY_ROOT
  delete process.env.ASTER_RECOVERY_ROOT
  dir = mkdtempSync(prefix)
})
afterEach(() => {
  if (previousVault === undefined) delete process.env.ASTER_RECOVERY_ROOT
  else process.env.ASTER_RECOVERY_ROOT = previousVault
  if (!dir.startsWith(prefix)) throw new Error('Refusing cleanup outside the named test directory')
  rmSync(dir, { recursive: true, force: true })
  vi.resetAllMocks()
})

type Mode = 'buffer' | 'copy' | 'stream'
async function save(mode: Mode, target: string, value: string): Promise<void> {
  if (mode === 'buffer') return atomicWriteFile(target, Buffer.from(value))
  if (mode === 'copy') {
    const source = join(dir, 'source.bin')
    writeFileSync(source, value)
    return atomicCopyFile(source, target)
  }
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return atomicWriteVia(target, (path) => real.writeFile(path, value))
}

describe.each(['buffer', 'copy', 'stream'] as const)('%s publication', (mode) => {
  it('publishes a complete temp and removes it after successful replacement', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'original')
    await save(mode, target, 'complete replacement')
    expect(readFileSync(target, 'utf8')).toBe('complete replacement')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
  it('preserves original and completed new bytes when replacement is refused', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'original')
    vi.mocked(rename).mockRejectedValueOnce(error('EEXIST'))
    const failure = await save(mode, target, 'complete replacement').then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(failure).toBeInstanceOf(AtomicSaveError)
    const detail = failure as AtomicSaveError
    expect(detail.code).toBe('EEXIST')
    expect(detail.asterCode).toBe('SAVE_NOT_PUBLISHED')
    expect(detail.targetPath).toBe(target)
    expect(basename(detail.recoveryPath)).toMatch(/^report\.docx\.[a-f0-9]{12}\.tmp$/)
    expect(readFileSync(target, 'utf8')).toBe('original')
    expect(readFileSync(detail.recoveryPath, 'utf8')).toBe('complete replacement')
    expect(vi.mocked(writeFile).mock.calls.some(([path]) => path === target)).toBe(false)
    expect(vi.mocked(copyFile).mock.calls.some(([, path]) => path === target)).toBe(false)
  })
  it('tolerates an unsupported flush and still publishes atomically', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'old')
    vi.mocked(open).mockRejectedValueOnce(error('EINVAL'))
    await save(mode, target, 'new')
    expect(readFileSync(target, 'utf8')).toBe('new')
  })
  it('does not publish bytes when a genuine flush failure occurs', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'old')
    vi.mocked(open).mockRejectedValueOnce(error('EIO'))
    await expect(save(mode, target, 'new')).rejects.toThrow('EIO')
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('save coordination and history', () => {
  it('still communicates the rescue path if a publisher rejects with a non-Error value', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'original')
    vi.mocked(rename).mockRejectedValueOnce(null)
    const failure = await atomicWriteFile(target, Buffer.from('replacement')).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(failure).toBeInstanceOf(AtomicSaveError)
    expect((failure as AtomicSaveError).code).toBe('ASTER_SAVE_NOT_PUBLISHED')
    expect(String(failure)).toContain((failure as AtomicSaveError).recoveryPath)
    expect(readFileSync((failure as AtomicSaveError).recoveryPath, 'utf8')).toBe('replacement')
    expect(readFileSync(target, 'utf8')).toBe('original')
  })

  it('retries Windows locks then retains complete bytes after exhausting its budget', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'old')
    vi.mocked(rename).mockRejectedValue(error('EPERM'))
    await expect(atomicWriteFile(target, Buffer.from('new'))).rejects.toMatchObject({
      code: 'EPERM',
    })
    expect(rename).toHaveBeenCalledTimes(5)
    expect(readFileSync(target, 'utf8')).toBe('old')
    const rescue = readdirSync(dir).find((name) => name.endsWith('.tmp'))!
    expect(readFileSync(join(dir, rescue), 'utf8')).toBe('new')
  })
  it('serializes saves so a slow earlier stream cannot win last', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'old')
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = atomicWriteVia(target, async (temp) => {
      await gate
      await real.writeFile(temp, 'first')
    })
    const second = atomicWriteFile(target, Buffer.from('second'))
    release()
    await Promise.all([first, second])
    expect(readFileSync(target, 'utf8')).toBe('second')
  })
  it('discards incomplete stream bytes while preserving the previous document', async () => {
    const target = join(dir, 'report.pptx')
    writeFileSync(target, 'old')
    await expect(
      atomicWriteVia(target, async (temp) => {
        await writeFile(temp, 'half')
        throw error('EIO')
      }),
    ).rejects.toThrow('EIO')
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['report.pptx'])
  })
  it('captures the previous version before replacing a document', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'previous version')
    process.env.ASTER_RECOVERY_ROOT = join(dir, 'vault')
    await atomicWriteFile(target, Buffer.from('new version'))
    const entries = await listRecoveryEntries(process.env.ASTER_RECOVERY_ROOT)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originalPath).toBe(target)
    expect(readFileSync(join(dir, 'vault', `${entries[0]!.id}.bin`), 'utf8')).toBe(
      'previous version',
    )
    expect(readFileSync(target, 'utf8')).toBe('new version')
  })
  it('refuses overwrite when the configured recovery vault is unavailable', async () => {
    const target = join(dir, 'report.docx')
    writeFileSync(target, 'old')
    const vault = join(dir, 'not-a-directory')
    writeFileSync(vault, 'occupied')
    process.env.ASTER_RECOVERY_ROOT = vault
    const failure = await atomicWriteFile(target, Buffer.from('new')).catch(
      (reason: unknown) => reason,
    )
    expect(failure).toBeInstanceOf(AtomicSaveError)
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readFileSync((failure as AtomicSaveError).recoveryPath, 'utf8')).toBe('new')
  })
})

describe('small JSON state replacement', () => {
  it('saves state without creating document history', () => {
    process.env.ASTER_RECOVERY_ROOT = join(dir, 'vault')
    const target = join(dir, 'recent.json')
    writeJsonAtomic(target, ['old'])
    writeJsonAtomic(target, ['new'])
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(['new'])
    expect(readdirSync(dir)).toEqual(['recent.json'])
  })
  it('preserves old state and a complete rescue copy when rename fails', () => {
    const target = join(dir, 'recent.json')
    writeJsonAtomic(target, ['old'])
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw error('EXDEV')
    })
    let failure: unknown
    try {
      writeJsonAtomic(target, ['new'])
    } catch (reason) {
      failure = reason
    }
    expect(failure).toBeInstanceOf(AtomicSaveError)
    expect((failure as AtomicSaveError).code).toBe('EXDEV')
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(['old'])
    expect(JSON.parse(readFileSync((failure as AtomicSaveError).recoveryPath, 'utf8'))).toEqual([
      'new',
    ])
  })
  it('cleans an incomplete state write without changing previous state', () => {
    const target = join(dir, 'recent.json')
    writeJsonAtomic(target, ['old'])
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw error('EIO')
    })
    expect(() => writeJsonAtomic(target, ['new'])).toThrow('EIO')
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(['old'])
    expect(readdirSync(dir)).toEqual(['recent.json'])
  })
})
