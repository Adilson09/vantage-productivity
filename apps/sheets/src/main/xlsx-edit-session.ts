import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  EDIT_API_VERSION,
  editOpenResultSchema,
  editRecalcResultSchema,
  editTransactionResultSchema,
  XlsxSidecarError,
  type EditInput,
  type EditRecalcRead,
  type EditRecalcResult,
  type EditSessionClient,
  type EditSessionOpen,
  type EditTransaction,
} from './xlsx-edit-contract'

/** Identifies a document independently of temporary snapshots and native UUIDs. */
export function editWorkbookId(originalPath: string, owner: string, sourceDigest: string): string {
  let canonical: string
  try {
    canonical = realpathSync.native(originalPath)
  } catch {
    canonical = resolve(originalPath)
  }
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return createHash('sha256')
    .update(JSON.stringify([canonical, owner, sourceDigest]))
    .digest('hex')
}

interface EditState {
  opened: boolean
  closed: boolean
  revision: number
  tail: Promise<unknown>
  /** Retained until its outcome is known, including across process death. */
  pending?: EditTransaction
  inputSignature?: string
}

function inputSignature(edits: readonly EditInput[]): string {
  const cells = edits.map(
    ({ sheetId, row, column, input }) => [sheetId, row, column, input] as const,
  )
  cells.sort(
    (a, b) =>
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) ||
      a[1] - b[1] ||
      a[2] - b[2] ||
      (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0),
  )
  return createHash('sha256').update(JSON.stringify(cells)).digest('hex')
}

/** Serializes one document's cumulative renderer overlays through Rust authority. */
export class XlsxEditSessions {
  private readonly states = new Map<string, EditState>()
  /** IronCalc has one worker per process; edits need not wait for that worker. */
  private calculationTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly client: EditSessionClient) {
    client.onProcessExit(() => {
      for (const state of this.states.values()) {
        state.opened = false
        delete state.inputSignature
      }
    })
  }

  forget(workbookId: string): void {
    const state = this.states.get(workbookId)
    if (state) state.closed = true
    this.states.delete(workbookId)
  }

  recalculate(
    open: EditSessionOpen,
    edits: readonly EditInput[],
    reads: readonly EditRecalcRead[],
  ): Promise<EditRecalcResult> {
    let state = this.states.get(open.workbookId)
    if (!state) {
      state = { opened: false, closed: false, revision: 0, tail: Promise.resolve() }
      this.states.set(open.workbookId, state)
    }
    const current = state
    const next = current.tail.catch(() => undefined).then(() => this.prepare(current, open, edits))
    current.tail = next
    return next.then((revision) => {
      const calculated = this.calculationTail
        .catch(() => undefined)
        .then(() => this.calculate(current, open, reads, revision))
      this.calculationTail = calculated
      return calculated
    })
  }

  private async prepare(
    state: EditState,
    open: EditSessionOpen,
    edits: readonly EditInput[],
  ): Promise<number> {
    this.assertActive(state)
    if (!state.opened) {
      const opened = editOpenResultSchema.parse(await this.client.openEditSession(open))
      this.assertActive(state)
      if (opened.workbookId !== open.workbookId)
        throw new Error('Rust opened a different workbook.')
      state.revision = opened.revision
      state.opened = true
      delete state.inputSignature
      // An encrypted workbook uses memory authority. A native restart loses
      // that authority's history, so an uncertain old command's revision is
      // meaningless. Rebuild it from the latest complete renderer overlay.
      // SQLite sessions retain the command ID and discover its durable result.
      if (open.storePath === undefined && !opened.recovered) delete state.pending
    }
    if (state.pending) {
      const known = await this.client.commandResult({
        apiVersion: EDIT_API_VERSION,
        workbookId: open.workbookId,
        commandId: state.pending.commandId,
      })
      this.assertActive(state)
      if (known !== null) this.accept(state, state.pending, known, open.storePath !== undefined)
      else await this.apply(state, state.pending, open.storePath !== undefined)
    }
    // Viewport reads often reuse the same cumulative inputs. Only a definitely
    // accepted overlay may reuse its revision without growing the journal.
    if (state.inputSignature === inputSignature(edits)) return state.revision
    const transaction: EditTransaction = {
      apiVersion: EDIT_API_VERSION,
      workbookId: open.workbookId,
      commandId: randomUUID(),
      expectedRevision: state.revision,
      actor: 'desktop',
      operations: [{ type: 'replace_inputs', edits }],
    }
    state.pending = transaction
    await this.apply(state, transaction, open.storePath !== undefined)
    this.assertActive(state)
    return state.revision
  }

  private async calculate(
    state: EditState,
    open: EditSessionOpen,
    reads: readonly EditRecalcRead[],
    revision: number,
  ): Promise<EditRecalcResult> {
    this.assertRevision(state, revision)
    const result = editRecalcResultSchema.parse(
      await this.client.recalcSnapshot({
        apiVersion: EDIT_API_VERSION,
        workbookId: open.workbookId,
        revision,
        reads,
      }),
    )
    this.assertRevision(state, revision)
    if (result.workbookId !== open.workbookId || result.revision !== revision) {
      throw new Error('Rust returned calculation values for a different workbook revision.')
    }
    return result
  }

  private async apply(
    state: EditState,
    transaction: EditTransaction,
    durable: boolean,
  ): Promise<void> {
    try {
      this.assertActive(state)
      const result = await this.client.applyTransaction(transaction)
      this.assertActive(state)
      this.accept(state, transaction, result, durable)
    } catch (error) {
      // A server rejection has a definite outcome. Transport failures retain
      // the same command ID so a retry can discover an already durable edit.
      if (error instanceof XlsxSidecarError) delete state.pending
      throw error
    }
  }

  private assertActive(state: EditState): void {
    if (state.closed)
      throw new XlsxSidecarError('edit_session_closed', 'Workbook edit session was closed.')
  }

  private assertRevision(state: EditState, revision: number): void {
    this.assertActive(state)
    if (state.revision !== revision) {
      throw new XlsxSidecarError(
        'stale_revision',
        'Calculation was superseded by a newer workbook revision.',
        state.revision,
      )
    }
  }

  private accept(
    state: EditState,
    transaction: EditTransaction,
    raw: unknown,
    durable: boolean,
  ): void {
    const result = editTransactionResultSchema.parse(raw)
    if (
      result.workbookId !== transaction.workbookId ||
      result.commandId !== transaction.commandId ||
      (durable && !result.durable)
    ) {
      throw new Error('Rust did not acknowledge the requested durable transaction.')
    }
    state.revision = result.revision
    const operation = transaction.operations[0]
    if (transaction.operations.length === 1 && operation?.type === 'replace_inputs') {
      state.inputSignature = inputSignature(operation.edits)
    } else {
      delete state.inputSignature
    }
    delete state.pending
  }
}
