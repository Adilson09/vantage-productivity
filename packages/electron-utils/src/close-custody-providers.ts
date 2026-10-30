import type {CloseCleanupCapturedEntry,CloseCleanupStatus,CloseCleanupTask} from './close-cleanup'
export type CloseCustodyJson=null|boolean|number|string|CloseCustodyJson[]|{[key:string]:CloseCustodyJson}
export interface CloseCustodyCapture {bytes:number;binding:CloseCleanupCapturedEntry;receipt:{[key:string]:CloseCustodyJson}}
export interface CloseCustodyProvider {
 /** Registered only by trusted main-process startup, never imported metadata. */
 id:string
 /** Main preparation only, never extends an already-ready close lease. */
 captureTimeoutMs?:number
 /** Explicit bounded native reconstruction I/O, distinct from the owner handoff. */
 restoreIoTimeoutMs?:number
 limits:{maxEntryBytes:number;maxTotalBytes:number;maxEntries:number}
 /** Reserve the entire measured charge before writing. This promise must own
  * actual I/O/finalizers to settlement; never return a timeout race/proxy. */
 capture(context:{task:CloseCleanupTask;targetRoot:string;signal:AbortSignal;reserve(bytes:number):void}):Promise<CloseCustodyCapture|null>
 validateReceipt(receipt:unknown):boolean
 /** Unverified partial snapshots require a distinct checked ownership route. */
 purgePartial?(context:{status:CloseCleanupStatus;targetRoot:string;signal:AbortSignal}):Promise<void>
 purge(context:{status:CloseCleanupStatus;targetRoot:string;receipt:unknown;signal:AbortSignal}):Promise<void>
 /** Persist beforePublication BEFORE invoking an awaited publisher, then mark
  * known creation. The returned promise includes actual I/O/finalizers. */
 restore?(context:{status:CloseCleanupStatus;targetRoot:string;receipt:unknown;destination:string;signal:AbortSignal;beforePublication():void;created():void}):Promise<{binding:CloseCleanupCapturedEntry;receipt?:{[key:string]:CloseCustodyJson}}>
}
/** Clone a bounded plain JSON proof before validating or retaining it. */
export function copyCloseCustodyReceipt(value:unknown):{[key:string]:CloseCustodyJson}{
 const seen=new Set<object>();let nodes=0,characters=0
 const copy=(item:unknown,depth:number):CloseCustodyJson=>{
  if(++nodes>2048||depth>16)throw new Error('Custody receipt exceeds its structural bound.')
  if(typeof item==='string'){characters+=item.length;if(characters>8192)throw new Error('Custody receipt exceeds its string bound.');return item}
  if(item===null||typeof item==='boolean')return item
  if(typeof item==='number'){if(!Number.isFinite(item))throw new Error('Custody receipt contains a non-finite number.');return item}
  if(typeof item!=='object')throw new Error('Custody receipt must contain plain JSON values.')
  if(seen.has(item))throw new Error('Custody receipt cannot contain cycles.')
  if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw new Error('Custody receipt must contain plain JSON objects.')
  seen.add(item)
  try{
   if(Array.isArray(item)){
    if(item.length>2048||Reflect.ownKeys(item).some(key=>typeof key!=='string'||(key!=='length'&&!/^(0|[1-9][0-9]*)$/.test(key))))throw new Error('Custody receipt must contain bounded plain JSON arrays.')
    const result:CloseCustodyJson[]=[]
    for(let index=0;index<item.length;index++){
     const field=Object.getOwnPropertyDescriptor(item,String(index))
     if(!field||!('value' in field))throw new Error('Custody receipt arrays must be dense data values.')
     result.push(copy(field.value,depth+1))
    }
    Object.freeze(result);return result
   }
   const result:{[key:string]:CloseCustodyJson}={}
   for(const key of Reflect.ownKeys(item)){
    if(typeof key!=='string')throw new Error('Custody receipt cannot contain symbol keys.')
    characters+=key.length;if(characters>8192)throw new Error('Custody receipt exceeds its string bound.')
    const field=Object.getOwnPropertyDescriptor(item,key)!
    if(!('value' in field))throw new Error('Custody receipt cannot contain accessors.')
    Object.defineProperty(result,key,{value:copy(field.value,depth+1),enumerable:true,configurable:true,writable:true})
   }
   Object.freeze(result);return result
  }finally{seen.delete(item)}
 }
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('Custody receipt must be a plain JSON object.')
 const result=copy(value,0) as {[key:string]:CloseCustodyJson}
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>8192)throw new Error('Custody receipt exceeds its byte bound.')
 return result
}
const main=globalThis as typeof globalThis&{__vantageCloseCustodyProviders?:Map<string,CloseCustodyProvider>}
const providers=main.__vantageCloseCustodyProviders??=new Map<string,CloseCustodyProvider>()
export function registerCloseCustodyProvider(provider:CloseCustodyProvider):void {
 if(!/^[a-z][a-z0-9-]{1,40}$/.test(provider.id)||provider.id==='draft-journal')throw new Error('Invalid or reserved main custody provider id.')
 for(const timeout of [provider.captureTimeoutMs,provider.restoreIoTimeoutMs])if(timeout!==undefined&&(!Number.isSafeInteger(timeout)||timeout<1||timeout>120_000))throw new Error('Invalid provider I/O timeout.')
 const bounds=provider.limits
 if(!Number.isSafeInteger(bounds.maxEntryBytes)||bounds.maxEntryBytes<1||!Number.isSafeInteger(bounds.maxTotalBytes)||bounds.maxTotalBytes<bounds.maxEntryBytes||!Number.isSafeInteger(bounds.maxEntries)||bounds.maxEntries<1||bounds.maxEntries>128)throw new Error('Invalid provider custody bounds.')
 const prior=providers.get(provider.id)
 if(prior&&prior!==provider)throw new Error('A main custody provider is already registered with this id.')
 providers.set(provider.id,provider)
}
export function registeredCloseCustodyProvider(id:string):CloseCustodyProvider|undefined{return providers.get(id)}
