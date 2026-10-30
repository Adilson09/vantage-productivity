import { cancelCloseCleanupQuitDrain } from '../../../../packages/electron-utils/src/close-cleanup-runtime'
import {
  installSheetsCloseRuntime,
  type SheetsCloseRuntimeInstallationOptions,
} from '../../../shell/src/main/sheets-close-runtime'
import {
  installSheetsCloseQuitGuard,
  SheetsCloseQuitLedger,
  type SheetsQuitApp,
} from '../../../shell/src/main/sheets-close-quit-ledger'

export interface StandaloneSheetsCloseRuntimeOptions {
  mode: 'gui' | 'headless-export'
  lockAcquired: boolean
  app: SheetsQuitApp
  setRuntime: SheetsCloseRuntimeInstallationOptions['setRuntime']
  closeState: SheetsCloseRuntimeInstallationOptions['closeState']
  initializeShared(): void
  startEditors(): void
  resetShutdown(): void
  warning(message: string): void
  onBlocked(retry: () => Promise<void>): void
}

export interface StandaloneSheetsCloseRuntime {
  cancel(): void
  readonly ledger: SheetsCloseQuitLedger
}

export interface StandaloneSheetsCloseRuntimeDependencies {
  createLedger(options: { report(error: unknown): void }): SheetsCloseQuitLedger
  installGuard: typeof installSheetsCloseQuitGuard
  installRuntime(options: SheetsCloseRuntimeInstallationOptions): unknown
  cancelSharedQuitDrain(): void
}

/** Factory injection keeps startup-order tests independent of Electron/Main. */
export function createStandaloneSheetsCloseRuntimeInitializer(
  dependencies: StandaloneSheetsCloseRuntimeDependencies,
) {
  let initialized: {
    options: StandaloneSheetsCloseRuntimeOptions
    control: StandaloneSheetsCloseRuntime
  } | undefined

  return (options: StandaloneSheetsCloseRuntimeOptions): StandaloneSheetsCloseRuntime | null => {
    // Headless work and the process that lost the profile lock must not create
    // shared recovery, custody providers, ledgers, quit listeners, or editors.
    if (options.mode !== 'gui' || !options.lockAcquired) return null
    if (initialized) {
      if (initialized.options.app !== options.app || initialized.options.setRuntime !== options.setRuntime ||
        initialized.options.closeState !== options.closeState)
        throw new Error('Standalone Sheets close runtime already belongs to another main host.')
      return initialized.control
    }

    const warning = (message: string): void => {
      try { options.warning(message) } catch { /* No fallback logger for protected errors. */ }
    }
    try { options.initializeShared() }
    catch { warning('Spreadsheet recovery could not be initialized. Close checks may be unavailable.') }
    let epoch = 1
    const cancellations = new Set<() => void>()
    const ledger = dependencies.createLedger({
      report: () => warning('Spreadsheet background work did not complete.'),
    })
    const cancel = (): void => {
      epoch++
      for (const listener of [...cancellations]) {
        try { listener() } catch { warning('The spreadsheet quit request could not be fully canceled.') }
      }
      try { dependencies.cancelSharedQuitDrain() }
      catch { warning('The spreadsheet cleanup quit request could not be canceled.') }
      try { options.resetShutdown() }
      catch { warning('The spreadsheet shutdown state could not be reset.') }
    }
    const control: StandaloneSheetsCloseRuntime = Object.freeze({ cancel, ledger })
    initialized = { options, control }

    let guarded = false
    try {
      dependencies.installGuard(options.app, ledger, {
        epoch: () => epoch,
        isCurrent: expected => expected === epoch,
        subscribeCancel: listener => {
          cancellations.add(listener)
          return () => { cancellations.delete(listener) }
        },
        onBlocked: () => {
          // Failure after removal is not permission to quit. Cleanup can be
          // retried explicitly, but this old quit intention remains canceled.
          cancel()
          try { options.onBlocked(() => ledger.retryFailed()) }
          catch { warning('Protected spreadsheet cleanup is incomplete. Keep the application open.') }
        },
        report: () => warning('Spreadsheet quit preparation did not complete.'),
      })
      guarded = true
    } catch {
      warning('Spreadsheet close protection could not be initialized. Keep the application open.')
    }
    if (guarded) {
      try {
        // Production installs the real provider plus its promise-only native
        // work observer before exposing the runtime to any editor services.
        dependencies.installRuntime({ ledger, setRuntime: options.setRuntime, closeState: options.closeState })
      } catch {
        warning('Spreadsheet close protection could not be installed. Keep the application open.')
      }
    }
    // Missing/failed runtime installation leaves main close coverage closed;
    // the GUI can still explain the failure and preserve the live workbook.
    options.startEditors()
    return control
  }
}

const initializeProduction = createStandaloneSheetsCloseRuntimeInitializer({
  createLedger: options => new SheetsCloseQuitLedger(options),
  installGuard: installSheetsCloseQuitGuard,
  installRuntime: installSheetsCloseRuntime,
  cancelSharedQuitDrain: cancelCloseCleanupQuitDrain,
})

export function initializeStandaloneSheetsCloseRuntime(
  options: StandaloneSheetsCloseRuntimeOptions,
): StandaloneSheetsCloseRuntime | null {
  return initializeProduction(options)
}
