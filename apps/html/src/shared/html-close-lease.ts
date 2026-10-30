import type {CloseCleanupStatus} from '../../../../packages/electron-utils/src/close-cleanup'
import type { CloseLeaseStamp, CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
export interface HtmlSourceState { stamp: CloseLeaseStamp; path: string | null; ready: boolean; dirty: boolean; pending: boolean; busy: boolean; composing: boolean }
export interface HtmlCloseLease { ticket: CloseLeaseTicket; stamp: CloseLeaseStamp }
export interface HtmlAssetCleanupReport {assetCleanup?:{assets:'retained'};warnings?:string[]}
export interface HtmlCloseReceipt extends HtmlAssetCleanupReport { phase?:'prepared'|'ready'; requestId: string; published: boolean; current: boolean; clean: boolean; path?: string; closeLease?: HtmlCloseLease; error?: string; previewProof?:string; journalCleanup?:CloseCleanupStatus;cleanup?:{journal:'staged'|'running'|'complete'|'retained'|'canceled';assets:'none'|'retained';retainedAssets?:number};warnings?:string[]; readOnlyPresentation?:number; draft?: {token:string;revision:number;throughSequence:number;documentPath:string|null} }

/** Main native/automated close authority is distinct from ordinary publication results. */
export type HtmlNativeCloseReceipt=HtmlCloseReceipt&{phase:'prepared'|'ready'}
