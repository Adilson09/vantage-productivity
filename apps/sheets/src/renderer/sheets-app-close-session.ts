import {
  CloseMutationBarrier,
  installCloseInputFence,
} from '../../../../packages/electron-utils/src/renderer-close-barrier'
import type { CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
import type {
  DesktopApi,
  WorkbookFile,
  WorkbookCloseCheckpointBinding,
  WorkbookWriteContext,
} from '../shared/desktop-api'
import type {
  SheetsCloseSource,
  SheetsPrepareCloseRequest,
  SheetsPrepareCloseResult,
} from '../shared/sheets-close'
import { sameSheetsCloseSource } from '../shared/sheets-close'
import {
  hashWorkbookDocumentPayload,
  serializeWorkbookDocumentPayload,
} from '../shared/document-payload-canonical'
import { createSheetsCloseController, type SheetsPublicationFence } from './sheets-close-controller'
import { createWorkbookAuthoredAdmission } from './workbook-authored-admission'
import { collectWorkbookDocumentPayload, type SaveContext, type SaveOutcome } from './save-actions'
import { checkpointWorkbookForClose } from './workbook-close-checkpoint'
import {
  drainWorkbookWork,
  withPublicationOwner,
  type WorkbookPublicationOwner,
} from './workbook-mutation-queue'
import type { LazyWorkbookState } from './univer-state'

export interface SheetsAppCloseOptions {
  api(): DesktopApi | undefined
  file(): WorkbookFile | null
  context(): SaveContext
  dirty(): boolean
  busy(excludeOwner?: WorkbookPublicationOwner): boolean
  derived(): boolean
  /** Remains false while any named producer/adoption transport gap remains. */
  coverageComplete(): boolean
  commitEditor(): Promise<boolean>
  save(request: SheetsPrepareCloseRequest): Promise<SaveOutcome>
  report(error: unknown): void
}

/** Real App bridge: correlated result and actual finalizer are intentionally distinct IPC messages. */
export class SheetsAppCloseSession {
  private options: SheetsAppCloseOptions
  private source: SheetsCloseSource | null = null
  private rendererEpoch = 1
  private fingerprint: {
    source: SheetsCloseSource
    stamp: string
    json: string
    sha256: string
  } | null = null
  private fingerprintBusy = false
  private fingerprintWriters = 0
  private activeRequest: (SheetsPrepareCloseRequest & { requestId: string }) | null = null
  private readonly actual = new Map<string, Promise<void>>()
  private readerRecovery: Promise<boolean> | null = null
  private sourceOpenWork = 0
  readonly barrier: CloseMutationBarrier
  readonly admission: ReturnType<typeof createWorkbookAuthoredAdmission>
  readonly controller: ReturnType<typeof createSheetsCloseController>

  constructor(options: SheetsAppCloseOptions) {
    this.options = options
    this.barrier = new CloseMutationBarrier({
      source: () => `sheets-renderer-${this.rendererEpoch}`,
      claim: (ticket) => this.requireApi().claimWorkbookClose(ticket),
      cancel: (ticket, reason) => this.requireApi().cancelWorkbookClose(ticket, reason),
      report: (error) => this.options.report(error),
    })
    this.admission = createWorkbookAuthoredAdmission({
      barrier: this.barrier,
      source: () => this.barrier.snapshot().source,
      isDerived: () => this.options.derived(),
      report: (error) => this.options.report(error),
      changed: () => this.notify(),
    })
    this.controller = createSheetsCloseController({
      barrier: this.barrier,
      current: () => this.state(),
      authoredPayloadSha256: () => this.currentFingerprint(),
      coverageComplete: () => this.options.coverageComplete(),
      settleWork: async () => {
        if (this.readerRecovery) await this.readerRecovery
        await drainWorkbookWork()
        await this.admission.drain()
        await this.refreshFingerprint()
      },
      save: async (request) => {
        const outcome = await this.options.save(request)
        await this.refreshFingerprint()
        return {
          published: outcome.published === true,
          adopted: outcome.adopted === true,
          ...(outcome.path ? { savedPath: outcome.path } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        }
      },
      flushAcceptedRecovery: async (expected, ticket) => {
        const request = this.activeRequest
        if (!request || !sameTicket(request.ticket, ticket))
          throw new Error('The close checkpoint has no matching active request.')
        const binding: WorkbookCloseCheckpointBinding = {
          requestId: request.requestId,
          ticket,
          stamp: expected.stamp,
          source: expected.source,
          payloadSha256: expected.payloadSha256,
        }
        const accepted = await checkpointWorkbookForClose(
          {
            ...this.options.context(),
            writeContext: { origin: 'close' },
          },
          binding,
        )
        return { ...expected, payloadSha256: accepted.payloadSha256 }
      },
      cancel: (ticket, reason) => this.requireApi().cancelWorkbookClose(ticket, reason),
      // The controller invalidates its preparing operations immediately. Keep
      // the visible old model/journal epoch usable if picker/fonts/open fails;
      // only beginRebase replaces that epoch at the actual accepted model swap.
      invalidateSource: () => {
        this.fingerprint = null
      },
    })
  }

  update(options: SheetsAppCloseOptions): void {
    this.options = options
  }

  get closeTicket(): CloseLeaseTicket | undefined {
    return this.activeRequest?.ticket
  }

  state(excludeOwner?: WorkbookPublicationOwner) {
    const file = this.options.file()
    const source = file?.closeSource ?? this.source
    if (!file || !source || source.sessionId !== file.sessionId) return null
    return {
      source: { ...source },
      stamp: this.barrier.snapshot(),
      dirty: this.options.dirty(),
      busy:
        this.fingerprintBusy ||
        this.readerRecovery !== null ||
        this.sourceOpenWork !== 0 ||
        this.options.busy(excludeOwner) ||
        this.admission.busy,
      protectedMemoryOnly: file.passwordProtected === true,
    }
  }

  /** Only this live publication's own fence excludes its queue/gate reservation.
   * Concurrent close inspection always calls state() without any exclusion.
   */
  captureOwnedPublicationFence(owner: WorkbookPublicationOwner): SheetsPublicationFence | null {
    return withPublicationOwner(owner, () => {
      const captured = this.state(owner),
        hash = this.currentFingerprint()
      if (!captured || captured.busy || !hash || !this.options.coverageComplete()) return null
      return {
        source: { ...captured.source },
        stamp: { ...captured.stamp },
        payloadSha256: hash,
        canAdopt: () => {
          try {
            return withPublicationOwner(owner, () => {
              const current = this.state(owner)
              return (
                !!current &&
                !current.busy &&
                current.dirty === captured.dirty &&
                current.protectedMemoryOnly === captured.protectedMemoryOnly &&
                sameSheetsCloseSource(current.source, captured.source) &&
                current.stamp.source === captured.stamp.source &&
                current.stamp.revision === captured.stamp.revision &&
                this.currentFingerprint() === hash
              )
            })
          } catch {
            return false
          }
        },
      }
    })
  }

  async beforeExplicitOpen(): Promise<void> {
    this.sourceOpenWork++
    this.notify()
    try {
      // Finish the old source's editor/work before changing its admission epoch.
      // Cancel any actual close writer first; cancellation alone is not its completion.
      const active = this.activeRequest
      if (active) {
        await this.requireApi().cancelWorkbookClose(
          active.ticket,
          'An explicit open superseded this close.',
        )
        this.controller.release(active.ticket)
        await Promise.all([...this.actual.values()])
      }
      await this.barrier.beforeMutation()
      if (this.readerRecovery) await this.readerRecovery
      if (!(await this.options.commitEditor()))
        throw new Error(
          'The old spreadsheet editor could not be committed before opening another file.',
        )
      await drainWorkbookWork()
      await this.admission.drain()
      if (this.options.file() && this.options.dirty())
        await checkpointWorkbookForClose(this.options.context())
      await this.controller.invalidateSourceBeforeOpen()
    } finally {
      this.sourceOpenWork--
      this.notify()
    }
  }

  /** The model has selected the offered reader; main still retains the old source until ACK/adoption. */
  select(file: WorkbookFile): void {
    this.source = file.closeSource ? { ...file.closeSource } : null
    this.fingerprint = null
  }

  /** Invalidate old bound journal/callback epochs at the actual owned model swap. */
  beginRebase(): string {
    this.rendererEpoch++
    this.fingerprint = null
    return this.admission.captureSource()
  }

  recoverSameModel(state: LazyWorkbookState): Promise<boolean> {
    if (this.readerRecovery) return this.readerRecovery
    const operation = this.recoverSameModelActual(state)
    this.readerRecovery = operation
    this.notify()
    void operation.then(
      () => {
        if (this.readerRecovery === operation) this.readerRecovery = null
        this.notify()
      },
      (error) => {
        if (this.readerRecovery === operation) this.readerRecovery = null
        this.options.report(error)
        this.notify()
      },
    )
    return operation
  }

  private async recoverSameModelActual(state: LazyWorkbookState): Promise<boolean> {
    if (this.options.context().lazyWorkbookRef.current !== state) return false
    const oldFile = state.file,
      oldSource = this.source
    const expected = oldFile.closeSource ?? oldSource
    const replacement = await this.requireApi().recoverWorkbookReader(oldFile.sessionId, {
      origin: 'automatic',
    })
    if (!replacement?.ownedOpen || !replacement.closeSource) return false
    if (
      !expected ||
      replacement.closeSource.lineage !== expected.lineage ||
      replacement.closeSource.openedSha256 !== expected.openedSha256 ||
      replacement.closeSource.documentPath !== expected.documentPath ||
      replacement.sha256 !== oldFile.sha256 ||
      replacement.sessionId === oldFile.sessionId
    ) {
      await this.requireApi().rejectWorkbookPublication(replacement.ownedOpen.id)
      return false
    }
    if (this.options.context().lazyWorkbookRef.current !== state || state.file !== oldFile) {
      await this.requireApi().rejectWorkbookPublication(replacement.ownedOpen.id)
      return false
    }
    // Same immutable base/model, with its complete pending journal retained.
    // No renderer epoch reset and no implicit acceptance of current disk bytes.
    state.file = {
      ...oldFile,
      sessionId: replacement.sessionId,
      closeSource: replacement.closeSource,
      ownedOpen: replacement.ownedOpen,
    }
    this.select(state.file)
    try {
      if (!(await this.finishAdoption(state.file, { origin: 'automatic' })))
        throw new Error('The immutable reader replacement was not acknowledged/adopted.')
      this.notify()
      return true
    } catch (error) {
      state.file = oldFile
      this.source = oldSource
      this.fingerprint = null
      await this.requireApi()
        .rejectWorkbookPublication(replacement.ownedOpen.id)
        .catch((failure) => this.options.report(failure))
      this.options.report(error)
      return false
    }
  }

  async mayAdopt(file: WorkbookFile): Promise<boolean> {
    return file.ownedOpen
      ? await this.requireApi().canAdoptWorkbookPublication(file.ownedOpen.id)
      : false
  }

  async finishAdoption(
    file: WorkbookFile,
    writeContext: WorkbookWriteContext = { origin: 'manual' },
  ): Promise<boolean> {
    const offer = file.ownedOpen
    if (!offer || !file.closeSource || !sameSheetsCloseSource(offer.source, file.closeSource))
      return false
    await this.refreshFingerprint()
    const state = this.state(),
      hash = this.currentFingerprint()
    if (!state || !hash) return false
    // Ambient close activity never upgrades an unrelated reader recovery or
    // ordinary publication into an authorized close checkpoint.
    const request = writeContext.origin === 'close' ? this.activeRequest : null
    if (writeContext.origin === 'close' && !request) return false
    const binding = request
      ? {
          requestId: request.requestId,
          ticket: request.ticket,
          source: state.source,
          stamp: state.stamp,
          payloadSha256: hash,
        }
      : undefined
    const accepted = await checkpointWorkbookForClose(
      { ...this.options.context(), writeContext },
      binding,
    )
    if (accepted.payloadSha256 !== hash || this.currentFingerprint() !== hash) return false
    return this.requireApi().adoptWorkbookPublication(offer.id, {
      source: state.source,
      stamp: state.stamp,
      payloadSha256: hash,
    })
  }

  async refreshFingerprint(): Promise<void> {
    this.fingerprintWriters++
    this.fingerprintBusy = true
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const file = this.options.file(),
          source = file?.closeSource ?? this.source
        if (!file || !source || source.sessionId !== file.sessionId) {
          this.fingerprint = null
          return
        }
        const stamp = JSON.stringify(this.barrier.snapshot())
        const snapshot = collectWorkbookDocumentPayload(this.options.context())
        const hashed = await hashWorkbookDocumentPayload(snapshot.payload)
        if (
          this.options.file()?.sessionId !== file.sessionId ||
          stamp !== JSON.stringify(this.barrier.snapshot()) ||
          hashed.json !==
            serializeWorkbookDocumentPayload(
              collectWorkbookDocumentPayload(this.options.context()).payload,
            )
        )
          continue
        this.fingerprint = {
          source: { ...source },
          stamp,
          json: hashed.json,
          sha256: hashed.sha256,
        }
        return
      }
      throw new Error('The full workbook payload did not settle for checkpoint preparation.')
    } finally {
      this.fingerprintWriters--
      this.fingerprintBusy = this.fingerprintWriters !== 0
    }
  }

  private currentFingerprint(): string | null {
    const known = this.fingerprint,
      file = this.options.file(),
      source = file?.closeSource ?? this.source
    if (
      !known ||
      !source ||
      this.fingerprintBusy ||
      !sameSheetsCloseSource(known.source, source) ||
      known.stamp !== JSON.stringify(this.barrier.snapshot())
    )
      return null
    try {
      return serializeWorkbookDocumentPayload(
        collectWorkbookDocumentPayload(this.options.context()).payload,
      ) === known.json
        ? known.sha256
        : null
    } catch {
      return null
    }
  }

  install(inputRoot: Parameters<typeof installCloseInputFence>[1]): () => void {
    const api = this.requireApi()
    const stopInput = installCloseInputFence(this.barrier, inputRoot)
    const afterInput = () => {
      queueMicrotask(() => this.notify())
    }
    inputRoot.addEventListener('input', afterInput, true)
    inputRoot.addEventListener('change', afterInput, true)
    const stopPrepare = api.onPrepareWorkbookClose((request) => {
      if (this.actual.has(request.requestId)) return
      const operation = this.prepareActual(request)
      this.actual.set(request.requestId, operation)
      void operation
        .catch((error) => this.options.report(error))
        .finally(() => this.actual.delete(request.requestId))
    })
    const stopRelease = api.onWorkbookCloseRelease((ticket) => this.controller.release(ticket))
    const unregisterLock = this.barrier.registerLock(() => {
      const prior = document.body.inert
      document.body.inert = true
      return () => {
        document.body.inert = prior
      }
    })
    return () => {
      stopPrepare()
      stopRelease()
      stopInput()
      unregisterLock()
      inputRoot.removeEventListener('input', afterInput, true)
      inputRoot.removeEventListener('change', afterInput, true)
    }
  }

  private async prepareActual(
    request: SheetsPrepareCloseRequest & { requestId: string },
  ): Promise<void> {
    const api = this.requireApi()
    if (this.activeRequest) {
      api.reportPrepareWorkbookCloseResult(request.requestId, {
        current: false,
        clean: false,
        published: false,
        intent: request.intent,
        error: 'Another actual spreadsheet close writer is still running.',
      })
      api.reportWorkbookCloseActualSettled(request.requestId)
      return
    }
    this.activeRequest = request
    try {
      if (!(await api.claimWorkbookClose(request.ticket)))
        throw new Error('The close request is no longer admitted by main.')
      if (!(await this.options.commitEditor()))
        throw new Error('The active cell could not be committed.')
      await drainWorkbookWork()
      await this.admission.drain()
      await this.refreshFingerprint()
      const result = await this.controller.prepare(request)
      api.reportPrepareWorkbookCloseResult(request.requestId, result)
    } catch (error) {
      try {
        await api.cancelWorkbookClose(request.ticket, String(error))
      } catch (failure) {
        this.options.report(failure)
      }
      const state = this.state()
      const result: SheetsPrepareCloseResult = {
        current: state !== null,
        clean: !!state && !state.dirty,
        published: false,
        intent: request.intent,
        error: String(error),
      }
      api.reportPrepareWorkbookCloseResult(request.requestId, result)
    } finally {
      // This is the actual renderer operation's finalizer, separate from result/RPC timers.
      this.activeRequest = null
      api.reportWorkbookCloseActualSettled(request.requestId)
    }
  }

  notify(): void {
    const state = this.state()
    if (state) this.options.api()?.notifyWorkbookCloseState(state, this.options.coverageComplete())
  }

  private requireApi(): DesktopApi {
    const api = this.options.api()
    if (!api) throw new Error('The spreadsheet desktop bridge is unavailable.')
    return api
  }
}

function sameTicket(left: CloseLeaseTicket, right: CloseLeaseTicket): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.source === right.source
}
