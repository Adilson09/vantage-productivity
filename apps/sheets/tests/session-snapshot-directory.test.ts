import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { allocateSessionSnapshotDirectory } from '../src/main/session-snapshot-directory'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vantage-snapshot-directory-test-'))
  roots.push(root)
  return root
}

describe('session snapshot directory allocation', () => {
  it('preserves an active snapshot when the same process allocates another directory', async () => {
    const root = await tempRoot()
    const first = await allocateSessionSnapshotDirectory(root)
    const active = join(first, `${randomUUID()}.xlsx`)
    await writeFile(active, 'an open workbook')

    const second = await allocateSessionSnapshotDirectory(root, {
      isProcessAlive: () => false,
    })

    expect(second).not.toBe(first)
    expect(existsSync(active)).toBe(true)
    expect(existsSync(second)).toBe(true)
  })

  it('sweeps only strict dead-owner directories and retains live or invalid candidates', async () => {
    const root = await tempRoot()
    const snapshotRoot = join(root, 'vantage-sheets-sessions')
    const current = join(snapshotRoot, `1111-${randomUUID()}`)
    const dead = join(snapshotRoot, `2222-${randomUUID()}`)
    const live = join(snapshotRoot, `3333-${randomUUID()}`)
    const malformed = join(snapshotRoot, '2222-user-data')
    const invalidPid = join(snapshotRoot, `0-${randomUUID()}`)
    const trailing = join(snapshotRoot, `2222-${randomUUID()}-other`)
    for (const path of [current, dead, live, malformed, invalidPid, trailing]) {
      await mkdir(path, { recursive: true })
      await writeFile(join(path, `${randomUUID()}.xlsx`), 'keep unless owned by a dead process')
    }
    const staging = join(dead, 'document-publish-ab12CD')
    await mkdir(staging)
    await writeFile(join(staging, 'complete.bin'), 'abandoned private output')

    await allocateSessionSnapshotDirectory(root, {
      processId: 1111,
      isProcessAlive: (pid) => pid !== 2222,
    })

    expect(existsSync(dead)).toBe(false)
    for (const path of [current, live, malformed, invalidPid, trailing]) {
      expect(existsSync(path)).toBe(true)
    }
  })

  it('keeps candidates when process liveness cannot be determined', async () => {
    const root = await tempRoot()
    const candidate = join(root, 'vantage-sheets-sessions', `2222-${randomUUID()}`)
    await mkdir(candidate, { recursive: true })
    const file = join(candidate, `${randomUUID()}.xlsx`)
    await writeFile(file, 'unknown owner status')

    await allocateSessionSnapshotDirectory(root, {
      processId: 1111,
      isProcessAlive: () => {
        throw new Error('process inspection denied')
      },
    })

    expect(existsSync(file)).toBe(true)
  })

  it('retains directory links and dead-owner trees containing links without following them', async () => {
    const root = await tempRoot()
    const outside = join(root, 'outside')
    const snapshotRoot = join(root, 'vantage-sheets-sessions')
    const linked = join(snapshotRoot, `2222-${randomUUID()}`)
    const containingLink = join(snapshotRoot, `2222-${randomUUID()}`)
    await mkdir(outside)
    await mkdir(containingLink, { recursive: true })
    const outsideFile = join(outside, `${randomUUID()}.xlsx`)
    const regularFile = join(containingLink, `${randomUUID()}.xlsx`)
    await writeFile(outsideFile, 'outside the owned snapshot tree')
    await writeFile(regularFile, 'retain the whole ambiguous candidate')
    await symlink(outside, linked, 'junction')
    await symlink(outside, join(containingLink, 'linked-child'), 'junction')

    await allocateSessionSnapshotDirectory(root, {
      processId: 1111,
      isProcessAlive: () => false,
    })

    expect(existsSync(linked)).toBe(true)
    expect(existsSync(regularFile)).toBe(true)
    expect(existsSync(outsideFile)).toBe(true)
  })

  it('refuses a linked snapshot root and leaves its target untouched', async () => {
    const root = await tempRoot()
    const outside = join(root, 'outside')
    await mkdir(outside)
    const file = join(outside, `${randomUUID()}.xlsx`)
    await writeFile(file, 'outside')
    await symlink(outside, join(root, 'vantage-sheets-sessions'), 'junction')

    await expect(allocateSessionSnapshotDirectory(root)).rejects.toThrow('owned regular directory')
    expect(existsSync(file)).toBe(true)
  })
})
