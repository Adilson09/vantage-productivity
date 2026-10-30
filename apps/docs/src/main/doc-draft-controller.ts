import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { types } from 'node:util'
import {
  discardDraftJournal,
  writeDraftJournal,
} from '../../../../packages/electron-utils/src/draft-journal'
import type { DocDraftSaveAcknowledgment, DocDraftWriteRequest } from '../shared/doc-draft'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_BYTES = 16 * 1024 * 1024
const canonical = (path: string | null) =>
  path === null ? null : process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const sequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

interface DraftSession {
  token: string
  documentPath: string | null
  highestReceived: number
  clearedThrough: number
  lastWritten: number
  lastWrittenDocumentPath:string|null
  lastWrittenSha256?:string
  active: boolean
  queue: Promise<unknown>
}

export interface DocDraftDependencies {
  recoveryRoot: () => string
  isLive: (owner: number) => boolean
  canWritePath: (owner: number, path: string) => boolean
  /** Capture protection synchronously, then materialize/protect the complete package. */
  prepare: (
    owner: number,
    path: string | null,
    bytes: Buffer,
    expectedProtected: boolean,
  ) => Buffer | Promise<Buffer>
  write?: typeof writeDraftJournal
  discard?: typeof discardDraftJournal
}

export interface DocDraftCloseStage {
 token:string
 documentPath:string|null
 drained:Promise<void>
 binding():{expectedDocumentPath:string|null;expectedSha256?:string}|null
 cancel():void
 discardCaptured(signal:AbortSignal):Promise<void>
}

/** Per-activation identities prevent candidate opens and slow saves from changing draft ownership. */
export class DocDraftController {
  private readonly sessions = new Map<number, DraftSession>()
  private readonly activations = new Map<number,symbol>()
  private readonly write: typeof writeDraftJournal
  private readonly discard: typeof discardDraftJournal

  constructor(private readonly dependencies: DocDraftDependencies) {
    this.write = dependencies.write ?? writeDraftJournal
    this.discard = dependencies.discard ?? discardDraftJournal
  }

  activate(owner: number, documentPath: unknown): string {
    this.assertOwner(owner)
    if (
      documentPath !== null &&
      (typeof documentPath !== 'string' ||
        !isAbsolute(documentPath) ||
        !this.dependencies.canWritePath(owner, documentPath))
    )
      throw new Error('Draft activation is not an opened document.')
    const previous = this.sessions.get(owner)
    if (previous) previous.active = false
    const token = randomUUID()
    this.activations.set(owner,Symbol('document activation'))
    this.sessions.set(owner, {
      token,
      documentPath,
      highestReceived: 0,
      clearedThrough: 0,
      lastWritten: 0,
      lastWrittenDocumentPath:documentPath,
      active: true,
      queue: Promise.resolve(),
    })
    return token
  }

  /** Renderer crash/destruction preserves the last committed journal. */
  retire(owner: number): void {
    this.activations.delete(owner)
    const state = this.sessions.get(owner)
    if (state) state.active = false
    this.sessions.delete(owner)
  }

  tokenFor(owner: number): string | null {
    return this.sessions.get(owner)?.token ?? null
  }

  rename(owner: number, oldPath: string, newPath: string): void {
    const state = this.sessions.get(owner)
    if (state && canonical(state.documentPath) === canonical(oldPath)) state.documentPath = newPath
  }

  async snapshot(owner: number, value: unknown): Promise<boolean> {
    const request = value as DocDraftWriteRequest | null
    if (
      !request ||
      !UUID.test(request.token) ||
      !sequence(request.sequence) ||
      request.sequence < 1 ||
      typeof request.encrypted !== 'boolean' ||
      !types.isArrayBuffer(request.data) ||
      request.data.byteLength < 1 ||
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
    if (canonical(request.documentPath) !== canonical(state.documentPath)) return false
    if (request.sequence <= state.clearedThrough || request.sequence <= state.highestReceived)
      return false
    state.highestReceived = request.sequence
    // Copy before any await; the caller cannot mutate a snapshot being prepared.
    const input = Buffer.from(new Uint8Array(request.data))
    const bytes = await this.dependencies.prepare(
      owner,
      state.documentPath,
      input,
      request.encrypted,
    )
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BYTES)
      throw new Error('The complete protected draft exceeds its 16 MiB limit.')
    return this.serialized(state, async () => {
      if (
        !this.isCurrent(owner, state) ||
        canonical(request.documentPath) !== canonical(state.documentPath) ||
        request.sequence <= state.clearedThrough ||
        request.sequence !== state.highestReceived
      )
        return false
      const writtenPath=state.documentPath
      const entry = await this.write(this.dependencies.recoveryRoot(), {
        id: state.token,
        module: 'docs',
        documentPath: writtenPath,
        extension: '.docx',
        bytes,
      })
      if(entry){
        if(entry.id!==state.token||entry.module!=='docs'||canonical(entry.documentPath)!==canonical(writtenPath)||entry.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new Error('The actual journal write did not return the captured document binding.')
        state.lastWritten=request.sequence;state.lastWrittenDocumentPath=entry.documentPath;state.lastWrittenSha256=entry.sha256
      }
      return entry !== null
    })
  }

  async acknowledgeSaved(owner: number, value: unknown): Promise<void> {
    const request = value as DocDraftSaveAcknowledgment | null
    if (
      !request ||
      !UUID.test(request.token) ||
      !sequence(request.throughSequence) ||
      typeof request.clean !== 'boolean' ||
      typeof request.documentPath !== 'string' ||
      !this.dependencies.canWritePath(owner, request.documentPath)
    )
      throw new Error('Invalid saved-draft acknowledgment.')
    const state = this.current(owner, request.token)
    state.documentPath = request.documentPath
    if (!request.clean) return
    // This watermark also rejects snapshots still serializing in the renderer.
    state.clearedThrough = Math.max(state.clearedThrough, request.throughSequence)
    await this.serialized(state, async () => {
      // A newer dirty snapshot may already have committed while save was awaiting.
      if (state.lastWritten > request.throughSequence) return
      await this.discard(this.dependencies.recoveryRoot(), state.token)
    })
  }

  /** Retire accepted work without deleting its durable journal before actual removal. */
  stageClose(owner:number,throughSequence:number):DocDraftCloseStage|null {
    if(!sequence(throughSequence))throw new Error('Invalid close recovery watermark.')
    const state=this.sessions.get(owner)
    if(!state)return null
    state.active=false
    state.clearedThrough=Math.max(state.clearedThrough,state.highestReceived,throughSequence)
    this.sessions.delete(owner)
    const root=this.dependencies.recoveryRoot(),token=state.token,documentPath=state.documentPath,activation=this.activations.get(owner)
    const writtenBinding=()=>state.lastWritten>0?{expectedDocumentPath:state.lastWrittenDocumentPath,expectedSha256:state.lastWrittenSha256}:null
    let capturedBinding=writtenBinding()
    // Seal inside the captured queue after accepted writers, before any newer
    // resumed setter can commit. Never re-read the resumed lifecycle later.
    const drained=this.serialized(state,async()=>{capturedBinding=writtenBinding()})
    let canceled=false,deletionAuthorized=false
    return {token,documentPath,drained,
      binding:()=>capturedBinding?{...capturedBinding}:null,
      cancel:()=>{
        if(canceled||deletionAuthorized)return
        canceled=true
        if(activation!==undefined&&this.activations.get(owner)===activation&&!this.sessions.has(owner)&&this.dependencies.isLive(owner)){
          state.active=true
          this.sessions.set(owner,state)
        }
      },
      discardCaptured:signal=>{
        signal.throwIfAborted()
        if(canceled)throw new Error('A canceled captured producer cannot authorize journal deletion.')
        deletionAuthorized=true
        return this.serialized(state,async()=>{
          signal.throwIfAborted()
          // No main-owned complete write means no journal deletion authority.
          // The custody stage already refused an unknown existing entry.
          if(capturedBinding){
            if(!capturedBinding.expectedSha256)throw new Error('Captured recovery has no verified main-owned payload hash.')
            await this.discard(root,token,{expectedSha256:capturedBinding.expectedSha256})
          }
          if(this.activations.get(owner)===activation)this.activations.delete(owner)
        })
      },
    }
  }

  /** Explicit discard waits for an in-flight commit and cannot resurrect it later. */
  async discardCurrent(owner: number): Promise<void> {
    const state = this.sessions.get(owner)
    if (!state) return
    const activation=this.activations.get(owner)
    state.active = false
    state.clearedThrough = Math.max(state.clearedThrough, state.highestReceived)
    this.sessions.delete(owner)
    try {
      await this.serialized(state, () =>
        this.discard(this.dependencies.recoveryRoot(), state.token),
      )
      if(this.activations.get(owner)===activation)this.activations.delete(owner)
    } catch (error) {
      // A storage failure refuses the close/replacement. The still-open
      // document must remain able to journal new edits and retry discard;
      // snapshots already started before the decision stay invalid.
      if (activation!==undefined&&this.activations.get(owner)===activation&&!this.sessions.has(owner) && this.dependencies.isLive(owner)) {
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
