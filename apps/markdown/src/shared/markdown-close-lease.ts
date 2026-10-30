import type { CloseCleanupStatus } from '../../../../packages/electron-utils/src/close-cleanup'
import type {
  CloseLeaseStamp,
  CloseLeaseTicket,
} from '../../../../packages/electron-utils/src/close-lease'
export interface MarkdownSourceState {
  stamp: CloseLeaseStamp
  path: string | null
  ready: boolean
  dirty: boolean
  pending: boolean
  busy: boolean
  composing: boolean
}
export interface MarkdownCloseLease {
  ticket: CloseLeaseTicket
  stamp: CloseLeaseStamp
}
export interface MarkdownAssetCleanupReport {
  assetCleanup?: { assets: 'retained' }
  warnings?: string[]
}
export interface MarkdownCloseReceipt extends MarkdownAssetCleanupReport {
  phase?: 'prepared' | 'ready'
  requestId: string
  published: boolean
  current: boolean
  clean: boolean
  path?: string
  closeLease?: MarkdownCloseLease
  error?: string
  journalCleanup?: CloseCleanupStatus
  cleanup?: {
    journal: 'staged' | 'running' | 'complete' | 'retained' | 'canceled'
    assets: 'none' | 'retained'
    retainedAssets?: number
  }
  warnings?: string[]
}

/** Main native/automated close authority is distinct from ordinary publication results. */
export type MarkdownNativeCloseReceipt = MarkdownCloseReceipt & { phase: 'prepared' | 'ready' }
