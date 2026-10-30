import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, readAtomicFileVersion, withAtomicSaveQueue, type AtomicFileVersion } from '@vantage/electron-utils/atomic-write'
import { withFilePublication } from '@vantage/electron-utils/file-publication-exclusion'
import type { UserOutputSourceProof } from '@vantage/electron-utils/user-output-publication'

type Session = { owner:number; dir:string; identity:string; pages:number; closed:boolean; proof:UserOutputSourceProof; pending:Set<Promise<void>>; owned:Map<string,AtomicFileVersion|null> }
const identity=(path:string)=>{const value=lstatSync(path,{bigint:true});if(!value.isDirectory()||value.isSymbolicLink())throw new Error('Export directory changed');return `${value.dev}:${value.ino}`}
const sameVersion=(a:AtomicFileVersion,b:AtomicFileVersion)=>a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.ino===b.ino&&a.dev===b.dev&&a.sha256!==undefined&&a.sha256===b.sha256

/** Main-owned output namespace; cancellation never retires an actual write. */
export class ImageExportSessions {
  private sessions=new Map<string,Session>()
  async start(owner:number,parent:string,name:string,proof:UserOutputSourceProof={}):Promise<string>{
    if(this.sessions.size>=64)throw new Error('Too many pending image exports')
    const base=name.replace(/[/\\:*?"<>|]/g,'_').slice(0,80).trim()||'Untitled'
    proof.assertCurrent?.()
    return withFilePublication({targetPath:parent,targetKind:'directory',sourcePaths:proof.sourcePaths},async()=>{
      proof.assertCurrent?.()
      const dir=await mkdtemp(join(parent,`${base}-images-`)),id=randomUUID()
      this.sessions.set(id,{owner,dir,identity:identity(dir),pages:0,closed:false,proof,pending:new Set(),owned:new Map()})
      return id
    })
  }
  private get(owner:number,id:string):Session{
    const session=this.sessions.get(id)
    if(!session||session.owner!==owner||session.closed)throw new Error('Export session is not authorized')
    this.current(session)
    return session
  }
  private current(session:Session):void{
    session.proof.assertCurrent?.()
    if(identity(session.dir)!==session.identity)throw new Error('Export directory changed')
  }
  async write(owner:number,id:string,page:number,base64:string):Promise<void>{
    const session=this.get(owner,id)
    if(!Number.isSafeInteger(page)||page!==session.pages+1||page>4096||session.pending.size)throw new Error('Invalid export page number')
    if(typeof base64!=='string')throw new Error('Invalid PNG data')
    const bytes=Buffer.from(base64,'base64')
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid PNG data')
    const path=join(session.dir,`page-${String(page).padStart(2,'0')}.png`)
    this.current(session)
    const actual=withFilePublication({targetPath:session.dir,targetKind:'directory',sourcePaths:session.proof.sourcePaths},async()=>{
      this.current(session)
      await atomicWriteFile(path,bytes,{expectedVersion:null})
      const version=await readAtomicFileVersion(path)
      session.owned.set(path,version?.sha256===createHash('sha256').update(bytes).digest('hex')?version:null)
      session.pages=page
    })
    session.pending.add(actual)
    void actual.finally(()=>session.pending.delete(actual)).catch(()=>{})
    return actual
  }
  async finish(owner:number,id:string,success:boolean):Promise<string|null>{
    const session=this.sessions.get(id)
    if(!session||session.owner!==owner||session.closed)throw new Error('Export session is not authorized')
    session.closed=true;this.sessions.delete(id)
    const results=await Promise.allSettled([...session.pending])
    if(success&&session.pages&&results.every(value=>value.status==='fulfilled')){this.current(session);return session.dir}
    // Never recursively delete a user directory, including a replaced old path.
    try{
      if(identity(session.dir)===session.identity)await withFilePublication({targetPath:session.dir,targetKind:'directory'},async()=>{
        if(identity(session.dir)!==session.identity)return
        for(const[path,owned]of session.owned){
          if(!owned)continue
          await withAtomicSaveQueue(path,async()=>{const current=await readAtomicFileVersion(path);if(identity(session.dir)===session.identity&&current&&sameVersion(owned,current))await unlink(path)})
        }
        if(identity(session.dir)===session.identity)await rmdir(session.dir)
      })
    }catch{/* Uncertain cleanup retains files; it cannot erase a peer's output. */}
    if(success)throw new Error('Cannot complete an empty or failed image export')
    return null
  }
  async dispose(owner:number):Promise<void>{await Promise.all([...this.sessions].filter(([,s])=>s.owner===owner).map(([id])=>this.finish(owner,id,false)))}
}
