// Aster Office: real filesystem checks around the native workbook save boundary.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listRecoveryEntries,
  restoreRecoveryCopy,
} from '../../../packages/electron-utils/src/recovery-vault'
import { withNativeSaveRecovery } from '../src/main/save-recovery'

let dir: string
let previousRoot: string | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aster-native-save-'))
  previousRoot = process.env.ASTER_RECOVERY_ROOT
  process.env.ASTER_RECOVERY_ROOT = join(dir, 'history')
})
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ASTER_RECOVERY_ROOT
  else process.env.ASTER_RECOVERY_ROOT = previousRoot
  if (!dir.startsWith(join(tmpdir(), 'aster-native-save-')))
    throw new Error('Unexpected test folder')
  await rm(dir, { recursive: true, force: true })
})

describe('native workbook save recovery', () => {
  it('captures the original before entering the native writer and preserves its return value', async () => {
    const target = join(dir, 'book.xlsx')
    await writeFile(target, 'original')
    const result = await withNativeSaveRecovery(target, async () => {
      expect(await listRecoveryEntries(process.env.ASTER_RECOVERY_ROOT!)).toHaveLength(1)
      await writeFile(target, 'native output')
      return { mutation: 'done' }
    })
    expect(result).toEqual({ mutation: 'done' })
    const [entry] = await listRecoveryEntries(process.env.ASTER_RECOVERY_ROOT!)
    await restoreRecoveryCopy(
      process.env.ASTER_RECOVERY_ROOT!,
      entry!.id,
      join(dir, 'restored.xlsx'),
    )
    expect(await readFile(join(dir, 'restored.xlsx'), 'utf8')).toBe('original')
    expect(await readFile(target, 'utf8')).toBe('native output')
  })

  it('never invokes the native writer when the configured vault is unavailable', async () => {
    const target = join(dir, 'book.xlsx')
    await writeFile(target, 'original')
    await writeFile(process.env.ASTER_RECOVERY_ROOT!, 'blocks directory creation')
    const write = vi.fn()
    await expect(withNativeSaveRecovery(target, write)).rejects.toThrow(
      'workbook was not overwritten',
    )
    expect(write).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it('allows a new file without inventing previous history', async () => {
    const target = join(dir, 'new.xlsx')
    await withNativeSaveRecovery(target, () => writeFile(target, 'new'))
    expect(await listRecoveryEntries(process.env.ASTER_RECOVERY_ROOT!)).toEqual([])
    expect(await readFile(target, 'utf8')).toBe('new')
  })

  it('serializes native saves so an older invocation cannot overwrite a later one', async () => {
    const target = join(dir, 'book.xlsx')
    await writeFile(target, 'original')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    const first = withNativeSaveRecovery(target, async () => {
      firstEntered()
      await gate
      await writeFile(target, 'first')
    })
    await entered
    const secondWriter = vi.fn(() => writeFile(target, 'second'))
    const second = withNativeSaveRecovery(target, secondWriter)
    expect(secondWriter).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second])
    expect(await readFile(target, 'utf8')).toBe('second')
    const entries = await listRecoveryEntries(process.env.ASTER_RECOVERY_ROOT!)
    expect(entries).toHaveLength(2)
    const originals = await Promise.all(
      entries.map((entry) =>
        readFile(join(process.env.ASTER_RECOVERY_ROOT!, `${entry.id}.bin`), 'utf8'),
      ),
    )
    expect(originals.sort()).toEqual(['first', 'original'])
  })
})
