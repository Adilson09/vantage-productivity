import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { exportSlidesPdf, type PdfExportWindow } from '../src/main/pdf-export'
import { reserveFileMutation } from '../../../packages/electron-utils/src/file-publication-exclusion'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const prefix = join(tmpdir(), 'vantage-slides-export-publication-')
let dir: string
beforeEach(() => { dir = mkdtempSync(prefix) })
afterEach(() => { if (!dir.startsWith(prefix)) throw new Error('Unexpected test root'); rmSync(dir, { recursive: true, force: true }) })
function windowFor(print: () => Promise<Buffer>): PdfExportWindow { return { loadFile: async () => undefined, webContents: { executeJavaScript: async () => undefined, printToPDF: print }, destroy: vi.fn() } }
it('a timed-out renderer can later finish bytes but can never publish after the caller result or a Root move', async () => {
  const path = join(dir, 'selected.pdf'), moved = join(dir, 'moved.pdf'); writeFileSync(path, 'original')
  const printed = deferred<Buffer>(), entered = deferred<void>(), win = windowFor(() => { entered.resolve(); return printed.promise })
  const job = exportSlidesPdf({ pages: [], widthPx: 960, heightPx: 540, filePath: path, createWindow: () => win, openExportedPdf: vi.fn(), timeoutMs: 5 })
  await entered.promise
  expect((await job).ok).toBe(false)
  const mutation = reserveFileMutation([{ path, kind: 'file' }, { path: moved, kind: 'file' }])
  await mutation.run(async () => { renameSync(path, moved) })
  printed.resolve(Buffer.from('late rendered bytes')); await Promise.resolve(); await Promise.resolve()
  expect(existsSync(path)).toBe(false)
  expect(readFileSync(moved, 'utf8')).toBe('original')
})
it('pins the selected PDF before render and preserves a peer replacement during rendering', async () => {
  const path = join(dir, 'selected.pdf'); writeFileSync(path, 'original')
  const printed = deferred<Buffer>(), entered = deferred<void>(), win = windowFor(() => { entered.resolve(); return printed.promise })
  const job = exportSlidesPdf({ pages: [], widthPx: 960, heightPx: 540, filePath: path, createWindow: () => win, openExportedPdf: vi.fn() })
  await entered.promise; writeFileSync(path, 'peer'); printed.resolve(Buffer.from('rendered'))
  expect((await job).ok).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('peer')
})
it('holds the selected namespace and synchronous open/adoption through publication before an enclosing move', async () => {
  const oldDir = join(dir, 'old'), newDir = join(dir, 'new'); mkdirSync(oldDir)
  const path = join(oldDir, 'selected.pdf'); writeFileSync(path, 'original')
  const printed = deferred<Buffer>(), entered = deferred<void>(), win = windowFor(() => { entered.resolve(); return printed.promise })
  let adopted = false
  const job = exportSlidesPdf({ pages: [], widthPx: 960, heightPx: 540, filePath: path, createWindow: () => win, openExportedPdf: () => { expect(existsSync(path)).toBe(true); adopted = true } })
  await entered.promise
  const mutation = reserveFileMutation([{ path: oldDir, kind: 'directory' }, { path: newDir, kind: 'directory' }])
  const move = mutation.run(async () => { expect(adopted).toBe(true); renameSync(oldDir, newDir) })
  printed.resolve(Buffer.from('finished PDF')); expect((await job).ok).toBe(true); await move
  expect(existsSync(oldDir)).toBe(false)
  expect(readFileSync(join(newDir, 'selected.pdf'), 'utf8')).toBe('finished PDF')
})
