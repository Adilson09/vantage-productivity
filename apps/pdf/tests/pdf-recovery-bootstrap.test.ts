import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFDocument } from 'pdf-lib'
import { PdfPrivateBases } from '../src/main/pdf-workspace'
import { PdfDraftController } from '../src/main/pdf-draft-controller'
import { encodePdfWorkspaceState } from '../src/shared/pdf-workspace'
import { emptyWorkspace } from './fixtures/pdf-workspace'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('PDF ordinary viewing with disabled/unavailable recovery foundation', () => {
  it('keeps native source authority/ordinary write gating but creates no UUID journal or private base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-bootstrap-')); roots.push(root)
    const pdf = await PDFDocument.create(); pdf.addPage([200, 300])
    const source = join(root, 'Original.pdf'), privateRoot = join(root, 'private')
    await writeFile(source, await pdf.save())
    const write = vi.fn(), controller = new PdfDraftController({ recoveryAvailable: () => false, alive: () => true, bases: new PdfPrivateBases(privateRoot),
      write, discard: async () => {}, retireCustody: async () => {}, failure: () => {}, resolvedFailure: async () => {}, notify: () => {},
    })
    const read = await controller.read(1, source)
    expect(read.draftCapability.available).toBe(false)
    expect(controller.activate(1, read.readId).token).toBe('')
    expect(controller.source(1)).toMatchObject({ helperPath: source, mode: 'native', readId: read.readId, token: '' })
    expect(() => controller.assertWritableSource(1, source)).not.toThrow()
    expect(() => controller.snapshot(1, { token: 'unminted', sequence: 1, state: encodePdfWorkspaceState(emptyWorkspace()) })).toThrow(/unavailable/)
    expect(write).not.toHaveBeenCalled()
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a recovery workspace before parsing or creating its private PDF base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-bootstrap-refusal-')); roots.push(root)
    const path = join(root, 'Recovered.vpdfdraft'), privateRoot = join(root, 'private')
    await writeFile(path, 'reserved workspace that must not be parsed')
    const controller = new PdfDraftController({ recoveryAvailable: () => false, alive: () => true, bases: new PdfPrivateBases(privateRoot),
      write: vi.fn(), discard: async () => {}, retireCustody: async () => {}, failure: () => {}, resolvedFailure: async () => {}, notify: () => {},
    })
    await expect(controller.read(1, path)).rejects.toThrow(/storage is unavailable/)
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
