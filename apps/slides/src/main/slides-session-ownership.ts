import {AsyncLocalStorage} from 'node:async_hooks'
interface Context<Source extends object>{identity:string;owner:number;source:Source|undefined;revision:number}
export interface SlidesOwnershipHost<Source extends object>{source(owner:number):Source|undefined;identity?(owner:number):string;batch?(source:Source):object|undefined;changed(source:Source):void}
/** All aliases share this main-owned mutation domain. A cancelled close is revoked before work is accepted. */
export class SlidesSessionOwnership<Source extends object>{
 private readonly context=new AsyncLocalStorage<Context<Source>>()
 private readonly revisions=new WeakMap<Source,number>()
 private readonly running=new Map<Source,number>()
 private readonly opening=new Map<number,number>()
 private readonly batchHolds=new Map<Source,number>()
 private readonly paused=new Map<Source,number>()
 private readonly actualWaiters=new Map<Source,Set<()=>void>>()
 private readonly runningBatches=new Map<object,Map<Source,number>>()
 constructor(private readonly host:SlidesOwnershipHost<Source>){}
 revision(source:Source):number{return this.revisions.get(source)??0}
 busy(source:Source):boolean{return (this.running.get(source)??0)>0||(this.batchHolds.get(source)??0)>0}
 actualIdle(source:Source):boolean{return(this.running.get(source)??0)===0}
 actualBatchSources(batch:object):readonly Source[]{return [...(this.runningBatches.get(batch)?.keys()??[])]}
 waitActual(source:Source):Promise<void>{if(this.actualIdle(source))return Promise.resolve();return new Promise(resolve=>{let waiters=this.actualWaiters.get(source);if(!waiters){waiters=new Set();this.actualWaiters.set(source,waiters)}waiters.add(resolve)})}
 holdBatch(source:Source):()=>void{this.batchHolds.set(source,(this.batchHolds.get(source)??0)+1);let done=false;return()=>{if(done)return;done=true;const count=(this.batchHolds.get(source)??1)-1;if(count)this.batchHolds.set(source,count);else this.batchHolds.delete(source)}}
 pauseOrdinary(source:Source):()=>void{this.paused.set(source,(this.paused.get(source)??0)+1);let done=false;return()=>{if(done)return;done=true;const count=(this.paused.get(source)??1)-1;if(count)this.paused.set(source,count);else this.paused.delete(source)}}
 /** Capability caller has validated exact batch identity. No ordinary invoke or
  * batch hold is entered here: waiting on either would create a self-wait. */
 finishBatch(source:Source,collapse:()=>number|null):number|null{if(!this.actualIdle(source))throw new Error('Actual presentation work is still running.');return this.context.exit(collapse)}
 private bump(source:Source):void{this.host.changed(source);this.revisions.set(source,this.revision(source)+1);const context=this.context.getStore();if(context?.source===source)context.revision=this.revision(source)}
 assert(source:Source):void{const context=this.context.getStore();if(context&&(this.host.source(context.owner)!==context.source||context.identity!==(this.host.identity?.(context.owner)??'')))throw new Error('The presentation changed before its pending operation finished.');this.bump(source)}
 /** Invoke before a main-owned Session/model replacement, including after awaited decode/generation. */
 adopt(owner:number,next:Source):void{const context=this.context.getStore();if(context&&(context.owner!==owner||this.host.source(owner)!==context.source||context.identity!==(this.host.identity?.(owner)??'')||(context.source&&this.revision(context.source)!==context.revision)))throw new Error('Newer presentation edits prevented an obsolete source replacement.');const current=this.host.source(owner);if(current)this.host.changed(current);if(context){context.source=next;context.revision=this.revision(next)}}
 run<Result>(owner:number,action:()=>Result,readOnly=false):Result{
  const source=this.host.source(owner),context:Context<Source>={identity:this.host.identity?.(owner)??'',owner,source,revision:source?this.revision(source):0}
  if(!readOnly&&source&&(this.paused.get(source)??0)>0)throw new Error('Owned history cleanup is still finishing. Retry after it settles.')
  if(!readOnly&&source)this.host.changed(source)
  if(!readOnly){if(source)this.running.set(source,(this.running.get(source)??0)+1);else this.opening.set(owner,(this.opening.get(owner)??0)+1)}
  const batch=!readOnly&&source?this.host.batch?.(source):undefined
  if(batch&&source){let sources=this.runningBatches.get(batch);if(!sources){sources=new Map();this.runningBatches.set(batch,sources)}sources.set(source,(sources.get(source)??0)+1)}
  let settled=false
  const done=()=>{if(settled)return;settled=true;if(batch&&source){const sources=this.runningBatches.get(batch),count=(sources?.get(source)??1)-1;if(count)sources?.set(source,count);else sources?.delete(source);if(sources?.size===0)this.runningBatches.delete(batch)}if(!readOnly){if(source){const count=(this.running.get(source)??1)-1;if(count)this.running.set(source,count);else{this.running.delete(source);const waiters=this.actualWaiters.get(source);this.actualWaiters.delete(source);for(const resolve of waiters??[])resolve()}}else{const count=(this.opening.get(owner)??1)-1;if(count)this.opening.set(owner,count);else this.opening.delete(owner)}}}
  try{return this.context.run(context,()=>{if(!readOnly&&source)this.bump(source);const result=action();if(result&&typeof(result as {then?:unknown}).then==='function')return Promise.resolve(result).finally(done) as Result;done();return result})}catch(error){done();throw error}
 }
}
let mutationGuard:(source:object)=>void=()=>{}
export function configureSlidesMutationGuard(guard:(source:object)=>void):void{mutationGuard=guard}
export function beforeSlidesSessionMutation(source:object):void{mutationGuard(source)}
