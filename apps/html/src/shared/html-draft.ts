/** Plain JSON/ArrayBuffer protocol for private HTML recovery; never publishes a normal file. */
export const HTML_DRAFT_MAX_BYTES = 16 * 1024 * 1024
export const HTML_DRAFT_MAX_ASSETS = 256
export const HTML_DRAFT_REMOTE_MARKER = 'vantage-html-recovery-remote-resources'
export interface HtmlDraftWriteRequest {
  token: string
  sequence: number
  revision: number
  documentPath: string | null
  data: ArrayBuffer
}
export interface HtmlDraftWriteResult {
  written: boolean
  remoteReferences: number
}
export interface HtmlDraftChange {
  token: string
  revision: number
  dirty: boolean
}
export interface HtmlDraftSaveAcknowledgment {
  token: string
  throughSequence: number
  revision: number
  documentPath: string | null
  clean: boolean
}
export interface HtmlDraftMaterialization {
  /** Close-proof mode only: past external executable responses are not sealed by this HTML. */
  unsealedExecutableReferences?:boolean
  bytes: Buffer
  remoteReferences: number
}
