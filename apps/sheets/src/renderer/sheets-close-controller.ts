import type {
  CloseLeaseStamp,
  CloseLeaseTicket,
} from '../../../../packages/electron-utils/src/close-lease'
import type { CloseMutationBarrier } from '../../../../packages/electron-utils/src/renderer-close-barrier'
import {
  sameSheetsCloseSource,
  type SheetsCloseEnvelope,
  type SheetsCloseSource,
  type SheetsCloseState,
  type SheetsPrepareCloseRequest,
  type SheetsPrepareCloseResult,
} from '../shared/sheets-close'

export interface SheetsPublicationFence {
  readonly source: SheetsCloseSource
  readonly stamp: CloseLeaseStamp
  readonly payloadSha256: string
  /** Check immediately BEFORE renderer rebase and main's old-reader release. */
  canAdopt(): boolean
}

export interface SheetsClosePublication {
  /** Bytes are known to have reached the requested destination. */
  readonly published: boolean
  /** A coherent owned replacement was adopted through canAdopt(). */
  readonly adopted: boolean
  readonly savedPath?: string
  readonly error?: string
}

export interface SheetsAcceptedRecovery {
  readonly source: SheetsCloseSource
  readonly stamp: CloseLeaseStamp
  readonly payloadSha256: string
}

export interface SheetsCloseControllerOptions {
  readonly barrier: CloseMutationBarrier
  /** Read synchronous canonical refs, never a delayed React projection. */
  current(): SheetsCloseState | null
  /** Canonical complete 28-family payload hash; null while not coherent/available. */
  authoredPayloadSha256(): string | null
  /** Drain ALL accepted authored work and publication, including post-await commits. */
  settleWork(): Promise<void>
  /** False until every authored producer and the native acceptance link are audited. */
  coverageComplete(): boolean
  save(
    request: SheetsPrepareCloseRequest,
    fence: SheetsPublicationFence,
  ): Promise<SheetsClosePublication>
  /**
   * Under the held barrier, force the complete document checkpoint and reconcile
   * unknown ACKs. Main must bind the actual native ACK, source and payload hash
   * to this owner/ticket/stamp; a renderer echo is not native acceptance proof.
   */
  flushAcceptedRecovery(
    expected: SheetsAcceptedRecovery,
    ticket: CloseLeaseTicket,
  ): Promise<SheetsAcceptedRecovery>
  /** Resolves only when main has revoked this exact close permission. */
  cancel(ticket: CloseLeaseTicket, reason: string): Promise<void>
  /** Invalidate the canonical source synchronously before an explicit open awaits. */
  invalidateSource(): void
}

export interface SheetsCloseController {
  state(): SheetsCloseState | null
  prepare(request: SheetsPrepareCloseRequest): Promise<SheetsPrepareCloseResult>
  release(ticket: CloseLeaseTicket): void
  invalidateSourceBeforeOpen(): Promise<void>
  /** Call after draining accepted work, before ordinary save snapshots its payload. */
  capturePublicationFence(): SheetsPublicationFence | null
}

interface Preparation {
  readonly request: SheetsPrepareCloseRequest
  readonly signature: string
  readonly epoch: number
  promise: Promise<SheetsPrepareCloseResult>
  published: boolean
  settled: boolean
  cancelled: boolean
  leaseIssued: boolean
  savedPath?: string
}

const sameStamp = (left: CloseLeaseStamp, right: CloseLeaseStamp): boolean =>
  left.source === right.source && left.revision === right.revision
const sameTicket = (left: CloseLeaseTicket, right: CloseLeaseTicket): boolean =>
  left.id === right.id && left.sequence === right.sequence && left.source === right.source
const copySource = (source: SheetsCloseSource): SheetsCloseSource => ({ ...source })
const copyStamp = (stamp: CloseLeaseStamp): CloseLeaseStamp => ({ ...stamp })
const copyRequest = (request: SheetsPrepareCloseRequest): SheetsPrepareCloseRequest => ({
  ticket: { ...request.ticket },
  intent: request.intent,
  expectedSource: copySource(request.expectedSource),
  ...(request.approvedStamp === undefined
    ? {}
    : { approvedStamp: copyStamp(request.approvedStamp) }),
  ...(request.path === undefined ? {} : { path: request.path }),
  ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite }),
})
const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000)

/**
 * Source-only proposal: this controller is safe only with audited synchronous
 * authored setters, accepted-work draining and the sender-bound native ACK seam.
 */
export function createSheetsCloseController(
  options: SheetsCloseControllerOptions,
): SheetsCloseController {
  let epoch = 0
  let active: Preparation | null = null

  const state = (): SheetsCloseState | null => {
    const current = options.current()
    return current === null
      ? null
      : {
          ...current,
          source: copySource(current.source),
          stamp: copyStamp(current.stamp),
          busy: current.busy || options.barrier.busy,
        }
  }
  const payloadHash = (): string | null => {
    const value = options.authoredPayloadSha256()
    return value !== null && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null
  }
  const sameCaptured = (
    expected: SheetsCloseState,
    capturedEpoch: number,
    expectedHash: string,
  ): boolean => {
    const current = state()
    return (
      capturedEpoch === epoch &&
      options.coverageComplete() &&
      current !== null &&
      !current.busy &&
      current.dirty === expected.dirty &&
      current.protectedMemoryOnly === expected.protectedMemoryOnly &&
      sameSheetsCloseSource(current.source, expected.source) &&
      sameStamp(current.stamp, expected.stamp) &&
      payloadHash() === expectedHash
    )
  }
  const capturePublicationFence = (): SheetsPublicationFence | null => {
    const captured = state()
    if (!captured || captured.busy || !options.coverageComplete()) return null
    const capturedHash = payloadHash()
    if (capturedHash === null) return null
    const capturedEpoch = epoch
    return {
      source: copySource(captured.source),
      stamp: copyStamp(captured.stamp),
      payloadSha256: capturedHash,
      canAdopt: () => sameCaptured(captured, capturedEpoch, capturedHash),
    }
  }
  const currentFor = (preparation: Preparation): SheetsCloseState | null => {
    const current = state()
    return preparation.epoch === epoch &&
      current?.source.lineage === preparation.request.expectedSource.lineage
      ? current
      : null
  }
  const release = (ticket: CloseLeaseTicket): void => {
    options.barrier.release(ticket)
    if (active && sameTicket(active.request.ticket, ticket)) {
      active.cancelled = true
      if (active.settled) active = null
    }
  }
  const cancel = async (ticket: CloseLeaseTicket, reason: string): Promise<void> => {
    // No local expiry/unlock: the acknowledgment must precede permission release.
    await options.cancel(ticket, reason)
    release(ticket)
  }
  const refused = async (
    preparation: Preparation,
    reason: string,
  ): Promise<SheetsPrepareCloseResult> => {
    let error = reason
    try {
      await cancel(preparation.request.ticket, reason)
    } catch (failure) {
      error += ` Close cancellation remains unconfirmed: ${describe(failure)}`
    }
    const current = currentFor(preparation)
    return {
      current: current !== null,
      published: preparation.published,
      clean: current !== null && !current.dirty,
      intent: preparation.request.intent,
      ...(preparation.savedPath === undefined ? {} : { savedPath: preparation.savedPath }),
      error,
    }
  }
  const preparing = (preparation: Preparation): boolean =>
    active === preparation && !preparation.cancelled && preparation.epoch === epoch
  const held = (preparation: Preparation): boolean => {
    const ticket = options.barrier.ticket
    return (
      preparing(preparation) && ticket !== null && sameTicket(ticket, preparation.request.ticket)
    )
  }

  const run = async (preparation: Preparation): Promise<SheetsPrepareCloseResult> => {
    const request = preparation.request
    try {
      const initial = state()
      if (
        !preparing(preparation) ||
        !initial ||
        !sameSheetsCloseSource(initial.source, request.expectedSource)
      )
        return await refused(preparation, 'The document source changed before close preparation.')
      if (!options.coverageComplete())
        return await refused(
          preparation,
          'Authored mutation coverage or native checkpoint attestation is incomplete.',
        )
      if (
        request.intent === 'discard' &&
        (!request.approvedStamp || !sameStamp(initial.stamp, request.approvedStamp))
      )
        return await refused(
          preparation,
          'Discard requires the exact revision approved by the caller.',
        )
      const approvedPayloadHash = request.intent === 'discard' ? payloadHash() : null
      if (request.intent === 'discard' && approvedPayloadHash === null)
        return await refused(preparation, 'The approved discard payload is not coherent.')

      await options.settleWork()
      let captured = currentFor(preparation)
      if (!preparing(preparation) || !captured || captured.busy || !options.coverageComplete())
        return await refused(
          preparation,
          'The document changed or still has accepted work while preparing close.',
        )
      // Discard approval never follows a newer source or a newer revision.
      if (
        request.intent === 'discard' &&
        (!sameSheetsCloseSource(captured.source, request.expectedSource) ||
          !sameStamp(captured.stamp, request.approvedStamp!) ||
          payloadHash() !== approvedPayloadHash)
      )
        return await refused(
          preparation,
          'The approved discard revision changed while waiting for accepted work.',
        )

      if (request.intent === 'save' && (captured.dirty || request.path !== undefined)) {
        const fence = capturePublicationFence()
        if (!fence)
          return await refused(preparation, 'A coherent publication snapshot is unavailable.')
        const publication = await options.save(request, fence)
        preparation.published = publication.published
        if (publication.savedPath !== undefined) preparation.savedPath = publication.savedPath
        captured = currentFor(preparation)
        if (!preparing(preparation) || !publication.published || !publication.adopted || !captured)
          return await refused(
            preparation,
            publication.error ?? 'The save did not adopt a coherent current document.',
          )
        if (captured.dirty || captured.busy)
          return await refused(
            preparation,
            'An earlier revision was published; later accepted edits remain pending.',
          )
      }

      const expected = captured
      const expectedHash = request.intent === 'discard' ? approvedPayloadHash : payloadHash()
      if (
        !expected ||
        expectedHash === null ||
        expected.busy ||
        (request.intent === 'save' && expected.dirty)
      )
        return await refused(preparation, 'The document is not ready to close.')
      const validate = () =>
        preparing(preparation) &&
        sameCaptured(expected, preparation.epoch, expectedHash) &&
        (request.intent === 'discard'
          ? sameStamp(expected.stamp, request.approvedStamp!) &&
            sameSheetsCloseSource(expected.source, request.expectedSource)
          : !state()!.dirty)
      const acquired = await options.barrier.acquire(request.ticket, validate)
      if (!acquired || !sameStamp(acquired, expected.stamp) || !held(preparation) || !validate())
        return await refused(preparation, 'The document changed while locking close preparation.')

      const accepted = await options.flushAcceptedRecovery(
        {
          source: copySource(expected.source),
          stamp: copyStamp(expected.stamp),
          payloadSha256: expectedHash,
        },
        { ...request.ticket },
      )
      if (
        !held(preparation) ||
        !validate() ||
        !sameSheetsCloseSource(accepted.source, expected.source) ||
        !sameStamp(accepted.stamp, expected.stamp) ||
        accepted.payloadSha256 !== expectedHash
      )
        return await refused(
          preparation,
          'The native checkpoint did not attest the exact prepared document revision.',
        )

      const envelope: SheetsCloseEnvelope = {
        ticket: { ...request.ticket },
        stamp: copyStamp(expected.stamp),
        source: copySource(expected.source),
        payloadSha256: expectedHash,
      }
      preparation.leaseIssued = true
      // Keep both the input lock and exact ticket alive until main commits or cancels.
      return {
        current: true,
        published: preparation.published,
        clean: !expected.dirty,
        intent: request.intent,
        closeLease: envelope,
        ...(preparation.savedPath === undefined ? {} : { savedPath: preparation.savedPath }),
      }
    } catch (error) {
      return await refused(preparation, describe(error))
    }
  }

  return {
    state,
    capturePublicationFence,
    prepare(request) {
      // A barrier-authored mutation can finish its correlated cancellation
      // without a separate release event reaching this controller first.
      if (active?.settled && active.leaseIssued) {
        const ticket = options.barrier.ticket
        if (!ticket || !sameTicket(ticket, active.request.ticket)) active = null
      }
      const copied = copyRequest(request)
      const signature = JSON.stringify(copied)
      if (
        active &&
        sameTicket(active.request.ticket, copied.ticket) &&
        active.signature === signature
      )
        return active.promise
      const preparation: Preparation = {
        request: copied,
        signature,
        epoch,
        published: false,
        settled: false,
        cancelled: false,
        leaseIssued: false,
        promise: Promise.resolve(null as unknown as SheetsPrepareCloseResult),
      }
      if (active)
        return refused(
          preparation,
          'Another close request is still preparing or holding permission.',
        )
      active = preparation
      preparation.promise = Promise.resolve()
        .then(() => run(preparation))
        .finally(() => {
          preparation.settled = true
          if (preparation.cancelled && active === preparation) active = null
        })
      return preparation.promise
    },
    release,
    async invalidateSourceBeforeOpen() {
      const ticket = active?.request.ticket ?? options.barrier.ticket
      // This synchronous invalidation happens before cancellation, fonts, dialogs or I/O await.
      epoch++
      options.invalidateSource()
      if (ticket)
        await cancel(ticket, 'A new explicit document open invalidated the old close source.')
    },
  }
}
