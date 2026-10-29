import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { blankXlsxBuffer } from '@vantage/xlsx-gateway/gateway/csv-import'
import { saveWorkbookViaSidecar } from '@vantage/xlsx-gateway/gateway/xlsx-package-io'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
import {
  editOpenResultSchema,
  editRecalcResultSchema,
  editTransactionResultSchema,
  type EditSessionOpen,
  type EditTransaction,
} from '../src/main/xlsx-edit-contract'

const binary = fileURLToPath(
  new URL(
    `../native/xlsx-engine/target/release/xlsx-sidecar${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
  ),
)
const reads = [{ sheet: 'Sheet1', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 } }]

async function fixture(path: string): Promise<void> {
  const zip = await JSZip.loadAsync(await blankXlsxBuffer())
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1"><v>10</v></c><c r="B1"><f>A1*2</f><v>20</v></c></row></sheetData></worksheet>',
  )
  zip.file('customXml/aster-preservation.xml', '<opaque preserve="exact">Test marker</opaque>')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

function openInput(sourcePath: string, storePath?: string): EditSessionOpen {
  return {
    apiVersion: 1,
    workbookId: 'native-integration-book',
    sourcePath,
    sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
    ...(storePath ? { storePath } : {}),
  }
}

function setCommand(input: string, revision = 0, commandId = 'first-edit'): EditTransaction {
  return {
    apiVersion: 1,
    workbookId: 'native-integration-book',
    commandId,
    expectedRevision: revision,
    actor: 'integration-test',
    operations: [{ type: 'set_cell', sheetId: 'sheet-1', row: 0, column: 0, input }],
  }
}

async function stopOwned(client: XlsxSidecarClient): Promise<void> {
  const child = (client as unknown as { process: ChildProcess | null }).process
  const exited = child && child.exitCode === null ? once(child, 'exit') : Promise.resolve()
  client.stop()
  await exited
}

describe('Rust edit backend over the real native process', () => {
  it('recovers durable inputs and the exact command receipt after an abrupt restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aster-native-recovery-'))
    const path = join(directory, 'source.xlsx')
    const copied = join(directory, 'new-snapshot.xlsx')
    const storePath = join(directory, 'recovery.sqlite')
    await fixture(path)
    let client = new XlsxSidecarClient(binary)
    try {
      const open = openInput(path, storePath)
      expect(editOpenResultSchema.parse(await client.openEditSession(open)).revision).toBe(0)
      const command = setCommand('21')
      const receipt = editTransactionResultSchema.parse(await client.applyTransaction(command))
      expect(receipt).toMatchObject({ revision: 1, changed: 1, durable: true })
      const values = editRecalcResultSchema.parse(
        await client.recalcSnapshot({
          apiVersion: 1,
          workbookId: open.workbookId,
          revision: 1,
          reads,
        }),
      )
      expect(values.cells.map((cell) => cell.number)).toEqual([21, 42])

      await stopOwned(client)
      await copyFile(path, copied)
      client = new XlsxSidecarClient(binary)
      const recovered = editOpenResultSchema.parse(
        await client.openEditSession({ ...open, sourcePath: copied }),
      )
      expect(recovered).toMatchObject({ recovered: true, revision: 1 })
      expect(
        await client.commandResult({
          apiVersion: 1,
          workbookId: open.workbookId,
          commandId: command.commandId,
        }),
      ).toEqual(receipt)
      expect(await client.applyTransaction(command)).toEqual(receipt)
      await expect(client.applyTransaction(setCommand('999'))).rejects.toMatchObject({
        code: 'idempotency_conflict',
      })
      await expect(client.applyTransaction(setCommand('99', 0, 'stale'))).rejects.toMatchObject({
        code: 'revision_conflict',
        currentRevision: 1,
      })
      const snapshot = await client.snapshot({ apiVersion: 1, workbookId: open.workbookId })
      expect(snapshot).toMatchObject({
        revision: 1,
        inputs: [{ sheetId: 'sheet-1', row: 0, column: 0, input: '21' }],
      })
      const recalculated = editRecalcResultSchema.parse(
        await client.recalcSnapshot({
          apiVersion: 1,
          workbookId: open.workbookId,
          revision: 1,
          reads,
        }),
      )
      expect(recalculated.cells.map((cell) => cell.number)).toEqual([21, 42])
    } finally {
      await stopOwned(client)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('distinguishes half-open clearing from restoring the imported base, without changing the source package', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aster-native-clear-'))
    const path = join(directory, 'source.xlsx')
    await fixture(path)
    const original = await readFile(path)
    const client = new XlsxSidecarClient(binary)
    try {
      const open = openInput(path)
      await client.openEditSession(open)
      const clear: EditTransaction = {
        ...setCommand(''),
        operations: [
          {
            type: 'clear_range',
            sheetId: 'sheet-1',
            range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
          },
        ],
      }
      expect(editTransactionResultSchema.parse(await client.applyTransaction(clear))).toMatchObject(
        { revision: 1, durable: false },
      )
      expect(await client.snapshot({ apiVersion: 1, workbookId: open.workbookId })).toMatchObject({
        inputs: [{ sheetId: 'sheet-1', row: 0, column: 0, input: '' }],
      })
      const undo: EditTransaction = {
        ...setCommand('', 1, 'restore-source'),
        operations: [{ type: 'replace_inputs', edits: [] }],
      }
      await client.applyTransaction(undo)
      const restored = editRecalcResultSchema.parse(
        await client.recalcSnapshot({
          apiVersion: 1,
          workbookId: open.workbookId,
          revision: 2,
          reads,
        }),
      )
      expect(restored.cells.map((cell) => cell.number)).toEqual([10, 20])
      await expect(
        client.recalcSnapshot({ apiVersion: 1, workbookId: open.workbookId, revision: 1, reads }),
      ).rejects.toMatchObject({ code: 'stale_revision' })
      expect(await readFile(path)).toEqual(original)
    } finally {
      await stopOwned(client)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('calculates through the desktop adapter and preserves opaque parts through the established save path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aster-native-save-'))
    const path = join(directory, 'source.xlsx')
    const target = join(directory, 'saved.xlsx')
    await fixture(path)
    const client = new XlsxSidecarClient(binary)
    try {
      const open = openInput(path, join(directory, 'recovery.sqlite'))
      const result = await client.recalculateEditSession(
        open,
        [{ sheetId: 'sheet-1', row: 0, column: 0, input: '7' }],
        reads,
      )
      expect(result.cells.map((cell) => cell.number)).toEqual([7, 14])
      await saveWorkbookViaSidecar({
        client,
        sourcePath: path,
        targetPath: target,
        edits: [{ sheetName: 'Sheet1', row: 0, column: 0, writeValue: true, cell: { value: 7 } }],
        formulaValues: [{ sheetName: 'Sheet1', cells: [{ row: 0, column: 1, value: 14 }] }],
      })
      const saved = await JSZip.loadAsync(await readFile(target))
      expect(await saved.file('customXml/aster-preservation.xml')?.async('text')).toBe(
        '<opaque preserve="exact">Test marker</opaque>',
      )
      expect(await saved.file('xl/worksheets/sheet1.xml')?.async('text')).toContain('<v>7</v>')
      expect(await saved.file('xl/worksheets/sheet1.xml')?.async('text')).toContain('<v>14</v>')
    } finally {
      await stopOwned(client)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
