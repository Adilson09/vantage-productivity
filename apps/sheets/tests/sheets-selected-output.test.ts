import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withFilePublication } from '@vantage/electron-utils/file-publication-exclusion'
import {
  captureFreshSheetsOutput,
  captureSelectedSheetsOutput,
  publishCapturedSheetsOutput,
  type AdmitSheetsOutput,
} from '../src/main/sheets-selected-output'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const prefix = join(tmpdir(), 'sheets-selected-output-')
let directory: string
beforeEach(() => { directory = mkdtempSync(prefix) })
afterEach(() => {
  if (!directory.startsWith(prefix)) throw new Error('Unexpected test-owned output directory.')
  rmSync(directory, { recursive: true, force: true })
})
// This adapter uses real JS publication ownership and the real shared atomic
// writer. It does not imitate native transport, a package serializer or its ACK.
const admit: AdmitSheetsOutput = (scope, actual) => withFilePublication(scope, actual)

describe('main-captured spreadsheet output versions', () => {
  it('preserves a peer target changed while serialization is pending', async () => {
    const targetPath = join(directory, 'selected.csv')
    writeFileSync(targetPath, 'selected version')
    const selected = await captureSelectedSheetsOutput(targetPath, () => {})
    const started = deferred(), finish = deferred(), afterPublished = vi.fn()
    const publication = publishCapturedSheetsOutput(selected, {
      assertCurrent: () => {},
      prepare: async () => { started.resolve(); await finish.promise; return Buffer.from('serialized output') },
      afterPublished,
    }, admit)
    await started.promise
    writeFileSync(targetPath, 'peer changed the selected output during serialization')
    finish.resolve()
    await expect(publication).rejects.toMatchObject({ vantageCode: 'SAVE_NOT_PUBLISHED' })
    expect(readFileSync(targetPath, 'utf8')).toBe('peer changed the selected output during serialization')
    expect(afterPublished).not.toHaveBeenCalled()
  })

  it('retains the chooser version when the destination changes before actual admission', async () => {
    const targetPath = join(directory, 'chosen.csv')
    writeFileSync(targetPath, 'the chooser observed these bytes')
    const selected = await captureSelectedSheetsOutput(targetPath, () => {})
    expect(Object.isFrozen(selected)).toBe(true)
    expect(Object.isFrozen(selected.expectedVersion)).toBe(true)
    writeFileSync(targetPath, 'another writer won before main admitted serialization')
    await expect(publishCapturedSheetsOutput(selected, {
      assertCurrent: () => {}, prepare: async () => Buffer.from('export output'),
    }, admit)).rejects.toMatchObject({ vantageCode: 'SAVE_NOT_PUBLISHED' })
    expect(readFileSync(targetPath, 'utf8')).toBe('another writer won before main admitted serialization')
  })

  it('refuses a source changed after the chooser before admission or serialization', async () => {
    const targetPath = join(directory, 'source-changed.csv')
    writeFileSync(targetPath, 'unchanged destination')
    let current = true
    const assertCurrent = () => { if (!current) throw new Error('The selected source changed.') }
    const selected = await captureSelectedSheetsOutput(targetPath, assertCurrent)
    current = false
    const observedAdmission = vi.fn(admit), prepare = vi.fn(async () => Buffer.from('obsolete source output'))
    expect(() => publishCapturedSheetsOutput(selected, { assertCurrent, prepare }, observedAdmission))
      .toThrow('The selected source changed.')
    expect(observedAdmission).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(readFileSync(targetPath, 'utf8')).toBe('unchanged destination')
  })

  it('preserves a peer that wins a fresh generated name while conversion is pending', async () => {
    const targetPath = join(directory, 'generated.xlsx'), started = deferred(), finish = deferred()
    const fresh = captureFreshSheetsOutput(targetPath)
    expect(fresh.expectedVersion).toBeNull()
    const publication = publishCapturedSheetsOutput(fresh, {
      assertCurrent: () => {},
      // Fixture bytes exercise publication only; no OOXML validity is claimed.
      prepare: async () => { started.resolve(); await finish.promise; return Buffer.from('converted fixture bytes') },
    }, admit)
    await started.promise
    writeFileSync(targetPath, 'a peer won this generated name')
    finish.resolve()
    await expect(publication).rejects.toMatchObject({ vantageCode: 'SAVE_NOT_PUBLISHED' })
    expect(readFileSync(targetPath, 'utf8')).toBe('a peer won this generated name')
  })

  it('permits replacing an unchanged selected target and awaits real adoption work', async () => {
    const targetPath = join(directory, 'overwrite.csv'), adopted = deferred(), finishAdoption = deferred()
    writeFileSync(targetPath, 'explicitly selected overwrite')
    const selected = await captureSelectedSheetsOutput(targetPath, () => {})
    let completed = false
    const publication = publishCapturedSheetsOutput(selected, {
      assertCurrent: () => {}, prepare: async () => Buffer.from('complete replacement'),
      afterPublished: async () => { adopted.resolve(); await finishAdoption.promise },
    }, admit).then(() => { completed = true })
    await adopted.promise
    expect(readFileSync(targetPath, 'utf8')).toBe('complete replacement')
    expect(completed).toBe(false)
    finishAdoption.resolve(); await publication
    expect(completed).toBe(true)
  })
})
