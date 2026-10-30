import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,symlink,writeFile,unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {registerCloseCleanupRuntime,stageCloseCleanup,beginRetireCloseCleanupCustody,getCloseCleanupRetirementActivity,cancelCloseCleanupQuitDrain,prepareCloseCleanupRestore,restoreCloseCleanupCustody,getCloseCleanupStatus,queryCloseCleanupCustody,retireCloseCleanupCustody} from '../src/close-cleanup-runtime'
const purgeHooks=vi.hoisted(()=>({before:undefined as undefined|((path:string)=>Promise<void>)}))
vi.mock('node:fs/promises',async original=>{const real=await original<typeof import('node:fs/promises')>();return{...real,rm:async(...args:Parameters<typeof real.rm>)=>{await purgeHooks.before?.(String(args[0]));return real.rm(...args)}}})
const restoreHooks=vi.hoisted(()=>({before:undefined as undefined|((destination:string)=>Promise<void>),after:undefined as undefined|((destination:string)=>Promise<void>)}))
vi.mock('../src/draft-journal',async original=>{
 const real=await original<typeof import('../src/draft-journal')>()
 return{...real,restoreDraftCustodyCopy:async(...args:Parameters<typeof real.restoreDraftCustodyCopy>)=>{
  await restoreHooks.before?.(args[3])
  const result=await real.restoreDraftCustodyCopy(...args)
  await restoreHooks.after?.(args[3])
  return result
 }}
})
import {discardDraftJournal,listDraftJournal,readDraftJournal,writeDraftJournal} from '../src/draft-journal'
import type {CloseCleanupTask} from '../src/close-cleanup'
import {createRecoveryCipher,setRecoveryCipher} from '../src/recovery-encryption'
vi.setConfig({testTimeout:30_000})
class App {
 listeners:Array<(event:{preventDefault():void})=>void>=[];quitCount=0;exited=false
 on(_event:'before-quit',listener:(event:{preventDefault():void})=>void){this.listeners.push(listener);return this}
 whenReady(){return Promise.resolve()}
 quit(){this.quitCount++;let prevented=false;for(const listener of this.listeners)listener({preventDefault:()=>{prevented=true}});if(!prevented)this.exited=true}
}
let fixtureRoot:string,directory:string,recovery:string,userFiles:string
const junctionRoots:string[]=[]
const releasePurge:Array<()=>void>=[],pendingPurge:Promise<void>[]=[]
const reset=()=>{delete (globalThis as typeof globalThis&{__vantageCloseCleanupRuntime?:unknown}).__vantageCloseCleanupRuntime}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}
beforeEach(async()=>{purgeHooks.before=undefined;restoreHooks.before=undefined;restoreHooks.after=undefined;reset();fixtureRoot=await mkdtemp(join(tmpdir(),'vantage-close-custody-'));directory=join(fixtureRoot,'profile');userFiles=join(fixtureRoot,'user-files');await mkdir(directory);await mkdir(userFiles);recovery=join(directory,'recovery')})
afterEach(async()=>{for(const release of releasePurge.splice(0))release();await Promise.allSettled(pendingPurge.splice(0));purgeHooks.before=undefined;reset();setRecoveryCipher(recovery,null);vi.useRealTimers();for(const owned of junctionRoots.splice(0)){if(!resolve(owned).startsWith(resolve(join(process.env.LOCALAPPDATA!,'Temp','vantage-close-junction-'))))throw new Error('Unexpected junction fixture cleanup');await rm(owned,{recursive:true,force:true})};const target=resolve(fixtureRoot),prefix=resolve(join(tmpdir(),'vantage-close-custody-'));if(!target.startsWith(prefix))throw new Error('Refusing unrelated fixture cleanup');await rm(target,{recursive:true,force:true})})
async function fixture(){
 const app=new App(),warning=vi.fn(),token=randomUUID(),plain=Buffer.from('Complete protected document bytes which must survive failed outer close.')
 setRecoveryCipher(recovery,createRecoveryCipher(randomBytes(32)))
 const entry=await writeDraftJournal(recovery,{id:token,module:'docs',documentPath:join(userFiles,'source.docx'),extension:'.docx',bytes:plain})
 registerCloseCleanupRuntime({app,userDataRoot:directory,warning})
 const task:CloseCleanupTask={id:randomUUID(),module:'docs',ownerKey:'7',source:'main-minted-source',generation:3,token,documentPath:entry!.documentPath,custody:{recoveryRoot:recovery,draftId:token,attest:()=>({expectedDocumentPath:entry!.documentPath,expectedSha256:entry!.sha256})},run:async()=>{await discardDraftJournal(recovery,token)}}
 return{app,warning,token,plain,entry:entry!,task}
}
describe('actual protected close custody and main quit hold',()=>{
 it('refuses publishing a user restoration into private engine storage',async()=>{
  const f=await fixture(),handle=await stageCloseCleanup(f.task);handle.cancel()
  await expect(restoreCloseCleanupCustody(handle.id,join(directory,'never-restored.docx'))).rejects.toThrow('outside private engine storage')
  await expect(readFile(join(directory,'never-restored.docx'))).rejects.toMatchObject({code:'ENOENT'})
 })
 it('keeps exact encrypted metadata/payload through cancellation and restores a verified separate copy',async()=>{
  const f=await fixture(),original=await readFile(join(recovery,'drafts',f.entry.payload)),handle=await stageCloseCleanup(f.task)
  handle.cancel('another document refused close')
  const folders=await readdir(join(directory,'close-cleanup','custody'))
  const backup=await readFile(join(directory,'close-cleanup','custody',folders[0]!,'drafts',f.entry.payload))
  expect(backup.equals(original)).toBe(true);expect(backup.includes(f.plain)).toBe(false)
  expect(await listDraftJournal(recovery)).toHaveLength(1)
  const destination=join(userFiles,'restored.docx'),restored=await restoreCloseCleanupCustody(handle.id,destination)
  expect(await readFile(destination)).toEqual(f.plain);expect(restored.sha256).toBe(f.entry.sha256)
  expect(restored.status).toMatchObject({token:f.token,source:f.task.source,generation:3,phase:'canceled'})
 })
 it('holds ordinary last-window quit because the pending job is registered before actual removal',async()=>{
  const f=await fixture(),gate=deferred();f.task.run=async()=>{await gate.promise;await discardDraftJournal(recovery,f.token)}
  const handle=await stageCloseCleanup(f.task)
  expect(handle.commitRemoval(()=>{f.app.quit();expect(f.app.exited).toBe(false);return true})).toBe(true)
  expect(f.app.quitCount).toBe(1)
  gate.resolve();expect((await handle.outcome).phase).toBe('complete')
  await vi.waitFor(()=>expect(f.app.quitCount).toBe(2));expect(f.app.exited).toBe(true);expect(f.warning).not.toHaveBeenCalled()
  expect(await listDraftJournal(recovery)).toEqual([])
 })
 it('indexes complete custody for checked privacy retirement and refuses later trusted restoration',async()=>{
  const f=await fixture(),handle=await stageCloseCleanup(f.task);handle.cancel()
  expect(queryCloseCleanupCustody({module:'docs',source:f.task.source,tokens:[f.token]})).toHaveLength(1)
  await retireCloseCleanupCustody({module:'docs',source:f.task.source,tokens:[f.token]},'PDF-style checked source retirement')
  expect(getCloseCleanupStatus(handle.id)?.phase).toBe('purged')
  await expect(restoreCloseCleanupCustody(handle.id,join(userFiles,'refused.docx'))).rejects.toThrow('unresolved or unavailable')
  expect(await listDraftJournal(recovery)).toHaveLength(1)
 })
})

describe('trusted conditional inherited-draft cleanup',()=>{
 it('is an idempotent no-op for an absent UUID and does not invalidate a queued writer',async()=>{
  const f=await fixture(),absent=randomUUID()
  const noOp=discardDraftJournal(recovery,absent,{expectedSha256:f.entry.sha256})
  const writer=writeDraftJournal(recovery,{id:absent,module:'docs',documentPath:null,extension:'.docx',bytes:Buffer.from('new live journal')})
  await noOp;expect(await writer).not.toBeNull()
  expect((await readDraftJournal(recovery,absent)).bytes.toString()).toBe('new live journal')
 })
 it('preserves a changed complete entry, its files, and the epoch of a newer queued writer',async()=>{
  const f=await fixture(),newer=Buffer.from('New original-view recovery after a separate copy was restored.')
  const changed=await writeDraftJournal(recovery,{id:f.token,module:'docs',documentPath:f.entry.documentPath,extension:'.docx',bytes:newer})
  const before=(await readdir(join(recovery,'drafts'))).sort()
  await expect(discardDraftJournal(recovery,f.token,{expectedSha256:f.entry.sha256})).rejects.toThrow('changed after restoration')
  expect((await readdir(join(recovery,'drafts'))).sort()).toEqual(before)
  expect((await readDraftJournal(recovery,f.token)).bytes).toEqual(newer)
  const mismatch=discardDraftJournal(recovery,f.token,{expectedSha256:f.entry.sha256})
  const next=writeDraftJournal(recovery,{id:f.token,module:'docs',documentPath:f.entry.documentPath,extension:'.docx',bytes:Buffer.from('still newer')})
  await expect(mismatch).rejects.toThrow('changed after restoration')
  expect(await next).not.toBeNull();expect(changed!.sha256).not.toBe(f.entry.sha256)
 })
 it('deletes only when the authenticated complete payload hash still matches the verified envelope',async()=>{
  const f=await fixture()
  await discardDraftJournal(recovery,f.token,{expectedSha256:f.entry.sha256})
  expect(await listDraftJournal(recovery)).toEqual([])
 })
})

describe('cleanup status restart and restore-path ownership',()=>{
 it('replays an unfinished status despite a crash-left fixed pending file and preserves that ambiguous file',async()=>{
  const f=await fixture(),handle=await stageCloseCleanup(f.task);handle.cancel()
  const statusRoot=join(directory,'close-cleanup','status'),names=await readdir(statusRoot),name=names.find(value=>value.endsWith('.json'))!
  const path=join(statusRoot,name),status=JSON.parse((await readFile(path)).toString('utf8')) as Record<string,unknown>
  status.phase='running';await writeFile(path,JSON.stringify(status))
  const legacyTemp=path+'.pending';await writeFile(legacyTemp,'interrupted status publication')
  reset();const nextApp=new App(),warning=vi.fn()
  expect(()=>registerCloseCleanupRuntime({app:nextApp,userDataRoot:directory,warning})).not.toThrow()
  expect(getCloseCleanupStatus(handle.id)?.phase).toBe('retained')
  expect((await readFile(legacyTemp)).toString()).toBe('interrupted status publication')
  await Promise.resolve();expect(warning).toHaveBeenCalled()
 })
 it('never deletes an external replacement and refuses privacy-complete until a pending publisher verdict',async()=>{
  const f=await fixture(),handle=await stageCloseCleanup(f.task);handle.cancel()
  const external=Buffer.from('External editor replacement which must survive.'),entered=deferred(),gate=deferred()
  restoreHooks.after=async destination=>{await unlink(destination);await writeFile(destination,external);entered.resolve();await gate.promise}
  const destination=join(userFiles,'externally-replaced.docx')
  // Observe every early rejection immediately, so a fixture/setup regression
  // fails here instead of timing out while waiting for a callback never reached.
  const restoring=restoreCloseCleanupCustody(handle.id,destination).then(value=>({value,error:undefined as unknown}),error=>({value:undefined,error}))
  await Promise.race([entered.promise,restoring.then(result=>{throw result.error??new Error('Restoration settled without entering its publication gate.')})])
  let settled=false
  const retiring=retireCloseCleanupCustody({module:'docs',ids:[handle.id]},'checked source retirement').finally(()=>{settled=true}),incomplete=expect(retiring).rejects.toThrow('needs review')
  await Promise.resolve();expect(settled).toBe(false);gate.resolve();const result=await restoring;expect(result.error).toBeInstanceOf(Error);expect(String(result.error)).toContain('retired');await incomplete
  expect(await readFile(destination)).toEqual(external)
  expect(getCloseCleanupStatus(handle.id)?.restoration?.phase).toBe('uncertain')
  expect(getCloseCleanupStatus(handle.id)?.phase).not.toBe('purged')
 })
 it('separates active Save As path from the last verified complete journal binding',async()=>{
  const f=await fixture(),active=join(userFiles,'new-save-as-name.docx')
  f.task.documentPath=active
  const handle=await stageCloseCleanup(f.task);handle.cancel()
  expect(handle.status()).toMatchObject({documentPath:active,capturedEntry:{module:'docs',documentPath:f.entry.documentPath,sha256:f.entry.sha256}})
  const restored=await restoreCloseCleanupCustody(handle.id,join(userFiles,'separate.docx'))
  expect(restored.entry.documentPath).toBe(f.entry.documentPath)
 })
 it.each(['path','module','hash','missing-hash'] as const)('refuses an existing journal without the main-owned %s attestation',async kind=>{
  const f=await fixture()
  if(kind==='module')f.task.module='pdf'
  else f.task.custody.attest=()=>({expectedDocumentPath:kind==='path'?join(userFiles,'unrelated.docx'):f.entry.documentPath,expectedSha256:kind==='missing-hash'?undefined:kind==='hash'?'f'.repeat(64):f.entry.sha256})
  await expect(stageCloseCleanup(f.task)).rejects.toThrow(/binding|hash|changed/)
  expect((await readDraftJournal(recovery,f.token)).bytes).toEqual(f.plain)
 })
 it('evaluates the captured final main-write binding only after the actual producer drain',async()=>{
  const f=await fixture(),gate=deferred(),newer=Buffer.from('accepted writer settles during captured retirement')
  let binding={expectedDocumentPath:f.entry.documentPath,expectedSha256:f.entry.sha256}
  f.task.custody.attest=()=>binding
  const staging=stageCloseCleanup({...f.task,ready:gate.promise})
  expect(queryCloseCleanupCustody({module:'docs',ids:[f.task.id]})[0]?.phase).toBe('preparing')
  const entry=await writeDraftJournal(recovery,{id:f.token,module:'docs',documentPath:f.entry.documentPath,extension:'.docx',bytes:newer})
  binding={expectedDocumentPath:entry!.documentPath,expectedSha256:entry!.sha256};gate.resolve()
  const handle=await staging;handle.cancel();expect(handle.status().capturedEntry?.sha256).toBe(entry!.sha256)
 })
 it('revalidates stored custody lineage before any separate output publication',async()=>{
  const f=await fixture(),handle=await stageCloseCleanup(f.task);handle.cancel()
  const [folder]=await readdir(join(directory,'close-cleanup','custody')),metadata=join(directory,'close-cleanup','custody',folder!,'drafts',f.token+'.json')
  const value=JSON.parse(await readFile(metadata,'utf8')) as Record<string,unknown>;value.module='pdf';await writeFile(metadata,JSON.stringify(value))
  const destination=join(userFiles,'refused.docx')
  await expect(prepareCloseCleanupRestore(handle.id,destination)).rejects.toThrow('stored lineage')
  await expect(readFile(destination)).rejects.toMatchObject({code:'ENOENT'})
 })
 it('maintains a full completed-status population before admitting the next captured stage',async()=>{
  const f=await fixture(),handle=await stageCloseCleanup(f.task);handle.cancel()
  const statusRoot=join(directory,'close-cleanup','status'),[name]=await readdir(statusRoot),template=JSON.parse(await readFile(join(statusRoot,name!),'utf8')) as Record<string,unknown>
  for(let i=0;i<128;i++){
   const id=i===0?handle.id:randomUUID(),file=createHash('sha256').update(id).digest('hex')+'.json'
   await writeFile(join(statusRoot,file),JSON.stringify({...template,id,phase:i===0?'retained':'complete',custody:i===0}))
  }
  reset();registerCloseCleanupRuntime({app:new App(),userDataRoot:directory,warning:vi.fn()})
  const next=await stageCloseCleanup({...f.task,id:randomUUID()});next.cancel()
  expect(getCloseCleanupStatus(handle.id)?.phase).toBe('retained')
  expect((await readdir(statusRoot)).filter(value=>value.endsWith('.json')).length).toBe(128)
  expect(queryCloseCleanupCustody({module:'docs'}).filter(value=>value.phase==='complete')).toHaveLength(126)
 })
})

async function realNtfsJunction(target:string):Promise<string>{
 if(!process.env.LOCALAPPDATA)throw new Error('Windows junction regression requires its local application-data test volume.')
 const parent=join(process.env.LOCALAPPDATA,'Temp');await mkdir(parent,{recursive:true})
 const owned=await mkdtemp(join(parent,'vantage-close-junction-'));junctionRoots.push(owned)
 const alias=join(owned,'selected-parent');await symlink(target,alias,'junction');return alias
}
describe('physical restore destination ownership on Windows NTFS',()=>{
 it.skipIf(process.platform!=='win32')('rejects a real outside junction which resolves into the private profile',async()=>{
  const f=await fixture(),handle=await stageCloseCleanup(f.task);handle.cancel();const alias=await realNtfsJunction(directory)
  await expect(restoreCloseCleanupCustody(handle.id,join(alias,'must-not-publish.docx'))).rejects.toThrow('outside private engine storage')
  await expect(readFile(join(directory,'must-not-publish.docx'))).rejects.toMatchObject({code:'ENOENT'})
 })
 it.skipIf(process.platform!=='win32')('publishes only to the verified physical outside parent when the selected junction later switches',async()=>{
  const f=await fixture(),handle=await stageCloseCleanup(f.task);handle.cancel();const alias=await realNtfsJunction(userFiles),name='fixed-physical-output.docx'
  restoreHooks.before=async()=>{await rm(alias,{recursive:true,force:true});await symlink(directory,alias,'junction')}
  const restored=await restoreCloseCleanupCustody(handle.id,join(alias,name)),physical=join(await realpath(userFiles),name)
  expect(restored.destination).toBe(physical);expect(await readFile(physical)).toEqual(f.plain)
  await expect(readFile(join(directory,name))).rejects.toMatchObject({code:'ENOENT'})
 })
})


async function blockedRealPurge(withSecondCopy=false){
 const f=await fixture(),copy=await stageCloseCleanup(f.task);copy.cancel()
 const secondCopy=withSecondCopy?await stageCloseCleanup({...f.task,id:randomUUID()}):undefined;secondCopy?.cancel()
 const entered=deferred(),gate=deferred();releasePurge.push(gate.resolve)
 const target=join(directory,'close-cleanup','custody',createHash('sha256').update(copy.id).digest('hex'))
 purgeHooks.before=async path=>{if(path===target){entered.resolve();await gate.promise}}
 const removal=beginRetireCloseCleanupCustody({module:'docs',ids:[copy.id]},'user selected this copy');pendingPurge.push(removal.actualSettled)
 void removal.ready.catch(()=>{});await entered.promise
 return{...f,copy,secondCopy,entered,gate,removal,target}
}
describe('actual purge lifetime and cancelable common quit intent',()=>{
 it('keeps actual selected purge busy and quit-owned until the real rm settles',async()=>{
  const f=await blockedRealPurge();expect(getCloseCleanupRetirementActivity(f.copy.id).busy).toBe(true)
  f.app.quit();expect(f.app.exited).toBe(false)
  const overlap=beginRetireCloseCleanupCustody({module:'docs',ids:[f.copy.id]},'second click')
  await expect(overlap.ready).rejects.toThrow('earlier recovery removal')
  f.gate.resolve();await f.removal.ready;await f.removal.actualSettled
  await vi.waitFor(()=>expect(f.app.exited).toBe(true));expect(getCloseCleanupStatus(f.copy.id)?.phase).toBe('purged')
 })
 it('canceling the quit intent does not settle actual purge and prevents its old automatic quit',async()=>{
  const f=await blockedRealPurge();f.app.quit();cancelCloseCleanupQuitDrain()
  expect(getCloseCleanupRetirementActivity(f.copy.id).busy).toBe(true);f.gate.resolve();await f.removal.actualSettled
  for(let i=0;i<8;i++)await Promise.resolve();expect(f.app.quitCount).toBe(1);expect(f.app.exited).toBe(false)
  f.app.quit();expect(f.app.exited).toBe(true)
 })
 it('a future explicit quit can drain the same actual work under a fresh intent',async()=>{
  const f=await blockedRealPurge();f.app.quit();cancelCloseCleanupQuitDrain();f.app.quit()
  expect(f.app.quitCount).toBe(2);expect(f.app.exited).toBe(false);f.gate.resolve();await f.removal.actualSettled
  await vi.waitFor(()=>expect(f.app.exited).toBe(true));expect(f.app.quitCount).toBe(3)
 })
 it('joins a newly indexed actual purge during an otherwise ready automatic retry',async()=>{
  const f=await blockedRealPurge(true),secondCopy=f.secondCopy!
  const secondGate=deferred(),secondEntered=deferred();releasePurge.push(secondGate.resolve)
  const target=join(directory,'close-cleanup','custody',createHash('sha256').update(secondCopy.id).digest('hex'))
  purgeHooks.before=async path=>{if(path===f.target)await f.gate.promise;if(path===target){secondEntered.resolve();await secondGate.promise}}
  let second:ReturnType<typeof beginRetireCloseCleanupCustody>|undefined
  f.app.listeners.unshift(()=>{if(f.app.quitCount===2){second=beginRetireCloseCleanupCustody({module:'docs',ids:[secondCopy.id]},'later selected copy');pendingPurge.push(second.actualSettled);void second.ready.catch(()=>{})}})
  f.app.quit();f.gate.resolve();await f.removal.actualSettled;await secondEntered.promise
  expect(f.app.exited).toBe(false);expect(getCloseCleanupRetirementActivity(secondCopy.id).busy).toBe(true)
  secondGate.resolve();await second!.actualSettled;await vi.waitFor(()=>expect(f.app.exited).toBe(true));expect(f.app.quitCount).toBe(3)
 })
 it.each(['earlier','later'] as const)('a %s reentrant listener can cancel the actual automatic retry',async position=>{
  const f=await blockedRealPurge()
  const cancel=()=>{if(f.app.quitCount===2)cancelCloseCleanupQuitDrain()}
  if(position==='earlier')f.app.listeners.unshift(cancel);else f.app.listeners.push(cancel)
  f.app.quit();f.gate.resolve();await f.removal.actualSettled
  await vi.waitFor(()=>expect(f.app.quitCount).toBe(2));expect(f.app.exited).toBe(false)
  f.app.quit();expect(f.app.exited).toBe(true);expect(f.app.quitCount).toBe(3)
 })
})
