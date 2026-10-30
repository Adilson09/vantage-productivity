import { randomUUID } from 'node:crypto'
import type { WorkbookRenamedMetadata, WorkbookRenameRefreshResult } from '../shared/desktop-api'

interface Pending<Owner> {
  owner: Owner
  id: string
  metadata: WorkbookRenamedMetadata
  response?: WorkbookRenameRefreshResult
  finalizing: boolean
  destroyed: boolean
  resolve(value: WorkbookRenameRefreshResult): void
  reject(error: unknown): void
  resolveActual(): void
  completion: Promise<WorkbookRenameRefreshResult>
  actualSettled: Promise<void>
}

/** A renderer deadline/delivery error never substitutes for its actual finalizer. */
export class SheetsRenameRefreshTransport<Owner> {
  private readonly pending = new Map<Owner, Pending<Owner>>()
  constructor(
    private readonly options: {
      send(owner: Owner, name: string, metadata: WorkbookRenamedMetadata): void
      publicationTail(owner: Owner): Promise<void>
      validate(
        owner: Owner,
        metadata: WorkbookRenamedMetadata,
        result: WorkbookRenameRefreshResult,
      ): boolean
    },
  ) {}

  begin(owner: Owner, name: string, metadata: WorkbookRenamedMetadata) {
    if (this.pending.has(owner))
      throw new Error('A previous rename refresh is still actually settling.')
    const id = randomUUID()
    let resolve!: Pending<Owner>['resolve'],
      reject!: Pending<Owner>['reject'],
      resolveActual!: () => void
    const completion = new Promise<WorkbookRenameRefreshResult>((yes, no) => {
      resolve = yes
      reject = no
    })
    const actualSettled = new Promise<void>((yes) => {
      resolveActual = yes
    })
    void completion.catch(() => undefined)
    const request: Pending<Owner> = {
      owner,
      id,
      metadata: { ...metadata, refreshId: id },
      finalizing: false,
      destroyed: false,
      resolve,
      reject,
      resolveActual,
      completion,
      actualSettled,
    }
    this.pending.set(owner, request)
    try {
      this.options.send(owner, name, request.metadata)
    } catch {
      /* Delivery is uncertain: only a real finalizer or verified destruction can release it. */
    }
    return { completion, actualSettled }
  }

  receiveResult(owner: Owner, id: unknown, result: unknown): boolean {
    const request = this.pending.get(owner)
    if (
      !request ||
      request.destroyed ||
      request.finalizing ||
      id !== request.id ||
      request.response ||
      !result ||
      typeof result !== 'object'
    )
      return false
    const value = result as WorkbookRenameRefreshResult
    if (
      typeof value.ok !== 'boolean' ||
      (value.error !== undefined && typeof value.error !== 'string')
    )
      return false
    request.response = value
    return true
  }

  receiveActualSettled(owner: Owner, id: unknown): boolean {
    const request = this.pending.get(owner)
    if (!request || request.destroyed || request.finalizing || id !== request.id) return false
    request.finalizing = true
    let tail: Promise<void>
    try {
      tail = this.options.publicationTail(owner)
    } catch (error) {
      request.reject(error)
      return true
    }
    void tail.then(
      () => this.finish(request),
      (error) => this.finish(request, error),
    )
    return true
  }

  /** The host calls only after actual owner destruction; cleanup itself is still awaited. */
  destroy(owner: Owner, actualCleanup: Promise<void>): void {
    const request = this.pending.get(owner)
    if (!request) return
    request.destroyed = true
    request.finalizing = true
    void actualCleanup.then(
      () =>
        this.finish(
          request,
          new Error('The rename owner was destroyed before refresh completed.'),
          true,
        ),
      (error) => this.finish(request, error, true),
    )
  }

  private finish(request: Pending<Owner>, failure?: unknown, verifiedOwnerCleanup = false): void {
    if (this.pending.get(request.owner) !== request) return
    if (request.destroyed && !verifiedOwnerCleanup) return
    this.pending.delete(request.owner)
    try {
      if (failure) throw failure
      if (
        !request.response?.ok ||
        !this.options.validate(request.owner, request.metadata, request.response)
      )
        throw new Error(
          request.response?.error ||
            'The renamed workbook did not acknowledge its complete current checkpoint.',
        )
      request.resolve(request.response)
    } catch (error) {
      request.reject(error)
    }
    request.resolveActual()
  }
}
