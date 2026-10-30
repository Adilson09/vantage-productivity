/** Main-process boundary for the Rust document checkpoint authority. */
export interface DocumentSheet {
  readonly id: string
  readonly name: string
}

export type DocumentPayload = Record<string, unknown>

export interface NativeDocumentInfo {
  readonly apiVersion: 1
  readonly documentId: string
  readonly revision: number
  readonly sourceFingerprint: string
  readonly recovered: boolean
  readonly durable: boolean
}

export interface NativeDocumentReceipt {
  readonly apiVersion: 1
  readonly documentId: string
  readonly commandId: string
  readonly revision: number
  readonly durable: boolean
}

export interface NativeDocumentSnapshot {
  readonly apiVersion: 1
  readonly documentId: string
  readonly revision: number
  readonly sourceFingerprint: string
  readonly sheets: readonly DocumentSheet[]
  readonly payload: DocumentPayload
}

/** Unknown responses are checked before the coordinator acknowledges them. */
export interface DocumentNativeClient {
  openDocument(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly sourcePath: string
    readonly storePath?: string
    readonly sheets: readonly DocumentSheet[]
  }): Promise<unknown>
  checkpointDocument(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly commandId: string
    readonly expectedRevision: number
    readonly actor: string
    readonly payload: DocumentPayload
  }): Promise<unknown>
  documentSnapshot(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly revision?: number
  }): Promise<unknown>
  documentCommandResult(input: {
    readonly apiVersion: 1
    readonly documentId: string
    readonly commandId: string
  }): Promise<unknown>
  closeDocument(input: { readonly apiVersion: 1; readonly documentId: string }): Promise<unknown>
}
