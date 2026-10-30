import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {resolve} from 'node:path'
import {atomicWriteFile,atomicWriteVia,AtomicSaveConflictError,readAtomicFileVersion,type AtomicFileVersion} from './atomic-write'
export interface PublicationVersion {readonly path:string|null;readonly version:Readonly<AtomicFileVersion>|null;readonly sha256:string|null}
export interface PublicationSelection {readonly source:PublicationVersion;readonly target?:PublicationVersion}
export interface PublicationTicket {readonly target:string;readonly expectedVersion:Readonly<AtomicFileVersion>|null;readonly source:PublicationVersion}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const samePath=(a:string,b:string)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b)
function cloneVersion(version:AtomicFileVersion|null):Readonly<AtomicFileVersion>|null{return version?Object.freeze({...version}):null}
function equalVersion(a:AtomicFileVersion|null,b:AtomicFileVersion|null):boolean{return a===null?b===null:!!b&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.ino===b.ino&&a.dev===b.dev&&(a.sha256===undefined||a.sha256===b.sha256)}
function bound(path:string|null,version:AtomicFileVersion|null,sha256:string|null):PublicationVersion{return Object.freeze({path,version:cloneVersion(version),sha256})}
/** A current target observation is usable only for an explicit new/SaveAs/Overwrite choice. */
export async function observePublicationTarget(path:string):Promise<PublicationVersion>{
 const before=await readAtomicFileVersion(path);if(!before)return bound(path,null,null)
 const hash=createHash('sha256');let size=0
 for await(const chunk of createReadStream(path,{highWaterMark:64*1024})){size+=chunk.length;if(size>before.size)throw new AtomicSaveConflictError();hash.update(chunk)}
 const after=await readAtomicFileVersion(path);if(size!==before.size||!equalVersion(before,after))throw new AtomicSaveConflictError()
 const sha256=hash.digest('hex');if(after?.sha256!==undefined&&after.sha256!==sha256)throw new AtomicSaveConflictError()
 return bound(path,before,sha256)
}
/** The saved baseline must describe the bytes actually adopted, not a later inspection read. */
export async function readPublicationFile(path:string,read:()=>Promise<Uint8Array>):Promise<{bytes:Uint8Array;binding:PublicationVersion}>{
 const before=await readAtomicFileVersion(path);if(!before)throw new Error('The document was moved or deleted before it could be read.')
 const bytes=await read(),sha256=digest(bytes),after=await readAtomicFileVersion(path)
 if(bytes.byteLength!==before.size||!equalVersion(before,after)||(after?.sha256!==undefined&&after.sha256!==sha256))throw new AtomicSaveConflictError()
 return{bytes,binding:bound(path,before,sha256)}
}
/** App-owned actor; old immutable tickets survive awaits and never adopt a fresh disk baseline. */
export function absentPublicationTarget(path:string):PublicationVersion{return bound(path,null,null)}
export class DocumentPublication {
 private value:PublicationVersion
 constructor(binding:PublicationVersion=bound(null,null,null)){
  if(binding.path!==null&&(!binding.version||!binding.sha256))throw new Error('A named document needs a verified loaded publication version.')
  this.value=bound(binding.path,binding.version,binding.sha256)
 }
 snapshot():PublicationVersion{return this.value}
 pin(target:string,explicit?:PublicationVersion,captured=this.value):PublicationTicket{
  if(this.value!==captured)throw new Error('The document publication lineage changed while Save was preparing.')
  const source=captured,candidate=explicit??source
  if(candidate.path===null||!samePath(candidate.path,target))throw new Error('The save destination has no loaded or explicitly confirmed file version. Reload or use Save As.')
  if(candidate.version!==null&&!candidate.sha256)throw new Error('The confirmed destination has no verified content identity.')
  return Object.freeze({target,expectedVersion:cloneVersion(candidate.version),source})
 }
 private async accept(ticket:PublicationTicket,sha256:string):Promise<PublicationVersion>{
  const actual=await observePublicationTarget(ticket.target)
  if(actual.sha256!==sha256||!actual.version)throw new Error('The new document was published but changed again before acknowledgment. Current edits and recovery are retained.')
  if(this.value!==ticket.source)throw new Error('The new bytes were published for an earlier source. Current document state and recovery are retained.')
  this.value=actual;return actual
 }
 async publishBytes(ticket:PublicationTicket,prepare:()=>Promise<Uint8Array>|Uint8Array,mayPublish:()=>boolean=()=>true):Promise<PublicationVersion>{
  const bytes=await prepare();if(this.value!==ticket.source||!mayPublish())throw new Error('The document changed before publication; current work is retained.')
  const sha256=digest(bytes);await atomicWriteFile(ticket.target,Buffer.from(bytes),{expectedVersion:ticket.expectedVersion});return this.accept(ticket,sha256)
 }
 async publishVia(ticket:PublicationTicket,prepare:(temporaryPath:string)=>Promise<void>,mayPublish:()=>boolean=()=>true):Promise<PublicationVersion>{
  let sha256:string|null=null
  await atomicWriteVia(ticket.target,async temporary=>{await prepare(temporary);const candidate=await observePublicationTarget(temporary);if(!candidate.version||!candidate.sha256)throw new Error('The completed save candidate is unavailable.');sha256=candidate.sha256;if(this.value!==ticket.source||!mayPublish())throw new Error('The document changed before publication; current work is retained.')},{expectedVersion:ticket.expectedVersion})
  if(!sha256)throw new Error('The completed save has no publication proof.');return this.accept(ticket,sha256)
 }
 async rebindMoved(oldPath:string,newPath:string,isCurrent:()=>boolean=()=>true):Promise<void>{
  const captured=this.value;if(captured.path===null||!samePath(captured.path,oldPath)||!captured.sha256)throw new Error('The moved source has no verified loaded version; current edits are retained.')
  const moved=await observePublicationTarget(newPath)
  if(this.value!==captured||!isCurrent()||!moved.version||moved.sha256!==captured.sha256)throw new Error('The moved destination does not match the known document bytes; current edits and recovery are retained.')
  this.value=moved
 }
}

interface ReadEntry {id:string;publication:DocumentPublication;source:string|null}
interface ReadOwner {session:unknown;active:string|null;entries:Map<string,ReadEntry>}
/** Main-minted read receipts are adopted only after the real renderer model replacement. */
export class PublicationReadRegistry<Owner> {
 private readonly owners=new Map<Owner,ReadOwner>()
 private trim(state:ReadOwner):void{for(const key of [...state.entries.keys()]){if(state.entries.size<=9)break;if(key!==state.active)state.entries.delete(key)}}
 private owner(owner:Owner,session:unknown):ReadOwner{let state=this.owners.get(owner);if(!state||state.session!==session){state={session,active:null,entries:new Map()};this.owners.set(owner,state)}return state}
 async read(owner:Owner,session:unknown,path:string,read:()=>Promise<Uint8Array>,isCurrent:()=>boolean):Promise<{bytes:Uint8Array;publicationId:string}>{
  const state=this.owner(owner,session),loaded=await readPublicationFile(path,read)
  if(this.owners.get(owner)!==state||!isCurrent())throw new Error('The document read belongs to an obsolete source.')
  const id=randomUUID();state.entries.set(id,{id,publication:new DocumentPublication(loaded.binding),source:null})
  this.trim(state)
  return{bytes:loaded.bytes,publicationId:id}
 }
 adopt(owner:Owner,session:unknown,source:string,path:string,id:unknown):boolean{
  const state=this.owners.get(owner),entry=typeof id==='string'?state?.entries.get(id):undefined
  if(!state||state.session!==session||!entry||entry.publication.snapshot().path===null||!samePath(entry.publication.snapshot().path!,path))return false
  entry.source=source;state.active=entry.id;return true
 }
 select(owner:Owner,session:unknown,source:string,id:unknown,path:string|null,allowSeparateCopy=false):ReadEntry{
  const state=this.owner(owner,session)
  if(path===null&&(id===null||id===undefined)){
   const active=state.active?state.entries.get(state.active):undefined;if(active?.source===source&&active.publication.snapshot().path===null)return active
   const blank:ReadEntry={id:randomUUID(),publication:new DocumentPublication(),source};state.entries.set(blank.id,blank);state.active=blank.id;this.trim(state);return blank
  }
  const entry=typeof id==='string'?state.entries.get(id):undefined,known=entry?.publication.snapshot().path
  if(!entry||state.active!==entry.id||entry.source!==source||path===null||known===null||known===undefined||!samePath(known,path)){if(allowSeparateCopy){const separate:ReadEntry={id:randomUUID(),publication:new DocumentPublication(),source};state.entries.set(separate.id,separate);state.active=separate.id;this.trim(state);return separate}throw new Error('The loaded file-version receipt is missing or obsolete. Reload or use Save As; current edits are retained.')}
  return entry
 }
 async rebind(owner:Owner,session:unknown,oldPath:string,newPath:string,isCurrent:()=>boolean):Promise<void>{
  const state=this.owners.get(owner),entry=state?.active?state.entries.get(state.active):undefined
  if(!state||state.session!==session||!entry)throw new Error('The moved document has no adopted file-version receipt.')
  await entry.publication.rebindMoved(oldPath,newPath,()=>this.owners.get(owner)===state&&state.session===session&&state.active===entry.id&&isCurrent())
 }
 forget(owner:Owner):void{this.owners.delete(owner)}
}
