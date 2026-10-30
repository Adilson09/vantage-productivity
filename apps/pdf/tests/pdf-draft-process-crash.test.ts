// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { PDFDocument } from 'pdf-lib'
import { listDraftJournal, restoreDraftCopy } from '@vantage/electron-utils/draft-journal'
import { decodePdfWorkspace, pdfDigest } from '../src/main/pdf-workspace'
import { completeWorkspace } from './fixtures/pdf-workspace'

function bounded<Value>(work: Promise<Value>, milliseconds: number): Promise<Value> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('The owned crash-fixture process did not settle within its test deadline.')), milliseconds); work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) }) })
}
describe('actual complete-package crash recovery', () => {
  it('restores every pending surface after its writer is killed and the original is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-real-draft-crash-'))
    let closed = true
    try {
      const bundle = join(root, 'owned-writer.mjs')
      // A test-private helper bundle only. Application build outputs stay untouched.
      await build({ entryPoints: [fileURLToPath(new URL('./fixtures/pdf-draft-crash-writer.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, external: ['electron'], logLevel: 'silent' })
      const document = await PDFDocument.create(); document.addPage([200, 300])
      const originalBytes = Buffer.from(await document.save()), original = join(root, 'Original.pdf'), recoveryRoot = join(root, 'recovery'), token = randomUUID()
      await writeFile(original, originalBytes)
      const child = spawn(process.execPath, [bundle, recoveryRoot, original, token], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
      closed = false
      const exited = once(child, 'close').then(() => { closed = true })
      let output = '', errors = ''
      const published = new Promise<{ token: string; sha256: string }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', () => { if (!output.includes('\n')) reject(new Error(`Owned writer exited before complete publication: ${errors.slice(0, 4096)}`)) })
        child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); if (Buffer.byteLength(errors) > 65536) { child.kill('SIGKILL'); reject(new Error('Owned writer exceeded its diagnostic budget.')) } })
        child.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          if (Buffer.byteLength(output) > 4096) { child.kill('SIGKILL'); reject(new Error('Owned writer exceeded its receipt budget.')); return }
          if (!output.includes('\n')) return
          try { const value = JSON.parse(output.slice(0, output.indexOf('\n'))); if (value.phase !== 'journal-published' || value.token !== token || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid complete-publication receipt'); resolve(value) } catch (error) { reject(error) }
        })
      })
      try {
        const receipt = await bounded(published, 30000)
        expect((await listDraftJournal(recoveryRoot)).find(entry => entry.id === token)?.sha256).toBe(receipt.sha256)
        // Kill only this exact owned helper, after its actual fsync/publication receipt.
        child.kill('SIGKILL'); await bounded(exited, 20000)
        await rm(original)
        const destination = join(root, 'Recovered.vpdfdraft')
        await restoreDraftCopy(recoveryRoot, token, destination)
        const decoded = await decodePdfWorkspace(await readFile(destination))
        expect(decoded.base).toEqual(originalBytes)
        expect(decoded.envelope.state).toEqual(completeWorkspace())
        expect(pdfDigest(await readFile(destination))).toBe(receipt.sha256)
      } finally {
        if (!closed) { child.kill('SIGKILL'); await bounded(exited, 20000) }
      }
    } finally {
      // Preserve diagnostic files if the OS has not acknowledged child termination.
      if (closed) await rm(root, { recursive: true, force: true })
    }
  }, 90000)
})
