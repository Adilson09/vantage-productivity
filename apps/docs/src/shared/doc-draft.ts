/** A document activation is distinct from an opened candidate or a save path. */
export interface DocDraftActivation {
  ok: boolean
  token?: string
  error?: string
}

export interface DocDraftWriteRequest {
  token: string
  sequence: number
  documentPath: string | null
  encrypted: boolean
  data: ArrayBuffer
}

export interface DocDraftSaveAcknowledgment {
  token: string
  throughSequence: number
  documentPath: string
  clean: boolean
}

export interface DocDraftResult {
  ok: boolean
  skipped?: boolean
  error?: string
}
