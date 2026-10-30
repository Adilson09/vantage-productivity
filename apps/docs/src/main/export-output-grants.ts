import { randomUUID } from 'node:crypto'
import { statSync, realpathSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve,sep } from 'node:path'
import { atomicWriteFile, readAtomicFileVersion, AtomicSaveConflictError, type AtomicFileVersion } from '@vantage/electron-utils/atomic-write'
import { withFilePublication, type FileMutationPath } from '@vantage/electron-utils/file-publication-exclusion'
import type { UserOutputSourceProof } from '@vantage/electron-utils/user-output-publication'

type Version = Readonly<AtomicFileVersion> | null
interface FileGrant { id:string; mediaIdentity:string|null; mediaDirectory:string|null; path:string; paths:readonly string[]; inFlight:boolean; parentIdentity:string; versions:Map<string,Version>; proof:UserOutputSourceProof; expires:number; namespaces:readonly FileMutationPath[] }
interface DirectoryGrant { id:string; path:string; identity:string; versions:Map<string,Version>; used:Set<string>; proof:UserOutputSourceProof; expires:number }
interface State { transition?:symbol; pauses:Map<symbol,{source:string;current:()=>boolean}>; adoptedSource?:string; closed:boolean; files:Map<string,FileGrant>; directories:Map<string,DirectoryGrant>; pending:Set<Promise<unknown>> }
export interface DocsExportFileLease { ensureMediaDirectory():Promise<void>; readonly expectedVersion:Version; assertCurrent():void; publish(bytes:Uint8Array):Promise<void>; publishAdditional(path:string,bytes:Uint8Array):Promise<void> }
const key=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path)
export function configuredDocsExportTarget(root:string|null,path:string):boolean{if(!root)return false;const directory=key(root),target=key(path);return target.startsWith(directory+(directory.endsWith(sep)?'':sep))}
const identity=(path:string)=>{const physical=realpathSync(path),value=statSync(physical,{bigint:true});if(!value.isDirectory())throw new Error('The selected output directory is unavailable.');if(value.ino<=0n)throw new Error('This folder cannot confirm its file identity. Choose another local export folder.');return `${key(physical)}:${value.dev}:${value.ino}`}
const maybeIdentity=(path:string)=>{try{return identity(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}}
export interface DocsOutputPause { readonly drained:Promise<void>; isReady():boolean; resume():void; retire():void }
const pinned=(value:AtomicFileVersion|null):Version=>value===null?null:Object.freeze({...value})
const same=(a:Version,b:Version)=>a===null?b===null:!!b&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.dev===b.dev&&a.ino===b.ino&&(a.sha256===undefined||a.sha256===b.sha256)

/** Main-only selected target authority; renderer path strings establish no versions. */
export class DocsOutputGrants<Owner extends object> {
  private readonly owners=new WeakMap<Owner,State>()
  constructor(private readonly now:()=>number=Date.now){}
  private rawState(owner:Owner):State {
    let state=this.owners.get(owner)
    if(!state){state={closed:false,pauses:new Map(),files:new Map(),directories:new Map(),pending:new Set()};this.owners.set(owner,state)}
    return state
  }
  private pruneStale(state:State):void {
    if(state.pending.size)return
    state.transition=undefined
    if(state.adoptedSource===undefined)return
    for(const[token,pause]of state.pauses){let current=false;try{current=pause.current()}catch{};if(pause.source!==state.adoptedSource&&!current)state.pauses.delete(token)}
  }
  private state(owner:Owner):State {
    const state=this.rawState(owner);this.pruneStale(state)
    if(state.closed)throw new Error('The export owner has ended.')
    if(state.transition||state.pauses.size)throw new Error('Document output admission is paused for closing.')
    return state
  }
  /** Reserve before invalidating old close authority: cancellation may resume its own pause. */
  transitionSource(owner:Owner,change:()=>string):void {
    const state=this.rawState(owner)
    if(state.closed)throw new Error('The export owner has ended.')
    // This fence belongs to genuine accepted work, not to a cancelable close ticket.
    // No continuation clears it: admission prunes it only once the actual ledger is empty.
    if(state.pending.size)state.transition=Symbol('Docs source transition')
    state.adoptedSource=change()
    this.pruneStale(state)
  }
  adoptSource(owner:Owner,source:string):void { this.transitionSource(owner,()=>source) }
  private async settled(state:State):Promise<void>{while(state.pending.size)await Promise.allSettled([...state.pending])}
  pause(owner:Owner,source:string,current:()=>boolean):DocsOutputPause {
    const state=this.rawState(owner)
    if(state.closed)throw new Error('The export owner has ended.')
    state.adoptedSource??=source
    const token=Symbol('Docs output close pause'),entry={source,current};state.pauses.set(token,entry)
    const owns=()=>state.pauses.get(token)===entry
    const isCurrent=()=>{try{return current()}catch{return false}}
    const drained=this.settled(state)
    return{drained,isReady:()=>owns()&&!state.closed&&state.pending.size===0&&isCurrent(),resume:()=>{if(owns()&&!state.closed&&isCurrent())state.pauses.delete(token)},retire:()=>{if(owns()&&state.pending.size===0){state.closed=true;state.pauses.delete(token)}}}
  }
  private own<T>(state:State,actual:()=>Promise<T>):Promise<T> {
    if(state.closed||state.transition||state.pauses.size)return Promise.reject(new Error('Document output admission is paused or ended.'))
    const work=(async()=>actual())();state.pending.add(work)
    void work.then(()=>state.pending.delete(work),()=>state.pending.delete(work))
    return work
  }
  closeAdmission(owner:Owner):void { this.rawState(owner).closed=true }
  async drain(owner:Owner):Promise<void> { this.closeAdmission(owner);const state=this.rawState(owner);await this.settled(state);state.files.clear();state.directories.clear() }
  fileSelection(owner:Owner,path:string):string { const state=this.state(owner),grant=state.files.get(key(path));if(!grant||grant.expires<=this.now())throw new Error('Select the export destination again.');grant.proof.assertCurrent?.();if(identity(dirname(grant.path))!==grant.parentIdentity||grant.mediaDirectory&&maybeIdentity(grant.mediaDirectory)!==grant.mediaIdentity)throw new Error('The selected output or media directory changed.');return grant.id }
  async captureFile(owner:Owner,path:string,proof:UserOutputSourceProof,options:{additionalPaths?:readonly string[];namespaces?:readonly FileMutationPath[];fresh?:boolean;mediaDirectory?:string}={}):Promise<string> {
    path=resolve(path)
    const state=this.state(owner),paths=[path,...(options.additionalPaths??[]).map(value=>resolve(value))]
    const derivedMedia=join(dirname(path),basename(path).replace(/\.md$/i,'')+'_files')
    if(options.mediaDirectory!==undefined&&key(options.mediaDirectory)!==key(derivedMedia))throw new Error('The media namespace must be derived from this exact output.')
    const mediaDirectory=options.mediaDirectory!==undefined?resolve(options.mediaDirectory):(/\.md$/i.test(path)?derivedMedia:null)
    const namespaces=[...(options.namespaces??[]).map(value=>({...value,path:resolve(value.path)})),...(mediaDirectory?[{path:mediaDirectory,kind:'directory' as const}]:[])]
    if(paths.length+namespaces.length>4096)throw new Error('Too many export targets.')
    const heldProof={...proof,sourcePaths:proof.sourcePaths?proof.sourcePaths.map(value=>resolve(value)):undefined};heldProof.assertCurrent?.()
    const parentIdentity=identity(dirname(path)),mediaIdentity=mediaDirectory?maybeIdentity(mediaDirectory):null
    return this.own(state,()=>withFilePublication({targetPath:path,additionalTargetPaths:paths.slice(1),additionalTargetNamespaces:namespaces,sourcePaths:heldProof.sourcePaths},async()=>{
      const versions=new Map<string,Version>()
      for(const target of paths){const version=pinned(await readAtomicFileVersion(target));if(options.fresh&&version!==null)throw new AtomicSaveConflictError();versions.set(key(target),version)}
      if(mediaDirectory){
        let entries:string[]=[]
        try{entries=await readdir(mediaDirectory)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
        if(entries.length+versions.size>4096)throw new Error('Too many Markdown media outputs.')
        for(const name of entries)if(/^image\d+\.\w+$/.test(String(name))){const target=join(mediaDirectory,String(name));if(!versions.has(key(target))){paths.push(target);versions.set(key(target),pinned(await readAtomicFileVersion(target)))}}
      }
      heldProof.assertCurrent?.();if(identity(dirname(path))!==parentIdentity||mediaDirectory&&maybeIdentity(mediaDirectory)!==mediaIdentity)throw new Error('The selected output or media directory changed.')
      if(state.closed)throw new Error('The export owner has ended.')
      for(const[id,value]of state.files)if(value.expires<=this.now())state.files.delete(id)
      while(state.files.size>=64)state.files.delete(state.files.keys().next().value!)
      const id=randomUUID()
      state.files.set(key(path),{id,mediaIdentity,mediaDirectory,path,paths:[...paths],inFlight:false,parentIdentity,versions,proof:heldProof,expires:this.now()+300_000,namespaces:namespaces.map(value=>({...value}))})
      return id
    }))
  }
  runFile<T>(owner:Owner,path:string,selectionId:unknown,actual:(lease:DocsExportFileLease)=>Promise<T>):Promise<T> {
    const state=this.state(owner),grant=state.files.get(key(path))
    if(!grant||typeof selectionId!=='string'||selectionId!==grant.id||grant.inFlight||grant.expires<=this.now())return Promise.reject(new Error('Select the export destination again.'))
    const assertCurrent=()=>{grant.proof.assertCurrent?.();if(identity(dirname(grant.path))!==grant.parentIdentity||grant.mediaDirectory&&maybeIdentity(grant.mediaDirectory)!==grant.mediaIdentity)throw new Error('The selected output or media directory changed.')}
    assertCurrent();grant.inFlight=true
    let published=false
    const work=this.own(state,()=>withFilePublication({targetPath:grant.path,additionalTargetPaths:grant.paths.slice(1),additionalTargetNamespaces:grant.namespaces,sourcePaths:grant.proof.sourcePaths},async()=>{
      const expected=grant.versions.get(key(grant.path))!
      if(!same(expected,await readAtomicFileVersion(grant.path)))throw new AtomicSaveConflictError()
      assertCurrent();const used=new Set<string>()
      const publish=async(target:string,bytes:Uint8Array)=>{const id=key(target),media=grant.mediaDirectory&&key(dirname(target))===key(grant.mediaDirectory)&&/^image\d+\.\w+$/.test(basename(target));if((!grant.versions.has(id)&&!media)||used.has(id)||used.size>=4096)throw new Error('The output target was not admitted or was already written.');used.add(id);assertCurrent();await atomicWriteFile(target,Buffer.from(bytes),{expectedVersion:grant.versions.get(id)??null});published=true}
      const ensureMediaDirectory=async()=>{
        assertCurrent()
        if(!grant.mediaDirectory)throw new Error('No Markdown media namespace was admitted.')
        if(grant.mediaIdentity!==null)return
        // Exclusive creation: an absence grant never adopts a peer's new directory.
        await mkdir(grant.mediaDirectory,{recursive:false})
        grant.mediaIdentity=identity(grant.mediaDirectory)
        assertCurrent()
      }
      return actual({expectedVersion:expected,assertCurrent,ensureMediaDirectory,publish:bytes=>publish(grant.path,bytes),publishAdditional:publish})
    }))
    return work.finally(()=>{grant.inFlight=false;if(published&&state.files.get(key(path))===grant)state.files.delete(key(path))})
  }
  async captureDirectory(owner:Owner,path:string,proof:UserOutputSourceProof):Promise<string> {
    path=resolve(path)
    const state=this.state(owner),heldProof={...proof,sourcePaths:proof.sourcePaths?proof.sourcePaths.map(value=>resolve(value)):undefined};heldProof.assertCurrent?.();const directoryIdentity=identity(path)
    return this.own(state,()=>withFilePublication({targetPath:path,targetKind:'directory',sourcePaths:heldProof.sourcePaths},async()=>{
      const entries=await readdir(path,{withFileTypes:true});if(entries.length>4096)throw new Error('Choose an export directory with fewer entries.')
      const versions=new Map<string,Version>()
      for(const entry of entries)if(entry.name.toLowerCase().endsWith('.png'))versions.set(key(join(path,entry.name)),pinned(await readAtomicFileVersion(join(path,entry.name))))
      heldProof.assertCurrent?.();if(identity(path)!==directoryIdentity)throw new Error('The selected output directory changed.')
      if(state.closed)throw new Error('The export owner has ended.')
      for(const[id,value]of state.directories)if(value.expires<=this.now())state.directories.delete(id)
      while(state.directories.size>=64)state.directories.delete(state.directories.keys().next().value!)
      const id=randomUUID()
      state.directories.set(key(path),{id,path,identity:directoryIdentity,versions,used:new Set(),proof:heldProof,expires:this.now()+300_000})
      return id
    }))
  }
  publishDirectoryImage(owner:Owner,directory:string,fileName:string,bytes:Uint8Array,selectionId:unknown):Promise<void> {
    const state=this.state(owner),grant=state.directories.get(key(directory))
    if(!grant||typeof selectionId!=='string'||selectionId!==grant.id||grant.expires<=this.now()||fileName!==basename(fileName)||!/^[^/\\]+\.png$/i.test(fileName))return Promise.reject(new Error('The image export target is unavailable.'))
    const target=join(grant.path,fileName),id=key(target)
    if(grant.used.size>=4096||grant.used.has(id))return Promise.reject(new Error('The image export target was already used.'))
    const assertCurrent=()=>{grant.proof.assertCurrent?.();if(identity(grant.path)!==grant.identity)throw new Error('The selected image directory changed.')}
    assertCurrent();grant.used.add(id)
    return this.own(state,()=>withFilePublication({targetPath:grant.path,targetKind:'directory',sourcePaths:grant.proof.sourcePaths},async()=>{assertCurrent();await atomicWriteFile(target,Buffer.from(bytes),{expectedVersion:grant.versions.get(id)??null})}))
  }
}
