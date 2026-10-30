import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  cleanupExpiredPastedFiles,
  cleanupImportTempDirectory,
  cleanupSessionResources,
  PASTED_FILE_TTL_MS,
} from '../src/main/temp-files'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vantage-sheets-temp-test-'))
  roots.push(root)
  return root
}

describe('session temporary resources', () => {
  it('closes the sidecar before removing the snapshot and converted import directory', async () => {
    const root = await tempRoot()
    const snapshotDir = join(root, 'vantage-sheets-sessions')
    const importDir = join(root, 'vantage-imports', randomUUID())
    const snapshotPath = join(snapshotDir, `${randomUUID()}.xlsx`)
    await mkdir(importDir, { recursive: true })
    await mkdir(snapshotDir, { recursive: true })
    await writeFile(snapshotPath, 'snapshot')
    await writeFile(join(importDir, 'converted.xlsx'), 'converted')
    let closeObservedOpenFiles = false

    await cleanupSessionResources({
      tempRoot: root,
      snapshotPath,
      importTempDir: importDir,
      closeSidecar: async () => {
        closeObservedOpenFiles = existsSync(snapshotPath) && existsSync(importDir)
        throw new Error('sidecar already stopped')
      },
    })

    expect(closeObservedOpenFiles).toBe(true)
    expect(existsSync(snapshotPath)).toBe(false)
    expect(existsSync(importDir)).toBe(false)
  })

  it('never recursively deletes an unowned import path', async () => {
    const root = await tempRoot()
    const arbitrary = join(root, 'user-data')
    await mkdir(arbitrary, { recursive: true })
    await writeFile(join(arbitrary, 'keep.txt'), 'keep')

    await cleanupImportTempDirectory(root, arbitrary)

    expect(existsSync(join(arbitrary, 'keep.txt'))).toBe(true)
  })

  it('removes a nested current-process snapshot after close and keeps the cached directory and other snapshots', async () => {
    const root = await tempRoot()
    const processDirectory = join(root, 'vantage-sheets-sessions', `${process.pid}-${randomUUID()}`)
    const snapshotPath = join(processDirectory, `${randomUUID()}.xlsx`)
    const otherSnapshot = join(processDirectory, `${randomUUID()}.xlsx`)
    await mkdir(processDirectory, { recursive: true })
    await writeFile(snapshotPath, 'close this workbook')
    await writeFile(otherSnapshot, 'another open workbook')
    let snapshotWasPresentAtClose = false

    await cleanupSessionResources({
      tempRoot: root,
      snapshotPath,
      closeSidecar: async () => {
        snapshotWasPresentAtClose = existsSync(snapshotPath)
      },
    })

    expect(snapshotWasPresentAtClose).toBe(true)
    expect(existsSync(snapshotPath)).toBe(false)
    expect(existsSync(processDirectory)).toBe(true)
    expect(existsSync(otherSnapshot)).toBe(true)
  })

  it('retains other-process, malformed, outside, and linked snapshot paths', async () => {
    const root = await tempRoot()
    const snapshotRoot = join(root, 'vantage-sheets-sessions')
    const otherPid = process.pid === 2222 ? 3333 : 2222
    const foreignDirectory = join(snapshotRoot, `${otherPid}-${randomUUID()}`)
    const malformedDirectory = join(snapshotRoot, `${process.pid}-user-files`)
    const ownDirectory = join(snapshotRoot, `${process.pid}-${randomUUID()}`)
    const outsideDirectory = join(root, 'outside')
    for (const path of [foreignDirectory, malformedDirectory, ownDirectory, outsideDirectory]) {
      await mkdir(path, { recursive: true })
    }
    const foreign = join(foreignDirectory, `${randomUUID()}.xlsx`)
    const malformed = join(malformedDirectory, `${randomUUID()}.xlsx`)
    const outside = join(outsideDirectory, `${randomUUID()}.xlsx`)
    const unownedName = join(ownDirectory, 'important.xlsx')
    for (const path of [foreign, malformed, outside, unownedName]) await writeFile(path, 'keep')
    const linkedDirectory = join(snapshotRoot, `${process.pid}-${randomUUID()}`)
    const linkedSnapshot = join(ownDirectory, `${randomUUID()}.xlsx`)
    await symlink(outsideDirectory, linkedDirectory, 'junction')
    await symlink(outsideDirectory, linkedSnapshot, 'junction')

    for (const snapshotPath of [
      foreign,
      malformed,
      outside,
      unownedName,
      linkedSnapshot,
      join(linkedDirectory, basename(outside)),
    ]) {
      await cleanupSessionResources({
        tempRoot: root,
        snapshotPath,
        closeSidecar: async () => undefined,
      })
    }

    for (const path of [foreign, malformed, outside, unownedName])
      expect(existsSync(path)).toBe(true)
    expect(existsSync(linkedDirectory)).toBe(true)
    expect(existsSync(linkedSnapshot)).toBe(true)
  })
})

describe('pasted-image TTL cleanup', () => {
  it('removes only expired app-owned files from the direct pasted temp directory', async () => {
    const root = await tempRoot()
    const pastedDir = join(root, 'vantage-pasted')
    const oldOwned = join(pastedDir, 'pasted-20260101-010203-1.png')
    const recentOwned = join(pastedDir, 'pasted-20260101-010203-2.jpeg')
    const arbitrary = join(pastedDir, 'vacation.png')
    const lookalikeDirectory = join(pastedDir, 'pasted-20260101-010203-3.png')
    const nestedOwned = join(lookalikeDirectory, 'pasted-20260101-010203-4.png')
    await mkdir(lookalikeDirectory, { recursive: true })
    await Promise.all([
      writeFile(oldOwned, 'old'),
      writeFile(recentOwned, 'recent'),
      writeFile(arbitrary, 'user'),
      writeFile(nestedOwned, 'nested'),
    ])
    const now = Date.now()
    const expired = new Date(now - PASTED_FILE_TTL_MS - 60_000)
    await Promise.all([
      utimes(oldOwned, expired, expired),
      utimes(arbitrary, expired, expired),
      utimes(nestedOwned, expired, expired),
    ])

    const removed = await cleanupExpiredPastedFiles(root, now)

    expect(removed).toEqual([oldOwned])
    expect(existsSync(oldOwned)).toBe(false)
    expect(existsSync(recentOwned)).toBe(true)
    expect(existsSync(arbitrary)).toBe(true)
    expect(existsSync(nestedOwned)).toBe(true)
  })
})
