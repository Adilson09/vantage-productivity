import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  PDF_WORKSPACE_EXTENSION,
  PDF_WORKSPACE_LIMITS,
  decodePdfWorkspaceState,
  type PdfSourceRead,
  type PdfDraftActivation,
  type PdfDraftSnapshotRequest,
  type PdfWorkspaceStateV1,
  type PdfWorkspaceSaveProof,
  type PdfCopyReceipt,
  pdfWorkspacePendingReasons,
  validatePdfWorkspaceGraph,
  type PdfDraftCloseFloor,
  type PdfSaveFallbackRequest,
  type PdfSaveFallbackResult,
} from '../shared/pdf-workspace'
import {
  classifyPdfWorkspaceBase,
  decodePdfWorkspace,
  encodePdfWorkspace,
  pdfDigest,
  readPdfWorkspaceFile,
  PdfPrivateBases,
  validatePdfWorkspacePageBounds,
} from './pdf-workspace'
import { validatePdfStampConfig } from '../shared/pdf-workspace-schema'

interface PdfReadRecord {
  owner: number
  id: string
  mode: 'native' | 'workspace'
  displayPath: string
  helperPath: string
  bytes: Buffer
  sha256: string
  protection: 'unencrypted' | 'protected' | 'unknown'
  reason?: string
  state?: PdfWorkspaceStateV1
  originalPath: string | null
  pageCount: number
  automaticTokens?: string[]
  inheritedEntries?: Array<[string, string]>
  originPending?: boolean
  restoreHandoff?: PdfRestoreHandoff
  unpublishedBase?: boolean
  savedPublication?: { path: string; sha256: string }
  forkedFromReadId?: string
}
interface Active {
  owner: number
  token: string
  generation: number
  read: PdfReadRecord
  live: boolean
  received: number
  written: number
  lastStateSha256: string | null
  closeStage?: PdfDraftCloseFloor
  automaticTokens: string[]
  inheritedEntries: Array<[string, string]>
  captureEpoch: number
  journalBinding?: { documentPath: string | null; sha256: string }
}
export interface PdfJournalWriteReceipt {
  id: string
  module: string
  documentPath: string | null
  sha256: string
}
export interface PdfOwnedFailure {
  id: string
  ownerKey: string
  source: string
  generation: number
  token: string
  documentPath: string
  error: string
}
export interface PdfRestoreHandoff {
  commitHandoff(action: () => boolean): boolean
  cancel(reason?: string): void
  completed?(): void
}
export interface PdfDraftDependencies {
  recoveryAvailable?(): boolean
  alive(owner: number): boolean
  bases: PdfPrivateBases
  write(id: string, path: string | null, bytes: Buffer): Promise<PdfJournalWriteReceipt | null>
  discard(id: string, expectedSha256?: string): Promise<void>
  retireCustody(lineage: {
    tokens: string[]
    inheritedEntries: Array<[string, string]>
  }): Promise<void>
  failure(value: PdfOwnedFailure): void
  resolvedFailure(id: string): Promise<void>
  notify(
    owner: number,
    message: { token: string; reason: 'discarded' | 'checkpoint' | 'redacted' | 'close' },
  ): void
}
/** Main-owned opaque receipts. Imported paths and copy metadata never grant authority. */
export class PdfDraftController {
  private readonly reads = new Map<string, PdfReadRecord>()
  private readonly active = new Map<number, Active>()
  private readonly contexts = new Map<
    number,
    { mode: 'native' | 'workspace'; path: string; helperPath: string; readId: string }
  >()
  private readonly tails = new Map<number, Promise<unknown>>()
  private readonly cleanup = new Set<string>()
  private readonly receipts = new Map<
    string,
    {
      owner: number
      oldToken: string
      readId: string
      lifecycle: Active
      outputPath: string
      outputSha256: string
      outputBytes: number
      redacted: boolean
      readSerial: number
    }
  >()
  private readonly readSerials = new Map<number, number>()
  private readonly forking = new Set<number>()
  private readonly forkTokens = new Map<
    string,
    { owner: number; fromReadId: string; live: boolean }
  >()
  private readonly tokenOwners = new Map<string, number>()
  private readonly privateCleanup = new Set<string>()
  private readonly privateCleanupOwners = new Map<string, number>()
  private readonly cleanupLineages = new Map<string, Active>()
  private readonly restoredOrigins = new Map<
    string,
    { token: string; sha256: string; handoff?: PdfRestoreHandoff; owner?: number }
  >()
  private readonly retiredOrigins = new Set<string>()
  private readonly nativeSuccessors = new Map<
    number,
    {
      path: string
      sha256: string
      automaticTokens: string[]
      inheritedEntries: Array<[string, string]>
    }
  >()
  private generation = 0
  private queued = 0
  private queuedBytes = 0
  private reading = 0
  constructor(private readonly dependencies: PdfDraftDependencies) {}
  private async removePrivate(path: string): Promise<void> {
    await this.dependencies.bases.remove(path)
    this.privateCleanup.delete(path)
    this.privateCleanupOwners.delete(path)
  }
  /** Main Root recovery only; imported envelope fields cannot call this seam. */
  grantRestoredOrigin(
    path: string,
    token: string,
    sha256: string,
    handoff?: PdfRestoreHandoff,
  ): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token) ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !/\.vpdfdraft$/i.test(path)
    )
      throw new Error('Invalid trusted PDF recovery origin.')
    if (this.restoredOrigins.size >= 64 && !this.restoredOrigins.has(path))
      throw new Error('Too many restored PDF origins are awaiting activation.')
    if (this.retiredOrigins.has(token))
      throw new Error(
        'That automatic PDF recovery source was retired before the restored copy could be handed to an editor. The user-owned copy was retained.',
      )
    if (this.restoredOrigins.has(path))
      throw new Error('Another PDF recovery handoff already owns this new output.')
    this.restoredOrigins.set(path, { token, sha256, ...(handoff ? { handoff } : {}) })
  }
  cancelRestoredOrigin(path: string, reason: string): void {
    const origin = this.restoredOrigins.get(path)
    if (origin) {
      this.restoredOrigins.delete(path)
      origin.handoff?.cancel(reason)
    }
  }

  private data(record: PdfReadRecord): PdfSourceRead {
    return {
      readId: record.id,
      mode: record.mode,
      displayPath: record.displayPath,
      helperPath: record.helperPath,
      baseSha256: record.sha256,
      data: record.bytes.buffer.slice(
        record.bytes.byteOffset,
        record.bytes.byteOffset + record.bytes.byteLength,
      ) as ArrayBuffer,
      ...(record.state ? { recoveredState: structuredClone(record.state) } : {}),
      ...(record.unpublishedBase ? { unpublishedBase: true } : {}),
      ...(record.savedPublication ? { savedPublication: { ...record.savedPublication } } : {}),
      draftCapability:
        record.protection === 'unencrypted' && this.dependencies.recoveryAvailable?.() !== false
          ? { available: true }
          : {
              available: false,
              reason: record.reason ?? 'Automatic recovery is unavailable for this process.',
            },
    }
  }
  private async remember(
    owner: number,
    record: Omit<PdfReadRecord, 'owner' | 'id'>,
    assertCurrent?: () => void,
  ): Promise<PdfSourceRead> {
    assertCurrent?.()
    if (!Number.isSafeInteger(owner) || owner < 1 || !this.dependencies.alive(owner))
      throw new Error('PDF recovery has no live owner.')
    const owners = new Set([
      ...this.contexts.keys(),
      ...this.active.keys(),
      ...[...this.reads.values()].map((read) => read.owner),
    ])
    if (!owners.has(owner) && owners.size >= PDF_WORKSPACE_LIMITS.ownedViews)
      throw new Error('Too many PDF recovery views are active.')
    // At most one candidate plus the successfully activated base per view.
    const current = this.active.get(owner)?.read.id
    for (const [id, previous] of [...this.reads])
      if (previous.owner === owner && id !== current) {
        this.reads.delete(id)
        if (this.dependencies.bases.owns(previous.helperPath)) {
          try {
            await this.removePrivate(previous.helperPath)
          } catch (error) {
            this.privateCleanup.add(previous.helperPath)
            this.privateCleanupOwners.set(previous.helperPath, owner)
            throw error
          }
        }
        assertCurrent?.()
      }
    if (!this.dependencies.alive(owner))
      throw new Error('The PDF owner closed during source preparation.')
    const total = [...this.reads.values()].reduce((sum, item) => sum + item.bytes.length, 0)
    if (total + record.bytes.length > 64 * 1024 * 1024)
      throw new Error(
        'The aggregate private PDF base budget is full. Close another PDF view first.',
      )
    const read: PdfReadRecord = {
      ...record,
      owner,
      id: randomUUID(),
      bytes: Buffer.from(record.bytes),
    }
    assertCurrent?.()
    this.reads.set(read.id, read)
    return this.data(read)
  }
  async read(owner: number, grantedPath: string): Promise<PdfSourceRead> {
    const serial = (this.readSerials.get(owner) ?? 0) + 1
    this.readSerials.set(owner, serial)
    if (this.reading >= 2)
      throw new Error(
        'Another complete PDF source is still being prepared. Recovery for this new read was refused; its prior entry was kept.',
      )
    this.reading++
    try {
      return await this.readPrepared(owner, grantedPath, serial)
    } finally {
      this.reading--
    }
  }
  private async readPrepared(
    owner: number,
    grantedPath: string,
    serial: number,
  ): Promise<PdfSourceRead> {
    const assertCurrent = () => {
      if (!this.dependencies.alive(owner) || this.readSerials.get(owner) !== serial)
        throw new Error('A newer PDF source replaced this read.')
    }
    assertCurrent()
    if (!this.dependencies.alive(owner)) throw new Error('The PDF owner is no longer open.')
    if (/\.vpdfdraft$/i.test(grantedPath)) {
      if (this.dependencies.recoveryAvailable?.() === false)
        throw new Error(
          'PDF recovery workspace storage is unavailable. The source workspace was kept.',
        )
      const bytes = await readPdfWorkspaceFile(grantedPath)
      const origin = this.restoredOrigins.get(grantedPath)
      if (origin) {
        if (origin.owner !== undefined && origin.owner !== owner)
          throw new Error('This PDF restoration belongs to another view.')
        origin.owner = owner
      }
      if (origin && this.retiredOrigins.has(origin.token))
        throw new Error(
          'The original automatic PDF recovery source was retired during restoration.',
        )
      if (origin && origin.sha256 !== pdfDigest(bytes))
        throw new Error(
          'The recovered PDF workspace changed before its trusted origin could be accepted.',
        )
      const { envelope, base, pageCount } = await decodePdfWorkspace(bytes)
      assertCurrent()
      const helperPath = await this.dependencies.bases.create(owner, base)
      try {
        return await this.remember(
          owner,
          {
            mode: 'workspace',
            displayPath: grantedPath,
            helperPath,
            bytes: base,
            sha256: pdfDigest(base),
            protection: 'unencrypted',
            pageCount,
            state: envelope.state,
            originalPath: envelope.source.originalPath,
            ...(origin
              ? {
                  automaticTokens: [origin.token],
                  inheritedEntries: [[origin.token, origin.sha256] as [string, string]],
                  originPending: true,
                  restoreHandoff: origin.handoff,
                }
              : {}),
          },
          assertCurrent,
        )
      } catch (error) {
        await this.removePrivate(helperPath)
        throw error
      }
    }
    const bytes = await readPdfWorkspaceFile(grantedPath, PDF_WORKSPACE_LIMITS.sourceBytes)
    const protection = await classifyPdfWorkspaceBase(bytes)
    const successor = this.nativeSuccessors.get(owner)
    const lineage =
      successor?.path === grantedPath && successor.sha256 === pdfDigest(bytes) ? successor : null
    return this.remember(
      owner,
      {
        mode: 'native',
        displayPath: grantedPath,
        helperPath: grantedPath,
        bytes,
        sha256: pdfDigest(bytes),
        protection: protection.kind,
        pageCount: protection.kind === 'unencrypted' ? protection.pageCount : 0,
        ...(protection.kind === 'unencrypted' ? {} : { reason: protection.reason }),
        originalPath: grantedPath,
        ...(lineage
          ? {
              automaticTokens: [...lineage.automaticTokens],
              inheritedEntries: [...lineage.inheritedEntries],
            }
          : {}),
      },
      assertCurrent,
    )
  }
  bindNativeWrite(owner: number, path: string, inputSha256: string, bytes: Uint8Array): void {
    const active = this.active.get(owner),
      context = this.contexts.get(owner),
      prior = this.nativeSuccessors.get(owner)
    if (!context || context.mode !== 'native' || context.helperPath !== path) return
    const lineage =
      active?.read.id === context.readId && active.read.sha256 === inputSha256
        ? active
        : prior?.path === path && prior.sha256 === inputSha256
          ? prior
          : null
    this.nativeSuccessors.set(owner, {
      path,
      sha256: pdfDigest(bytes),
      automaticTokens: [...(lineage?.automaticTokens ?? [])],
      inheritedEntries: [...(lineage?.inheritedEntries ?? [])],
    })
  }
  activate(owner: number, readId: string): PdfDraftActivation {
    const read = this.reads.get(readId)
    const handoff = read?.restoreHandoff
    if (handoff) {
      let result: PdfDraftActivation | undefined
      const accepted = handoff.commitHandoff(() => {
        result = this.activateRecord(owner, readId)
        return true
      })
      if (!accepted || !result)
        throw new Error(
          'The PDF restoration source retired or its main handoff expired. The separate user-owned output was retained.',
        )
      read!.restoreHandoff = undefined
      handoff.completed?.()
      return result
    }
    return this.activateRecord(owner, readId)
  }
  private activateRecord(owner: number, readId: string): PdfDraftActivation {
    const read = this.reads.get(readId)
    if (!read || read.owner !== owner || !this.dependencies.alive(owner))
      throw new Error('PDF activation does not belong to this live view.')
    if (
      read.originPending &&
      read.inheritedEntries?.some(([token]) => this.retiredOrigins.has(token))
    )
      throw new Error(
        'The original automatic PDF recovery source was retired before this editor activation. The restored user-owned workspace was kept.',
      )
    this.contexts.set(owner, {
      mode: read.mode,
      path: read.displayPath,
      helperPath: read.helperPath,
      readId: read.id,
    })
    if (read.protection !== 'unencrypted' || this.dependencies.recoveryAvailable?.() === false) {
      const old = this.active.get(owner)
      if (old) old.live = false
      return { token: '', sourceGeneration: ++this.generation, mode: read.mode }
    }
    if (this.tokenOwners.size >= 256)
      for (const [token, tokenOwner] of this.tokenOwners) {
        if (!this.tails.has(tokenOwner) && this.active.get(tokenOwner)?.token !== token)
          this.tokenOwners.delete(token)
      }
    if (this.tokenOwners.size >= 256)
      throw new Error(
        'Too many PDF recovery lifecycles are still finishing. Retry after pending writes finish.',
      )
    const previous = this.active.get(owner)
    if (previous?.live && previous.read === read)
      return {
        token: previous.token,
        sourceGeneration: previous.generation,
        mode: read.mode,
        sequenceFloor: previous.received,
      }
    if (previous) previous.live = false
    const token = randomUUID()
    const automaticTokens = [...new Set([...(read.automaticTokens ?? []), token])]
    if (automaticTokens.length > 128)
      throw new Error('This PDF recovery lineage needs checked cleanup before another checkpoint.')
    const active: Active = {
      owner,
      token,
      generation: ++this.generation,
      read,
      live: true,
      received: 0,
      written: 0,
      lastStateSha256: null,
      automaticTokens,
      inheritedEntries: [...(read.inheritedEntries ?? [])],
      captureEpoch: 0,
    }
    this.active.set(owner, active)
    read.originPending = false
    this.restoredOrigins.delete(read.displayPath)
    this.dependencies.bases.bind(read.helperPath, {
      ownerKey: String(owner),
      source: read.id,
      generation: active.generation,
      token: active.token,
      documentPath: read.displayPath,
    })
    this.tokenOwners.set(active.token, owner)
    return {
      token: active.token,
      sourceGeneration: active.generation,
      mode: read.mode,
      sequenceFloor: active.received,
    }
  }
  private current(owner: number, token: string): Active {
    const active = this.active.get(owner)
    if (!active?.live || active.token !== token || !this.dependencies.alive(owner))
      throw new Error('This PDF source changed; the previous recovery entry was kept.')
    return active
  }
  private queue<T>(owner: number, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(owner) ?? Promise.resolve()
    const next = prior.catch(() => undefined).then(operation)
    this.tails.set(owner, next)
    void next.then(
      () => {
        if (this.tails.get(owner) === next) this.tails.delete(owner)
      },
      () => {
        if (this.tails.get(owner) === next) this.tails.delete(owner)
      },
    )
    return next
  }
  snapshot(
    owner: number,
    request: PdfDraftSnapshotRequest,
  ): Promise<{ ok: true; skipped?: boolean }> {
    if (this.dependencies.recoveryAvailable?.() === false)
      throw new Error('Automatic PDF recovery is unavailable. Prior complete entries were kept.')
    const active = this.current(owner, request?.token)
    if (
      !Number.isSafeInteger(request.sequence) ||
      request.sequence < 1 ||
      request.sequence > Number.MAX_SAFE_INTEGER - 1
    )
      return Promise.reject(new Error('Invalid PDF recovery sequence.'))
    if (request.sequence <= active.received) return Promise.resolve({ ok: true, skipped: true })
    if (
      !(request.state instanceof ArrayBuffer) ||
      request.state.byteLength > PDF_WORKSPACE_LIMITS.entryBytes
    )
      return Promise.reject(
        new Error('The complete PDF recovery request is oversized or unsupported.'),
      )
    const buffer = request.state.slice(0)
    const state = decodePdfWorkspaceState(buffer)
    validatePdfWorkspacePageBounds(state, active.read.pageCount)
    const byteLength = buffer.byteLength
    if (
      this.queued >= PDF_WORKSPACE_LIMITS.queuedSnapshots ||
      this.queuedBytes + byteLength > PDF_WORKSPACE_LIMITS.queuedBytes
    )
      return Promise.reject(
        new Error('The complete PDF recovery queue is full; the prior entry was kept.'),
      )
    active.received = request.sequence
    this.queued++
    this.queuedBytes += byteLength
    const sequence = request.sequence
    const token = request.token
    const captureEpoch = active.captureEpoch
    return this.queue(owner, async () => {
      if (active.captureEpoch !== captureEpoch) return { ok: true as const, skipped: true }
      this.current(owner, token)
      const bytes = encodePdfWorkspace(active.read.bytes, state, {
        displayName: basename(active.read.displayPath),
        originalPath: active.read.originalPath,
      })
      this.current(owner, token)
      const documentPath = active.read.displayPath
      const result = await this.dependencies.write(token, documentPath, bytes)
      // Bind the actual main publication even if its renderer/source was retired
      // during I/O. Close custody reads this only after the captured queue drains.
      if (result !== null) {
        if (
          !result ||
          result.id !== token ||
          result.module !== 'pdf' ||
          result.documentPath !== documentPath ||
          result.sha256 !== pdfDigest(bytes)
        )
          throw new Error(
            'The PDF journal publication did not return a verified complete-entry binding.',
          )
        active.journalBinding = { documentPath: result.documentPath, sha256: result.sha256 }
      }
      this.current(owner, token)
      if (active.captureEpoch !== captureEpoch)
        throw new Error('The earlier PDF capture settled after its producer was retired.')
      if (result === null) throw new Error('PDF recovery was invalidated before publication.')
      active.written = sequence
      active.lastStateSha256 = pdfDigest(new Uint8Array(buffer))
      return { ok: true as const }
    }).finally(() => {
      this.queued--
      this.queuedBytes -= byteLength
    })
  }
  async discard(owner: number, token: string): Promise<void> {
    const active = this.current(owner, token)
    active.live = false // synchronous invalidation precedes storage or renderer notification
    active.captureEpoch++
    active.closeStage = undefined
    this.dependencies.notify(owner, { token, reason: 'discarded' })
    await this.queue(owner, () => this.dependencies.discard(token))
  }
  async discardEntry(id: string): Promise<boolean> {
    const fork = this.forkTokens.get(id)
    if (fork) {
      fork.live = false
      const current = this.active.get(fork.owner)
      if (current?.read.id === fork.fromReadId) {
        current.live = false
        current.closeStage = undefined
        current.captureEpoch++
        this.dependencies.notify(fork.owner, { token: current.token, reason: 'discarded' })
      }
      await this.queue(fork.owner, () => this.dependencies.discard(id))
      return true
    }
    const active = [...this.active.values()].find((item) => item.token === id)
    const owner = active?.owner ?? this.tokenOwners.get(id)
    if (owner === undefined) return false
    if (active?.live) await this.discard(owner, id)
    else {
      if (active) {
        active.closeStage = undefined
        this.dependencies.notify(owner, { token: id, reason: 'discarded' })
      }
      await this.queue(owner, () => this.dependencies.discard(id))
    }
    this.tokenOwners.delete(id)
    return true
  }
  source(
    owner: number,
  ): {
    mode: 'native' | 'workspace'
    path: string
    helperPath: string
    token: string
    readId: string
  } | null {
    const active = this.active.get(owner)
    const context = this.contexts.get(owner)
    return context
      ? {
          mode: context.mode,
          path: context.path,
          helperPath: context.helperPath,
          readId: context.readId,
          token: active?.live && active.read.id === context.readId ? active.token : '',
        }
      : null
  }
  acceptUnjournaled(owner: number, path: string): PdfDraftActivation {
    if (
      !this.dependencies.alive(owner) ||
      this.dependencies.bases.owns(path) ||
      /\.vpdfdraft$/i.test(path)
    )
      throw new Error('A private workspace cannot become an unjournaled native source.')
    const active = this.active.get(owner)
    if (active) active.live = false
    this.contexts.set(owner, { mode: 'native', path, helperPath: path, readId: '' })
    return { token: '', sourceGeneration: ++this.generation, mode: 'native' }
  }
  renamed(owner: number, oldPath: string, nextPath: string): void {
    const context = this.contexts.get(owner)
    if (context?.mode === 'native' && context.path === oldPath) {
      context.path = nextPath
      context.helperPath = nextPath
    } else if (context?.mode === 'workspace' && context.path === oldPath) context.path = nextPath
    for (const read of this.reads.values())
      if (read.owner === owner && read.mode === 'native' && read.displayPath === oldPath) {
        read.displayPath = nextPath
        read.helperPath = nextPath
        if (read.originalPath === oldPath) read.originalPath = nextPath
      }
    for (const read of this.reads.values())
      if (read.owner === owner && read.mode === 'workspace' && read.displayPath === oldPath)
        read.displayPath = nextPath
    for (const read of this.reads.values())
      if (read.owner === owner && read.savedPublication?.path === oldPath)
        read.savedPublication.path = nextPath
    for (const receipt of this.receipts.values())
      if (receipt.owner === owner && receipt.outputPath === oldPath) receipt.outputPath = nextPath
    const successor = this.nativeSuccessors.get(owner)
    if (successor?.path === oldPath) successor.path = nextPath
  }
  ownerOfEntry(token: string): number | undefined {
    return this.tokenOwners.get(token)
  }
  hasForkWriter(owner: number): boolean {
    return this.forking.has(owner)
  }
  hasUnpublishedBase(owner: number): boolean {
    const readId = this.contexts.get(owner)?.readId
    return (
      (this.active.get(owner)?.read.unpublishedBase === true &&
        readId === this.active.get(owner)?.read.id) ||
      [...this.receipts.values()].some(
        (receipt) =>
          receipt.owner === owner &&
          !receipt.redacted &&
          (receipt.lifecycle.read.id === readId || receipt.readId === readId),
      )
    )
  }
  usesPrivateBase(path: string): boolean {
    return [...this.reads.values()].some((read) => {
      if (read.helperPath !== path || !this.dependencies.alive(read.owner)) return false
      const active = this.active.get(read.owner)
      return read.id !== active?.read.id || !!(active?.live || active?.closeStage)
    })
  }
  hasEarlierCleanup(owner: number): boolean {
    return (
      [...this.cleanupLineages.values()].some((active) => active.owner === owner) ||
      [...this.cleanup].some((token) => this.tokenOwners.get(token) === owner) ||
      [...this.privateCleanupOwners.values()].some((candidate) => candidate === owner)
    )
  }
  private reportFailure(active: Active, kind: 'redaction' | 'checkpoint', error: unknown): void {
    this.dependencies.failure({
      id: `pdf-${kind}:${active.token}`,
      ownerKey: String(active.owner),
      source: active.read.id,
      generation: active.generation,
      token: active.token,
      documentPath: active.read.displayPath,
      error: String(error).slice(0, 4096),
    })
  }
  stageClose(
    owner: number,
    floor: PdfDraftCloseFloor,
  ): PdfDraftCloseFloor & {
    source: string
    generation: number
    documentPath: string
    helperPath: string
    drained: Promise<void>
    journalBinding(): { documentPath: string | null; sha256: string } | null
  } {
    const active = this.current(owner, floor.token)
    if (
      floor.readId !== active.read.id ||
      !Number.isSafeInteger(floor.throughSequence) ||
      floor.throughSequence < 0 ||
      floor.throughSequence > Number.MAX_SAFE_INTEGER - 2
    )
      throw new Error('Invalid PDF producer sequence floor.')
    active.received = Math.max(active.received, floor.throughSequence)
    const staged = { token: active.token, readId: active.read.id, throughSequence: active.received }
    active.closeStage = staged
    active.captureEpoch++
    active.live = false
    this.dependencies.notify(owner, { token: active.token, reason: 'close' })
    const drained = this.queue(owner, async () => undefined)
    return {
      ...staged,
      source: active.read.id,
      generation: active.generation,
      documentPath: active.read.displayPath,
      helperPath: active.read.helperPath,
      drained,
      journalBinding: () => (active.journalBinding ? { ...active.journalBinding } : null),
    }
  }
  resumeClose(owner: number, floor: PdfDraftCloseFloor): boolean {
    const active = this.active.get(owner)
    if (
      !active ||
      active.token !== floor.token ||
      active.read.id !== floor.readId ||
      active.closeStage?.token !== floor.token ||
      !this.dependencies.alive(owner)
    )
      return false
    active.received = Math.max(
      active.received,
      active.closeStage.throughSequence,
      floor.throughSequence,
    )
    active.closeStage = undefined
    active.captureEpoch++
    active.live = true
    return true
  }
  async discardCaptured(token: string): Promise<void> {
    const owner = this.tokenOwners.get(token)
    if (owner === undefined) {
      await this.dependencies.discard(token)
      return
    }
    await this.queue(owner, () => this.dependencies.discard(token))
    this.tokenOwners.delete(token)
  }
  private async cleanupRedacted(active: Active): Promise<void> {
    for (const token of active.automaticTokens)
      if (
        [...this.active.values()].some(
          (current) =>
            current !== active && current.token === token && (current.live || current.closeStage),
        )
      )
        throw new Error(
          'An earlier original PDF view still owns automatic recovery. Its newer work was retained.',
        )
    // Inherited entries can have advanced independently since Root restored this
    // older workspace. Compare-and-delete under the shared journal lock.
    for (const [token, sha256] of active.inheritedEntries)
      await this.dependencies.discard(token, sha256)
    await this.dependencies.retireCustody({
      tokens: [...active.automaticTokens],
      inheritedEntries: [...active.inheritedEntries],
    })
    for (const token of active.automaticTokens)
      if (!active.inheritedEntries.some(([inherited]) => inherited === token))
        await this.dependencies.discard(token)
  }
  assertWritableSource(owner: number, path: string): void {
    const active = this.active.get(owner)
    if (this.hasUnpublishedBase(owner))
      throw new Error(
        'Finish the complete PDF save/recovery acknowledgment before another file rewrite. Save an unpublished recovery workspace to a new PDF copy.',
      )
    if (
      this.dependencies.bases.owns(path) ||
      /\.vpdfdraft$/i.test(path) ||
      (active?.read.mode === 'workspace' &&
        (path === active.read.helperPath || path === active.read.displayPath))
    )
      throw new Error(
        'This is a recovery workspace. Save a new PDF copy before using file-level operations.',
      )
  }
  captureCopy(
    owner: number,
    proof: PdfWorkspaceSaveProof,
  ): {
    activeToken: string
    bytes: Buffer
    state: PdfWorkspaceStateV1
    sequence: number
    stateSha256: string
    pageCount: number
    renderedStampConfig: PdfWorkspaceStateV1['edits']['stampCfg']
    lifecycle: Active
    readSerial: number
    savedPublication?: { path: string; sha256: string }
  } {
    if (this.dependencies.recoveryAvailable?.() === false)
      throw new Error('Automatic PDF recovery is unavailable. Prior complete entries were kept.')
    const active = this.current(owner, proof?.token)
    if (
      !Number.isSafeInteger(proof.sequence) ||
      proof.sequence < 1 ||
      proof.sequence < active.received
    )
      throw new Error('The PDF copy request predates a recovery capture. Retry Save.')
    if (
      !(proof.state instanceof ArrayBuffer) ||
      proof.state.byteLength > PDF_WORKSPACE_LIMITS.entryBytes
    )
      throw new Error('The complete PDF copy proof is oversized or unsupported.')
    validatePdfWorkspaceGraph(proof.renderedStampConfig)
    validatePdfStampConfig(proof.renderedStampConfig)
    const copied = proof.state.slice(0)
    const state = decodePdfWorkspaceState(copied)
    validatePdfWorkspacePageBounds(state, active.read.pageCount)
    active.received = proof.sequence
    return {
      activeToken: active.token,
      bytes: Buffer.from(active.read.bytes),
      state,
      sequence: proof.sequence,
      stateSha256: pdfDigest(new Uint8Array(copied)),
      pageCount: active.read.pageCount,
      renderedStampConfig: structuredClone(proof.renderedStampConfig),
      lifecycle: active,
      readSerial: this.readSerials.get(owner) ?? 0,
      ...(active.read.savedPublication
        ? { savedPublication: { ...active.read.savedPublication } }
        : {}),
    }
  }
  checkCopy(owner: number, capture: ReturnType<PdfDraftController['captureCopy']>): void {
    const active = this.current(owner, capture.activeToken)
    if (active.read.sha256 !== pdfDigest(capture.bytes))
      throw new Error('The PDF base changed before copy publication.')
  }
  async publication(
    owner: number,
    capture: ReturnType<PdfDraftController['captureCopy']>,
    result: {
      bytes: Buffer
      outputPath: string
      representedIds: string[]
      pageMap: Array<[number, number]>
      skipped: string[]
      redacted: boolean
    },
  ): Promise<PdfCopyReceipt> {
    const active = capture.lifecycle
    if (active.owner !== owner || active.token !== capture.activeToken)
      throw new Error('Invalid PDF publication lifecycle.')
    const receipt: PdfCopyReceipt = {
      copyId: randomUUID(),
      token: active.token,
      throughSequence: capture.sequence,
      requestedStateSha256: capture.stateSha256,
      pdfSha256: pdfDigest(result.bytes),
      representedIds: result.representedIds,
      pageMap: result.pageMap,
      complete: result.skipped.length === 0,
      representedComplete: result.skipped.length === 0,
      skipped: [...result.skipped],
      outputPath: result.outputPath,
      adopted: false,
    }
    for (const [id, value] of this.receipts) if (value.owner === owner) this.receipts.delete(id)
    const stored = {
      owner,
      oldToken: active.token,
      readId: '',
      lifecycle: active,
      outputPath: result.outputPath,
      outputSha256: receipt.pdfSha256,
      outputBytes: result.bytes.length,
      redacted: result.redacted,
      readSerial: capture.readSerial,
    }
    this.receipts.set(receipt.copyId, stored)
    try {
      const sameOwner = () =>
        this.active.get(owner) === active &&
        this.contexts.get(owner)?.readId === active.read.id &&
        (this.readSerials.get(owner) ?? 0) === capture.readSerial &&
        this.dependencies.alive(owner)
      if (result.redacted) {
        // Publication already succeeded. Retire before any classification/cleanup await,
        // so no old in-flight producer can recreate unredacted recovery afterwards.
        active.live = false
        active.captureEpoch++
        for (const token of active.automaticTokens) this.retiredOrigins.add(token)
        if (this.retiredOrigins.size > 16384)
          for (const token of this.retiredOrigins) {
            if (
              ![...this.restoredOrigins.values()].some((origin) => origin.token === token) &&
              ![...this.reads.values()].some((read) =>
                read.inheritedEntries?.some(([origin]) => origin === token),
              ) &&
              !this.tokenOwners.has(token)
            )
              this.retiredOrigins.delete(token)
            if (this.retiredOrigins.size <= 8192) break
          }
        this.dependencies.notify(owner, { token: active.token, reason: 'redacted' })
        const cleanup = this.queue(owner, () => this.cleanupRedacted(active))
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            cleanup,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('Earlier recovery cleanup is still finishing.')),
                5000,
              )
            }),
          ])
        } catch (error) {
          this.cleanupLineages.set(active.token, active)
          this.reportFailure(active, 'redaction', error)
          receipt.cleanupWarning =
            'The sanitized PDF was saved. Earlier automatic recovery cleanup is incomplete; earlier user-owned files and backups also remain.'
        } finally {
          if (timer) clearTimeout(timer)
          void cleanup.then(
            () => {
              this.cleanupLineages.delete(active.token)
              void this.dependencies
                .resolvedFailure(`pdf-redaction:${active.token}`)
                .catch(() => {})
            },
            () => {},
          )
        }
        const current = this.active.get(owner)
        if (this.dependencies.bases.owns(active.read.helperPath)) {
          if (current !== active && current?.read.helperPath === active.read.helperPath)
            receipt.cleanupWarning = `${receipt.cleanupWarning ?? 'The sanitized PDF was saved.'} An earlier private checkpoint is still in use and was retained.`
          else
            try {
              await this.removePrivate(active.read.helperPath)
            } catch {
              this.privateCleanup.add(active.read.helperPath)
              this.privateCleanupOwners.set(active.read.helperPath, owner)
              receipt.cleanupWarning = `${receipt.cleanupWarning ?? 'The sanitized PDF was saved.'} Its earlier private checkpoint could not be removed.`
            }
        }
      }
      if (!sameOwner()) {
        receipt.complete = false
        receipt.skipped.push(
          'The PDF view changed after output publication; its newer source was left intact.',
        )
        return receipt
      }
      const protection = await classifyPdfWorkspaceBase(result.bytes)
      if (!sameOwner()) {
        receipt.complete = false
        receipt.skipped.push('The PDF view changed during checkpoint preparation.')
        return receipt
      }
      if (protection.kind !== 'unencrypted') {
        receipt.complete = false
        receipt.skipped.push(protection.reason)
        if (result.redacted) {
          receipt.adopted = true
          receipt.cleanupWarning =
            `${receipt.cleanupWarning ?? ''} The sanitized output must reopen as a normal PDF; automatic recovery is unavailable for its new base.`.trim()
        }
        return receipt
      }
      if (!receipt.complete) return receipt
      const nextMode = result.redacted ? 'native' : active.read.mode
      const helperPath =
        nextMode === 'workspace'
          ? await this.dependencies.bases.create(owner, result.bytes)
          : result.outputPath
      if (!sameOwner()) {
        if (this.dependencies.bases.owns(helperPath)) await this.removePrivate(helperPath)
        receipt.complete = false
        receipt.skipped.push('The PDF source changed before checkpoint adoption.')
        return receipt
      }
      active.live = false
      if (!result.redacted)
        this.dependencies.notify(owner, { token: active.token, reason: 'checkpoint' })
      receipt.checkpoint = await this.remember(
        owner,
        {
          mode: nextMode,
          displayPath: nextMode === 'workspace' ? active.read.displayPath : result.outputPath,
          helperPath,
          bytes: result.bytes,
          sha256: receipt.pdfSha256,
          protection: 'unencrypted',
          pageCount: protection.pageCount,
          originalPath: active.read.originalPath,
          savedPublication: { path: result.outputPath, sha256: receipt.pdfSha256 },
          automaticTokens: result.redacted ? [] : [...active.automaticTokens],
          inheritedEntries: result.redacted ? [] : [...active.inheritedEntries],
        },
        () => {
          if (!sameOwner()) throw new Error('The PDF source changed before checkpoint adoption.')
        },
      )
      receipt.adopted = true
      stored.readId = receipt.checkpoint.readId
      return receipt
    } catch (error) {
      receipt.complete = false
      receipt.skipped.push('Recovery checkpoint preparation failed after actual PDF publication.')
      receipt.cleanupWarning = `${receipt.cleanupWarning ?? 'The PDF output was saved.'} Its recovery checkpoint remains incomplete: ${String(error)}`
      return receipt
    }
  }
  /** Normal publication may finish while same-ID edits, Undo or child content
   * advances. Preserve the ENTIRE current model against its immutable old base;
   * never reapply that model to the newly saved on-disk PDF. */
  async forkAfterSave(
    owner: number,
    request: PdfSaveFallbackRequest,
  ): Promise<PdfSaveFallbackResult> {
    if (this.dependencies.recoveryAvailable?.() === false)
      throw new Error('Automatic PDF recovery is unavailable. Prior complete entries were kept.')
    if (
      !request ||
      typeof request.copyId !== 'string' ||
      request.copyId.length > 128 ||
      typeof request.fromReadId !== 'string' ||
      request.fromReadId.length > 128 ||
      !(request.state instanceof ArrayBuffer) ||
      request.state.byteLength > PDF_WORKSPACE_LIMITS.entryBytes
    )
      throw new Error('Invalid complete PDF save fallback.')
    if (this.forking.has(owner) || !this.dependencies.alive(owner))
      throw new Error('Another complete PDF save fallback is still finishing.')
    request = {
      copyId: request.copyId,
      fromReadId: request.fromReadId,
      state: request.state.slice(0),
    }
    const state = decodePdfWorkspaceState(request.state),
      stateSha256 = pdfDigest(new Uint8Array(request.state))
    const existing = this.active.get(owner)
    // A failed candidate open can leave the already-created fallback alive. An
    // explicit retry may update that exact owned old-base branch, never another B.
    if (
      existing?.live &&
      existing.read.unpublishedBase &&
      existing.read.forkedFromReadId === request.fromReadId &&
      this.contexts.get(owner)?.readId === existing.read.id
    ) {
      this.forking.add(owner)
      try {
        await this.snapshot(owner, {
          token: existing.token,
          sequence: existing.received + 1,
          state: request.state,
        })
        this.current(owner, existing.token)
        return { read: this.data(existing.read), recordedStateSha256: stateSha256 }
      } finally {
        this.forking.delete(owner)
      }
    }
    const publication = this.receipts.get(request.copyId)
    if (!publication || publication.owner !== owner || publication.redacted)
      throw new Error(
        'This save fallback does not belong to an ordinary publication of this source. Sanitized output can never retain an old unredacted base.',
      )
    // After synchronous adoption, a failed acknowledgment (for example an
    // externally replaced output) must preserve the current NEW cached base and
    // its whole current model, rather than replaying that model over the old base.
    const previous =
      publication.lifecycle.read.id === request.fromReadId
        ? publication.lifecycle
        : existing?.live &&
            existing.read.id === request.fromReadId &&
            publication.readId === request.fromReadId
          ? existing
          : null
    if (!previous)
      throw new Error('This complete PDF fallback does not match the current captured base.')
    validatePdfWorkspacePageBounds(state, previous.read.pageCount)
    const envelope = encodePdfWorkspace(previous.read.bytes, state, {
      displayName: basename(previous.read.displayPath),
      originalPath: previous.read.originalPath,
    })
    const token = randomUUID(),
      staging = { owner, fromReadId: previous.read.id, live: true }
    const assertCurrent = () => {
      if (
        !staging.live ||
        !this.dependencies.alive(owner) ||
        this.contexts.get(owner)?.readId !== previous.read.id ||
        (this.readSerials.get(owner) ?? 0) !== publication.readSerial
      )
        throw new Error(
          'The PDF source changed before its complete fallback could be adopted. The current view was left intact.',
        )
    }
    assertCurrent()
    if (
      this.queued >= PDF_WORKSPACE_LIMITS.queuedSnapshots ||
      this.queuedBytes + request.state.byteLength > PDF_WORKSPACE_LIMITS.queuedBytes
    )
      throw new Error('The complete PDF fallback queue is full. Its prior recovery entry was kept.')
    if (this.tokenOwners.size >= 256)
      for (const [candidate, candidateOwner] of this.tokenOwners) {
        if (
          !this.tails.has(candidateOwner) &&
          this.active.get(candidateOwner)?.token !== candidate &&
          !this.forkTokens.has(candidate)
        )
          this.tokenOwners.delete(candidate)
      }
    if (this.tokenOwners.size >= 256)
      throw new Error(
        'Too many PDF recovery lifecycles are still finishing. The current full workspace was kept.',
      )
    const current = this.active.get(owner)
    const automaticTokens = [
      ...new Set([
        ...previous.automaticTokens,
        ...(current?.read.id === previous.read.id ? current.automaticTokens : []),
        token,
      ]),
    ]
    if (automaticTokens.length > 128)
      throw new Error('The captured PDF lineage needs checked cleanup before another fallback.')
    const inheritedEntries = [
      ...new Map([
        ...previous.inheritedEntries,
        ...(current?.read.id === previous.read.id ? current.inheritedEntries : []),
      ]),
    ]
    for (const actor of [
      previous,
      ...(current && current !== previous && current.read.id === previous.read.id ? [current] : []),
    ]) {
      actor.live = false
      actor.captureEpoch++
      this.dependencies.notify(owner, { token: actor.token, reason: 'checkpoint' })
    }
    // Admission itself establishes this automatic UUID lineage. A journal writer
    // can reject after durable publication, so failure must not orphan an old-base
    // entry outside later checked redaction/close cleanup.
    previous.automaticTokens = [...automaticTokens]
    previous.read.automaticTokens = [...automaticTokens]
    this.forking.add(owner)
    this.forkTokens.set(token, staging)
    this.tokenOwners.set(token, owner)
    this.queued++
    this.queuedBytes += request.state.byteLength
    let helper: string | undefined, readId: string | undefined
    return this.queue(owner, async () => {
      try {
        assertCurrent()
        helper = await this.dependencies.bases.create(owner, previous.read.bytes)
        assertCurrent()
        const read = await this.remember(
          owner,
          {
            mode: 'workspace',
            displayPath: previous.read.displayPath,
            helperPath: helper,
            bytes: previous.read.bytes,
            sha256: previous.read.sha256,
            protection: 'unencrypted',
            pageCount: previous.read.pageCount,
            originalPath: previous.read.originalPath,
            automaticTokens,
            inheritedEntries,
            unpublishedBase: true,
            forkedFromReadId: previous.read.id,
            savedPublication: { path: publication.outputPath, sha256: publication.outputSha256 },
          },
          assertCurrent,
        )
        readId = read.readId
        const journalPath = read.displayPath
        const written = await this.dependencies.write(token, journalPath, envelope)
        if (
          !written ||
          written.id !== token ||
          written.module !== 'pdf' ||
          written.documentPath !== journalPath ||
          written.sha256 !== pdfDigest(envelope)
        )
          throw new Error(
            'The complete fallback journal did not return a verified durable receipt.',
          )
        assertCurrent()
        const record = this.reads.get(read.readId)!
        const active: Active = {
          owner,
          token,
          generation: ++this.generation,
          read: record,
          live: true,
          received: 1,
          written: 1,
          lastStateSha256: stateSha256,
          automaticTokens,
          inheritedEntries,
          captureEpoch: 0,
          journalBinding: { documentPath: written.documentPath, sha256: written.sha256 },
        }
        this.active.set(owner, active)
        this.contexts.set(owner, {
          mode: 'workspace',
          path: record.displayPath,
          helperPath: record.helperPath,
          readId: record.id,
        })
        this.dependencies.bases.bind(record.helperPath, {
          ownerKey: String(owner),
          source: record.id,
          generation: active.generation,
          token,
          documentPath: record.displayPath,
        })
        this.receipts.delete(request.copyId)
        return { read: this.data(record), recordedStateSha256: stateSha256 }
      } catch (error) {
        if (readId && this.active.get(owner)?.read.id !== readId) this.reads.delete(readId)
        if (helper && this.dependencies.bases.owns(helper) && !this.usesPrivateBase(helper))
          try {
            await this.removePrivate(helper)
          } catch {
            this.privateCleanup.add(helper)
            this.privateCleanupOwners.set(helper, owner)
          }
        this.cleanup.add(token)
        this.reportFailure({ ...previous, token }, 'checkpoint', error)
        throw error
      }
    }).finally(() => {
      this.forking.delete(owner)
      this.forkTokens.delete(token)
      this.queued--
      this.queuedBytes -= request.state.byteLength
    })
  }
  async acknowledgeCopy(
    owner: number,
    request: { token: string; copyId: string; state: ArrayBuffer; sequence: number },
  ): Promise<void> {
    const active = this.current(owner, request.token)
    const receipt = this.receipts.get(request.copyId)
    if (!receipt || receipt.owner !== owner || receipt.readId !== active.read.id)
      throw new Error('This copy acknowledgment does not match the current PDF checkpoint.')
    if (
      !Number.isSafeInteger(request.sequence) ||
      request.sequence < 1 ||
      request.sequence > Number.MAX_SAFE_INTEGER - 1
    )
      throw new Error('Invalid PDF acknowledgment sequence.')
    if (
      !(request.state instanceof ArrayBuffer) ||
      request.state.byteLength > PDF_WORKSPACE_LIMITS.entryBytes
    )
      throw new Error('The complete PDF acknowledgment state is oversized or unsupported.')
    request = {
      token: active.token,
      copyId: request.copyId,
      sequence: request.sequence,
      state: request.state.slice(0),
    }
    const state = decodePdfWorkspaceState(request.state.slice(0))
    if (pdfWorkspacePendingReasons(state).length)
      await this.snapshot(owner, {
        token: request.token,
        sequence: request.sequence,
        state: request.state.slice(0),
      })
    else active.received = Math.max(active.received, request.sequence)
    const assertSuccessor = () => {
      if (this.current(owner, request.token) !== active)
        throw new Error('A newer PDF source replaced this acknowledgment.')
      if (active.received > request.sequence && active.written < active.received)
        throw new Error('Newer PDF recovery is not durable. The prior complete entry was retained.')
    }
    assertSuccessor()
    const output = await readPdfWorkspaceFile(receipt.outputPath, receipt.outputBytes)
    if (output.length !== receipt.outputBytes || pdfDigest(output) !== receipt.outputSha256)
      throw new Error('The saved PDF changed before acknowledgment. Earlier recovery was retained.')
    assertSuccessor()
    // A complete successor journal or a proven complete/clean checkpoint now exists.
    // Any failure remains visible, retains the entry, and can only retry this owned ID.
    const inherited = new Set(active.inheritedEntries.map(([token]) => token))
    const obsolete = active.automaticTokens.filter(
      (token) => token !== active.token && !inherited.has(token),
    )
    try {
      await this.dependencies.retireCustody({ tokens: obsolete, inheritedEntries: [] })
      await this.queue(owner, async () => {
        assertSuccessor()
        for (const token of obsolete) {
          assertSuccessor()
          await this.dependencies.discard(token)
        }
      })
      active.automaticTokens = active.automaticTokens.filter((token) => !obsolete.includes(token))
      active.read.automaticTokens = [...active.automaticTokens]
      const successor = this.nativeSuccessors.get(owner)
      if (successor?.sha256 === active.read.sha256)
        successor.automaticTokens = [...active.automaticTokens]
      for (const token of obsolete) this.tokenOwners.delete(token)
    } catch (error) {
      this.cleanup.add(receipt.oldToken)
      this.reportFailure(receipt.lifecycle, 'checkpoint', error)
      throw error
    }
    this.receipts.delete(request.copyId)
    this.tokenOwners.delete(receipt.oldToken)
  }
  async retryCleanup(owner: number): Promise<void> {
    if (!this.dependencies.alive(owner)) throw new Error('The PDF cleanup owner is no longer open.')
    for (const [token, active] of [...this.cleanupLineages])
      if (active.owner === owner) {
        await this.queue(active.owner, () => this.cleanupRedacted(active))
        await this.dependencies.resolvedFailure(`pdf-redaction:${token}`)
        this.cleanupLineages.delete(token)
      }
    for (const id of [...this.cleanup])
      if (this.tokenOwners.get(id) === owner) {
        await this.dependencies.retireCustody({ tokens: [id], inheritedEntries: [] })
        await this.dependencies.discard(id)
        await this.dependencies.resolvedFailure(`pdf-checkpoint:${id}`)
        this.cleanup.delete(id)
      }
    for (const path of [...this.privateCleanup]) {
      if (this.privateCleanupOwners.get(path) !== owner) continue
      if (
        [...this.active.values()].some((active) => active.live && active.read.helperPath === path)
      )
        throw new Error(
          'An earlier private PDF checkpoint is still in use. Close that view before retrying cleanup.',
        )
      await this.removePrivate(path)
    }
  }
  retire(owner: number): void {
    this.readSerials.set(owner, (this.readSerials.get(owner) ?? 0) + 1)
    const active = this.active.get(owner)
    const readIds = [...this.reads].filter(([, read]) => read.owner === owner).map(([id]) => id)
    const tokens = [...this.tokenOwners]
      .filter(([, tokenOwner]) => tokenOwner === owner)
      .map(([token]) => token)
    const receiptIds = [...this.receipts]
      .filter(([, receipt]) => receipt.owner === owner)
      .map(([id]) => id)
    for (const [path, origin] of this.restoredOrigins)
      if (origin.owner === owner)
        this.cancelRestoredOrigin(
          path,
          'The PDF view closed or reloaded before its trusted recovery activation.',
        )
    for (const id of readIds)
      this.reads
        .get(id)
        ?.restoreHandoff?.cancel(
          'The PDF source was retired before its trusted recovery activation.',
        )
    if (active) active.live = false
    this.contexts.delete(owner)
    this.nativeSuccessors.delete(owner)
    void this.queue(owner, async () => {
      if (this.active.get(owner) !== active || active?.live) return
      for (const id of readIds) {
        const read = this.reads.get(id)
        if (!read || read.owner !== owner) continue
        this.reads.delete(id)
        if (this.dependencies.bases.owns(read.helperPath)) {
          try {
            await this.removePrivate(read.helperPath)
          } catch {
            this.privateCleanup.add(read.helperPath)
            this.privateCleanupOwners.set(read.helperPath, owner)
          }
        }
      }
      if (this.active.get(owner) === active) this.active.delete(owner)
      for (const id of receiptIds) this.receipts.delete(id)
      // No writer remains. Future Root deletion may use the ordinary journal path.
      for (const token of tokens) this.tokenOwners.delete(token)
    }).catch(() => undefined)
  }
}
