import type { DocumentNativeClient } from './document-native-contract'

/** The client owns correlation to the exact request and spawned child. */
export interface AttestedDocumentRequestClient {
  requestAttested(command: Readonly<Record<string, unknown>>, timeoutMs?: number): {
    readonly result: Promise<unknown>
    readonly completion: Promise<unknown>
    readonly actualSettled: Promise<void>
  }
}

const ARCHIVE_TIMEOUT_MS = 180_000

/**
 * Recovery/captured authority queues advance only after a matching native reply
 * or a rejection backed by verified child exit/spawn failure. A bounded caller
 * result, failed stdin write, cancellation request or timer is not that proof.
 * This adapter adds no timeout/finally-based settlement and no worker protocol.
 */
export function createSettledDocumentNativeClient(client: AttestedDocumentRequestClient): DocumentNativeClient {
  const completed = async (command: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown> => {
    const operation = client.requestAttested(command, timeoutMs)
    // This consumer deliberately does not use the bounded result. Observe its
    // rejection without replacing the client-owned definitive completion.
    void operation.result.catch(() => undefined)
    return operation.completion
  }
  const adapter: DocumentNativeClient = {
    openDocument: input => completed({ command: 'open_document', ...input }, ARCHIVE_TIMEOUT_MS),
    checkpointDocument: input => completed({ command: 'checkpoint_document', ...input }, ARCHIVE_TIMEOUT_MS),
    documentSnapshot: input => completed({ command: 'document_snapshot', ...input }, ARCHIVE_TIMEOUT_MS),
    documentCommandResult: input => completed({ command: 'document_command_result', ...input }),
    closeDocument: input => completed({ command: 'close_document', ...input }),
  }
  return Object.freeze(adapter)
}
