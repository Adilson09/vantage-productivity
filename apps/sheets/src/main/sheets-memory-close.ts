import { randomUUID } from 'node:crypto'
import type { CloseCleanupHandle, CloseCleanupStatus } from '../../../../packages/electron-utils/src/close-cleanup'
import type { CapturedNativeCloseAuthority } from './workbook-document-recovery'
import type { SheetsCleanupAdmission } from './sheets-close-coordinator'

/** Main-owned, nonpersistent quit ledger. Registration is synchronous; release waits actual work. */
export interface SheetsMemoryCloseLedger {
  holdUntilSettled(work: Promise<void>): void
  /** Protected failure stays a RAM-only quit veto until an exact retry succeeds. */
  holdProtectedRetirement?(work: Promise<void>, retry: () => Promise<void>): void
  report(error: unknown): void
}

/** Protected close never enters the disk-backed cleanup/provider service. */
export function beginSheetsMemoryClose(
  authority: CapturedNativeCloseAuthority,
  lineage: string,
  ledger: SheetsMemoryCloseLedger,
): SheetsCleanupAdmission {
  if (!authority.encrypted) throw new Error('Memory close requires a protected native authority.')
  const abort = new AbortController()
  let cancelled = false
  let removalAttempted = false
  let terminal = false
  let resolveOutcome!: (status: CloseCleanupStatus) => void
  const outcome = new Promise<CloseCleanupStatus>(resolve => { resolveOutcome = resolve })
  let status: CloseCleanupStatus = {
    id: randomUUID(), module: 'sheets', ownerKey: authority.ownerId,
    source: lineage, generation: authority.generation, token: authority.producer,
    documentPath: authority.originalPath, phase: 'preparing', custody: false,
    updatedAt: new Date().toISOString(),
  }
  const publish = (phase: CloseCleanupStatus['phase'], error?: string): void => {
    status = { ...status, phase, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) }
  }
  const finish = (phase: CloseCleanupStatus['phase'], error?: string): void => {
    if (terminal) return
    terminal = true
    publish(phase, error)
    resolveOutcome(structuredClone(status))
  }
  const cancel = (reason = 'Protected close cancelled.'): void => {
    if (removalAttempted || terminal) return
    cancelled = true
    abort.abort()
    finish('canceled', reason)
  }
  const handle: CloseCleanupHandle = {
    id: status.id, status: () => structuredClone(status), outcome, cancel,
    commitRemoval: remove => {
      if (cancelled || terminal || status.phase !== 'staged') return false
      removalAttempted = true
      publish('committing')
      let resolveRemoval!: (removed: boolean) => void
      const decision = new Promise<boolean>(resolve => { resolveRemoval = resolve })
      const actual = decision.then(async removed => {
        if (!removed) { finish('canceled', 'Actual removal was refused.'); return }
        publish('running')
        try {
          const retirement = authority.retireCapturedOnly(abort.signal)
          try {
            ledger.holdProtectedRetirement?.(retirement, () =>
              authority.retireCapturedOnly(new AbortController().signal))
          } catch (error) {
            // The enclosing actual promise was indexed before remove(). Even
            // a failed hook must not let it settle ahead of native retirement.
            await retirement.catch(() => undefined)
            throw error
          }
          await retirement
          finish('complete')
        } catch (error) {
          finish('retained', String(error))
          throw error
        }
      })
      // A quit triggered synchronously inside remove sees the actual pending native work.
      try { ledger.holdUntilSettled(actual) }
      catch (error) {
        resolveRemoval(false)
        finish('retained', 'The memory cleanup quit hold could not be registered.')
        ledger.report(error)
        return false
      }
      void actual.catch(error => ledger.report(error))
      try {
        const removed = remove()
        if (typeof removed !== 'boolean') throw new Error('Memory cleanup requires synchronous actual removal.')
        resolveRemoval(removed)
        return removed
      } catch (error) {
        resolveRemoval(false)
        throw error
      }
    },
  }
  const preparation = authority.ready.then(() => {
    if (cancelled || authority.cancelled) throw new Error('Protected close was cancelled.')
    const proof = authority.attest()
    if (!proof || proof.pending || proof.documentId !== authority.id || !proof.payloadSha256)
      throw new Error('The protected checkpoint acknowledgment is uncertain.')
    publish('staged')
    return handle
  })
  const ready = preparation.catch(error => { finish('retained', String(error)); throw error })
  const actualSettled = preparation.then(() => undefined, () => undefined)
  // This ledger must remain memory-only, including its error handling and status projections.
  try { ledger.holdUntilSettled(actualSettled) }
  catch (error) {
    cancel('The protected preparation quit hold could not be registered.')
    void ready.catch(failure => ledger.report(failure))
    throw error
  }
  return { ready, actualSettled, cancel }
}
