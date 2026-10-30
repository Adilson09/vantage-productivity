import { randomUUID } from 'node:crypto'
import { isSlidesHistoryBatchTicket,type SlidesHistoryBatchTicket } from '../shared/slides-history-batch'
export interface SlidesHistoryBatchHost<Owner extends object,Source extends object,Batch extends object>{
 source(owner:Owner):Source|undefined
 begin(source:Source):Batch
 carriers(batch:Batch,origin:Source,owner:Owner):readonly Source[]
 sameBatch(source:Source,batch:Batch):boolean
 actualBatchSources(batch:Batch):readonly Source[]
 closed(batch:Batch):boolean
 hold(source:Source):()=>void
 pause(source:Source):()=>void
 waitActual(source:Source):Promise<void>
 actualIdle(source:Source):boolean
 /** Synchronous exact-batch collapse, with no ordinary invoke entered. */
 finish(source:Source,batch:Batch,carriers:readonly Source[]):number|null
 report(error:unknown):void
}
interface RecordOf<Owner,Source,Batch>{owner:Owner;frame:string;origin:Source;batch:Batch;ticket:SlidesHistoryBatchTicket;release():void;finishing?:Promise<number|null>}
/** One nonce owns one depth increment on one exact batch object. Holds and
 * finish waiters are deliberately excluded from the actual-running drain. */
export class SlidesHistoryBatches<Owner extends object,Source extends object,Batch extends object>{
 private readonly records=new Map<string,RecordOf<Owner,Source,Batch>>()
 private readonly destroyed=new WeakSet<Owner>()
 private readonly closedFrames=new WeakMap<Owner,Set<string>>()
 private readonly knownSources=new WeakMap<Batch,Set<Source>>()
 constructor(private readonly host:SlidesHistoryBatchHost<Owner,Source,Batch>){}
 begin(owner:Owner,frame:string):SlidesHistoryBatchTicket|null{
  if(this.destroyed.has(owner)||this.closedFrames.get(owner)?.has(frame))throw new Error('This history batch owner has ended.')
  if(!frame||frame.length>128||(this.closedFrames.get(owner)?.size??0)>=64||this.records.size>=512||[...this.records.values()].filter(value=>value.owner===owner).length>=32)throw new Error('Too many unsettled history batches.')
  const source=this.host.source(owner);if(!source)return null
  const ticket=Object.freeze({nonce:randomUUID()}),release=this.host.hold(source)
  let batch:Batch
  try{batch=this.host.begin(source)}catch(error){release();throw error}
  let sources=this.knownSources.get(batch);if(!sources){sources=new Set();this.knownSources.set(batch,sources)}sources.add(source)
  this.records.set(ticket.nonce,{owner,frame,origin:source,batch,ticket,release})
  return ticket
 }
 finish(owner:Owner,frame:string,value:unknown):Promise<number|null>{
  if(!isSlidesHistoryBatchTicket(value))return Promise.reject(new Error('Invalid owned history batch receipt.'))
  const record=this.records.get(value.nonce)
  if(!record||record.owner!==owner||record.frame!==frame||record.finishing)return Promise.reject(new Error('History batch receipt is stale, already used or belongs to another owner.'))
  return this.start(record)
 }
 private start(record:RecordOf<Owner,Source,Batch>):Promise<number|null>{
  if(record.finishing)return record.finishing
  const actual=(async()=>{
   const sources=new Set<Source>([record.origin]),pauses=new Map<Source,()=>void>()
   const carriers=()=>{
    const current=this.host.carriers(record.batch,record.origin,record.owner),known=this.knownSources.get(record.batch)??new Set<Source>()
    for(const source of current)known.add(source)
    this.knownSources.set(record.batch,known)
    return [...new Set([...current,...known])].filter(source=>this.host.sameBatch(source,record.batch))
   }
   let completed=false
   try{
    for(;;){
     for(const source of [...carriers(),...this.host.actualBatchSources(record.batch)])sources.add(source)
     for(const source of sources)if(!pauses.has(source))pauses.set(source,this.host.pause(source))
     // Wait ONLY actual ordinary invokes. Neither batch lifetime holds nor any
     // concurrent finish continuation contributes to this wait predicate.
     await Promise.all([...sources].map(source=>this.host.waitActual(source)))
     const observed=[...carriers(),...this.host.actualBatchSources(record.batch)]
     if(observed.some(source=>!sources.has(source))){for(const source of observed)sources.add(source);continue}
     if([...sources].some(source=>!this.host.actualIdle(source)))continue
     // No await between the final actual-idle check and the exact synchronous
     // collapse. An unrelated replacement batch is never an end target.
     const exact=carriers()
     if(this.host.closed(record.batch)){const result=this.host.finish(record.origin,record.batch,exact);completed=true;return result}
     const carrier=exact[0]
     if(!carrier)throw new Error('The captured batch carrier cannot be attested; its ownership remains held.')
     const result=this.host.finish(carrier,record.batch,exact);completed=true;return result
    }
   }catch(error){try{this.host.report(error)}catch{};throw error}
   finally{
    if(completed||this.host.closed(record.batch)){
     for(const release of pauses.values())release()
     record.release();if(this.records.get(record.ticket.nonce)===record)this.records.delete(record.ticket.nonce)
    }
    // Failed/unattested collapse keeps its holds and paused admission. A caller
    // error or timeout is never evidence that the native batch ended.
   }
  })()
  record.finishing=actual;return actual
 }
 retireFrames(owner:Owner):Promise<void>{
  let frames=this.closedFrames.get(owner);if(!frames){frames=new Set();this.closedFrames.set(owner,frames)}
  const records=[...this.records.values()].filter(record=>record.owner===owner)
  for(const record of records)frames.add(record.frame)
  return Promise.allSettled(records.map(record=>this.start(record))).then(results=>{const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failure)throw failure.reason})
 }
 destroy(owner:Owner):Promise<void>{this.destroyed.add(owner);return this.retireFrames(owner)}
 /** Undo/Redo may settle legacy orphaned batches, never a live capability.
  * Match the batch object across every owner, including carried/aliased sources. */
 assertReplayAllowed(batch:Batch|undefined):void{
  if(batch&&[...this.records.values()].some(record=>record.batch===batch))throw new Error('History replay must wait for the owned history batch to finish.')
 }
 busy(owner:Owner):boolean{return [...this.records.values()].some(record=>record.owner===owner)}
 get pending():number{return this.records.size}
}
