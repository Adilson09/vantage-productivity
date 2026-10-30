import type { RenderSlide } from '@vantage/pptx-render'
import type {
  CloseLeaseTicket,
  CloseLeaseStamp,
} from '../../../../packages/electron-utils/src/close-lease'
export type SlidesCloseIntent = 'save' | 'discard'
export interface SlidesToolSaveRequest {
  requestId: string
  path: string
  requireClean: boolean
  sourceToken: string | null
  intent: SlidesCloseIntent
  sourceIdentity: string
  closeLease?: CloseLeaseTicket
  approvedStamp?: CloseLeaseStamp
}
export interface SlidesToolSaveIdentity {
  requestId: string
  sourceToken: string
}
export interface SlidesToolSaveProbe {
  current: boolean
  revision: string
  dirty: boolean
}
export interface SlidesToolSaveWriteResult {
  ok: boolean
  path: string
  dirty?: boolean
  slides?: RenderSlide[]
  error?: string
}
export interface SlidesToolSaveResult extends SlidesToolSaveIdentity {
  published: boolean
  current: boolean
  clean: boolean
  revision: string
  stamp?: CloseLeaseStamp
  throughSequence?: number
  error?: string
}
export interface SlidesToolSaveCompletion extends SlidesToolSaveResult {
  phase?: 'prepared' | 'ready'
  path: string
  closeLease?: CloseLeaseTicket
  cleanupId?: string
  intent?: SlidesCloseIntent
}
export interface SlidesCloseQuery {
  id: string
  stamp: CloseLeaseStamp
  dirty: boolean
  pending: boolean
  unsupported?: string
}

export type SlidesNativeCloseReceipt = SlidesToolSaveCompletion & { phase: 'prepared' | 'ready' }
