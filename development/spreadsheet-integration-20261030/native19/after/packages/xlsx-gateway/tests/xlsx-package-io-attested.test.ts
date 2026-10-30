import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { EntrySource, MutationPlan } from '../src/gateway/xlsx-gateway'
import type { ArchiveClient, ArchiveNativeRequestAdmission } from '../src/gateway/xlsx-package-io'
import { reserveFileMutation } from '../../electron-utils/src/file-publication-exclusion'

const planning = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../src/gateway/xlsx-gateway', () => ({ planCellEditsToXlsx: (...args: unknown[]) => planning.run(...args), syncFileBestEffort: async () => undefined }))
import { readArchiveEntryText, saveWorkbookViaSidecar } from '../src/gateway/xlsx-package-io'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve() }
function operation() {
  const result = deferred<unknown>(), completion = deferred<unknown>(), actual = deferred<void>()
  return { result, completion, actual,
    admission: { result: result.promise, completion: completion.promise, actualSettled: actual.promise } }
}
const entry = (name: string, crc32 = 1) => ({ name, crc32, compressedSize: 1, uncompressedSize: 1 })
function plan() {
  return { replaced: new Map([['sheet.xml', '<patched/>']]), added: new Map([['added.xml', '<added/>']]),
    addedBinary: new Map(), removedEntries: [], touchedEntries: ['sheet.xml'], addedEntries: ['added.xml'] } as unknown as MutationPlan
}
function nativeClient(dispatch: (command: Readonly<Record<string, unknown>>, timeoutMs?: number) => ArchiveNativeRequestAdmission) {
  const legacy = { archiveManifest: vi.fn(async () => { throw new Error('legacy manifest dispatch forbidden') }),
    readEntries: vi.fn(async () => { throw new Error('legacy extraction dispatch forbidden') }),
    scanEntries: vi.fn(async () => { throw new Error('legacy scanning dispatch forbidden') }),
    saveArchive: vi.fn(async () => { throw new Error('legacy save dispatch forbidden') }) }
  return { client: { ...legacy, requestAttested: vi.fn(dispatch) } satisfies ArchiveClient, legacy }
}
/** Test worker action owns all its actual writes; no timer/race is used as attestation. */
function finished(action: () => Promise<unknown>): ArchiveNativeRequestAdmission {
  const completion = action()
  return { result: completion, completion, actualSettled: completion.then(() => undefined, () => undefined) }
}
let root: string, sourcePath: string, targetPath: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vantage-attested-gateway-test-'))
  sourcePath = join(root, 'source.xlsx'); targetPath = join(root, 'saved.xlsx')
  await writeFile(sourcePath, 'synthetic source')
  planning.run.mockReset(); planning.run.mockImplementation(async () => plan())
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('attested native archive I/O (private successor sources)', () => {
  it('refuses an unattested legacy client before dispatch or publication', async () => {
    const f = nativeClient(() => { throw new Error('must not dispatch') })
    const { requestAttested: _omitted, ...legacy } = f.client
    await expect(saveWorkbookViaSidecar({ client: legacy, sourcePath, targetPath, edits: [] })).rejects.toThrow('requires definitive request attestation')
    await expect(readArchiveEntryText(legacy, sourcePath, 'sheet.xml')).rejects.toThrow('requires definitive request attestation')
    for (const method of Object.values(f.legacy)) expect(method).not.toHaveBeenCalled()
    expect(existsSync(targetPath)).toBe(false)
    expect(await readFile(sourcePath, 'utf8')).toBe('synthetic source')
  })

  it('preserves archive commands, payloads and180s budgets and protects exact native source/content files', async () => {
    const saving = operation(), dispatched = deferred<Readonly<Record<string, unknown>>>()
    const f = nativeClient(command => {
      if (command.command === 'archive_manifest') return finished(async () => ({ entries: [entry('sheet.xml')] }))
      if (command.command === 'scan_entries') return finished(async () => ({ matches: ['sheet.xml'] }))
      if (command.command === 'read_entries') return finished(async () => {
        const path = join(String(command.outputDir), 'entry.xml'); await writeFile(path, '<original/>')
        return { entries: [{ name: 'sheet.xml', path }] }
      })
      if (command.command === 'save_archive') { dispatched.resolve(command); return saving.admission }
      throw new Error('unexpected command')
    })
    planning.run.mockImplementation(async (source: EntrySource) => {
      expect(await source.containsText!('sheet.xml', 'needle')).toBe(true)
      expect(await source.readText('sheet.xml')).toBe('<original/>')
      return plan()
    })
    const pending = saveWorkbookViaSidecar({ client: f.client, sourcePath, targetPath, edits: [] })
    const command = await dispatched.promise
    expect(f.client.requestAttested.mock.calls.map(([input]) => input.command)).toEqual(['archive_manifest', 'scan_entries', 'read_entries', 'save_archive'])
    for (const [, timeout] of f.client.requestAttested.mock.calls) expect(timeout).toBe(180_000)
    expect(command.sourcePath).toBe(sourcePath)
    expect(command.targetPath).not.toBe(targetPath)
    expect(dirname(String(command.targetPath))).toBe(dirname(targetPath))
    const replacements = command.replacements as { name: string; contentPath: string }[]
    const additions = command.additions as { name: string; contentPath: string }[]
    expect(await readFile(replacements[0]!.contentPath, 'utf8')).toBe('<patched/>')
    expect(await readFile(additions[0]!.contentPath, 'utf8')).toBe('<added/>')
    const moves = [sourcePath, replacements[0]!.contentPath, additions[0]!.contentPath].map(path => reserveFileMutation([{ path, kind: 'file' }]))
    for (const move of moves) expect(move.isReady()).toBe(false)
    saving.result.reject(new Error('bounded archive caller timed out')); await flush()
    for (const move of moves) expect(move.isReady()).toBe(false)
    expect(existsSync(replacements[0]!.contentPath)).toBe(true)
    expect(existsSync(targetPath)).toBe(false)
    await writeFile(String(command.targetPath), 'completed native archive')
    saving.completion.resolve({ beforeEntries: [entry('sheet.xml')], afterEntries: [entry('sheet.xml', 2), entry('added.xml', 3)] })
    saving.actual.resolve()
    // Full gateway ownership outlives the native reply through promotion and cleanup.
    for (const move of moves) { await move.ready; expect(move.cancelPending()).toBe(true) }
    expect(await pending).toMatchObject({ touchedEntries: ['sheet.xml'], addedEntries: ['added.xml'] })
    expect(await readFile(targetPath, 'utf8')).toBe('completed native archive')
    expect(existsSync(replacements[0]!.contentPath)).toBe(false)
    for (const method of Object.values(f.legacy)) expect(method).not.toHaveBeenCalled()
  })

  it('native save failure cannot remove its temporary archive or staging inputs before actual settlement', async () => {
    const saving = operation(), dispatched = deferred<Readonly<Record<string, unknown>>>()
    const f = nativeClient(command => {
      if (command.command === 'archive_manifest') return finished(async () => ({ entries: [entry('sheet.xml')] }))
      dispatched.resolve(command); return saving.admission
    })
    const pending = saveWorkbookViaSidecar({ client: f.client, sourcePath, targetPath, edits: [] })
    const command = await dispatched.promise
    const staging = dirname((command.replacements as { contentPath: string }[])[0]!.contentPath)
    const temporaryTarget = String(command.targetPath)
    await writeFile(temporaryTarget, 'partial native archive')
    saving.result.reject(new Error('bounded timeout'))
    const failure = new Error('definitive native archive failure')
    saving.completion.reject(failure); await flush()
    expect(existsSync(staging)).toBe(true); expect(existsSync(temporaryTarget)).toBe(true)
    expect(existsSync(targetPath)).toBe(false)
    saving.actual.resolve()
    await expect(pending).rejects.toBe(failure)
    expect(existsSync(staging)).toBe(false); expect(existsSync(temporaryTarget)).toBe(false)
  })

  it('an admitted save continues its exact native temporary target when a source move begins during planning', async () => {
    const entered = deferred<void>(), resume = deferred<void>()
    const f = nativeClient(command => {
      if (command.command === 'archive_manifest') return finished(async () => ({ entries: [entry('sheet.xml')] }))
      if (command.command === 'save_archive') return finished(async () => {
        await writeFile(String(command.targetPath), 'completed while move drains')
        return { beforeEntries: [entry('sheet.xml')], afterEntries: [entry('sheet.xml', 2), entry('added.xml', 3)] }
      })
      throw new Error('unexpected command')
    })
    planning.run.mockImplementation(async () => { entered.resolve(); await resume.promise; return plan() })
    const pending = saveWorkbookViaSidecar({ client: f.client, sourcePath, targetPath, edits: [] })
    await entered.promise
    const move = reserveFileMutation([{ path: sourcePath, kind: 'file' }])
    expect(move.isReady()).toBe(false)
    resume.resolve()
    await expect(pending).resolves.toMatchObject({ touchedEntries: ['sheet.xml'] })
    await move.ready; expect(move.cancelPending()).toBe(true)
    expect(await readFile(targetPath, 'utf8')).toBe('completed while move drains')
  })

  it('one-shot entry read waits for late extraction and its actual finalizer before removing the output directory', async () => {
    const reading = operation(), dispatched = deferred<Readonly<Record<string, unknown>>>()
    const f = nativeClient(command => { dispatched.resolve(command); return reading.admission })
    let complete = false
    const pending = readArchiveEntryText(f.client, sourcePath, 'sheet.xml').then(value => { complete = true; return value })
    const command = await dispatched.promise, directory = String(command.outputDir)
    reading.result.reject(new Error('bounded timeout')); await flush()
    expect(existsSync(directory)).toBe(true); expect(complete).toBe(false)
    const path = join(directory, 'late.xml'); await writeFile(path, '<worksheet/>')
    reading.completion.resolve({ entries: [{ name: 'sheet.xml', path }] }); await flush()
    expect(existsSync(directory)).toBe(true); expect(complete).toBe(false)
    reading.actual.resolve()
    expect(await pending).toBe('<worksheet/>'); expect(existsSync(directory)).toBe(false)
  })

  it('a rejected parallel planner read drains the sibling extraction and its JS file read before cleanup', async () => {
    const bad = operation(), slow = operation(), both = deferred<void>(), commands: Readonly<Record<string, unknown>>[] = []
    const f = nativeClient(command => {
      if (command.command === 'archive_manifest') return finished(async () => ({ entries: [entry('bad.xml'), entry('slow.xml')] }))
      commands.push(command); if (commands.length === 2) both.resolve()
      return (command.entries as string[])[0] === 'bad.xml' ? bad.admission : slow.admission
    })
    planning.run.mockImplementation(async (source: EntrySource) => {
      await Promise.all([source.readText('bad.xml'), source.readText('slow.xml')]); return plan()
    })
    const pending = saveWorkbookViaSidecar({ client: f.client, sourcePath, targetPath, edits: [] })
    await both.promise
    const slowCommand = commands.find(command => (command.entries as string[])[0] === 'slow.xml')!
    const staging = dirname(String(slowCommand.outputDir)), failure = new Error('bad entry failed')
    bad.result.reject(failure); bad.completion.reject(failure); bad.actual.resolve(); await flush()
    expect(existsSync(staging)).toBe(true)
    const path = join(String(slowCommand.outputDir), 'entry.xml'); await writeFile(path, '<late-but-valid/>')
    slow.result.resolve({ entries: [{ name: 'slow.xml', path }] })
    slow.completion.resolve({ entries: [{ name: 'slow.xml', path }] }); slow.actual.resolve()
    await expect(pending).rejects.toBe(failure)
    expect(existsSync(staging)).toBe(false); expect(existsSync(targetPath)).toBe(false)
  })
})
