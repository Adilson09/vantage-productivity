import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
import type { EditSessionOpen } from '../src/main/xlsx-edit-contract'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aster-edit-cleanup-'))
  const storePath = join(directory, 'authority.sqlite')
  const paths = [storePath, `${storePath}-wal`, `${storePath}-shm`]
  await Promise.all(paths.map((path) => writeFile(path, 'retained database state')))
  const client = new XlsxSidecarClient('/unused-sidecar')
  const open: EditSessionOpen = {
    apiVersion: 1,
    workbookId: 'old-document',
    sourcePath: '/immutable-snapshot.xlsx',
    sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    storePath,
  }
  await client.bindEditSession('legacy-session', open)
  return {
    client,
    open,
    paths,
    async cleanup() {
      client.stop()
      if (!directory.startsWith(join(tmpdir(), 'aster-edit-cleanup-')))
        throw new Error('Unexpected test folder')
      await rm(directory, { recursive: true, force: true })
    },
  }
}

describe('edit authority journal cleanup', () => {
  it('retains the database and WAL when native close fails or times out', async () => {
    const { client, open, paths, cleanup } = await fixture()
    try {
      vi.spyOn(client, 'closeEditSession').mockRejectedValueOnce(
        new Error('Native close timed out'),
      )
      await expect(
        client.bindEditSession('legacy-session', { ...open, workbookId: 'replacement' }),
      ).rejects.toThrow('Native close timed out')
      expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(
        paths.map(() => 'retained database state'),
      )
    } finally {
      await cleanup()
    }
  })

  it('removes journal files only after native close acknowledges success', async () => {
    const { client, open, paths, cleanup } = await fixture()
    try {
      let acknowledge!: () => void
      const closed = vi.spyOn(client, 'closeEditSession').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve
          }),
      )
      const closing = client.bindEditSession('legacy-session', {
        ...open,
        workbookId: 'replacement',
      })
      expect(closed).toHaveBeenCalledWith({ apiVersion: 1, workbookId: open.workbookId })
      expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(
        paths.map(() => 'retained database state'),
      )
      acknowledge()
      await closing
      for (const path of paths)
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await cleanup()
    }
  })
})
