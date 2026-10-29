import { describe, expect, it, vi } from 'vitest'
import {
  XlsxSidecarError,
  type EditSessionClient,
  type EditSessionOpen,
  type EditTransaction,
  type EditTransactionResult,
} from '../src/main/xlsx-edit-contract'
import { editWorkbookId, XlsxEditSessions } from '../src/main/xlsx-edit-session'

const open: EditSessionOpen = {
  apiVersion: 1,
  workbookId: 'document',
  sourcePath: '/immutable/snapshot.xlsx',
  sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
  storePath: '/private/document.sqlite',
}
const reads = [{ sheet: 'Sheet1', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } }]
const edits = [{ sheetId: 'sheet-1', row: 0, column: 0, input: '4' }]

function fixture(durable = true) {
  let revision = 0
  let onExit: () => void = () => {}
  const results = new Map<string, EditTransactionResult>()
  const commit = (request: EditTransaction): EditTransactionResult => {
    if (request.expectedRevision !== revision)
      throw new XlsxSidecarError('revision_conflict', 'Stale revision')
    const result: EditTransactionResult = {
      apiVersion: 1,
      workbookId: request.workbookId,
      commandId: request.commandId,
      revision: ++revision,
      changed: 1,
      durable,
    }
    results.set(request.commandId, result)
    return result
  }
  const client = {
    onProcessExit: vi.fn((listener: () => void) => {
      onExit = listener
      return () => {}
    }),
    openEditSession: vi.fn(async (_request: EditSessionOpen) => ({
      apiVersion: 1,
      workbookId: 'document',
      revision,
      sourceFingerprint: 'fingerprint',
      recovered: revision > 0,
    })),
    applyTransaction: vi.fn(async (request: EditTransaction) => commit(request)),
    commandResult: vi.fn(
      async (request: { commandId: string }) => results.get(request.commandId) ?? null,
    ),
    recalcSnapshot: vi.fn(async (request: { workbookId: string; revision: number }) => ({
      workbookId: request.workbookId,
      revision: request.revision,
      cells: [],
    })),
  } satisfies EditSessionClient
  return {
    client,
    commit,
    crash: (loseMemory = false) => {
      if (loseMemory) {
        revision = 0
        results.clear()
      }
      onExit()
    },
    sessions: new XlsxEditSessions(client),
  }
}

describe('Rust edit session adapter', () => {
  it('keeps identity independent of native session/snapshot paths and isolates document owners', () => {
    expect(editWorkbookId('book.xlsx', 'tab-one', 'digest')).toBe(
      editWorkbookId('book.xlsx', 'tab-one', 'digest'),
    )
    expect(editWorkbookId('book.xlsx', 'tab-one', 'digest')).not.toBe(
      editWorkbookId('book.xlsx', 'tab-two', 'digest'),
    )
    expect(editWorkbookId('book.xlsx', 'tab-one', 'digest')).not.toBe(
      editWorkbookId('book.xlsx', 'tab-one', 'saved-digest'),
    )
  })

  it('serializes cumulative overlays and pins calculation to the acknowledged revision', async () => {
    const { client, sessions } = fixture()
    await sessions.recalculate(open, edits, reads)
    await sessions.recalculate(open, [], reads)
    expect(client.openEditSession).toHaveBeenCalledTimes(1)
    expect(client.applyTransaction.mock.calls.map(([request]) => request.expectedRevision)).toEqual(
      [0, 1],
    )
    expect(client.applyTransaction.mock.calls[1]![0].operations).toEqual([
      { type: 'replace_inputs', edits: [] },
    ])
    expect(client.recalcSnapshot.mock.calls.map(([request]) => request.revision)).toEqual([1, 2])
    expect(client.recalcSnapshot.mock.calls[0]![0]).toMatchObject({ reads })
  })

  it('reuses an accepted revision for unchanged inputs in another order and different viewport reads', async () => {
    const { client, sessions } = fixture()
    const secondCell = { ...edits[0]!, column: 1, input: '8' }
    await sessions.recalculate(open, [...edits, secondCell], reads)
    const nextReads = [
      { sheet: 'Sheet1', range: { startRow: 1, endRow: 1, startColumn: 0, endColumn: 1 } },
    ]
    await sessions.recalculate(open, [secondCell, ...edits], nextReads)
    expect(client.applyTransaction).toHaveBeenCalledTimes(1)
    expect(client.recalcSnapshot).toHaveBeenCalledTimes(2)
    expect(client.recalcSnapshot.mock.calls[1]![0]).toMatchObject({ revision: 1, reads: nextReads })
  })

  it('forgets its accepted signature when memory authority is reopened after a crash', async () => {
    const { client, sessions, crash } = fixture(false)
    const { storePath: _store, ...memoryOpen } = open
    await sessions.recalculate(memoryOpen, edits, reads)
    crash(true)
    await sessions.recalculate(memoryOpen, edits, reads)
    expect(client.applyTransaction).toHaveBeenCalledTimes(2)
    expect(client.applyTransaction.mock.calls[1]![0].expectedRevision).toBe(0)
    expect(client.recalcSnapshot.mock.calls[1]![0].revision).toBe(1)
  })

  it('recovers an acknowledged edit whose reply was lost without issuing it again', async () => {
    const { client, commit, sessions, crash } = fixture()
    client.applyTransaction.mockImplementationOnce(async (request) => {
      commit(request)
      throw new Error('Pipe closed before acknowledgement')
    })
    await expect(sessions.recalculate(open, edits, reads)).rejects.toThrow('Pipe closed')
    const commandId = client.applyTransaction.mock.calls[0]![0].commandId
    crash()
    await sessions.recalculate({ ...open, sourcePath: '/replacement/snapshot.xlsx' }, edits, reads)
    expect(client.openEditSession).toHaveBeenCalledTimes(2)
    expect(client.openEditSession.mock.calls[1]![0]).toMatchObject({
      sourcePath: '/replacement/snapshot.xlsx',
    })
    expect(client.commandResult).toHaveBeenCalledWith({
      apiVersion: 1,
      workbookId: 'document',
      commandId,
    })
    expect(client.applyTransaction).toHaveBeenCalledTimes(1)
    expect(client.recalcSnapshot.mock.calls[0]![0].revision).toBe(1)
  })

  it('retries an uncommitted transport failure with the identical command ID', async () => {
    const { client, sessions, crash } = fixture()
    client.applyTransaction.mockRejectedValueOnce(new Error('Pipe closed before commit'))
    await expect(sessions.recalculate(open, edits, reads)).rejects.toThrow('Pipe closed')
    crash()
    await sessions.recalculate(open, edits, reads)
    expect(client.applyTransaction.mock.calls[1]![0]).toEqual(
      client.applyTransaction.mock.calls[0]![0],
    )
    expect(client.applyTransaction).toHaveBeenCalledTimes(2)
    expect(client.recalcSnapshot.mock.calls[0]![0].revision).toBe(1)
  })

  it('rebuilds lost memory authority from the latest overlay instead of replaying an old revision', async () => {
    const { client, sessions, crash } = fixture(false)
    const { storePath: _store, ...memoryOpen } = open
    await sessions.recalculate(memoryOpen, edits, reads)
    client.applyTransaction.mockRejectedValueOnce(new Error('Native process died'))
    await expect(
      sessions.recalculate(memoryOpen, [{ ...edits[0]!, input: '5' }], reads),
    ).rejects.toThrow('Native process died')
    const lost = client.applyTransaction.mock.calls[1]![0]
    expect(lost.expectedRevision).toBe(1)
    crash(true)
    const latest = [{ ...edits[0]!, input: '9' }]
    await sessions.recalculate(memoryOpen, latest, reads)
    const rebuilt = client.applyTransaction.mock.calls[2]![0]
    expect(rebuilt.expectedRevision).toBe(0)
    expect(rebuilt.commandId).not.toBe(lost.commandId)
    expect(rebuilt.operations).toEqual([{ type: 'replace_inputs', edits: latest }])
    expect(client.commandResult).not.toHaveBeenCalled()
    expect(client.recalcSnapshot.mock.calls[1]![0].revision).toBe(1)
  })

  it('retires in-flight and queued work without reopening authority after a close', async () => {
    const { client, sessions } = fixture()
    let finish!: (result: EditTransactionResult) => void
    let applied!: () => void
    const applying = new Promise<void>((resolve) => {
      applied = resolve
    })
    client.applyTransaction.mockImplementationOnce((request) => {
      applied()
      return new Promise<EditTransactionResult>((resolve) => {
        finish = (result) => resolve({ ...result, commandId: request.commandId })
      })
    })
    const first = sessions.recalculate(open, edits, reads)
    const queued = sessions.recalculate(open, [], reads)
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'edit_session_closed' })
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'edit_session_closed' })
    await applying
    sessions.forget(open.workbookId)
    finish({
      apiVersion: 1,
      workbookId: open.workbookId,
      commandId: '',
      revision: 1,
      changed: 1,
      durable: true,
    })
    await Promise.all([firstRejected, queuedRejected])
    expect(client.openEditSession).toHaveBeenCalledTimes(1)
    expect(client.applyTransaction).toHaveBeenCalledTimes(1)
    expect(client.recalcSnapshot).not.toHaveBeenCalled()
  })

  it('commits newer edits during calculation and skips superseded queued calculations', async () => {
    const { client, sessions } = fixture()
    type Result = { workbookId: string; revision: number; cells: [] }
    let finish!: (result: Result) => void
    let started!: () => void
    const calculating = new Promise<void>((resolve) => {
      started = resolve
    })
    client.recalcSnapshot.mockImplementationOnce(() => {
      started()
      return new Promise<Result>((resolve) => {
        finish = resolve
      })
    })
    const first = sessions.recalculate(open, edits, reads)
    const firstStale = expect(first).rejects.toMatchObject({
      code: 'stale_revision',
      currentRevision: 3,
    })
    await calculating
    const second = sessions.recalculate(open, [{ ...edits[0]!, input: '5' }], reads)
    const secondStale = expect(second).rejects.toMatchObject({
      code: 'stale_revision',
      currentRevision: 3,
    })
    const latest = sessions.recalculate(open, [{ ...edits[0]!, input: '6' }], reads)
    await vi.waitFor(() => expect(client.applyTransaction).toHaveBeenCalledTimes(3))
    expect(client.recalcSnapshot).toHaveBeenCalledTimes(1)
    finish({ workbookId: open.workbookId, revision: 1, cells: [] })
    await Promise.all([firstStale, secondStale])
    await expect(latest).resolves.toMatchObject({ revision: 3 })
    expect(client.recalcSnapshot.mock.calls.map(([request]) => request.revision)).toEqual([1, 3])
  })

  it('rejects queued and running calculations when the document closes', async () => {
    const { client, sessions } = fixture()
    type Result = { workbookId: string; revision: number; cells: [] }
    let finish!: (result: Result) => void
    let started!: () => void
    const calculating = new Promise<void>((resolve) => {
      started = resolve
    })
    client.recalcSnapshot.mockImplementationOnce(() => {
      started()
      return new Promise<Result>((resolve) => {
        finish = resolve
      })
    })
    const first = sessions.recalculate(open, edits, reads)
    const firstClosed = expect(first).rejects.toMatchObject({ code: 'edit_session_closed' })
    await calculating
    const queued = sessions.recalculate(open, [], reads)
    const queuedClosed = expect(queued).rejects.toMatchObject({ code: 'edit_session_closed' })
    await vi.waitFor(() => expect(client.applyTransaction).toHaveBeenCalledTimes(2))
    sessions.forget(open.workbookId)
    finish({ workbookId: open.workbookId, revision: 1, cells: [] })
    await Promise.all([firstClosed, queuedClosed])
    expect(client.recalcSnapshot).toHaveBeenCalledTimes(1)
  })

  it('propagates revision conflicts instead of silently rebasing or calculating', async () => {
    const { client, sessions } = fixture()
    const conflict = new XlsxSidecarError('revision_conflict', 'Stale revision')
    client.applyTransaction.mockRejectedValueOnce(conflict)
    await expect(sessions.recalculate(open, edits, reads)).rejects.toBe(conflict)
    expect(client.recalcSnapshot).not.toHaveBeenCalled()
    expect(client.commandResult).not.toHaveBeenCalled()
  })

  it('accepts an explicit memory session for encrypted inputs, but requires durable journal acknowledgements', async () => {
    const { sessions } = fixture(false)
    const { storePath: _store, ...memoryOpen } = open
    await expect(sessions.recalculate(memoryOpen, edits, reads)).resolves.toMatchObject({
      revision: 1,
    })
    await expect(fixture(false).sessions.recalculate(open, edits, reads)).rejects.toThrow(
      'durable transaction',
    )
  })

  it('rejects results for a different revision before they reach the renderer', async () => {
    const { client, sessions } = fixture()
    client.recalcSnapshot.mockResolvedValueOnce({ workbookId: 'document', revision: 0, cells: [] })
    await expect(sessions.recalculate(open, edits, reads)).rejects.toThrow(
      'different workbook revision',
    )
  })
})
