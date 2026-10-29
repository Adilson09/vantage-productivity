// Aster Office addition (2026): user-selected, local-only inspection and recovery copies.
import { extname, join, parse, resolve } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ASTER_CHANNELS } from '../shared/aster-api'
import { auditFile } from './workspace-audit'
import { openAsterMail } from './aster-mail'
import {
  listRecoveryEntries,
  restoreRecoveryCopy,
} from '../../../../packages/electron-utils/src/recovery-vault'

export function registerAsterIpc(getHost: () => BrowserWindow | null): void {
  const root = join(app.getPath('userData'), 'recovery')
  const hostFor = (event: IpcMainInvokeEvent) => {
    const host = getHost()
    if (!host || host.isDestroyed() || event.sender !== host.webContents) {
      throw new Error('This action is only available from the Aster workspace.')
    }
    return host
  }
  ipcMain.handle(ASTER_CHANNELS.inspectFile, async (event) => {
    const host = hostFor(event)
    const selected = await dialog.showOpenDialog(host, {
      title: 'Inspect a document locally',
      properties: ['openFile'],
      filters: [
        {
          name: 'Supported documents',
          extensions: ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'markdown', 'html', 'htm'],
        },
      ],
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    return auditFile(selected.filePaths[0])
  })
  ipcMain.handle(ASTER_CHANNELS.recoveryList, async (event) => {
    hostFor(event)
    return listRecoveryEntries(root)
  })
  ipcMain.handle(ASTER_CHANNELS.openMail, async (event) => {
    hostFor(event)
    return openAsterMail({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      platform: process.platform,
    })
  })
  ipcMain.handle(ASTER_CHANNELS.recoveryRestoreCopy, async (event, id: unknown) => {
    const host = hostFor(event)
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id))
      throw new Error('Invalid recovery entry.')
    const entry = (await listRecoveryEntries(root)).find((item) => item.id === id)
    if (!entry) throw new Error('That recovery version is no longer available. Refresh the list.')
    const file = parse(entry.fileName)
    const selected = await dialog.showSaveDialog(host, {
      title: 'Save a recovered copy',
      defaultPath: `${file.name}.recovered${file.ext}`,
      filters: [
        { name: 'Recovered document', extensions: [extname(entry.fileName).slice(1) || '*'] },
      ],
    })
    if (selected.canceled || !selected.filePath) return null
    const destination = resolve(selected.filePath)
    const canonical = (value: string) =>
      process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
    if (canonical(destination) === canonical(entry.originalPath)) {
      throw new Error('Choose a new filename. Recovery never overwrites the original document.')
    }
    await restoreRecoveryCopy(root, id, destination)
    return destination
  })
}
