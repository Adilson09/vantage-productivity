import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { auditFileIsolated } from '../src/main/workspace-audit-process'

const roots: string[] = []
async function worker(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vantage-parser-test-'))
  roots.push(root)
  const path = join(root, 'worker.cjs')
  await writeFile(path, source)
  return path
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('isolated workspace parser lifecycle', () => {
  it('accepts a complete successful report, but refuses a forged success or nonzero exit', async () => {
    const report = {
      fileName: 'sample.md',
      filePath: 'sample.md',
      kind: 'md',
      scannedAt: new Date().toISOString(),
      bytes: 0,
      scope: 'Local check',
      checks: [],
      summary: { passed: 0, warnings: 0, failed: 0, informational: 0 },
    }
    const valid = await worker(
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, result: report }))})`,
    )
    expect(await auditFileIsolated('sample.md', { workerPath: valid })).toEqual(report)
    const failedExit = await worker(
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, result: report }))},()=>process.exit(7))`,
    )
    await expect(auditFileIsolated('sample.md', { workerPath: failedExit })).rejects.toThrow(
      'did not complete successfully',
    )
    const malformed = await worker('process.stdout.write(JSON.stringify({ok:true,result:{}}))')
    await expect(auditFileIsolated('sample.md', { workerPath: malformed })).rejects.toThrow(
      'incomplete report',
    )
  })
  it('rejects a process that exceeds its deadline and closes its handle', async () => {
    const workerPath = await worker('setInterval(()=>{},1000)')
    await expect(auditFileIsolated('sample.docx', { workerPath, timeoutMs: 150 })).rejects.toThrow(
      'time limit',
    )
  })
  it('cancels a parser in flight without manufacturing a successful report', async () => {
    const workerPath = await worker('setInterval(()=>{},1000)')
    const controller = new AbortController()
    const task = auditFileIsolated('sample.docx', { workerPath, signal: controller.signal })
    controller.abort()
    await expect(task).rejects.toThrow('Inspection cancelled')
  })
  it('refuses unbounded parser output', async () => {
    const workerPath = await worker(
      'process.stdout.write("x".repeat(3*1024*1024));setInterval(()=>{},1000)',
    )
    await expect(auditFileIsolated('sample.docx', { workerPath })).rejects.toThrow(
      'output exceeded',
    )
  })
  it('reports a parser crash and an explicit incomplete result as failures', async () => {
    const crashed = await worker('process.exit(7)')
    await expect(auditFileIsolated('sample.pdf', { workerPath: crashed })).rejects.toThrow(
      'stopped without a result',
    )
    const incomplete = await worker(
      'process.stdout.write(JSON.stringify({ok:false,error:"Expanded byte budget exhausted"}))',
    )
    await expect(auditFileIsolated('sample.xlsx', { workerPath: incomplete })).rejects.toThrow(
      'Expanded byte budget exhausted',
    )
  })
})
