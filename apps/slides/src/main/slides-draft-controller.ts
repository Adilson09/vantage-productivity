import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import {
  discardDraftJournal,
  writeDraftJournal,
} from '../../../../packages/electron-utils/src/draft-journal'
import type {
  SlidesDraftSaveAcknowledgment,
  SlidesDraftWriteRequest,
  SlidesPendingDraft,
} from '../shared/slides-draft'
import {
  inspectDraftBudget,
  SLIDES_DRAFT_MAX_BYTES,
  SLIDES_DRAFT_PENDING_BYTES,
} from './slides-draft-package'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const canonical = (path: string | null) =>
  path === null ? null : process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const sequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
interface Source {
  path: string
}
interface DraftSession {
  token: string
  source: Source
  documentPath: string | null
  highestReceived: number
  clearedThrough: number
  lastWritten: number
  active: boolean
  queue: Promise<unknown>
  pending: Set<Promise<unknown>>
  receipts:Set<{sequence:number;binding:Readonly<{expectedDocumentPath:string|null;expectedSha256:string}>|null}>
  lastBinding: {expectedDocumentPath:string|null;expectedSha256:string}|null
}
export interface SlidesDraftDependencies {
  recoveryRoot: () => string
  sourceFor: (owner: number) => Source | undefined
  revisionFor: (owner: number) => string | null
  isLive: (owner: number) => boolean
  /** Synchronous capture returns an immutable serializer, never the mutable live deck. */
  capture: (owner: number, pending: SlidesPendingDraft) => () => Promise<Buffer>
  write?: typeof writeDraftJournal
  discard?: typeof discardDraftJournal
  retaining?: (owner:number)=>boolean
}

/** Per-view identities preserve independent overlays even when views alias one live deck. */
export class SlidesDraftController {
  private readonly sessions = new Map<number, DraftSession>()
  private preparationTail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private queuedBytes = 0
  private readonly write: typeof writeDraftJournal
  private readonly discard: typeof discardDraftJournal
  constructor(private readonly dependencies: SlidesDraftDependencies) {
    this.write = dependencies.write ?? writeDraftJournal
    this.discard = dependencies.discard ?? discardDraftJournal
  }
  activate(owner: number, documentPath: unknown): string {
    const source = this.source(owner)
    if (documentPath !== null && (typeof documentPath !== 'string' || !isAbsolute(documentPath)))
      throw new Error('Draft activation is not an opened presentation.')
    if (canonical(documentPath as string | null) !== canonical(source.path || null))
      throw new Error('Draft activation belongs to a different presentation.')
    const prior = this.sessions.get(owner)
    if (prior) prior.active = false
    const token = randomUUID()
    this.sessions.set(owner, {
      token,
      source,
      documentPath: documentPath as string | null,
      highestReceived: 0,
      clearedThrough: 0,
      lastWritten: 0,
      active: true,
      queue: Promise.resolve(),
      pending: new Set(),
      receipts:new Set(),
      lastBinding:null,
    })
    return token
  }
  tokenFor(owner: number): string | null {
    const state = this.sessions.get(owner)
    return state && this.isCurrent(owner, state) ? state.token : null
  }
  ownsToken(owner:number,token:string):boolean{const state=this.sessions.get(owner);return!!state&&state.token===token&&this.dependencies.sourceFor(owner)===state.source}
  retire(owner: number): void {
    const state = this.sessions.get(owner)
    if (state) state.active = false
    this.sessions.delete(owner)
  }
  rename(source: Source, oldPath: string | null, newPath: string): void {
    for (const state of this.sessions.values())
      if (state.source === source && canonical(state.documentPath) === canonical(oldPath))
        state.documentPath = newPath
  }
  async snapshot(owner: number, value: unknown): Promise<boolean> {
    let request = value as SlidesDraftWriteRequest | null
    if (
      !request ||
      !UUID.test(request.token) ||
      !sequence(request.sequence) ||
      request.sequence < 1 ||
      typeof request.expectedRevision !== 'string' ||
      request.expectedRevision.length < 1 ||
      request.expectedRevision.length > 128 ||
      (request.documentPath !== null &&
        (typeof request.documentPath !== 'string' ||
          request.documentPath.length > 32768 ||
          !isAbsolute(request.documentPath))) ||
      !request.pending ||
      typeof request.pending !== 'object' ||
      Array.isArray(request.pending)
    )
      throw new Error('Invalid presentation recovery snapshot.')
    const pendingBytes = inspectDraftBudget(request.pending, SLIDES_DRAFT_PENDING_BYTES, 50000)
    const bytes =
      pendingBytes +
      Buffer.byteLength(request.documentPath ?? '') +
      Buffer.byteLength(request.expectedRevision) +
      128
    const state = this.sessions.get(owner)
    if (
      !state ||
      state.token !== request.token ||
      !this.isCurrent(owner, state) ||
      canonical(request.documentPath) !== canonical(state.documentPath) ||
      request.sequence <= state.clearedThrough ||
      request.sequence <= state.highestReceived
    )
      return false
    if (this.queued >= 16 || this.queuedBytes + bytes > 8 * 1024 * 1024)
      throw new Error(
        'Presentation recovery is busy; its previous draft was kept. Retry after earlier snapshots finish.',
      )
    const pending = structuredClone(request.pending)
    const captured: SlidesDraftWriteRequest = {
      token: request.token,
      sequence: request.sequence,
      documentPath: request.documentPath,
      expectedRevision: request.expectedRevision,
      pending,
    }
    state.highestReceived = request.sequence
    request = null
    value = undefined
    this.queued++
    this.queuedBytes += bytes
    const receipt={sequence:captured.sequence,binding:null as Readonly<{expectedDocumentPath:string|null;expectedSha256:string}>|null}
    state.receipts.add(receipt)
    const operation = this.preparationTail
      .catch(() => {})
      .then(async () => {
        if (!this.validSnapshot(owner, state, captured)) return false
        this.requireRevision(owner, captured)
        const serialize = this.dependencies.capture(owner, pending)
        const data = await serialize()
        if (!Buffer.isBuffer(data) || data.length < 1 || data.length > SLIDES_DRAFT_MAX_BYTES)
          throw new Error('The complete presentation draft exceeds its 16 MiB limit.')
        return this.serialized(state, async () => {
          if (!this.validSnapshot(owner, state, captured)) return false
          this.requireRevision(owner, captured)
          const writtenPath=state.documentPath
          const entry = await this.write(this.dependencies.recoveryRoot(), {
            id: state.token,
            module: 'slides',
            documentPath: writtenPath,
            extension: '.pptx',
            bytes: data,
          })
          if (entry) {
            if(entry.id!==state.token||entry.module!=='slides'||entry.extension!=='.pptx'||entry.bytes!==data.length||canonical(entry.documentPath)!==canonical(writtenPath)||entry.sha256!==createHash('sha256').update(data).digest('hex'))throw new Error('The presentation journal returned an unverified main write receipt; previous authority is retained.')
            state.lastWritten = captured.sequence
            state.lastBinding=Object.freeze({expectedDocumentPath:entry.documentPath,expectedSha256:entry.sha256})
            receipt.binding=state.lastBinding
          }
          return entry !== null
        })
      })
    this.preparationTail = operation
    state.pending.add(operation)
    try {
      return await operation
    } finally {
      state.pending.delete(operation)
      state.receipts.delete(receipt)
      this.queued--
      this.queuedBytes -= bytes
    }
  }
  async acknowledgeSaved(owner: number, value: unknown): Promise<void> {
    const request = value as SlidesDraftSaveAcknowledgment | null
    if (
      !request ||
      !UUID.test(request.token) ||
      !sequence(request.throughSequence) ||
      typeof request.clean !== 'boolean' ||
      typeof request.documentPath !== 'string' ||
      !isAbsolute(request.documentPath)
    )
      throw new Error('Invalid presentation save acknowledgment.')
    const state = this.sessions.get(owner)
    if (!state || state.token !== request.token || !this.isCurrent(owner, state)) return
    if (canonical(request.documentPath) !== canonical(state.source.path || null))
      throw new Error('The saved presentation path no longer belongs to this view.')
    state.documentPath = request.documentPath
    if (!request.clean) return
    state.clearedThrough = Math.max(state.clearedThrough, request.throughSequence)
    await this.serialized(state, async () => {
      if (state.lastWritten > request.throughSequence) return
      if(!this.dependencies.retaining?.(owner))await this.discard(this.dependencies.recoveryRoot(), state.token)
    })
  }
  /** Invalidate synchronously before awaiting storage, including a Root Recovery discard. */
  async discardCurrent(owner: number): Promise<void> {
    const state = this.sessions.get(owner)
    if (!state) return
    state.active = false
    state.clearedThrough = Math.max(state.clearedThrough, state.highestReceived)
    this.sessions.delete(owner)
    try {
      await this.serialized(state, () =>
        this.discard(this.dependencies.recoveryRoot(), state.token),
      )
    } catch (error) {
      if (
        !this.sessions.has(owner) &&
        this.dependencies.isLive(owner) &&
        this.dependencies.sourceFor(owner) === state.source
      ) {
        state.active = true
        this.sessions.set(owner, state)
      }
      throw error
    }
  }
  /** Retire this exact per-view producer now, KEEP durable bytes until actual removal. */
  stageClose(owner:number,throughSequence=0){
    const state=this.sessions.get(owner)
    if(!state||!this.isCurrent(owner,state))throw new Error('Presentation recovery is not active for this source.')
    state.active=false
    state.clearedThrough=Math.max(state.clearedThrough,state.highestReceived,throughSequence)
    const baseline=state.lastBinding?Object.freeze({...state.lastBinding}):null
    const acceptedReceipts=[...state.receipts]
    let sealed:Readonly<{expectedDocumentPath:string|null;expectedSha256:string}>|null=null
    const drained=Promise.allSettled([...state.pending,state.queue]).then(()=>{const last=acceptedReceipts.filter(receipt=>receipt.binding).sort((a,b)=>a.sequence-b.sequence).at(-1);sealed=last?.binding?Object.freeze({...last.binding}):baseline})
    let removed=false
    return {token:state.token,documentPath:state.documentPath,ready:drained,
      attest:()=>sealed?{...sealed}:null,
      removed:()=>{removed=true;if(this.sessions.get(owner)===state)this.sessions.delete(owner)},
      cancel:()=>{if(!removed&&this.sessions.get(owner)===state&&this.dependencies.isLive(owner)&&this.dependencies.sourceFor(owner)===state.source)state.active=true},
      cleanup:async(signal:AbortSignal)=>{await drained;signal.throwIfAborted();if(sealed)await this.discard(this.dependencies.recoveryRoot(),state.token,{expectedSha256:sealed.expectedSha256})},
    }
  }
  private source(owner: number): Source {
    const source = this.dependencies.sourceFor(owner)
    if (!Number.isSafeInteger(owner) || !this.dependencies.isLive(owner) || !source)
      throw new Error('This presentation view is no longer active.')
    return source
  }
  private requireRevision(owner: number, request: SlidesDraftWriteRequest): void {
    if (this.dependencies.revisionFor(owner) !== request.expectedRevision)
      throw new Error(
        'The presentation changed while recovery was queued; its previous draft was kept. A later snapshot will retry.',
      )
  }
  private isCurrent(owner: number, state: DraftSession): boolean {
    return (
      state.active &&
      this.sessions.get(owner) === state &&
      this.dependencies.isLive(owner) &&
      this.dependencies.sourceFor(owner) === state.source
    )
  }
  private validSnapshot(
    owner: number,
    state: DraftSession,
    request: SlidesDraftWriteRequest,
  ): boolean {
    return (
      this.isCurrent(owner, state) &&
      canonical(request.documentPath) === canonical(state.documentPath) &&
      request.sequence > state.clearedThrough &&
      request.sequence === state.highestReceived
    )
  }
  private async serialized<T>(state: DraftSession, operation: () => Promise<T>): Promise<T> {
    const pending = state.queue.catch(() => {}).then(operation)
    state.queue = pending
    return pending
  }
}
