import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { RootQuitIntent } from '../src/main/root-quit-intent'
import { runRootFileMutation, tryReadyRootFileMutation } from '../src/main/root-file-mutation'
import {
  reserveFileMutation,
  withAttestedFilePublication,
} from '../../../packages/electron-utils/src/file-publication-exclusion'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const prefix = join(tmpdir(), 'vantage-root-file-mutation-')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(prefix)
})
afterEach(() => {
  if (!dir.startsWith(prefix)) throw new Error('Unexpected test directory')
  rmSync(dir, { recursive: true, force: true })
})

it('reserves Root before asynchronous drain, and a caller timeout cannot release the actual move/refresh', async () => {
  const source = join(dir, 'old.xlsx'),
    destination = join(dir, 'new.xlsx')
  writeFileSync(source, 'original')
  const native = deferred(),
    reply = deferred(),
    atRefresh = deferred(),
    refresh = deferred()
  const publisher = withAttestedFilePublication({ targetPath: source }, () => ({
    result: reply.promise,
    actualSettled: native.promise,
  }))
  const intent = new RootQuitIntent(),
    epoch = intent.capture()
  const actual = runRootFileMutation(
    intent,
    [
      { path: source, kind: 'file' },
      { path: destination, kind: 'file' },
    ],
    'Move source',
    async () => {
      renameSync(source, destination)
      atRefresh.resolve()
      await refresh.promise
    },
  )
  expect(intent.current(epoch)).toBe(false)
  expect(existsSync(source)).toBe(true)
  reply.resolve()
  await publisher
  await expect(
    Promise.race([actual, Promise.reject(new Error('caller timed out'))]),
  ).rejects.toThrow('caller timed out')
  expect(intent.mutationAllowed()).toBe(false)
  native.resolve()
  await atRefresh.promise
  expect(intent.mutationAllowed()).toBe(false)
  expect(existsSync(source)).toBe(false)
  refresh.resolve()
  await actual
  expect(intent.mutationAllowed()).toBe(true)
  expect(readFileSync(destination, 'utf8')).toBe('original')
})

it('a failed physical move releases only its own mutation intent, never another writer actual promise', async () => {
  const source = join(dir, 'failed.docx'),
    unrelated = join(dir, 'still-writing.xlsx'),
    writer = deferred()
  writeFileSync(source, 'untouched')
  const pendingWriter = withAttestedFilePublication({ targetPath: unrelated }, () => ({
    result: Promise.resolve(),
    actualSettled: writer.promise,
  }))
  const intent = new RootQuitIntent()
  await expect(
    runRootFileMutation(intent, [{ path: source, kind: 'file' }], 'Failed move', async () => {
      throw new Error('filesystem refused')
    }),
  ).rejects.toThrow('filesystem refused')
  expect(intent.mutationAllowed()).toBe(true)
  expect(readFileSync(source, 'utf8')).toBe('untouched')
  const otherMutation = reserveFileMutation([{ path: unrelated, kind: 'file' }])
  expect(otherMutation.isReady()).toBe(false)
  writer.resolve()
  await pendingWriter
  await otherMutation.run(async () => undefined)
})

it('legacy path-return relocation refuses a real drain, then holds a synchronously completed move through async refresh', async () => {
  const source = join(dir, 'first.docx'),
    destination = join(dir, 'folder-first.docx'),
    writer = deferred()
  writeFileSync(source, 'saved')
  const actualWriter = withAttestedFilePublication({ targetPath: source }, () => ({
    result: Promise.resolve(),
    actualSettled: writer.promise,
  }))
  const intent = new RootQuitIntent()
  const refused = tryReadyRootFileMutation(
    intent,
    [
      { path: source, kind: 'file' },
      { path: destination, kind: 'file' },
    ],
    'First-save move',
    async () => {
      renameSync(source, destination)
    },
  )
  expect(refused.started).toBe(false)
  expect(intent.mutationAllowed()).toBe(true)
  expect(existsSync(source)).toBe(true)
  writer.resolve()
  await actualWriter
  await Promise.resolve()
  const refresh = deferred()
  const started = tryReadyRootFileMutation(
    intent,
    [
      { path: source, kind: 'file' },
      { path: destination, kind: 'file' },
    ],
    'First-save move',
    async () => {
      renameSync(source, destination)
      await refresh.promise
    },
  )
  expect(started.started).toBe(true)
  expect(existsSync(destination)).toBe(true)
  expect(intent.mutationAllowed()).toBe(false)
  refresh.resolve()
  if (!started.started) throw new Error('Expected a synchronously admitted physical move')
  await started.actual
  expect(intent.mutationAllowed()).toBe(true)
})
