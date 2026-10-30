import { requireRecoveryRuntime } from '../../../../packages/electron-utils/src/recovery-bootstrap'
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { basename, extname } from 'node:path'
import {
  acknowledgeCloseCleanupRestoreArtifact, beginRetireCloseCleanupCustody, getCloseCleanupRetirementActivity,
  getCloseCleanupStatus, prepareCloseCleanupRestore, prepareProviderCloseCleanupRestore, queryCloseCleanupCustody,
} from '../../../../packages/electron-utils/src/close-cleanup-runtime'
import { registeredCloseCustodyProvider } from '../../../../packages/electron-utils/src/close-custody-providers'
import type { CloseCleanupStatus } from '../../../../packages/electron-utils/src/close-cleanup'
import { VANTAGE_CHANNELS } from '../shared/vantage-api'
import { createRetainedRecoveryController } from './retained-recovery-controller'

interface RetainedRecoveryMaintenance {
  id: string
  matches(status: CloseCleanupStatus): boolean
  retry(status: CloseCleanupStatus): Promise<void>
}
const maintenance = new Map<string, RetainedRecoveryMaintenance>()
/** App-owned status-only failures need their own checked repair; hiding a row is not cleanup. */
export function registerRetainedRecoveryMaintenance(handler: RetainedRecoveryMaintenance): void {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(handler.id) || maintenance.has(handler.id) || maintenance.size >= 32)
    throw new Error('Invalid or duplicate recovery maintenance registration.')
  maintenance.set(handler.id, Object.freeze({ ...handler }))
}
const repairFor = (status: CloseCleanupStatus) => [...maintenance.values()].find(handler => handler.matches(status))
const modules = ['docs', 'md', 'markdown', 'html', 'slides', 'pdf', 'sheets', 'recovery']
const extensions: Readonly<Record<string, string>> = {
  docs: '.docx', md: '.md', markdown: '.md', html: '.html', slides: '.pptx', pdf: '.vpdfdraft', sheets: '.xlsx',
}
const extensionFor = (module: string): string => extensions[module] ?? '.recovered'

export function registerRetainedRecoveryIpc(
  hostFor: (event: IpcMainInvokeEvent) => BrowserWindow,
  unlockRecovery: () => Promise<unknown>,
): void {
  const controller = createRetainedRecoveryController({
    list: () => { requireRecoveryRuntime('Retained recovery inspection'); return modules.flatMap(module => queryCloseCleanupCustody({ module })) },
    get: getCloseCleanupStatus,
    capabilities: status => {
      const busy = getCloseCleanupRetirementActivity(status.id).busy
      const providerId = status.custodyProvider ?? (status.custody ? 'draft-journal' : undefined)
      const provider = providerId && providerId !== 'draft-journal' ? registeredCloseCustodyProvider(providerId) : undefined
      return {
        restore: !busy && (providerId === 'draft-journal' || typeof provider?.restore === 'function'),
        remove: !busy && (providerId === 'draft-journal' || !!provider && (status.custody || typeof provider.purgePartial === 'function')),
        retry: !busy && !!repairFor(status),
      }
    },
    prepare: (status, destination) => (status.custodyProvider ?? 'draft-journal') === 'draft-journal'
      ? prepareCloseCleanupRestore(status.id, destination)
      : prepareProviderCloseCleanupRestore(status.id, destination),
    remove: status => beginRetireCloseCleanupCustody({ module: status.module, ids: [status.id] }, 'The user removed this selected recovery copy.').ready,
    retry: async status => {
      const repair = repairFor(status)
      if (!repair) throw new Error('No safe cleanup retry is available for this item yet.')
      await repair.retry(status)
    },
    keep: (status, outputId) => acknowledgeCloseCleanupRestoreArtifact(status.id, outputId),
  })
  ipcMain.handle(VANTAGE_CHANNELS.retainedRecoveryList, async event => {
    hostFor(event)
    return controller.list()
  })
  ipcMain.handle(VANTAGE_CHANNELS.recoverRetainedCopy, async (event, selection: unknown) => {
    hostFor(event)
    requireRecoveryRuntime('Retained recovery action')
    await unlockRecovery()
    const host = hostFor(event)
    return controller.recover(selection, async status => {
      const extension = extensionFor(status.module)
      const original = status.documentPath ? basename(status.documentPath) : 'document'
      const stem = original.slice(0, original.length - extname(original).length) || 'document'
      const result = await dialog.showSaveDialog(host, {
        title: status.module === 'pdf' ? 'Save a recovered PDF workspace' : 'Save a recovered copy',
        defaultPath: `Recovered ${stem}${extension}`,
        filters: [{ name: status.module === 'pdf' ? 'PDF workspace' : 'Recovered document', extensions: [extension.slice(1)] }],
      })
      hostFor(event)
      return result.canceled || !result.filePath ? null : result.filePath
    })
  })
  ipcMain.handle(VANTAGE_CHANNELS.removeRetainedCopy, async (event, selection: unknown) => {
    hostFor(event)
    requireRecoveryRuntime('Retained recovery action')
    await controller.remove(selection)
  })
  ipcMain.handle(VANTAGE_CHANNELS.retryRetainedRecovery, async (event, selection: unknown) => {
    hostFor(event)
    requireRecoveryRuntime('Retained recovery action')
    await controller.retry(selection)
  })
  ipcMain.handle(VANTAGE_CHANNELS.keepRetainedOutput, async (event, selection: unknown, outputId: unknown) => {
    hostFor(event)
    requireRecoveryRuntime('Retained recovery action')
    controller.keep(selection, outputId)
  })
}
