// Vantage Productivity addition (2026): user-selected, local-only inspection and recovery copies.
import { extname, join, parse, resolve } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { VANTAGE_CHANNELS } from '../shared/vantage-api'
import { auditFileIsolated } from './workspace-audit-process'
import { openVantageMail } from './vantage-mail'
import { currentNetworkPolicy } from './privacy-runtime'
import { requireRemoteFeature } from '../../../../packages/electron-utils/src/network-policy'
import { registerEngineeringIpc } from './engineering-ipc'
import { getAtomicSaveReports } from '../../../../packages/electron-utils/src/atomic-write'
import {
  listRecoveryEntries,
  restoreRecoveryCopy,
} from '../../../../packages/electron-utils/src/recovery-vault'

export function registerVantageIpc(getHost: () => BrowserWindow | null): void {
  let inspection: AbortController | undefined
  let choosingInspection = false
  const root = join(app.getPath('userData'), 'recovery')
  const hostFor = (event: IpcMainInvokeEvent) => {
    const host = getHost()
    if (!host || host.isDestroyed() || event.sender !== host.webContents) {
      throw new Error('This action is only available from the Vantage workspace.')
    }
    return host
  }
  registerEngineeringIpc(hostFor)
  const announced = new Map<string, string>()
  const saveWarnings = setInterval(() => {
    const host = getHost()
    if (!host || host.isDestroyed()) return
    for (const { path, report } of getAtomicSaveReports()) {
      if (!report.warning) {
        announced.delete(path)
        continue
      }
      if (announced.get(path) === report.warning) continue
      announced.set(path, report.warning)
      host.webContents.send(
        VANTAGE_CHANNELS.saveWarning,
        `Saved ${parse(path).base}. ${report.warning}`,
      )
    }
  }, 2000)
  saveWarnings.unref()
  app.once('will-quit', () => clearInterval(saveWarnings))
  ipcMain.handle(VANTAGE_CHANNELS.cancelInspection, (event) => {
    hostFor(event)
    inspection?.abort()
  })
  ipcMain.handle(VANTAGE_CHANNELS.inspectFile, async (event) => {
    const host = hostFor(event)
    if (inspection || choosingInspection)
      throw new Error(
        'An inspection is already running. Cancel it before choosing another document.',
      )
    choosingInspection = true
    const selected = await dialog.showOpenDialog(host, {
      title: 'Inspect a document locally',
      properties: ['openFile'],
      filters: [
        {
          name: 'Supported documents',
          extensions: ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'markdown', 'html', 'htm'],
        },
      ],
    }).finally(() => { choosingInspection = false })
    if (selected.canceled || !selected.filePaths[0]) return null
    const controller = new AbortController()
    inspection = controller
    const aborted = () => controller.abort()
    host.webContents.once('destroyed', aborted)
    try {
      return await auditFileIsolated(selected.filePaths[0], { signal: controller.signal })
    } finally {
      if (inspection === controller) inspection = undefined
      host.webContents.removeListener('destroyed', aborted)
    }
  })
  ipcMain.handle(VANTAGE_CHANNELS.recoveryList, async (event) => {
    hostFor(event)
    return listRecoveryEntries(root)
  })
  ipcMain.handle(VANTAGE_CHANNELS.openMail, async (event) => {
    hostFor(event)
    requireRemoteFeature(currentNetworkPolicy(), 'mail')
    return openVantageMail({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      platform: process.platform,
    })
  })
  ipcMain.handle(VANTAGE_CHANNELS.recoveryRestoreCopy, async (event, id: unknown) => {
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
