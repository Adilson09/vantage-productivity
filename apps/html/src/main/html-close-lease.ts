import type {PublicationVersion} from '../../../../packages/electron-utils/src/document-publication'
import type {NativeClosePromptHold} from '../../../../packages/electron-utils/src/native-close-admission'
import { randomUUID } from 'node:crypto'
import { CloseLeaseBroker, type CloseLeaseStamp, type CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
import type { HtmlSourceState, HtmlCloseReceipt,HtmlNativeCloseReceipt } from '../shared/html-close-lease'
import type { HtmlSaveTicket, SaveMode } from '../shared/ipc'
export interface HtmlClosePrepareOptions {deferSeal?:boolean;signal?:AbortSignal;isCurrent?:()=>boolean}
export function htmlClosePermit(options:HtmlClosePrepareOptions={}):boolean{try{return !options.signal?.aborted&&options.isCurrent?.()!==false}catch{return false}}
interface Options {
  alive(owner: number): boolean
  pathAllowed(owner: number, path: string): boolean
  send(owner: number, mode: SaveMode, request: HtmlSaveTicket): void
  release(owner: number, ticket: CloseLeaseTicket, reason: string): void
  validate?(owner:number,ticket:CloseLeaseTicket,stamp:CloseLeaseStamp,result:HtmlCloseReceipt):boolean
  setTimer?(callback: () => void, milliseconds: number): unknown
  clearTimer?(timer: unknown): void
}
interface RecordEntry {
  publicationTarget?:PublicationVersion
  requestId: string; source: string; sourcePath: string | null; targetPath?: string; requireClean: boolean; intent: 'save' | 'discard' | 'clean'; approved?: CloseLeaseStamp
  ticket?: CloseLeaseTicket; phase: 'preparing' | 'prepared' | 'ready' | 'cancelled'; rendererFinished: boolean
  permit:HtmlClosePrepareOptions;approval?:HtmlCloseReceipt;detachAbort?:()=>void
  writes: number; publications: number; publishedPath?: string; settled: boolean;retainedAssets:boolean
  completion?: HtmlCloseReceipt; complete(result: HtmlCloseReceipt): void; timer?: unknown
}
export interface HtmlMutationWork { owner: number; source: string; record?: RecordEntry }
const ticketEqual = (a: CloseLeaseTicket, b: CloseLeaseTicket) => a.id === b.id && a.sequence === b.sequence && a.source === b.source
const stampEqual = (a: CloseLeaseStamp, b: CloseLeaseStamp) => a.source === b.source && a.revision === b.revision
function isStamp(value: unknown): value is CloseLeaseStamp {
  const stamp = value as CloseLeaseStamp | null
  return !!stamp && typeof stamp.source === 'string' && stamp.source.length > 0 && stamp.source.length <= 256 && typeof stamp.revision === 'string' && /^[0-9]{1,16}$/.test(stamp.revision) && Number.isSafeInteger(Number(stamp.revision))
}
function isTicket(value: unknown): value is CloseLeaseTicket {
  const ticket = value as CloseLeaseTicket | null
  return !!ticket && typeof ticket.id === 'string' && /^[0-9a-f-]{36}$/.test(ticket.id) && Number.isSafeInteger(ticket.sequence) && ticket.sequence > 0 && typeof ticket.source === 'string' && ticket.source.length <= 512
}
/** Main owns permission, writer lifetime and publication proof; renderer owns no expiry timer. */
export class HtmlCloseCoordinator {
  private readonly records = new Map<number, RecordEntry>()
  private readonly states = new Map<number, HtmlSourceState>()
  private readonly sessions = new Map<number, string>()
  private readonly mutations = new Map<number, number>()
  private readonly broker: CloseLeaseBroker<number>
  private readonly setTimer: (callback: () => void, milliseconds: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  constructor(private readonly options: Options) {
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.broker = new CloseLeaseBroker({ alive: owner => options.alive(owner), source: owner => this.source(owner), validate: (owner, ticket, stamp) => this.validReady(owner, ticket, stamp), release: (owner, ticket, reason) => this.released(owner, ticket, reason), setTimer: this.setTimer, clearTimer: this.clearTimer })
  }
  open(owner: number): void { this.sessions.set(owner, randomUUID()); this.states.delete(owner) }
  session(owner:number):string{return this.sessions.get(owner)??'unopened'}
  source(owner: number): string { return (this.sessions.get(owner) ?? 'unopened') + ':' + (this.states.get(owner)?.stamp.source ?? 'loading') }
  state(owner: number): HtmlSourceState | null { return this.states.get(owner) ?? null }
  pending(owner: number): boolean { return this.records.has(owner) }
  busy(owner: number): boolean { return (this.mutations.get(owner) ?? 0) !== 0 }
  observe(owner: number, value: unknown): boolean {
    const state = value as HtmlSourceState | null
    if (!this.options.alive(owner) || !state || !isStamp(state.stamp) || (state.path !== null && (typeof state.path !== 'string' || !this.options.pathAllowed(owner, state.path))) || ['ready','dirty','pending','busy','composing'].some(key => typeof state[key as keyof HtmlSourceState] !== 'boolean')) return false
    const previous = this.states.get(owner)
    if (previous && Number(state.stamp.revision) < Number(previous.stamp.revision)) return false
    const record = this.records.get(owner)
    if (record?.ticket && previous && (previous.stamp.source !== state.stamp.source || (record.phase==='ready'||record.phase==='prepared')&&JSON.stringify(previous)!==JSON.stringify(state)||record.intent==='discard'&&previous.stamp.revision!==state.stamp.revision)) this.broker.cancel(owner, record.ticket, 'source or authored state changed')
    this.states.set(owner, { ...state, stamp: { ...state.stamp } })
    return true
  }
  request(owner: number, mode: SaveMode, targetPath?: string, requireClean = false, intent: 'save' | 'discard' | 'clean' = 'save', approved?: CloseLeaseStamp, prepareOptions:HtmlClosePrepareOptions={},publicationTarget?:PublicationVersion): Promise<HtmlCloseReceipt> {
    if (!this.options.alive(owner)) return Promise.reject(new Error('The Html view is no longer open.'))
    if (this.records.has(owner)) return Promise.reject(new Error('Another Html save/close writer is still finishing.'))
    const permit=Object.freeze({deferSeal:prepareOptions.deferSeal===true,signal:prepareOptions.signal,isCurrent:prepareOptions.isCurrent})
    if(!htmlClosePermit(permit))return Promise.reject(new Error('The close operation was canceled before request delivery.'))
    if(requireClean&&this.busy(owner))return Promise.reject(new Error('An actual document writer is still finishing.'))
    const requestId = randomUUID(), source = this.source(owner), sourcePath = this.states.get(owner)?.path ?? null
    const ticket = requireClean ? this.broker.reserve(owner, requestId) : undefined
    return new Promise(resolve => {
      const record: RecordEntry = { publicationTarget,permit,requestId, source, sourcePath, targetPath, requireClean, intent, approved, ticket, phase:'preparing',rendererFinished:false,writes:0,publications:0,settled:false,retainedAssets:false,complete:resolve }
      this.records.set(owner, record)
      if(permit.signal){const abort=()=>this.cancelRecord(owner,record,'The owned close operation was aborted.');permit.signal.addEventListener('abort',abort,{once:true});record.detachAbort=()=>permit.signal?.removeEventListener('abort',abort)}
      if(!htmlClosePermit(permit)){record.rendererFinished=true;this.cancelRecord(owner,record,'The close operation ended before request delivery.');return}
      if (!ticket) record.timer = this.setTimer(() => this.cancelRecord(owner, record, 'Save confirmation expired; an outstanding write may still publish later.'), 120000)
      try { this.options.send(owner, mode, {requestId,requireClean,sourcePath,targetPath,closeLease:ticket,intent,approved}) }
      catch (error) { record.rendererFinished = true; this.cancelRecord(owner, record, String(error)) }
    })
  }
  matches(owner:number,requestId:unknown):boolean{const record=this.records.get(owner);return !!record&&record.requestId===requestId&&record.phase==='preparing'&&record.source===this.source(owner)&&htmlClosePermit(record.permit)}
  intent(owner:number,requestId:unknown):'save'|'discard'|'clean'|undefined{const record=this.records.get(owner);return record&&record.requestId===requestId?record.intent:undefined}
  publicationTarget(owner:number,requestId:unknown):PublicationVersion|undefined{const record=this.records.get(owner);return record&&this.matches(owner,requestId)?record.publicationTarget:undefined}
  target(owner: number, requestId: unknown): string | undefined { const record = this.records.get(owner); return record && record.requestId === requestId && record.phase === 'preparing' ? record.targetPath : undefined }
  ownsCloseWrite(owner:number,requestId:unknown):boolean{const entry=this.records.get(owner);return !!entry?.ticket&&entry.requireClean&&entry.phase==='preparing'&&this.matches(owner,requestId)}
  beginMutation(owner: number, requestId?: unknown, expected?: CloseLeaseStamp): HtmlMutationWork {
    if (!this.options.alive(owner)) throw new Error('The document is no longer open.')
    const recordAtStart = this.records.get(owner)
    if(recordAtStart&&requestId===recordAtStart.requestId&&!htmlClosePermit(recordAtStart.permit)){this.cancelRecord(owner,recordAtStart,'The group ended before the actual write.');throw new Error('The close group is no longer current; no write was accepted.')}
    if (requestId && (!recordAtStart || recordAtStart.requestId !== requestId || recordAtStart.phase !== 'preparing')) throw new Error('The save request expired before write delivery.')
    const state = this.states.get(owner)
    if (expected && (!isStamp(expected) || state?.stamp.source !== expected.source)) throw new Error('The asset/write target source changed.')
    const record = this.records.get(owner)
    if (record?.ticket && (record.requestId !== requestId || record.phase !== 'preparing')) this.broker.cancel(owner, record.ticket, 'another main mutation started')
    this.mutations.set(owner, (this.mutations.get(owner) ?? 0) + 1)
    const owned = record && record.requestId === requestId ? record : undefined
    if (owned) owned.writes++
    return {owner,source:this.source(owner),record:owned}
  }
  current(work: HtmlMutationWork): boolean { return this.options.alive(work.owner) && this.source(work.owner) === work.source && (!work.record||work.record.phase==='preparing'&&htmlClosePermit(work.record.permit)) }
  finishMutation(work: HtmlMutationWork, publishedPath?: string,retainedAssets=false): void {
    this.mutations.set(work.owner, Math.max(0,(this.mutations.get(work.owner) ?? 1)-1))
    const record = work.record
    if (record) { record.retainedAssets ||= retainedAssets; record.writes--; if (publishedPath) { record.publications++; record.publishedPath=publishedPath } if (record.rendererFinished && record.writes===0) this.finishRecord(work.owner,record) }
  }
  receive(owner: number, value: unknown): void {
    const result = value as HtmlCloseReceipt | null, record = this.records.get(owner)
    if (!record || record.phase==='ready'||record.phase==='prepared' || !result || result.requestId !== record.requestId || typeof result.published !== 'boolean' || typeof result.current !== 'boolean' || typeof result.clean !== 'boolean') return
    record.rendererFinished = true; record.completion = result
    if (record.writes === 0) this.finishRecord(owner,record)
  }
  private finishRecord(owner: number, record: RecordEntry): void {
    if (this.records.get(owner) !== record || record.writes !== 0 || !record.rendererFinished) return
    if (record.phase === 'cancelled') { if (record.ticket) this.broker.settle(owner,record.ticket); record.detachAbort?.();this.records.delete(owner); return }
    const received = record.completion
    if (!received) { this.cancelRecord(owner,record,'The renderer finished without a valid receipt.'); return }
    const result: HtmlCloseReceipt = {requestId:record.requestId,published:record.publications>0,path:record.publishedPath,current:received.current && this.source(owner)===record.source,clean:received.clean,...(typeof received.error==='string'?{error:received.error.slice(0,1024)}:{}),...(received.closeLease?{closeLease:received.closeLease}:{}),...(typeof received.previewProof==='string'&&received.previewProof.length<=128?{previewProof:received.previewProof}:{}),...(received.draft?{draft:received.draft}:{}),...(record.retainedAssets?{assetCleanup:{assets:'retained'},warnings:['Some image files were kept because another open copy or a saved version may still need them.']}:{}) }
    if (record.ticket) {
      this.broker.settle(owner,record.ticket)
      const lease=received.closeLease
      if(!result.current||record.intent!=='discard'&&!result.clean||!lease||!isTicket(lease.ticket)||!ticketEqual(lease.ticket,record.ticket)||!isStamp(lease.stamp)||!htmlClosePermit(record.permit)||!this.validReady(owner,record.ticket,lease.stamp)){this.cancelRecord(owner,record,'Current editor state is not prepared to close.');return}
      record.phase='prepared';result.phase='prepared';result.closeLease={ticket:{...record.ticket},stamp:{...lease.stamp}};record.approval=result
      if(record.permit.deferSeal)this.resolve(record,result)
      else{const sealed=this.seal(owner,result);if(sealed)this.resolve(record,sealed);else this.cancelRecord(owner,record,'The close seal was refused.')}
    } else {
      if (record.timer !== undefined) this.clearTimer(record.timer)
      record.detachAbort?.();this.records.delete(owner); this.resolve(record,result)
    }
  }
  private validReady(owner: number, ticket: CloseLeaseTicket, stamp: CloseLeaseStamp): boolean {
    const record=this.records.get(owner),state=this.states.get(owner)
    return !!record && !record.permit.signal?.aborted && record.requestId===ticket.id && record.source===this.source(owner) && !!state && stampEqual(state.stamp,stamp) && state.ready && (record.intent === 'discard' ? !!record.approved && stampEqual(record.approved,stamp) : !state.dirty && !state.pending) && !state.busy && !state.composing && !this.busy(owner) && record.writes===0 && !!record.completion && this.options.validate?.(owner,ticket,stamp,record.completion)!==false
  }
  /** LOCAL predicate only; group isCurrent may iterate this method. Never recurse into it. */
  isPrepared(owner:number,receipt:HtmlCloseReceipt):boolean{const record=this.records.get(owner),lease=receipt.closeLease;return!!record&&record.phase==='prepared'&&receipt.phase==='prepared'&&record.approval===receipt&&!!record.ticket&&!!lease&&ticketEqual(record.ticket,lease.ticket)&&!record.permit.signal?.aborted&&this.validReady(owner,record.ticket,lease.stamp)&&this.broker.claim(owner,record.ticket)}
  seal(owner:number,receipt:HtmlCloseReceipt):HtmlNativeCloseReceipt|null{const record=this.records.get(owner);if(!record||!htmlClosePermit(record.permit)||!this.isPrepared(owner,receipt)){if(receipt.closeLease)this.cancel(owner,receipt.closeLease.ticket,'The deferred close source or permit expired.');return null}const lease=receipt.closeLease!;if(!this.broker.ready(owner,lease.ticket,lease.stamp))return null;const ready={...receipt,phase:'ready' as const};record.phase='ready';record.approval=ready;return ready}
  claim(owner:number,value:unknown):boolean { return isTicket(value) && this.broker.claim(owner,value) }
  cancel(owner:number,value?:unknown,reason='cancelled'):void { if (value===undefined) {const record=this.records.get(owner);if(record&&!record.ticket)this.cancelRecord(owner,record,reason);else this.broker.cancel(owner,undefined,reason)} else if(isTicket(value)) this.broker.cancel(owner,value,reason) }
  private cancelRecord(owner:number,record:RecordEntry,reason:string):void {
    if(record.ticket){this.broker.cancel(owner,record.ticket,reason);return}
    record.phase='cancelled';if(record.timer!==undefined)this.clearTimer(record.timer)
    this.resolve(record,{requestId:record.requestId,published:record.publications>0,current:false,clean:false,error:reason})
    if(record.rendererFinished&&record.writes===0){record.detachAbort?.();this.records.delete(owner)}
  }
  private released(owner:number,ticket:CloseLeaseTicket,reason:string):void {
    const record=this.records.get(owner)
    if(record?.ticket&&ticketEqual(record.ticket,ticket)) {
      record.phase='cancelled';this.resolve(record,{requestId:record.requestId,published:record.publications>0,current:false,clean:false,error:reason})
      if(record.rendererFinished&&record.writes===0){this.broker.settle(owner,ticket);record.detachAbort?.();this.records.delete(owner)}
    }
    this.options.release(owner,ticket,reason)
  }
  private resolve(record:RecordEntry,result:HtmlCloseReceipt):void { if(record.settled)return;record.settled=true;record.complete(result) }
  complete(owner:number,receipt:HtmlCloseReceipt,remove:()=>boolean):boolean {
    const record=this.records.get(owner),lease=receipt.closeLease
    if(!record?.ticket||!lease||receipt.phase!=='ready'||record.phase!=='ready'||record.approval!==receipt||!htmlClosePermit(record.permit)||record.requestId!==receipt.requestId||!ticketEqual(record.ticket,lease.ticket)){if(lease)this.broker.cancel(owner,lease.ticket,'obsolete close receipt');return false}
    return this.broker.complete(owner,lease.ticket,lease.stamp,remove)
  }
  rendererGone(owner:number):void {
    const record=this.records.get(owner)
    if(record){record.rendererFinished=true;if(record.ticket)this.broker.cancel(owner,record.ticket,'renderer source ended');else this.cancelRecord(owner,record,'renderer source ended');if(record.writes===0)this.finishRecord(owner,record)}
    this.states.delete(owner);this.sessions.set(owner,randomUUID())
  }
  destroy(owner:number):void { this.rendererGone(owner);if(!this.busy(owner))this.broker.destroy(owner) }
}

export interface HtmlNativeCloseHost {holdAutomaticSaves():NativeClosePromptHold|null;alive():boolean;readOnly?():boolean;state():HtmlSourceState|null;retainedAssets():Promise<readonly string[]>;prompt(retainedCount:number):Promise<number>;prepare(intent:'save'|'discard'|'clean',approved:CloseLeaseStamp|undefined,options:HtmlClosePrepareOptions):Promise<HtmlNativeCloseReceipt>;cancel(receipt:HtmlCloseReceipt):void|Promise<void>}
/** The actual native control flow is dependency-injected only at platform query/dialog boundaries. */
export async function runHtmlNativeClose(host:HtmlNativeCloseHost,options:HtmlClosePrepareOptions={}):Promise<HtmlNativeCloseReceipt|null>{
 const external=Object.freeze({deferSeal:options.deferSeal===true,signal:options.signal,isCurrent:options.isCurrent})
 if(!host.alive()||!htmlClosePermit(external))return null
 if(host.readOnly?.()){const receipt=await host.prepare('clean',undefined,external);if(!host.alive()||!htmlClosePermit(external)){await host.cancel(receipt);return null}return receipt}
 const hold=host.holdAutomaticSaves();if(!hold)return null
 let transferred=false
 const permit={...external,isCurrent:()=>htmlClosePermit(external)&&(transferred||hold.current())},allowed=()=>host.alive()&&htmlClosePermit(permit)
 try{
  const prepared=async(intent:'save'|'discard'|'clean',stamp?:CloseLeaseStamp)=>{if(!allowed())return null;const receipt=await host.prepare(intent,stamp,permit);if(!allowed()){await host.cancel(receipt);return null}transferred=true;return receipt}
  const observed=host.state();if(!observed?.ready||observed.busy||observed.composing)return null
  const same=()=>{const current=host.state();return!!current&&current.stamp.source===observed.stamp.source&&current.stamp.revision===observed.stamp.revision}
  if(!observed.dirty&&!observed.pending)return await prepared('clean')
  const retained=await host.retainedAssets();if(!allowed()||!same())return null
  const response=await host.prompt(retained.length);if(!allowed()||!same()||response===2)return null
  return await prepared(response===1?'discard':'save',observed.stamp)
 }finally{hold.release()}
}
