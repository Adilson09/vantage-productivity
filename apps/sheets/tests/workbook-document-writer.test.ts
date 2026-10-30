import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { workbookSaveRequestSchema } from '../src/shared/desktop-api'
import {
  writeWorkbookDocumentPackage,
  type DocumentPackageWriteInput,
} from '../src/main/workbook-document-writer'

vi.mock('@vantage/xlsx-gateway/gateway/xlsx-package-io', () => ({
  saveWorkbookViaSidecar: async (request: { targetPath: string }) => {
    const fs = await import('node:fs/promises')
    await fs.writeFile(request.targetPath, 'complete plain workbook package')
    return { touchedEntries: [], removedEntries: [], addedEntries: [] }
  },
}))

let directory: string | undefined
afterEach(async () => {
  if (!directory) return
  const checked = resolve(directory)
  if (
    !basename(checked).startsWith('vantage-document-writer-') ||
    relative(resolve(tmpdir()), checked).startsWith('..')
  )
    throw new Error('Unexpected writer test directory')
  await rm(checked, { recursive: true, force: true })
})

it.each(['', 'nonempty-password'])(
  'encrypts a supplied password even when it is %j',
  async (password) => {
    directory = await mkdtemp(join(tmpdir(), 'vantage-document-writer-'))
    const targetPath = join(directory, 'protected.xlsx')
    const encrypt = vi.fn((bytes: Buffer, _password: string) =>
      Buffer.concat([Buffer.from('cipher:'), bytes]),
    )
    let recoveryCalls = 0
    const request = workbookSaveRequestSchema.parse({
      sessionId: '10000000-0000-4000-8000-000000000001',
      mode: 'save-as',
      edits: [],
      structuralOps: [],
      chartEdits: [],
      visualEdits: [],
      visualAdditions: [],
      tableAdditions: [],
      pivotAdditions: [],
      sheetOps: [],
      sheetOrder: [],
      filterStates: [],
      hyperlinkEdits: [],
      cfStates: [],
      dvStates: [],
      pageSetupStates: [],
      noteStates: [],
      formulaValues: [],
      pivotCacheRefreshPaths: [],
      pivotRefreshUpdates: [],
      sheetProtections: [],
      definedNamesState: null,
    })
    await writeWorkbookDocumentPackage({
      client: {} as DocumentPackageWriteInput['client'],
      session: { snapshotPath: join(directory, 'base.bin'), sheetNames: new Map(), password },
      request,
      targetPath,
      tempRoot: directory,
      encryptOoxml: encrypt,
      verifyPreservation: false,
      atomicWriteFile: async (path, bytes) => writeFile(path, bytes),
      withNativeSaveRecovery: async <T>(_path: string, write: () => Promise<T>) => {
        recoveryCalls += 1
        return write()
      },
    })
    expect(encrypt).toHaveBeenCalledWith(Buffer.from('complete plain workbook package'), password)
    expect(await readFile(targetPath, 'utf8')).toBe('cipher:complete plain workbook package')
    expect(recoveryCalls).toBe(0)
  },
)
