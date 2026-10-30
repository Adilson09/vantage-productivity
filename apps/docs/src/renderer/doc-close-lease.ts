import { installDocInputReservations } from './doc-input-reservations'
import { batchAuthoredCells } from '../../../../packages/electron-utils/src/authored-cell'
import {
  isCloseLeaseTicket,
  type CloseLeaseTicket,
} from '../../../../packages/electron-utils/src/close-lease'
import {
  CloseMutationBarrier,
  installCloseInputFence,
} from '../../../../packages/electron-utils/src/renderer-close-barrier'

let sourceReader = () => '0'
const rendererIdentity = globalThis.crypto.randomUUID()
let retired=false
const liveBarrierSource=()=>retired ? `retired:${rendererIdentity}` : sourceReader()
let report = (error: unknown) => console.error('[docs close]', error)

export const docCloseBarrier = new CloseMutationBarrier({
  source: liveBarrierSource,
  claim: async (ticket) => {
    if (!window.desktop.claimDocCloseLease) throw new Error('The close lease bridge is unavailable.')
    return window.desktop.claimDocCloseLease(ticket)
  },
  cancel: async (ticket, reason) => {
    if (!window.desktop.cancelDocCloseLease) throw new Error('The close cancellation bridge is unavailable.')
    await window.desktop.cancelDocCloseLease(ticket, reason)
  },
  report: (error) => report(error),
})

export function setDocCloseSourceReader(reader: () => string): void { sourceReader = reader }
export function docMutationSource(): string { return sourceReader() }
export function isDocAuthoringActive(): boolean { return !retired }
export function retireDocAuthoring(): void { retired=true }
export function docSourceStamp(generation: number): string { return `${rendererIdentity}:${generation}` }
export function reportDocCloseError(error: unknown): void { report(error) }

/** Call only after beforeMutation/source work owns its cancellation acknowledgment. */
export function withDocSourceCommit<Result>(action: () => Result): Result {
  if (retired) throw new Error('The document owner was removed.')
  if (docCloseBarrier.locked) throw new Error('Source replacement is waiting for close cancellation.')
  return batchAuthoredCells(action)
}

export function assertDocMutationSource(source: string): void {
  if (retired || source !== sourceReader()) throw new Error('The document changed before the pending edit completed.')
}

export function guardDocAsync<Arguments extends unknown[], Result>(
  action: (...args: Arguments) => Promise<Result>,
  source = sourceReader(),
): (...args: Arguments) => Promise<Result> {
  return (...args) => docCloseBarrier.runAsyncMutation(() => {
    // Admission is an authored intent even before its first async result. A
    // replacement approved earlier must not retire this accepted writer.
    docCloseBarrier.mutate(() => {}, source)
    return action(...args)
  }, source)
}

export function installDocCloseLease(reportError: (error: unknown) => void): () => void {
  report = reportError
  const removeFence = installCloseInputFence(docCloseBarrier, document)
  const removeInputReservations = installDocInputReservations(docCloseBarrier,docMutationSource,(error)=>report(error))
  const unsubscribe = window.desktop.onDocCloseRelease?.((value) => {
    if (isCloseLeaseTicket(value)) docCloseBarrier.release(value)
  })
  return () => {
    removeFence()
    removeInputReservations()
    unsubscribe?.()
    const ticket = docCloseBarrier.ticket
    if (ticket) void window.desktop.cancelDocCloseLease(ticket, 'renderer disposed')
      .then(() => docCloseBarrier.release(ticket)).catch((error) => report(error))
  }
}

export async function releaseDocCloseAfterFailure(ticket: CloseLeaseTicket): Promise<void> {
  await window.desktop.cancelDocCloseLease(ticket, 'renderer close preparation failed')
  docCloseBarrier.release(ticket)
}
