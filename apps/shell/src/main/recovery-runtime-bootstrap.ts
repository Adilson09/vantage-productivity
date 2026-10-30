import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  initializeRecoveryRuntime,
  recoveryRuntimeState,
  requireRecoveryRuntime,
  queueRecoveryWarning,
  flushRecoveryWarnings,
  onRecoveryRuntimeState,
  type RecoveryBootstrapApp,
  type RecoveryRuntimePublicState,
} from '../../../../packages/electron-utils/src/recovery-bootstrap'
import type { CloseCleanupStatus } from '../../../../packages/electron-utils/src/close-cleanup'
import { VANTAGE_CHANNELS } from '../shared/vantage-api'

export interface RecoveryMaintenance {
  id: string
  matches(status: CloseCleanupStatus): boolean
  retry(status: CloseCleanupStatus): Promise<void>
}
/** Called after GUI profile and successful instance lock, BEFORE editor services.
 * Foundation failure is returned, never allowed to abort unrelated workspace Open.
 * PDF inventory has its own scope; failure does not disable unrelated recovery. */
export function initializeShellRecovery(options: {
  app: RecoveryBootstrapApp
  userDataRoot: string
  lockAcquired: boolean
  registerMaintenance(handler: RecoveryMaintenance): void
  inspectPdf(): Promise<void>
  retryPdf(id: string): Promise<void>
}): { state: RecoveryRuntimePublicState; inspection: Promise<void> } {
  const state = initializeRecoveryRuntime({
    app: options.app,
    userDataRoot: options.userDataRoot,
    mode: 'gui',
    lockAcquired: options.lockAcquired,
  })
  if (!state.available) return { state, inspection: Promise.resolve() }
  try {
    options.registerMaintenance({
      id: 'pdf-private-bases',
      matches: (status) =>
        status.module === 'pdf' && /^pdf-private:[0-9a-f-]{36}(?::[0-9a-f-]{36})?$/.test(status.id),
      retry: async (status) => {
        requireRecoveryRuntime('Private PDF recovery maintenance')
        await options.retryPdf(status.id)
      },
    })
  } catch {
    queueRecoveryWarning(
      'pdf-maintenance-registration',
      'Private PDF recovery cleanup is unavailable. Retained files were kept; open Recovery to review them.',
    )
  }
  const inspection = Promise.resolve()
    .then(() => {
      requireRecoveryRuntime('Private PDF recovery inspection')
      return options.inspectPdf()
    })
    .catch(() => {
      queueRecoveryWarning(
        'pdf-private-inspection',
        'Some private PDF recovery storage could not be inspected. Files were retained; open Recovery for review.',
      )
    })
  return { state, inspection }
}

/** One trusted Root host; no private root/token/source/hash crosses this channel.
 * Query also replays queued warnings AFTER preload subscribes, avoiding lost
 * did-finish-load/useEffect races. The persistent status stays queryable. */
export function registerRecoveryRuntimeIpc(options: {
  ipc: Pick<IpcMain, 'handle'>
  hostFor(event: IpcMainInvokeEvent): BrowserWindow
  getHost(): BrowserWindow | null
  terminal(cleanup: () => void): void
}): void {
  let subscribed: WebContents | null = null,
    ready = false
  const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) ready = false
  }
  const observe = (contents: WebContents) => {
    if (subscribed === contents) return
    subscribed?.removeListener('did-start-navigation', navigation)
    subscribed = contents
    ready = false
    contents.on('did-start-navigation', navigation)
  }
  const deliver = (message: string): boolean => {
    const host = options.getHost()
    if (
      !host ||
      host.isDestroyed() ||
      host.webContents.isDestroyed() ||
      host.webContents !== subscribed ||
      !ready ||
      host.webContents.isLoadingMainFrame()
    )
      return false
    host.webContents.send(VANTAGE_CHANNELS.saveWarning, message)
    return true
  }
  const unsubscribe = onRecoveryRuntimeState(() => flushRecoveryWarnings(deliver))
  options.terminal(() => {
    unsubscribe()
    subscribed?.removeListener('did-start-navigation', navigation)
    subscribed = null
    ready = false
  })
  options.ipc.handle(VANTAGE_CHANNELS.recoveryRuntimeStatus, (event) => {
    const host = options.hostFor(event)
    if (event.senderFrame !== event.sender.mainFrame)
      throw new Error('Recovery status is only available from the main workspace.')
    observe(host.webContents)
    ready = true // preload subscribes before invoking
    const before = recoveryRuntimeState()
    flushRecoveryWarnings(deliver)
    if (!before.available && before.phase !== 'disabled' && before.warningCount === 0)
      deliver(before.message)
    return recoveryRuntimeState()
  })
}
