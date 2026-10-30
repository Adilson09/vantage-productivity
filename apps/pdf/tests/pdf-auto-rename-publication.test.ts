// @vitest-environment node
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { renameOwnedPdf } from '../src/main/pdf-auto-rename'
import { readPinnedPdf, type PdfLoadedFile } from '../src/main/pdf-publication'
import {
  withAttestedFilePublication,
  withFilePublication,
} from '../../../packages/electron-utils/src/file-publication-exclusion'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const prefix = join(tmpdir(), 'vantage-pdf-own-rename-')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(prefix)
})
afterEach(() => {
  if (!dir.startsWith(prefix)) throw new Error('Unexpected test root')
  rmSync(dir, { recursive: true, force: true })
})
async function loaded(path: string): Promise<PdfLoadedFile> {
  return { path, ...(await readPinnedPdf(path)), readId: 'read', session: 'session' }
}
const move = (source: string, target: string) => {
  try {
    linkSync(source, target)
    unlinkSync(source)
    return 'moved' as const
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'occupied' as const
    return 'failed' as const
  }
}
it('waits actual final publication after caller cancellation and refuses the now-stale loaded rename', async () => {
  const path = join(dir, 'Untitled.pdf')
  writeFileSync(path, 'loaded')
  const source = await loaded(path)
  const terminal = deferred(),
    cancel = deferred()
  let renamed = false,
    canceled = false
  const result = withAttestedFilePublication({ targetPath: path }, () => ({
    result: cancel.promise.then(() => {
      throw new Error('caller canceled')
    }),
    actualSettled: terminal.promise,
  }))
  cancel.resolve()
  await expect(result).rejects.toThrow('caller canceled')
  const rename = renameOwnedPdf({
    source,
    baseName: 'Title',
    current: () => {},
    cancelClose: () => {
      canceled = true
    },
    move: (a, b) => {
      renamed = true
      return move(a, b)
    },
    adopt: () => {},
  })
  await Promise.resolve()
  expect(canceled).toBe(true)
  expect(renamed).toBe(false)
  const temp = join(dir, 'actual.tmp')
  writeFileSync(temp, 'actual published')
  renameSync(temp, path)
  terminal.resolve()
  await expect(rename).rejects.toThrow(/changed/)
  expect(renamed).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('actual published')
  const target = await renameOwnedPdf({
    source: await loaded(path),
    baseName: 'Title',
    current: () => {},
    cancelClose: () => {},
    move,
    adopt: () => {},
  })
  expect(target).toBe(join(dir, 'Title.pdf'))
  expect(existsSync(path)).toBe(false)
})
it('retains exclusive no-clobber and actual adoption until its promise settles', async () => {
  const path = join(dir, 'Untitled.pdf')
  writeFileSync(path, 'loaded')
  writeFileSync(join(dir, 'Title.pdf'), 'peer')
  const entered = deferred(),
    done = deferred()
  let adopted = false
  const job = renameOwnedPdf({
    source: await loaded(path),
    baseName: 'Title',
    current: () => {},
    cancelClose: () => {},
    move,
    adopt: async () => {
      entered.resolve()
      await done.promise
      adopted = true
    },
  })
  await entered.promise
  await expect(
    Promise.resolve().then(() =>
      withFilePublication({ targetPath: path }, async () => {
        writeFileSync(path, 'obsolete')
      }),
    ),
  ).rejects.toThrow()
  expect(adopted).toBe(false)
  expect(readFileSync(join(dir, 'Title.pdf'), 'utf8')).toBe('peer')
  done.resolve()
  expect(await job).toBe(join(dir, 'Title-2.pdf'))
  expect(adopted).toBe(true)
  await withFilePublication({ targetPath: join(dir, 'unrelated.pdf') }, async () => {})
})
it('a failed source proof releases only its mutation so a later valid operation can proceed', async () => {
  const path = join(dir, 'Untitled.pdf')
  writeFileSync(path, 'loaded')
  const source = await loaded(path)
  let checks = 0
  await expect(
    renameOwnedPdf({
      source,
      baseName: 'Title',
      current: () => {
        if (++checks > 1) throw new Error('source changed')
      },
      cancelClose: () => {},
      move,
      adopt: () => {},
    }),
  ).rejects.toThrow('source changed')
  expect(readFileSync(path, 'utf8')).toBe('loaded')
  await withFilePublication({ targetPath: path }, async () => {})
})
