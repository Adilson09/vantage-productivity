import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { beginCloseCleanup } from '../../../../packages/electron-utils/src/close-cleanup-runtime'
import { registerCloseCustodyProvider, type CloseCustodyProvider } from '../../../../packages/electron-utils/src/close-custody-providers'
import { requireRecoveryRuntime } from '../../../../packages/electron-utils/src/recovery-bootstrap'
import type { CloseCleanupAdmission, CloseCleanupTask } from '../../../../packages/electron-utils/src/close-cleanup'
import { createNativeCloseCustodyProvider, type NativeCloseCustodyProvider, type NativeCustodyLineage } from '../../../sheets/src/main/native-close-custody'
import { beginSheetsMemoryClose, type SheetsMemoryCloseLedger } from '../../../sheets/src/main/sheets-memory-close'
import type { SheetsCloseRuntime } from '../../../sheets/src/main/sheets-main'
import type { SheetsCloseState } from '../../../sheets/src/shared/sheets-close'
import type { SheetsCleanupAdmission } from '../../../sheets/src/main/sheets-close-coordinator'
import type { CapturedNativeCloseAuthority } from '../../../sheets/src/main/workbook-document-recovery'

export interface SheetsRuntimeQuitLedger extends SheetsMemoryCloseLedger {
  holdProtectedRetirement(work: Promise<void>, retry: () => Promise<void>): void
}

export interface SheetsCloseRuntimeInstallationOptions {
  ledger: SheetsRuntimeQuitLedger
  /** Root supplies the actual Sheets setter after recovery bootstrap, before GUI services. */
  setRuntime(runtime: SheetsCloseRuntime): void
  /** Actual main-owned Sheets state. Never a group isCurrent/receipt predicate. */
  closeState(owner: WebContents): SheetsCloseState | null
}

export interface SheetsCloseRuntimeInstallation {
  readonly runtime: SheetsCloseRuntime
  /** Main-only data restore seam; it conveys no imported close permission. */
  readonly provider: NativeCloseCustodyProvider
}

export interface SheetsCloseRuntimeDependencies {
  createProvider(): NativeCloseCustodyProvider
  registerProvider(provider: CloseCustodyProvider): void
  beginPersistent(task: CloseCleanupTask): CloseCleanupAdmission
  beginMemory(authority: CapturedNativeCloseAuthority, lineage: string, ledger: SheetsMemoryCloseLedger): SheetsCleanupAdmission
  requireRecovery(operation: string): void
  uuid(): string
}

const CAPTURE_TIMEOUT_MS = 120_000

/** Separate installer factory keeps the real production startup adapter testable without Electron. */
export function createSheetsCloseRuntimeInstaller(dependencies: SheetsCloseRuntimeDependencies) {
  let nativeProvider: NativeCloseCustodyProvider | undefined
  let registration: CloseCustodyProvider | undefined
  let installed: SheetsCloseRuntimeInstallation | undefined
  let installedOptions: SheetsCloseRuntimeInstallationOptions | undefined

  return (options: SheetsCloseRuntimeInstallationOptions): SheetsCloseRuntimeInstallation => {
    if (installed) {
      if (options.ledger !== installedOptions!.ledger || options.setRuntime !== installedOptions!.setRuntime || options.closeState !== installedOptions!.closeState)
        throw new Error('Sheets close runtime already belongs to another main host or quit ledger.')
      return installed
    }
    nativeProvider ??= dependencies.createProvider()
    const provider = nativeProvider
    if (!registration) {
      // This extends only bounded preparation I/O. The coordinator's original
      // preparing/ready lease deadlines and actual-settlement rules are unchanged.
      const candidate: CloseCustodyProvider = { ...provider, captureTimeoutMs: CAPTURE_TIMEOUT_MS }
      dependencies.registerProvider(candidate)
      registration = candidate
    }
    const assertOwner = (owner: WebContents, authority: CapturedNativeCloseAuthority) => {
      if (owner.isDestroyed() || authority.ownerId !== String(owner.id) || authority.cancelled)
        throw new Error('The close cleanup authority no longer belongs to this exact live Sheets owner.')
    }
    const runtime: SheetsCloseRuntime = {
      stagePersistent: (owner, lineage, authority) => {
        // Never even mint an opaque persistent input for protected memory.
        if (authority.encrypted) throw new Error('Protected Sheets close must use its memory-only stage.')
        assertOwner(owner, authority)
        dependencies.requireRecovery('Sheets close snapshot custody')
        const exact: NativeCustodyLineage = Object.freeze({ id: dependencies.uuid(), module: 'sheets',
          ownerKey: authority.ownerId, source: lineage, generation: authority.generation,
          token: authority.producer, documentPath: authority.originalPath })
        const admission = dependencies.beginPersistent({ ...exact,
          custody: { provider: provider.id, input: provider.captureInput(authority, exact) },
          ready: authority.ready,
          run: signal => {
            // The shared queue's bounded execution outcome is not a native I/O
            // finalizer. Keep the actual provider promise in the memory ledger.
            const actual = provider.runCaptured(authority, signal)
            options.ledger.holdUntilSettled(actual)
            return actual
          },
        })
        // Includes real capture/admission finalizers even after ready times out.
        options.ledger.holdUntilSettled(admission.actualSettled)
        return admission
      },
      stageMemory: (owner, lineage, authority) => {
        if (!authority.encrypted) throw new Error('Memory-only Sheets close requires a protected authority.')
        assertOwner(owner, authority)
        // Do not require/read/status/stage the shared disk runtime here. This
        // path remains available when persistent recovery bootstrap failed.
        return dependencies.beginMemory(authority, lineage, options.ledger)
      },
      holdNativeUntilSettled: (_owner, actual) => options.ledger.holdUntilSettled(actual),
      coverageComplete: owner => !!installed && !!registration && !owner.isDestroyed() && options.closeState(owner) !== null,
    }
    options.setRuntime(runtime)
    installedOptions = options
    installed = Object.freeze({ runtime, provider })
    return installed
  }
}

const productionInstaller = createSheetsCloseRuntimeInstaller({
  createProvider: createNativeCloseCustodyProvider,
  registerProvider: registerCloseCustodyProvider,
  beginPersistent: beginCloseCleanup,
  beginMemory: beginSheetsMemoryClose,
  requireRecovery: requireRecoveryRuntime,
  uuid: randomUUID,
})

/** Call after initializeShellRecovery and the memory quit guard, before GUI editor services. */
export function installSheetsCloseRuntime(options: SheetsCloseRuntimeInstallationOptions): SheetsCloseRuntimeInstallation {
  return productionInstaller(options)
}
