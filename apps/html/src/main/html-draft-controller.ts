import { createHash,randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { types } from 'node:util'
import {
  discardDraftJournal,
  writeDraftJournal,
} from '../../../../packages/electron-utils/src/draft-journal'
import type {
  HtmlDraftChange,
  HtmlDraftMaterialization,
  HtmlDraftSaveAcknowledgment,
  HtmlDraftWriteRequest,
  HtmlDraftWriteResult,
} from '../shared/html-draft'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_BYTES = 16 * 1024 * 1024
const canonical = (path: string | null) =>
  path === null ? null : process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const sequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

interface HtmlJournalBinding {receiptSequence:number;expectedDocumentPath:string|null;expectedSha256:string}
interface DraftSession {
  token: string
  documentPath: string | null
  highestReceived: number
  clearedThrough: number
  lastWritten: number
  revision: number
  sourceRevisionFloor: number
  sourceOperation: number
  active: boolean
  queue: Promise<unknown>
  receiptSequence:number
  lastWriteBinding:HtmlJournalBinding|null
  pendingWrites:Set<Promise<HtmlJournalBinding|null>>
}

export interface HtmlDraftDependencies {
  recoveryRoot: () => string
  isLive: (owner: number) => boolean
  canWritePath: (owner: number, path: string) => boolean
  /** Capture grants synchronously, then materialize the complete independent document. */
  prepare: (
    owner: number,
    path: string | null,
    bytes: Buffer,
  ) => Promise<HtmlDraftMaterialization> | HtmlDraftMaterialization
  write?: typeof writeDraftJournal
  discard?: typeof discardDraftJournal
}

/** Per-activation identities prevent candidate opens and slow saves from changing draft ownership. */
export class HtmlDraftController {
  private readonly sessions = new Map<number, DraftSession>()
  private readonly write: typeof writeDraftJournal
  private readonly discard: typeof discardDraftJournal

  constructor(private readonly dependencies: HtmlDraftDependencies) {
    this.write = dependencies.write ?? writeDraftJournal
    this.discard = dependencies.discard ?? discardDraftJournal
  }

  activate(owner: number, documentPath: unknown, revision = 0): string {
    this.assertOwner(owner)
    if (
      documentPath !== null &&
      (typeof documentPath !== 'string' ||
        !isAbsolute(documentPath) ||
        !this.dependencies.canWritePath(owner, documentPath))
    )
      throw new Error('Draft activation is not an opened document.')
    if (!sequence(revision)) throw new Error('Invalid HTML document revision.')
    const previous = this.sessions.get(owner)
    if (previous) previous.active = false
    const token = randomUUID()
    this.sessions.set(owner, {
      token,
      documentPath,
      highestReceived: 0,
      clearedThrough: 0,
      lastWritten: 0,
      revision,
      sourceRevisionFloor: 0,
      sourceOperation: 0,
      active: true,
      queue: Promise.resolve(),
      receiptSequence:0,lastWriteBinding:null,pendingWrites:new Set(),
    })
    return token
  }

  /** Renderer crash/destruction preserves the last committed journal. */
  retire(owner: number): void {
    const state = this.sessions.get(owner)
    if (state) state.active = false
    this.sessions.delete(owner)
  }

  tokenFor(owner: number): string | null {
    return this.sessions.get(owner)?.token ?? null
  }

  pathFor(owner: number): string | null | undefined {
    return this.sessions.get(owner)?.documentPath
  }

  isActivation(owner: number, token: unknown): boolean {
    const state = this.sessions.get(owner)
    return (
      typeof token === 'string' && !!state && state.token === token && this.isCurrent(owner, state)
    )
  }

  sourceOperationFor(owner: number): number | null {
    return this.sessions.get(owner)?.sourceOperation ?? null
  }

  acceptsSourceRevision(owner: number, token: string, revision: number): boolean {
    const state = this.current(owner, token)
    return sequence(revision) && revision >= state.sourceRevisionFloor
  }

  /** Same-path Reload retains the UUID and sequence; only the prior content epoch is retired. */
  async applyReload(owner: number, value: unknown): Promise<void> {
    const request = value as {
      token: string
      documentPath: string
      previousRevision: number
      revision: number
      throughSequence: number
    } | null
    if (
      !request ||
      !UUID.test(request.token) ||
      typeof request.documentPath !== 'string' ||
      !sequence(request.previousRevision) ||
      !sequence(request.revision) ||
      request.revision <= request.previousRevision ||
      !sequence(request.throughSequence)
    )
      throw new Error('Invalid HTML reload receipt.')
    const state = this.current(owner, request.token)
    if (
      !this.dependencies.canWritePath(owner, request.documentPath) ||
      canonical(request.documentPath) !== canonical(state.documentPath) ||
      request.previousRevision < state.sourceRevisionFloor
    )
      throw new Error('HTML reload belongs to an obsolete document source.')
    state.sourceOperation++
    state.sourceRevisionFloor = request.revision
    state.revision = Math.max(state.revision, request.revision)
    state.clearedThrough = Math.max(state.clearedThrough, request.throughSequence)
    await this.serialized(state, async () => {
      if (state.lastWritten > request.throughSequence) return
      await this.discard(this.dependencies.recoveryRoot(), state.token)
      state.lastWriteBinding=null
    })
  }

  rename(owner: number, oldPath: string, newPath: string): void {
    const state = this.sessions.get(owner)
    if (state && canonical(state.documentPath) === canonical(oldPath)) state.documentPath = newPath
  }

  changed(owner: number, value: unknown): boolean {
    const request = value as HtmlDraftChange | null
    if (
      !request ||
      !UUID.test(request.token) ||
      !sequence(request.revision) ||
      typeof request.dirty !== 'boolean'
    )
      throw new Error('Invalid HTML draft change.')
    const state = this.current(owner, request.token)
    if (request.revision < state.revision) return false
    state.revision = request.revision
    return true
  }

  revisionFor(owner: number): number | null {
    return this.sessions.get(owner)?.revision ?? null
  }

  async snapshot(owner: number, value: unknown): Promise<HtmlDraftWriteResult> {
    const request = value as HtmlDraftWriteRequest | null
    if (
      !request ||
      !UUID.test(request.token) ||
      !sequence(request.sequence) ||
      request.sequence < 1 ||
      !sequence(request.revision) ||
      !types.isArrayBuffer(request.data) ||
      request.data.byteLength > MAX_BYTES
    )
      throw new Error('Invalid draft snapshot or the complete document exceeds its 16 MiB limit.')
    const state = this.current(owner, request.token)
    if (
      request.documentPath !== null &&
      (typeof request.documentPath !== 'string' ||
        !this.dependencies.canWritePath(owner, request.documentPath))
    )
      throw new Error('Draft snapshot is not an opened document.')
    if (canonical(request.documentPath) !== canonical(state.documentPath))
      return { written: false, remoteReferences: 0 }
    if (request.sequence <= state.clearedThrough || request.sequence <= state.highestReceived)
      return { written: false, remoteReferences: 0 }
    if (request.revision < state.revision) return { written: false, remoteReferences: 0 }
    state.revision = request.revision
    state.highestReceived = request.sequence
    // Copy before any await; the caller cannot mutate a snapshot being prepared.
    const input = Buffer.from(new Uint8Array(request.data))
    const materialized = await this.dependencies.prepare(owner, state.documentPath, input)
    const { bytes, remoteReferences } = materialized
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length > MAX_BYTES ||
      !sequence(remoteReferences) ||
      remoteReferences > 10000
    )
      throw new Error('The complete HTML draft exceeds its 16 MiB limit.')
    return this.serialized(state, async () => {
      if (
        !this.isCurrent(owner, state) ||
        canonical(request.documentPath) !== canonical(state.documentPath) ||
        request.sequence <= state.clearedThrough ||
        request.sequence !== state.highestReceived ||
        request.revision !== state.revision
      )
        return { written: false, remoteReferences: 0 }
      const pathAtWrite=state.documentPath,expectedSha256=createHash('sha256').update(bytes).digest('hex')
      const writing=this.write(this.dependencies.recoveryRoot(),{id:state.token,module:'html',documentPath:pathAtWrite,extension:'.html',bytes}).then(entry=>{
        if(!entry)return null
        if(entry.id!==state.token||entry.module!=='html'||canonical(entry.documentPath)!==canonical(pathAtWrite)||entry.extension!=='.html'||entry.bytes!==bytes.length||entry.sha256!==expectedSha256)throw new Error('The HTML journal writer returned an unverified receipt; the previous custody binding is retained.')
        const receiptSequence=state.receiptSequence+1
        if(!Number.isSafeInteger(receiptSequence))throw new Error('The HTML journal receipt sequence is exhausted; its previous copy is retained.')
        state.receiptSequence=receiptSequence
        const binding=Object.freeze({receiptSequence,expectedDocumentPath:entry.documentPath,expectedSha256:entry.sha256})
        state.lastWriteBinding=binding
        return binding
      })
      state.pendingWrites.add(writing)
      let entry:HtmlJournalBinding|null
      try{entry=await writing}finally{state.pendingWrites.delete(writing)}
      if(entry)state.lastWritten=request.sequence
      if (
        !this.isCurrent(owner, state) ||
        request.sequence <= state.clearedThrough ||
        request.revision < state.sourceRevisionFloor
      )
        return { written: false, remoteReferences: 0 }
      return { written: entry !== null, remoteReferences }
    })
  }

  async acknowledgeSaved(owner: number, value: unknown): Promise<boolean> {
    const request = value as HtmlDraftSaveAcknowledgment | null
    if (
      !request ||
      !UUID.test(request.token) ||
      !sequence(request.throughSequence) ||
      typeof request.clean !== 'boolean' ||
      !sequence(request.revision) ||
      (request.documentPath !== null &&
        (typeof request.documentPath !== 'string' ||
          !this.dependencies.canWritePath(owner, request.documentPath)))
    )
      throw new Error('Invalid saved-draft acknowledgment.')
    const state = this.current(owner, request.token)
    if (request.documentPath === null && state.documentPath !== null)
      throw new Error('A named document cannot become untitled through a clean acknowledgment.')
    if (request.revision < state.sourceRevisionFloor) return false
    state.documentPath = request.documentPath
    if (!request.clean || request.revision !== state.revision) return false
    // This watermark also rejects snapshots still serializing in the renderer.
    state.clearedThrough = Math.max(state.clearedThrough, request.throughSequence)
    await this.serialized(state, async () => {
      // A newer dirty snapshot may already have committed while save was awaiting.
      if (state.lastWritten > request.throughSequence) return
      await this.discard(this.dependencies.recoveryRoot(), state.token)
      state.lastWriteBinding=null
    })
    return true
  }

  /** Retire an approved close producer, drain its accepted commits, and KEEP its durable bytes. */
  stageClose(owner:number,value:unknown):{token:string;documentPath:string|null;drain:Promise<void>;attest:()=>{expectedDocumentPath:string|null;expectedSha256:string}|null;cancel:()=>void}{
    const request=value as HtmlDraftSaveAcknowledgment|null
    if(!request||!UUID.test(request.token)||!sequence(request.throughSequence)||!sequence(request.revision)||(request.documentPath!==null&&typeof request.documentPath!=='string'))throw new Error('Invalid captured HTML close journal.')
    const state=this.current(owner,request.token)
    if(request.revision!==state.revision||canonical(request.documentPath)!==canonical(state.documentPath))throw new Error('The approved HTML journal source changed.')
    // No old snapshot may enter the writer after this synchronous retirement.
    state.active=false
    state.sourceOperation++
    state.clearedThrough=Math.max(state.clearedThrough,state.highestReceived,request.throughSequence)
    // Seal only the baseline and the accepted writes captured at retirement.
    // Never look up this owner's resumed/replacement producer after an await.
    let sealed=state.lastWriteBinding,drained=false
    const accepted=Promise.allSettled([...state.pendingWrites])
    const drain=state.queue.catch(()=>{}).then(async()=>{for(const result of await accepted)if(result.status==='fulfilled'&&result.value&&(!sealed||result.value.receiptSequence>sealed.receiptSequence))sealed=result.value;drained=true})
    const attest=()=>{if(!drained)throw new Error('The captured HTML journal writer drain is unfinished; its prior copy is retained.');return sealed?{expectedDocumentPath:sealed.expectedDocumentPath,expectedSha256:sealed.expectedSha256}:null}
    return {token:state.token,documentPath:state.documentPath,drain,attest,cancel:()=>{
      // A canceled outer close must never rearm a replacement activation or dead owner.
      if(this.sessions.get(owner)===state&&this.dependencies.isLive(owner))state.active=true
    }}
  }

  /** Explicit discard waits for an in-flight commit and cannot resurrect it later. */
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
      state.lastWriteBinding=null
    } catch (error) {
      // A storage failure refuses the close/replacement. The still-open
      // document must remain able to journal new edits and retry discard;
      // snapshots already started before the decision stay invalid.
      if (!this.sessions.has(owner) && this.dependencies.isLive(owner)) {
        state.active = true
        this.sessions.set(owner, state)
      }
      throw error
    }
  }

  private assertOwner(owner: number): void {
    if (!Number.isSafeInteger(owner) || !this.dependencies.isLive(owner))
      throw new Error('This document view is no longer active.')
  }

  private current(owner: number, token: string): DraftSession {
    this.assertOwner(owner)
    const state = this.sessions.get(owner)
    if (!state || state.token !== token || !state.active)
      throw new Error('The draft belongs to a different document activation.')
    return state
  }

  private isCurrent(owner: number, state: DraftSession): boolean {
    return state.active && this.sessions.get(owner) === state && this.dependencies.isLive(owner)
  }

  private async serialized<T>(state: DraftSession, operation: () => Promise<T>): Promise<T> {
    const pending = state.queue.catch(() => {}).then(operation)
    state.queue = pending
    return pending
  }
}
