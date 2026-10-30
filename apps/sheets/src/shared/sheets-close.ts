import type { CloseLeaseStamp, CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'

/** Main owns lineage; an owned publication may replace its reader session. */
export interface SheetsCloseSource {
  lineage: string
  sessionId: string
  openedSha256: string
  documentPath: string | null
}

export interface SheetsCloseState {
  source: SheetsCloseSource
  stamp: CloseLeaseStamp
  dirty: boolean
  busy: boolean
  protectedMemoryOnly: boolean
}

export interface SheetsCloseEnvelope {
  ticket: CloseLeaseTicket
  stamp: CloseLeaseStamp
  source: SheetsCloseSource
  /** Canonical complete accepted DocumentPayload; main binds it to the actual native ACK. */
  payloadSha256: string
}

export interface SheetsPrepareCloseRequest {
  ticket: CloseLeaseTicket
  intent: 'save' | 'discard'
  expectedSource: SheetsCloseSource
  /** The revision the caller explicitly approved discarding. Never refresh it after awaiting. */
  approvedStamp?: CloseLeaseStamp
  path?: string
  overwrite?: boolean
}

export interface SheetsPrepareCloseResult {
  current: boolean
  published: boolean
  clean: boolean
  intent: 'save' | 'discard'
  closeLease?: SheetsCloseEnvelope
  savedPath?: string
  error?: string
}

export interface SheetsNativeAuthorityProof {
  documentId: string
  producer: string
  generation: number
  revision: number
  sourceFingerprint: string
  protectedMemoryOnly: boolean
}

export interface SheetsCloseReceipt {
  /** Prepared holds the original120s reservation; only seal creates a5s ready grant. */
  phase: 'prepared' | 'ready'
  source: string
  intent: 'save' | 'discard'
  published: boolean
  clean: boolean
  closeLease: SheetsCloseEnvelope
  nativeAuthorities: readonly SheetsNativeAuthorityProof[]
  cleanup: { id: string; phase: string; custody: boolean }
  savedPath?: string
}

export function sameSheetsCloseSource(left: SheetsCloseSource, right: SheetsCloseSource): boolean {
  return left.lineage === right.lineage && left.sessionId === right.sessionId &&
    left.openedSha256 === right.openedSha256 && left.documentPath === right.documentPath
}
