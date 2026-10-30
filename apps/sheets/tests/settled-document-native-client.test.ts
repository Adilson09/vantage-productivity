import { describe, expect, it, vi } from 'vitest'
import {
  createSettledDocumentNativeClient,
  type AttestedDocumentRequestClient,
} from '../src/main/settled-document-native-client'
import type { DocumentNativeClient } from '../src/main/document-native-contract'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
function nativeOperation() {
  const result = deferred<unknown>(),
    completion = deferred<unknown>(),
    actual = deferred<void>()
  return {
    result,
    completion,
    actual,
    admission: {
      result: result.promise,
      completion: completion.promise,
      actualSettled: actual.promise,
    },
  }
}
const documentId = '10000000-0000-4000-8000-000000000001'
const commandId = '20000000-0000-4000-8000-000000000001'
const open = {
  apiVersion: 1 as const,
  documentId,
  sourcePath: 'C:/synthetic/pinned-base.xlsx',
  storePath: 'C:/synthetic/journal.sqlite',
  sheets: [{ id: 'sheet-1', name: 'Résumé' }],
}
const checkpoint = {
  apiVersion: 1 as const,
  documentId,
  commandId,
  expectedRevision: 8,
  actor: 'desktop',
  payload: { edits: [{ sheet: 'sheet-1', row: 0, col: 0, value: 'line one\nline two' }] },
}

describe('document authority definitive-native adapter', () => {
  it.each([
    {
      command: 'open_document',
      input: open,
      timeout: 180_000,
      invoke: (client: DocumentNativeClient) => client.openDocument(open),
    },
    {
      command: 'checkpoint_document',
      input: checkpoint,
      timeout: 180_000,
      invoke: (client: DocumentNativeClient) => client.checkpointDocument(checkpoint),
    },
    {
      command: 'document_snapshot',
      input: { apiVersion: 1, documentId, revision: 9 },
      timeout: 180_000,
      invoke: (client: DocumentNativeClient) =>
        client.documentSnapshot({ apiVersion: 1, documentId, revision: 9 }),
    },
    {
      command: 'document_command_result',
      input: { apiVersion: 1, documentId, commandId },
      timeout: undefined,
      invoke: (client: DocumentNativeClient) =>
        client.documentCommandResult({ apiVersion: 1, documentId, commandId }),
    },
    {
      command: 'close_document',
      input: { apiVersion: 1, documentId },
      timeout: undefined,
      invoke: (client: DocumentNativeClient) => client.closeDocument({ apiVersion: 1, documentId }),
    },
  ])(
    'uses the existing $command fields/deadline and returns its definitive raw response',
    async (test) => {
      const operation = nativeOperation(),
        request = vi.fn(() => operation.admission)
      const client = createSettledDocumentNativeClient({ requestAttested: request })
      const pending = test.invoke(client),
        reply = { syntheticRawNativeResponse: test.command }
      expect(request).toHaveBeenCalledWith({ command: test.command, ...test.input }, test.timeout)
      operation.result.resolve(reply)
      operation.completion.resolve(reply)
      operation.actual.resolve()
      expect(await pending).toBe(reply)
    },
  )

  it('keeps a checkpoint pending after the bounded timeout and preserves a late matching acknowledgment', async () => {
    const operation = nativeOperation(),
      client = createSettledDocumentNativeClient({ requestAttested: () => operation.admission })
    let settled = false
    const pending = client.checkpointDocument(checkpoint).then((value) => {
      settled = true
      return value
    })
    operation.result.reject(new Error('bounded caller timed out'))
    await flush()
    expect(settled).toBe(false)
    const receipt = { apiVersion: 1, documentId, commandId, revision: 9, durable: true }
    operation.completion.resolve(receipt)
    operation.actual.resolve()
    expect(await pending).toBe(receipt)
  })

  it('propagates the definitive native error rather than a previous caller timeout', async () => {
    const operation = nativeOperation(),
      client = createSettledDocumentNativeClient({ requestAttested: () => operation.admission })
    const pending = client.documentSnapshot({ apiVersion: 1, documentId, revision: 9 })
    operation.result.reject(new Error('bounded caller timed out'))
    await flush()
    const definitive = Object.assign(new Error('Native revision no longer exists.'), {
      code: 'stale_revision',
    })
    operation.completion.reject(definitive)
    operation.actual.resolve()
    await expect(pending).rejects.toBe(definitive)
  })

  it('rejects retirement on verified child exit and never manufactures a successful close acknowledgment', async () => {
    const operation = nativeOperation(),
      client = createSettledDocumentNativeClient({ requestAttested: () => operation.admission })
    let retired = false
    const pending = client.closeDocument({ apiVersion: 1, documentId }).then(() => {
      retired = true
    })
    operation.result.reject(new Error('stdin write failed; child still unconfirmed'))
    await flush()
    expect(retired).toBe(false)
    const exited = Object.assign(new Error('The exact child has now exited.'), {
      code: 'sidecar_exited',
    })
    operation.completion.reject(exited)
    operation.actual.resolve()
    await expect(pending).rejects.toBe(exited)
    expect(retired).toBe(false)
  })

  it('does not use a void actual-settlement notification as a document result', async () => {
    const operation = nativeOperation(),
      client = createSettledDocumentNativeClient({ requestAttested: () => operation.admission })
    let acknowledged = false
    const pending = client.openDocument(open).then((value) => {
      acknowledged = true
      return value
    })
    operation.actual.resolve()
    await flush()
    expect(acknowledged).toBe(false)
    const reply = { apiVersion: 1, documentId, revision: 0 }
    operation.result.resolve(reply)
    operation.completion.resolve(reply)
    expect(await pending).toBe(reply)
  })

  it('keeps the async method contract when dispatch itself rejects before an admission can be returned', async () => {
    const failed = new Error('Definitive spawn failure')
    const client = createSettledDocumentNativeClient({
      requestAttested: () => {
        throw failed
      },
    })
    await expect(client.openDocument(open)).rejects.toBe(failed)
  })

  it('a serialized authority tail cannot publish an ACK, start close, or retire on bounded-result rejection', async () => {
    const checkpointOperation = nativeOperation(),
      closeOperation = nativeOperation()
    const dispatched: string[] = [],
      events: string[] = []
    const native: AttestedDocumentRequestClient = {
      requestAttested: (command) => {
        dispatched.push(String(command.command))
        return command.command === 'checkpoint_document'
          ? checkpointOperation.admission
          : closeOperation.admission
      },
    }
    const client = createSettledDocumentNativeClient(native)
    const tail = (async () => {
      await client.checkpointDocument(checkpoint)
      events.push('acknowledged')
      await client.closeDocument({ apiVersion: 1, documentId })
      events.push('retired-exact-authority')
    })()
    checkpointOperation.result.reject(new Error('checkpoint caller timeout'))
    await flush()
    expect(events).toEqual([])
    expect(dispatched).toEqual(['checkpoint_document'])
    checkpointOperation.completion.resolve({
      apiVersion: 1,
      documentId,
      commandId,
      revision: 9,
      durable: true,
    })
    checkpointOperation.actual.resolve()
    await flush()
    expect(events).toEqual(['acknowledged'])
    expect(dispatched).toEqual(['checkpoint_document', 'close_document'])
    closeOperation.result.reject(new Error('close caller timeout'))
    await flush()
    expect(events).toEqual(['acknowledged'])
    closeOperation.completion.resolve({ closed: true })
    closeOperation.actual.resolve()
    await tail
    expect(events).toEqual(['acknowledged', 'retired-exact-authority'])
  })
})
