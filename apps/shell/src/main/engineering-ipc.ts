import {
  app,
  dialog,
  ipcMain,
  safeStorage,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron'
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, join, parse } from 'node:path'
import {
  discoverEngines,
  convertDocument,
  checkPdf,
} from '../../../../packages/engine-bridge/src/index.mjs'
import {
  createCalendar,
  expandCalendar,
  parseContacts,
} from '../../../../packages/productivity-engine/src/calendar'
import { atomicWriteFile } from '../../../../packages/electron-utils/src/atomic-write'
import {
  listDraftJournal,
  restoreDraftCopy,
  discardDraftJournal,
} from '../../../../packages/electron-utils/src/draft-journal'
import {
  exportRecoveryBackup,
  inspectRecoveryBackup,
  restoreBackupCopy,
} from '../../../../packages/electron-utils/src/recovery-backup'
import { VantageDatabase } from '../../../../packages/productivity-engine/src/database'
import { queryDatabaseIsolated } from '../../../../packages/productivity-engine/src/database-isolated'
import {
  getRecoveryVaultStatus,
  setRecoveryPolicy,
} from '../../../../packages/electron-utils/src/recovery-vault'
import { enableRecoveryEncryption } from '../../../../packages/electron-utils/src/recovery-encryption'
import { currentNetworkPolicy, saveNetworkPolicy } from './privacy-runtime'
import { VANTAGE_CHANNELS } from '../shared/vantage-api'

async function readBoundedText(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > 4 * 1024 * 1024)
      throw new Error('Choose a calendar or contact file smaller than 4 MiB.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) throw new Error('The selected file changed while reading.')
      offset += result.bytesRead
    }
    const after = await file.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('The selected file changed while reading.')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    await file.close()
  }
}

export function registerEngineeringIpc(
  hostFor: (event: IpcMainInvokeEvent) => BrowserWindow,
): void {
  const engineOptions = () => ({
    manifestPath:
      process.env.VANTAGE_ENGINE_MANIFEST ||
      (app.isPackaged
        ? join(process.resourcesPath, 'engines', 'engines.json')
        : join(app.getAppPath(), '../../packages/engine-bridge/engines.local.json')),
    tempRoot: process.env.VANTAGE_ENGINE_TEMP_DIR,
  })
  const recoveryRoot = join(app.getPath('userData'), 'recovery')
  let recoveryReady = existsSync(join(recoveryRoot, 'protected-key.bin'))
    ? enableRecoveryEncryption(recoveryRoot, safeStorage)
    : Promise.resolve()
  // Retain rejection for actions to display, without an unhandled startup rejection.
  void recoveryReady.catch(() => {})
  const databases = new Map<number, VantageDatabase>()
  const selectedBackups = new Map<number, string>()
  const observedSenders = new Set<number>()
  const watchSender = (event: IpcMainInvokeEvent) => {
    const id = event.sender.id
    if (observedSenders.has(id)) return
    observedSenders.add(id)
    event.sender.once('destroyed', () => {
      databases.get(id)?.close()
      databases.delete(id)
      selectedBackups.delete(id)
      observedSenders.delete(id)
    })
  }
  const databaseFor = (event: IpcMainInvokeEvent): VantageDatabase => {
    hostFor(event)
    const database = databases.get(event.sender.id)
    if (!database) throw new Error('Create or open a Vantage database first.')
    return database
  }
  const databasePreview = (database: VantageDatabase) => {
    return { path: database.path, tables: database.tables() }
  }
  app.once('will-quit', () => {
    for (const database of databases.values()) database.close()
    databases.clear()
  })
  const validatedId = (id: unknown): string => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))
      throw new Error('Invalid recovery item.')
    return id
  }
  const passwordText = (value: unknown): string => {
    if (typeof value !== 'string' || value.length < 8 || value.length > 1024)
      throw new Error('Use a backup password between 8 and 1,024 characters.')
    return value
  }
  ipcMain.handle(VANTAGE_CHANNELS.draftList, async (event) => {
    hostFor(event)
    await recoveryReady
    return (await listDraftJournal(recoveryRoot)).map(
      ({ id, module, documentPath, extension, updatedAt, bytes, encrypted }) => ({
        id,
        module,
        documentPath,
        extension,
        updatedAt,
        bytes,
        encrypted,
      }),
    )
  })
  ipcMain.handle(VANTAGE_CHANNELS.restoreDraft, async (event, id: unknown) => {
    const host = hostFor(event)
    await recoveryReady
    const identifier = validatedId(id)
    const item = (await listDraftJournal(recoveryRoot)).find((item) => item.id === identifier)
    if (!item) throw new Error('This draft is no longer available.')
    const destination = await dialog.showSaveDialog(host, {
      title: 'Recover a draft to a new file',
      defaultPath: `Recovered draft${item.extension}`,
    })
    if (destination.canceled || !destination.filePath) return null
    await restoreDraftCopy(recoveryRoot, identifier, destination.filePath)
    return destination.filePath
  })
  ipcMain.handle(VANTAGE_CHANNELS.discardDraft, async (event, id: unknown) => {
    hostFor(event)
    await recoveryReady
    await discardDraftJournal(recoveryRoot, validatedId(id))
  })
  ipcMain.handle(VANTAGE_CHANNELS.exportRecoveryBackup, async (event, value: unknown) => {
    const host = hostFor(event)
    await recoveryReady
    const password = passwordText(value)
    const output = await dialog.showSaveDialog(host, {
      title: 'Export encrypted saved history',
      defaultPath: 'Vantage history.vbackup',
      filters: [{ name: 'Encrypted Vantage history', extensions: ['vbackup'] }],
    })
    if (output.canceled || !output.filePath) return null
    await exportRecoveryBackup(recoveryRoot, output.filePath, password)
    return output.filePath
  })
  ipcMain.handle(VANTAGE_CHANNELS.inspectRecoveryBackup, async (event, value: unknown) => {
    const host = hostFor(event)
    const password = passwordText(value)
    const input = await dialog.showOpenDialog(host, {
      title: 'Open encrypted saved history',
      properties: ['openFile'],
      filters: [{ name: 'Encrypted Vantage history', extensions: ['vbackup'] }],
    })
    if (input.canceled || !input.filePaths[0]) return null
    const report = await inspectRecoveryBackup(input.filePaths[0], password)
    watchSender(event)
    selectedBackups.set(event.sender.id, input.filePaths[0])
    return report
  })
  ipcMain.handle(VANTAGE_CHANNELS.restoreBackupCopy, async (event, value: unknown, id: unknown) => {
    const host = hostFor(event)
    const password = passwordText(value),
      identifier = validatedId(id)
    const selectedBackup = selectedBackups.get(event.sender.id)
    if (!selectedBackup) throw new Error('Open an encrypted history export first.')
    const entry = (await inspectRecoveryBackup(selectedBackup, password)).entries.find(
      (e) => e.id === identifier,
    )
    if (!entry) throw new Error('This history entry is unavailable.')
    const output = await dialog.showSaveDialog(host, {
      title: 'Restore a separate backup copy',
      defaultPath: `Recovered ${entry.fileName}`,
    })
    if (output.canceled || !output.filePath) return null
    await restoreBackupCopy(selectedBackup, password, identifier, output.filePath)
    return output.filePath
  })
  ipcMain.handle(VANTAGE_CHANNELS.saveCalendarEvent, async (event, value: unknown) => {
    const host = hostFor(event)
    const input = value as {
      summary?: unknown
      start?: unknown
      end?: unknown
      location?: unknown
    } | null
    if (
      !input ||
      ![input.summary, input.start, input.end, input.location].every(
        (v) => typeof v === 'string' && v.length < 4096,
      )
    )
      throw new Error('Provide an event title, start, end and location.')
    const source = createCalendar([
      {
        summary: input.summary as string,
        start: input.start as string,
        end: input.end as string,
        location: input.location as string,
      },
    ])
    const output = await dialog.showSaveDialog(host, {
      title: 'Save a new calendar',
      defaultPath: 'My event.ics',
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
    })
    if (output.canceled || !output.filePath) return null
    if (existsSync(output.filePath))
      throw new Error('Choose a new file so your existing calendar remains unchanged.')
    await atomicWriteFile(output.filePath, Buffer.from(source, 'utf8'), { expectedVersion: null })
    return output.filePath
  })
  ipcMain.handle(VANTAGE_CHANNELS.engineeringStatus, async (event) => {
    hostFor(event)
    const metrics = app.getAppMetrics()
    return {
      version: app.getVersion(),
      runtime: {
        node: process.versions.node,
        electron: process.versions.electron,
        platform: `${process.platform}-${process.arch}`,
      },
      networkPolicy: currentNetworkPolicy(),
      engines: await discoverEngines(engineOptions()),
      metrics: {
        processes: metrics.length,
        workingSetKiB: metrics.reduce((sum, p) => sum + p.memory.workingSetSize, 0),
        cpuPercent: metrics.reduce((sum, p) => sum + p.cpu.percentCPUUsage, 0),
      },
    }
  })
  ipcMain.handle(VANTAGE_CHANNELS.updateNetworkPolicy, (event, value: unknown) => {
    hostFor(event)
    return saveNetworkPolicy(value)
  })
  ipcMain.handle(VANTAGE_CHANNELS.convertDocument, async (event) => {
    const host = hostFor(event)
    const input = await dialog.showOpenDialog(host, {
      title: 'Choose a document to convert',
      properties: ['openFile'],
      filters: [
        { name: 'Office documents', extensions: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'] },
      ],
    })
    if (input.canceled || !input.filePaths[0]) return null
    const source = input.filePaths[0]
    if (
      !['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'].includes(extname(source).toLowerCase())
    )
      throw new Error('Choose a supported Office document.')
    const output = await dialog.showSaveDialog(host, {
      title: 'Create a separate PDF copy',
      defaultPath: `${parse(source).name}.converted.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (output.canceled || !output.filePath) return null
    return convertDocument(source, output.filePath, engineOptions())
  })
  ipcMain.handle(VANTAGE_CHANNELS.checkSpecialistPdf, async (event, engine: unknown) => {
    const host = hostFor(event)
    if (engine !== 'qpdf' && engine !== 'verapdf')
      throw new Error('Choose qpdf or veraPDF for this check.')
    const input = await dialog.showOpenDialog(host, {
      title:
        engine === 'qpdf' ? 'Check PDF structure with qpdf' : 'Validate a PDF conformance profile',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (input.canceled || !input.filePaths[0]) return null
    return checkPdf(input.filePaths[0], { ...engineOptions(), engine })
  })
  ipcMain.handle(VANTAGE_CHANNELS.importCalendar, async (event) => {
    const host = hostFor(event)
    const input = await dialog.showOpenDialog(host, {
      title: 'Open a calendar',
      properties: ['openFile'],
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
    })
    if (input.canceled || !input.filePaths[0]) return null
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    const end = new Date(start.getTime() + 90 * 86400000)
    return {
      fileName: basename(input.filePaths[0]),
      ...expandCalendar(await readBoundedText(input.filePaths[0]), {
        start: start.toISOString(),
        end: end.toISOString(),
        maxOccurrences: 500,
        maxIterations: 20_000,
      }),
    }
  })
  ipcMain.handle(VANTAGE_CHANNELS.importContacts, async (event) => {
    const host = hostFor(event)
    const input = await dialog.showOpenDialog(host, {
      title: 'Open contacts',
      properties: ['openFile'],
      filters: [{ name: 'vCard contacts', extensions: ['vcf', 'vcard'] }],
    })
    if (input.canceled || !input.filePaths[0]) return null
    return {
      fileName: basename(input.filePaths[0]),
      ...parseContacts(await readBoundedText(input.filePaths[0])),
    }
  })
  ipcMain.handle(VANTAGE_CHANNELS.openDatabase, async (event, create: unknown) => {
    const host = hostFor(event)
    if (typeof create !== 'boolean') throw new Error('Choose create or open database.')
    let path: string | undefined
    if (create) {
      const result = await dialog.showSaveDialog(host, {
        title: 'Create a Vantage database',
        defaultPath: 'My database.vdb',
        filters: [{ name: 'Vantage database', extensions: ['vdb'] }],
      })
      if (!result.canceled) path = result.filePath
    } else {
      const result = await dialog.showOpenDialog(host, {
        title: 'Open a Vantage database',
        properties: ['openFile'],
        filters: [{ name: 'Vantage database', extensions: ['vdb'] }],
      })
      if (!result.canceled) path = result.filePaths[0]
    }
    if (!path) return null
    const next = new VantageDatabase(path, { create })
    databases.get(event.sender.id)?.close()
    databases.set(event.sender.id, next)
    watchSender(event)
    return databasePreview(next)
  })
  ipcMain.handle(VANTAGE_CHANNELS.queryDatabase, async (event, sql: unknown) => {
    const database = databaseFor(event)
    if (typeof sql !== 'string' || sql.length > 32_000)
      throw new Error('The query must be text smaller than 32,000 characters.')
    return queryDatabaseIsolated(database.path, sql, { timeoutMs: 3000, maxRows: 1000 })
  })
  ipcMain.handle(VANTAGE_CHANNELS.createDatabaseTable, (event, name: unknown, columns: unknown) => {
    const database = databaseFor(event)
    if (
      typeof name !== 'string' ||
      !Array.isArray(columns) ||
      columns.length > 128 ||
      !columns.every(
        (c) => c && typeof c.name === 'string' && ['TEXT', 'INTEGER', 'REAL'].includes(c.type),
      )
    )
      throw new Error('Provide a table name and named text or number columns.')
    database.createTable({ name, columns })
    return databasePreview(database)
  })
  ipcMain.handle(VANTAGE_CHANNELS.insertDatabaseRows, (event, table: unknown, rows: unknown) => {
    const database = databaseFor(event)
    if (
      typeof table !== 'string' ||
      !Array.isArray(rows) ||
      rows.length > 1000 ||
      JSON.stringify(rows).length > 2 * 1024 * 1024 ||
      !rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))
    )
      throw new Error('Provide up to 1,000 records smaller than 2 MiB.')
    database.insert(table, rows)
    return databasePreview(database)
  })
  ipcMain.handle(VANTAGE_CHANNELS.recoveryStatus, async (event) => {
    hostFor(event)
    await recoveryReady
    return getRecoveryVaultStatus(recoveryRoot)
  })
  ipcMain.handle(VANTAGE_CHANNELS.updateRecoveryPolicy, async (event, value: unknown) => {
    hostFor(event)
    await recoveryReady
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid recovery storage choices.')
    await setRecoveryPolicy(recoveryRoot, value)
    return getRecoveryVaultStatus(recoveryRoot)
  })
  ipcMain.handle(VANTAGE_CHANNELS.setRecoveryEncryption, async (event) => {
    hostFor(event)
    recoveryReady = enableRecoveryEncryption(recoveryRoot, safeStorage)
    await recoveryReady
    return getRecoveryVaultStatus(recoveryRoot)
  })
}
