// Native archive publication shares the common non-truncating save contract.
import { copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promoteFileAtomically } from '@vantage/xlsx-gateway/gateway/xlsx-package-io'
import { AtomicSaveError } from '../../../packages/electron-utils/src/atomic-write'

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, rename: vi.fn(real.rename), copyFile: vi.fn(real.copyFile) }
})
const prefix = join(tmpdir(), 'vantage-promote-test-')
let dir: string, previousRoot: string | undefined
beforeEach(async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockReset().mockImplementation(real.rename)
  vi.mocked(copyFile).mockReset().mockImplementation(real.copyFile)
  dir = await mkdtemp(prefix)
  previousRoot = process.env.VANTAGE_RECOVERY_ROOT
  delete process.env.VANTAGE_RECOVERY_ROOT
})
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.VANTAGE_RECOVERY_ROOT
  else process.env.VANTAGE_RECOVERY_ROOT = previousRoot
  if (!dir.startsWith(prefix)) throw new Error('Unexpected test folder')
  await rm(dir, { recursive: true, force: true })
})
const failure = (code: string) => Object.assign(new Error(`${code}: injected publication refusal`), { code })
async function fixture() {
  const temporary = join(dir, 'new.tmp.xlsx'), target = join(dir, 'book.xlsx')
  await writeFile(temporary, 'complete new workbook')
  await writeFile(target, 'original workbook')
  return { temporary, target }
}
describe('native completed-file publication', () => {
  it('publishes a complete native archive and removes only its renamed temp', async () => {
    const { temporary, target } = await fixture()
    await promoteFileAtomically(temporary, target)
    expect(await readFile(target, 'utf8')).toBe('complete new workbook')
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(copyFile).not.toHaveBeenCalled()
  })
  it('retries transient Windows locks and publishes after the lock is released', async () => {
    const { temporary, target } = await fixture()
    vi.mocked(rename).mockRejectedValueOnce(failure('EPERM')).mockRejectedValueOnce(failure('EBUSY'))
    await promoteFileAtomically(temporary, target)
    expect(rename).toHaveBeenCalledTimes(3)
    expect(copyFile).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe('complete new workbook')
  })
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retains complete rescue bytes and preserves the original after persistent %s', async (code) => {
    const { temporary, target } = await fixture()
    vi.mocked(rename).mockRejectedValue(failure(code))
    const error = await promoteFileAtomically(temporary, target).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AtomicSaveError)
    expect(error).toMatchObject({ targetPath: target, recoveryPath: temporary, code, vantageCode: 'SAVE_NOT_PUBLISHED' })
    expect(await readFile(target, 'utf8')).toBe('original workbook')
    expect(await readFile(temporary, 'utf8')).toBe('complete new workbook')
    expect(copyFile).not.toHaveBeenCalled()
    expect(rename).toHaveBeenCalledTimes(5)
  })
  it('retains the completed file on non-retryable publication failure too', async () => {
    const { temporary, target } = await fixture()
    vi.mocked(rename).mockRejectedValue(failure('EIO'))
    await expect(promoteFileAtomically(temporary, target)).rejects.toMatchObject({ code: 'EIO', recoveryPath: temporary })
    expect(rename).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('original workbook')
    expect(await readFile(temporary, 'utf8')).toBe('complete new workbook')
  })
  it('does not advertise a missing temporary file as completed recovery data', async () => {
    await expect(promoteFileAtomically(join(dir, 'missing.tmp'), join(dir, 'book.xlsx'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(rename).not.toHaveBeenCalled()
  })
  it('rejects a temporary file outside the destination folder', async () => {
    const { temporary } = await fixture()
    await expect(promoteFileAtomically(temporary, join(dir, 'other', 'book.xlsx'))).rejects.toThrow('beside')
    expect(await readFile(temporary, 'utf8')).toBe('complete new workbook')
  })
})
