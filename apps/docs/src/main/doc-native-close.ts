import {NativeCloseAdmission} from '../../../../packages/electron-utils/src/native-close-admission'
import {isCloseLeaseStamp,isCloseLeaseTicket,type CloseLeaseBroker,type CloseLeaseStamp,type CloseLeaseTicket} from '../../../../packages/electron-utils/src/close-lease'
import type {CloseCleanupHandle,CloseCleanupStatus} from '../../../../packages/electron-utils/src/close-cleanup'
import type {DocCloseEnvelope,DocNativeCloseRequest,DocNativeCloseResult} from '../shared/ipc'
export interface DocsNativeCloseState {dirty:boolean;autoSave:boolean;filePath?:string|null;stamp?:CloseLeaseStamp;unresponsive?:boolean}
export interface DocsClosePrepareOptions {deferSeal?:boolean;signal?:AbortSignal;isCurrent?:()=>boolean}
export type DocsCloseReceipt=
 |{kind:'lease';phase:'prepared'|'ready';intent:'save'|'discard';published:boolean;clean:boolean;source:string;closeLease:DocCloseEnvelope;cleanupId?:string}
 |{kind:'force';phase:'force';id:string;source:string;published:false;clean:false}
export interface DocStagedCloseCleanup {ready:Promise<CloseCleanupHandle|null>;actualSettled:Promise<void>;cancel():void}
export interface DocOutputPause { readonly drained:Promise<void>; isReady():boolean; resume():void; retire():void }
export interface DocNativeCloseOptions<Owner,Parent> {
 pauseOutputs(owner:Owner,source:string):DocOutputPause
 leases:CloseLeaseBroker<Owner>
 id():string
 ownerKey(owner:Owner):string
 alive(owner:Owner):boolean
 source(owner:Owner):string
 query(owner:Owner):Promise<DocsNativeCloseState>
 choose(owner:Owner,state:DocsNativeCloseState,parent:Parent|undefined,allowForce:boolean):Promise<'save'|'discard'|'force'|'cancel'>
 send(owner:Owner,request:DocNativeCloseRequest):void
 /** Synchronous captured producer retirement, indexed before any custody await. */
 stage(owner:Owner,state:DocsNativeCloseState,throughSequence:number):DocStagedCloseCleanup
 preserveRecovery(owner:Owner):()=>void
 report(owner:Owner,error:unknown):void
}
interface Pending<Owner>{deadline:number;outputs:DocOutputPause;owner:Owner;request:DocNativeCloseRequest;source:string;state:DocsNativeCloseState;options:DocsClosePrepareOptions;detachAbort():void;resolve(value:DocsCloseReceipt|null):void;timer:ReturnType<typeof setTimeout>;timedOut:boolean}
interface Prepared<Owner>{deadline:number;expiryTimer:ReturnType<typeof setTimeout>;outputs:DocOutputPause;owner:Owner;ownerKey:string;receipt:DocsCloseReceipt&{kind:'lease'};options:DocsClosePrepareOptions;detachAbort():void;stage:DocStagedCloseCleanup;handle:CloseCleanupHandle|null;staged:boolean;active:boolean;removed:boolean;committing:boolean;resolve(value:DocsCloseReceipt|null):void}
const equalTicket=(a:CloseLeaseTicket,b:CloseLeaseTicket)=>a.id===b.id&&a.sequence===b.sequence&&a.source===b.source
const envelopeOf=(value:unknown):DocCloseEnvelope|null=>{const v=value as Partial<DocCloseEnvelope>|null;return v&&isCloseLeaseTicket(v.ticket)&&isCloseLeaseStamp(v.stamp)?{ticket:v.ticket,stamp:v.stamp}:null}
const snapshot=(value:DocsClosePrepareOptions):DocsClosePrepareOptions=>({deferSeal:value.deferSeal===true,signal:value.signal,isCurrent:value.isCurrent})
/** Preparing authority is held through all approvals/drains; only final synchronous sealing starts ready's five seconds. */
export class DocNativeCloseCoordinator<Owner,Parent=undefined>{
 private readonly promptAdmission=new NativeCloseAdmission<Owner>()
 private pending=new Map<string,Pending<Owner>>()
 private prepared=new Map<string,Prepared<Owner>>()
 private staging=new Map<Owner,Promise<void>>()
 private readonly completed=new Map<string,{ownerKey:string;envelope:DocCloseEnvelope;outcome:Promise<CloseCleanupStatus>}>()
 private preparing=new Map<Owner,{work:Promise<DocsCloseReceipt|null>;allowForce:boolean;options:DocsClosePrepareOptions;outputs:DocOutputPause;cancel():void}>()
 private forces=new Map<Owner,{receipt:DocsCloseReceipt&{kind:'force'};options:DocsClosePrepareOptions;outputs:DocOutputPause;timer:ReturnType<typeof setTimeout>}>()
 constructor(private readonly options:DocNativeCloseOptions<Owner,Parent>){}
 private captureOutputs(owner:Owner,source:string):DocOutputPause{
  const pause=this.options.pauseOutputs(owner,source)
  if(!pause||!pause.drained||typeof pause.drained.then!=='function'||typeof pause.isReady!=='function'||typeof pause.resume!=='function'||typeof pause.retire!=='function')throw new Error('An export could not confirm that its file work finished. Keep this document open and retry.')
  return pause
 }
 private outputsReady(pause:DocOutputPause):boolean{try{return pause.isReady()===true}catch{return false}}
 private report(owner:Owner,error:unknown):void{try{this.options.report(owner,error)}catch{/* warning failure never retains a removal permission or prevents unlock */}}
 private cancelStage(record:Prepared<Owner>,reason:string):void{
  clearTimeout(record.expiryTimer)
  record.outputs.resume()
  try{record.stage.cancel()}catch(error){this.report(record.owner,error)}
  try{record.handle?.cancel(reason)}catch(error){this.report(record.owner,error)}
 }
 private current(owner:Owner,source:string){try{return this.options.alive(owner)&&this.options.source(owner)===source}catch{return false}}
 private permitted(options:DocsClosePrepareOptions):boolean{try{return !options.signal?.aborted&&options.isCurrent?.()!==false}catch{return false}}
 private watchAbort(options:DocsClosePrepareOptions,action:()=>void):()=>void{
  const signal=options.signal
  if(!signal)return()=>{}
  signal.addEventListener('abort',action,{once:true})
  if(signal.aborted)action()
  return()=>signal.removeEventListener('abort',action)
 }
 prepare(owner:Owner,parent?:Parent,allowForce=true,input:DocsClosePrepareOptions={}):Promise<DocsCloseReceipt|null>{
  const options=snapshot(input),prior=this.preparing.get(owner)
  if(prior)return prior.allowForce===allowForce&&prior.options.deferSeal===options.deferSeal&&prior.options.signal===options.signal&&prior.options.isCurrent===options.isCurrent?prior.work:Promise.resolve(null)
  if(this.staging.has(owner)||!this.permitted(options))return Promise.resolve(null)
  const hold=this.promptAdmission.hold(owner,owner);if(!hold)return Promise.resolve(null)
  const deadline=Date.now()+120_000
  let outputs:DocOutputPause
  try{outputs=this.captureOutputs(owner,this.options.source(owner))}catch(error){hold.release();this.report(owner,error);return Promise.resolve(null)}
  let transferred=false,active=true,refuse!:(value:null)=>void
  const refusal=new Promise<null>(resolve=>{refuse=resolve})
  const cancel=()=>{if(!active)return;active=false;outputs.resume();refuse(null)}
  const invalidate=(reason:string)=>{cancel();this.cancelDecisions(owner,undefined,reason,outputs)}
  const timer=setTimeout(()=>invalidate('native preparation timed out'),Math.max(0,deadline-Date.now()))
  const detachAbort=this.watchAbort(options,()=>invalidate('outer close canceled'))
  const guarded={...options,isCurrent:()=>active&&this.permitted(options)&&(transferred||hold.current())}
  // This races only removal permission. Genuine work remains in the output
  // registry until actual settlement; cancellation cannot retire that work.
  const flow=this.prepareOnce(owner,parent,allowForce,guarded,outputs,deadline)
  const work=Promise.race([flow,refusal]).then(receipt=>{
   if(!receipt)return null
   if(!active||!hold.current()||!this.permitted(options)){this.cancel(owner,receipt,'native prompt became obsolete');return null}
   transferred=true;return receipt
  }).catch(error=>{this.report(owner,error);return null}).finally(()=>{clearTimeout(timer);detachAbort();if(!transferred)outputs.resume();hold.release();if(this.preparing.get(owner)?.work===work)this.preparing.delete(owner)})
  this.preparing.set(owner,{work,allowForce,options,outputs,cancel});return work
 }
 canPublish(owner:Owner,ticket:unknown):boolean{
  if(!isCloseLeaseTicket(ticket)||!this.options.alive(owner))return false
  const entry=this.pending.get(ticket.id)
  if(entry&&(entry.owner!==owner||entry.timedOut||entry.request.intent!=='save'||!equalTicket(entry.request.ticket,ticket)||!this.current(owner,entry.source)||!this.permitted(entry.options)))return false
  return this.options.leases.claim(owner,ticket)
 }
 /** Main validates this ticket before exempting its own native Save from the prompt latch. */
 beginWrite(owner:Owner,automatic:boolean,ticket?:unknown):(()=>void)|null{
  if(!this.options.alive(owner)||this.promptAdmission.busy(owner))return null
  let owned=false,nativeOwned=false
  if(ticket!==undefined){
   if(!isCloseLeaseTicket(ticket))return null
   const entry=this.pending.get(ticket.id)
   if(entry){nativeOwned=entry.owner===owner&&!entry.timedOut&&entry.request.intent==='save'&&equalTicket(entry.request.ticket,ticket)&&this.current(owner,entry.source)&&this.permitted(entry.options);if(!nativeOwned)return null}
   owned=this.options.leases.claim(owner,ticket)
   if(!owned)return null
  }
  if(automatic&&([...this.prepared.values()].some(entry=>entry.owner===owner&&entry.active)||this.preparing.has(owner)))return null
  if(!automatic&&!owned)this.cancel(owner,undefined,'manual save changed the native close decision')
  return this.promptAdmission.write(owner,automatic,nativeOwned?owner:undefined)
 }
 private async prepareOnce(owner:Owner,parent:Parent|undefined,allowForce:boolean,options:DocsClosePrepareOptions,outputs:DocOutputPause,deadline:number):Promise<DocsCloseReceipt|null>{
  const source=this.options.source(owner)
  await outputs.drained
  if(Date.now()>=deadline||!this.outputsReady(outputs)||!this.current(owner,source)||!this.permitted(options))return null
  let state=await this.options.query(owner)
  if(Date.now()>=deadline||!this.current(owner,source)||!this.permitted(options))return null
  if(state.unresponsive){
   const decision=await this.options.choose(owner,state,parent,allowForce&&!options.deferSeal)
   if(Date.now()>=deadline||!allowForce||options.deferSeal||decision!=='force'||!this.current(owner,source)||!this.permitted(options)||this.options.leases.hasWriter(owner)||this.staging.has(owner))return null
   this.cancelDecisions(owner,undefined,'force replaces prior decision',outputs)
   const receipt={kind:'force' as const,phase:'force' as const,id:this.options.id(),source,published:false as const,clean:false as const}
   const timer=setTimeout(()=>{if(this.forces.get(owner)?.receipt===receipt){this.forces.delete(owner);outputs.resume()}},5_000)
   this.forces.set(owner,{receipt,options,outputs,timer});return receipt
  }
  if(!isCloseLeaseStamp(state.stamp))return null
  if(!state.dirty)return this.request(owner,state,source,'save',options,outputs,deadline)
  if(state.autoSave){
   const saved=await this.request(owner,state,source,'save',options,outputs,deadline)
   if(saved)return saved
   if(!this.current(owner,source)||!this.permitted(options)||this.options.leases.hasWriter(owner)||this.staging.has(owner))return null
   state=await this.options.query(owner)
   if(!this.current(owner,source)||!this.permitted(options)||state.unresponsive||!isCloseLeaseStamp(state.stamp))return null
  }
  const decision=await this.options.choose(owner,state,parent,allowForce&&!options.deferSeal)
  if(!this.current(owner,source)||!this.permitted(options)||(decision!=='save'&&decision!=='discard'))return null
  return this.request(owner,state,source,decision,options,outputs,deadline)
 }
 prepareDiscard(owner:Owner,expectedPath?:string|null):Promise<DocsCloseReceipt|null>{
  if(this.preparing.has(owner)||this.staging.has(owner))return Promise.resolve(null)
  const hold=this.promptAdmission.hold(owner,owner);if(!hold)return Promise.resolve(null)
  const deadline=Date.now()+120_000;let source:string,outputs:DocOutputPause
  try{source=this.options.source(owner);outputs=this.captureOutputs(owner,source)}catch(error){hold.release();this.report(owner,error);return Promise.resolve(null)}
  let transferred=false,active=true,refuse!:(value:null)=>void
  const refusal=new Promise<null>(resolve=>{refuse=resolve})
  const cancel=()=>{if(!active)return;active=false;outputs.resume();refuse(null)}
  const timer=setTimeout(()=>{cancel();this.cancelDecisions(owner,undefined,'discard preparation timed out',outputs)},Math.max(0,deadline-Date.now()))
  const options={isCurrent:()=>active&&(transferred||hold.current())}
  const flow=(async()=>{
   await outputs.drained
   if(Date.now()>=deadline||!this.outputsReady(outputs)||!options.isCurrent()||!this.current(owner,source))return null
   const state=await this.options.query(owner)
   if(!this.current(owner,source)||!options.isCurrent()||state.unresponsive||!isCloseLeaseStamp(state.stamp)||(expectedPath!==undefined&&(state.filePath??null)!==expectedPath))return null
   const receipt=await this.request(owner,state,source,'discard',options,outputs,deadline)
   if(!receipt)return null
   if(!options.isCurrent()){this.cancel(owner,receipt,'discard decision became obsolete');return null}
   transferred=true;return receipt
  })()
  const work=Promise.race([flow,refusal]).catch(error=>{this.report(owner,error);return null}).finally(()=>{clearTimeout(timer);if(!transferred)outputs.resume();hold.release();if(this.preparing.get(owner)?.work===work)this.preparing.delete(owner)})
  this.preparing.set(owner,{work,allowForce:false,options,outputs,cancel});return work
 }

 private request(owner:Owner,state:DocsNativeCloseState,source:string,intent:'save'|'discard',options:DocsClosePrepareOptions,outputs:DocOutputPause,deadline:number):Promise<DocsCloseReceipt|null>{
  if(Date.now()>=deadline||!this.current(owner,source)||!this.permitted(options)||this.staging.has(owner))return Promise.resolve(null)
  const ticket=this.options.leases.reserve(owner,this.options.id()),request:DocNativeCloseRequest={ticket,intent,sourcePath:state.filePath??null,...(intent==='discard'?{approvedStamp:state.stamp}:{})}
  return new Promise(resolve=>{
   const invalidate=(reason:string)=>{const entry=this.pending.get(ticket.id);if(!entry)return;entry.timedOut=true;clearTimeout(entry.timer);entry.detachAbort();this.options.leases.cancel(owner,ticket,reason);resolve(null)}
   const timer=setTimeout(()=>invalidate('native prepare timed out'),Math.max(0,deadline-Date.now()))
   const entry:Pending<Owner>={deadline,outputs,owner,request,source,state,options,timer,resolve,timedOut:false,detachAbort:()=>{}}
   this.pending.set(ticket.id,entry)
   entry.detachAbort=this.watchAbort(options,()=>invalidate('outer close canceled'))
   if(entry.timedOut){entry.detachAbort();this.pending.delete(ticket.id);this.options.leases.settle(owner,ticket);return}
   try{this.options.send(owner,request)}catch(error){clearTimeout(timer);entry.detachAbort();this.pending.delete(ticket.id);this.options.leases.settle(owner,ticket);this.options.leases.cancel(owner,ticket,'dispatch failed');this.report(owner,error);resolve(null)}
  })
 }
 receive(owner:Owner,id:unknown,value:unknown):void{
  if(typeof id!=='string')return
  const pending=this.pending.get(id);if(!pending||pending.owner!==owner)return
  this.pending.delete(id);clearTimeout(pending.timer);pending.detachAbort()
  const ticket=pending.request.ticket;this.options.leases.settle(owner,ticket)
  const result=value as Partial<DocNativeCloseResult>|null,envelope=envelopeOf(result?.closeLease)
  const valid=!pending.timedOut&&this.current(owner,pending.source)&&this.permitted(pending.options)&&result?.current===true&&result.intent===pending.request.intent&&typeof result.published==='boolean'&&typeof result.clean==='boolean'&&Number.isSafeInteger(result.throughSequence)&&result.throughSequence! >= 0&&(result.intent==='discard'||result.clean===true)&&!!envelope&&equalTicket(envelope.ticket,ticket)
  if(!valid||!envelope||!this.options.leases.claim(owner,ticket)){this.options.leases.cancel(owner,ticket,'native receipt refused');if(!pending.timedOut)pending.resolve(null);return}
  const receipt={kind:'lease' as const,phase:'prepared' as const,source:pending.source,intent:pending.request.intent,published:result!.published===true,clean:result!.clean===true,closeLease:envelope}
  this.stageReceipt(owner,pending.state,receipt,result!.throughSequence!,pending.resolve,pending.options,pending.outputs,pending.deadline)
 }
 /** MCP's physical save settles first; custody, then final sealing, still run in main. */
 stageSaved(owner:Owner,envelope:DocCloseEnvelope,published:boolean,throughSequence:number):Promise<DocsCloseReceipt|null>{
  if(!Number.isSafeInteger(throughSequence)||throughSequence<0||this.staging.has(owner)||!this.options.leases.claim(owner,envelope.ticket))return Promise.resolve(null)
  const deadline=Date.now()+120_000
  let source:string,outputs:DocOutputPause
  try{source=this.options.source(owner);outputs=this.captureOutputs(owner,source)}catch(error){this.report(owner,error);return Promise.resolve(null)}
  const receipt={kind:'lease' as const,phase:'prepared' as const,source,intent:'save' as const,published,clean:true,closeLease:envelope}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(0,deadline-Date.now()))
  return new Promise<DocsCloseReceipt|null>(resolve=>this.stageReceipt(owner,{dirty:false,autoSave:false,stamp:envelope.stamp},receipt,throughSequence,resolve,{signal:controller.signal},outputs,deadline)).finally(()=>clearTimeout(timer))
 }
 private stageReceipt(owner:Owner,state:DocsNativeCloseState,receipt:DocsCloseReceipt&{kind:'lease'},floor:number,resolve:(value:DocsCloseReceipt|null)=>void,options:DocsClosePrepareOptions,outputs:DocOutputPause,deadline:number):void{
  let stage:DocStagedCloseCleanup
  try{stage=this.options.stage(owner,state,floor)}catch(error){outputs.resume();this.options.leases.cancel(owner,receipt.closeLease.ticket,'custody retirement failed');this.report(owner,error);resolve(null);return}
  if(stage.actualSettled){
   const actual=Promise.all([stage.actualSettled,outputs.drained]).then(()=>{});this.staging.set(owner,actual)
   void actual.then(()=>{if(this.staging.get(owner)===actual)this.staging.delete(owner)},error=>{if(this.staging.get(owner)===actual)this.staging.delete(owner);this.report(owner,error)})
  }
  const record:Prepared<Owner>={deadline,expiryTimer:setTimeout(()=>this.cancel(owner,record.receipt,'native preparing lifetime expired'),Math.max(0,deadline-Date.now())),outputs,owner,ownerKey:this.options.ownerKey(owner),receipt,options,detachAbort:()=>{},stage,handle:null,staged:false,active:true,removed:false,committing:false,resolve}
  this.prepared.set(receipt.closeLease.ticket.id,record)
  record.detachAbort=this.watchAbort(options,()=>this.cancel(owner,record.receipt,'outer close canceled'))
  void Promise.all([stage.ready,stage.actualSettled,outputs.drained]).then(([handle])=>{
   record.staged=true;record.handle=handle
   if(handle)void handle.outcome.then(()=>{if(record.removed||!record.active)this.prepared.delete(receipt.closeLease.ticket.id)})
   if(Date.now()>=deadline||!record.active||!this.current(owner,receipt.source)||!this.permitted(options)||!this.options.leases.claim(owner,receipt.closeLease.ticket)){
    this.cancel(owner,record.receipt,'close custody became obsolete');if(!handle)this.prepared.delete(receipt.closeLease.ticket.id);resolve(null);return
   }
   if(handle)record.receipt={...receipt,cleanupId:handle.id}
   resolve(options.deferSeal?record.receipt:this.seal(owner,record.receipt))
  },error=>{this.cancel(owner,record.receipt,'custody preparation failed');this.report(owner,error);this.prepared.delete(receipt.closeLease.ticket.id);resolve(null)})
 }
 /** Local only: calling group isCurrent here would recursively rescan this receipt. */
 isPrepared(owner:Owner,receipt:DocsCloseReceipt):boolean{
  if(receipt.kind!=='lease'||receipt.phase!=='prepared')return false
  const record=this.prepared.get(receipt.closeLease.ticket.id)
  return !!record&&record.owner===owner&&record.receipt===receipt&&record.active&&record.staged&&Date.now()<record.deadline&&this.outputsReady(record.outputs)&&!record.removed&&!record.committing&&!record.options.signal?.aborted&&this.current(owner,receipt.source)&&this.options.leases.claim(owner,receipt.closeLease.ticket)
 }
 seal(owner:Owner,receipt:DocsCloseReceipt):DocsCloseReceipt|null{
  if(receipt.kind!=='lease')return null
  const record=this.prepared.get(receipt.closeLease.ticket.id)
  if(!record||!this.permitted(record.options)||!this.isPrepared(owner,receipt)||!this.options.leases.ready(owner,receipt.closeLease.ticket,receipt.closeLease.stamp)){
   this.cancel(owner,receipt,'final seal refused');return null
  }
  clearTimeout(record.expiryTimer)
  record.receipt={...receipt,phase:'ready'}
  return record.receipt
 }
 /** Called synchronously by the broker BEFORE its renderer release message. */
 released(owner:Owner,ticket:CloseLeaseTicket,reason:string):void{
  const record=this.prepared.get(ticket.id)
  if(!record||record.owner!==owner||!equalTicket(record.receipt.closeLease.ticket,ticket)||record.removed||record.committing)return
  record.active=false;record.detachAbort();this.cancelStage(record,reason);record.resolve(null)
  if(record.staged&&!record.handle)this.prepared.delete(ticket.id)
 }
 completeEnvelope(owner:Owner,value:unknown,remove:()=>boolean):boolean|undefined{
  const envelope=envelopeOf(value);if(!envelope)return false
  const record=this.prepared.get(envelope.ticket.id);if(!record)return undefined
  if(record.owner!==owner||!equalTicket(record.receipt.closeLease.ticket,envelope.ticket)||record.receipt.closeLease.stamp.source!==envelope.stamp.source||record.receipt.closeLease.stamp.revision!==envelope.stamp.revision)return false
  return this.complete(owner,record.receipt,remove)
 }
 complete(owner:Owner,receipt:DocsCloseReceipt,remove:()=>boolean):boolean{
  if(!this.current(owner,receipt.source)){this.cancel(owner,receipt,'source changed');return false}
  if(receipt.kind==='force'){
   const force=this.forces.get(owner);if(!force||force.receipt!==receipt||!this.outputsReady(force.outputs)||!this.permitted(force.options)||this.options.leases.hasWriter(owner)||this.staging.has(owner))return false
   clearTimeout(force.timer);this.forces.delete(owner);this.options.leases.cancel(owner,undefined,'explicit force removal')
   const restore=this.options.preserveRecovery(owner);let removed=false
   try{removed=remove();if(typeof removed!=='boolean')throw new Error('Force requires synchronous actual removal.');return removed}finally{if(removed===true)force.outputs.retire();else{restore();force.outputs.resume()}}
  }
  const record=this.prepared.get(receipt.closeLease.ticket.id)
  if(!record||record.owner!==owner||record.receipt!==receipt||receipt.phase!=='ready'||!record.active||!this.outputsReady(record.outputs)||!this.permitted(record.options))return false
  let removed=false
  try{return this.options.leases.complete(owner,receipt.closeLease.ticket,receipt.closeLease.stamp,()=>{
   record.committing=true;record.detachAbort()
   try{
    removed=record.handle?record.handle.commitRemoval(remove):remove()
    if(typeof removed!=='boolean')throw new Error('Close requires synchronous actual removal.')
    record.removed=removed
    if(removed)record.outputs.retire()
    if(removed&&record.handle){
      this.completed.set(receipt.closeLease.ticket.id,{ownerKey:record.ownerKey,envelope:receipt.closeLease,outcome:record.handle.outcome})
      while(this.completed.size>128)this.completed.delete(this.completed.keys().next().value!)
    }
    return removed
   }finally{record.committing=false;if(!removed){record.active=false;this.cancelStage(record,'actual removal refused')}}
  })}finally{
   record.committing=false
   if(!removed){record.active=false;record.detachAbort();this.cancelStage(record,'actual removal refused')}
   else if(!record.handle)this.prepared.delete(receipt.closeLease.ticket.id)
  }
 }
 cancel(owner:Owner,receipt?:DocsCloseReceipt,reason='close canceled'):void{this.cancelDecisions(owner,receipt,reason)}
 private cancelDecisions(owner:Owner,receipt:DocsCloseReceipt|undefined,reason:string,keep?:DocOutputPause):void{
  const preparing=this.preparing.get(owner);if(!receipt&&preparing&&preparing.outputs!==keep)preparing.cancel()
  const force=this.forces.get(owner);if(force&&(!receipt||force.receipt===receipt)){clearTimeout(force.timer);this.forces.delete(owner);force.outputs.resume()}
  if(!receipt||receipt.kind==='lease'){
   for(const entry of this.pending.values())if(entry.owner===owner&&(!receipt||equalTicket(entry.request.ticket,receipt.closeLease.ticket))){entry.timedOut=true;clearTimeout(entry.timer);entry.detachAbort();entry.resolve(null)}
   for(const record of this.prepared.values())if(record.owner===owner&&(!receipt||equalTicket(record.receipt.closeLease.ticket,receipt.closeLease.ticket))&&!record.removed&&!record.committing){record.active=false;record.detachAbort();this.cancelStage(record,reason);record.resolve(null);if(record.staged&&!record.handle)this.prepared.delete(record.receipt.closeLease.ticket.id)}
   this.options.leases.cancel(owner,receipt?.kind==='lease'?receipt.closeLease.ticket:undefined,reason)
  }
 }
 cleanup(ownerKey:string,value:unknown):Promise<CloseCleanupStatus|undefined>{
  const envelope=envelopeOf(value),record=envelope?this.prepared.get(envelope.ticket.id):undefined,completed=envelope?this.completed.get(envelope.ticket.id):undefined
  if(!envelope)return Promise.resolve(undefined)
  const same=(expected:DocCloseEnvelope)=>equalTicket(expected.ticket,envelope.ticket)&&expected.stamp.source===envelope.stamp.source&&expected.stamp.revision===envelope.stamp.revision
  if(completed&&completed.ownerKey===ownerKey&&same(completed.envelope))return completed.outcome
  if(!record||record.ownerKey!==ownerKey||!same(record.receipt.closeLease)||!record.removed)return Promise.resolve(undefined)
  return record.handle?record.handle.outcome:Promise.resolve(undefined)
 }
 destroy(owner:Owner):void{
  this.preparing.get(owner)?.cancel()
  const force=this.forces.get(owner);if(force){clearTimeout(force.timer);this.forces.delete(owner);force.outputs.resume()}
  this.promptAdmission.destroy(owner)
  for(const record of this.prepared.values())if(record.owner===owner&&!record.committing&&!record.removed){record.active=false;record.detachAbort();this.cancelStage(record,'owner destroyed');record.resolve(null)}
  for(const [id,pending]of this.pending)if(pending.owner===owner){this.pending.delete(id);clearTimeout(pending.timer);pending.detachAbort();pending.resolve(null)}
  this.preparing.delete(owner);this.options.leases.destroy(owner)
 }
}
