import {DocsOutputGrants} from '../src/main/export-output-grants'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {CloseLeaseBroker} from '../../../packages/electron-utils/src/close-lease'
import {CloseCleanupQueue,type CloseCleanupStatus} from '../../../packages/electron-utils/src/close-cleanup'
import {DocNativeCloseCoordinator,type DocsNativeCloseState} from '../src/main/doc-native-close'
import type {DocNativeCloseFailure,DocNativeCloseRequest} from '../src/shared/ipc'
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}
function fixture(){
 const owner={id:7,alive:true,source:'A',token:'old' as string|null},other={id:8,alive:true,source:'A',token:'other' as string|null}
 const sent:DocNativeCloseRequest[]=[],order:string[]=[],state:DocsNativeCloseState={dirty:true,autoSave:false,filePath:'/a.docx',stamp:{source:'renderer-A',revision:'7'}}
 let service!:DocNativeCloseCoordinator<typeof owner>,sequence=0
 const release=vi.fn((o:typeof owner,ticket:Parameters<DocNativeCloseCoordinator<typeof owner>['released']>[1],reason:string)=>{service?.released(o,ticket,reason);order.push('renderer unlocked')})
 const leases=new CloseLeaseBroker<typeof owner>({alive:o=>o.alive,source:o=>o.source,validate:(_o,_t,s)=>s.source===state.stamp?.source&&s.revision===state.stamp?.revision,release})
 const prepareCustody=vi.fn(async()=>true),cleanup=vi.fn(async(_token:string)=>{}),report=vi.fn(),restore=vi.fn(),preserve=vi.fn(()=>restore),persist=vi.fn<(s:CloseCleanupStatus)=>void>()
 const queue=new CloseCleanupQueue({persist,prepare:()=>prepareCustody(),purge:async()=>{},warning:()=>{},timeoutMs:10_000})
 const choose=vi.fn(async()=> 'save' as 'save'|'discard'|'force'|'cancel'),query=vi.fn(async()=>state)
 let actual:Promise<void>|undefined
 const stage=vi.fn((o:typeof owner,_state:DocsNativeCloseState,floor:number)=>{
  const token=o.token!,source=o.source;o.token=null;order.push('producer paused')
  const admission=queue.begin({id:`cleanup-${++sequence}`,module:'docs',ownerKey:String(o.id),source,generation:1,token,documentPath:state.filePath??null,custody:{},run:async()=>cleanup(token)})
  const ready=admission.ready
  let canceled=false
  return{ready,actualSettled:actual??admission.actualSettled,cancel:()=>{if(canceled)return;canceled=true;admission.cancel('test producer resumed');order.push('producer resumed');if(o.alive&&o.source===source&&o.token===null)o.token=token;void ready.then(h=>h.cancel(),()=>{})}}
 })
 const outputs=new DocsOutputGrants<typeof owner>()
 service=new DocNativeCloseCoordinator({pauseOutputs:(o,source)=>outputs.pause(o,source,()=>o.alive&&o.source===source),leases,id:()=>`n-${++sequence}`,ownerKey:o=>String(o.id),alive:o=>o.alive,source:o=>o.source,query,choose,send:(_o,request)=>{sent.push(request)},stage,preserveRecovery:preserve,report})
 const respond=(patch:Record<string,unknown>={},sender=owner)=>{const request=sent.at(-1)!;service.receive(sender,request.ticket.id,{published:true,current:true,clean:true,intent:request.intent,throughSequence:17,closeLease:{ticket:request.ticket,stamp:state.stamp},...patch})}
 return{outputs,owner,other,state,leases,service,sent,respond,release,choose,stage,cleanup,prepareCustody,queue,report,preserve,restore,order,query,setActual:(work:Promise<void>)=>{actual=work}}
}
async function dispatched(f:ReturnType<typeof fixture>){for(let i=0;i<12&&!f.sent.length;i++)await Promise.resolve();expect(f.sent).toHaveLength(1)}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers())
describe('Docs native and MCP two-phase actual-removal authority',()=>{
 it('rejects an uncaptured preparation failure without inventing cleanup or removal authority',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner)
  await dispatched(f)
  const request=f.sent.at(-1)!,failure:DocNativeCloseFailure={published:false,current:false,clean:false,intent:request.intent}
  f.service.receive(f.owner,request.ticket.id,failure)
  expect(await work).toBeNull()
  expect(f.stage).not.toHaveBeenCalled();expect(f.cleanup).not.toHaveBeenCalled()
  expect(f.owner.token).toBe('old');expect(f.queue.hasPending()).toBe(false)
  const remove=vi.fn(()=>true)
  expect(f.service.completeEnvelope(f.owner,{ticket:request.ticket,stamp:f.state.stamp!},remove)).toBeUndefined()
  expect(f.leases.complete(f.owner,request.ticket,f.state.stamp!,remove)).toBe(false)
  expect(remove).not.toHaveBeenCalled()
 })
 it('refuses an automatic discard for a different source path',async()=>{const f=fixture();expect(await f.service.prepareDiscard(f.owner,'/previous.docx')).toBeNull();expect(f.stage).not.toHaveBeenCalled()})
 it('keeps publication success separate from clean/current permission',async()=>{const f=fixture(),work=f.service.prepare(f.owner);await dispatched(f);f.respond({clean:false});expect(await work).toBeNull();expect(f.release).toHaveBeenCalled();expect(f.cleanup).not.toHaveBeenCalled()})
 it('accepts only same-owner final receipt, captures the watermark and runs cleanup only after actual removal',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner);await dispatched(f);f.respond({},f.other);expect(f.leases.hasWriter(f.owner)).toBe(true)
  f.respond();const receipt=(await work)!,remove=vi.fn(()=>{expect(f.queue.hasPending()).toBe(true);expect(f.cleanup).not.toHaveBeenCalled();return true})
  expect(f.stage).toHaveBeenCalledWith(f.owner,f.state,17);expect(f.cleanup).not.toHaveBeenCalled()
  expect(f.service.complete(f.owner,receipt,remove)).toBe(true);expect(remove).toHaveBeenCalledTimes(1)
  expect(f.service.complete(f.owner,receipt,remove)).toBe(false)
  if(receipt.kind!=='lease')throw new Error('Expected held receipt')
  expect((await f.service.cleanup(String(f.owner.id),receipt.closeLease))?.phase).toBe('complete');expect(f.cleanup).toHaveBeenCalledWith('old')
 })
 it('retains timed-out actual writer ownership until its terminal response',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner);await dispatched(f);await vi.advanceTimersByTimeAsync(120_000);expect(await work).toBeNull()
  expect(f.leases.hasWriter(f.owner)).toBe(true);expect(()=>f.leases.reserve(f.owner,'later')).toThrow();f.respond();expect(f.leases.hasWriter(f.owner)).toBe(false);expect(f.stage).not.toHaveBeenCalled()
 })
 it('restores the exact producer before renderer unlock on ready expiry and refuses late removal',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner);await dispatched(f);f.respond();const receipt=(await work)!,remove=vi.fn(()=>true)
  expect(f.owner.token).toBeNull();await vi.advanceTimersByTimeAsync(5_000)
  expect(f.owner.token).toBe('old');expect(f.order.indexOf('producer resumed')).toBeLessThan(f.order.indexOf('renderer unlocked'))
  expect(f.service.complete(f.owner,receipt,remove)).toBe(false);expect(remove).not.toHaveBeenCalled();expect(f.cleanup).not.toHaveBeenCalled()
 })
 it('retains last-good journal while another family vetoes close and reuses the same producer',async()=>{
  const f=fixture();f.choose.mockResolvedValue('discard');const work=f.service.prepare(f.owner);await dispatched(f);f.respond({published:false,clean:false});const receipt=(await work)!
  expect(f.cleanup).not.toHaveBeenCalled();f.service.cancel(f.owner,receipt,'another family veto')
  expect(f.owner.token).toBe('old');expect(f.cleanup).not.toHaveBeenCalled();expect(f.queue.query({module:'docs'})[0]?.phase).toBe('canceled')
 })
 it('cannot rearm an obsolete producer when custody finishes after cancellation/source replacement',async()=>{
  const f=fixture(),gate=deferred();f.prepareCustody.mockImplementation(async()=>{await gate.promise;return true})
  const work=f.service.prepare(f.owner);await dispatched(f);f.respond();f.leases.cancel(f.owner,undefined,'outer canceled');f.owner.source='B';f.owner.token='new'
  expect(await work).toBeNull();gate.resolve();for(let i=0;i<12;i++)await Promise.resolve()
  expect(f.owner.token).toBe('new');expect(f.cleanup).not.toHaveBeenCalled()
 })
 it('refuses removal and restores producer when custody preparation fails',async()=>{
  const f=fixture();f.prepareCustody.mockRejectedValue(new Error('disk busy'));const work=f.service.prepare(f.owner);await dispatched(f);f.respond()
  expect(await work).toBeNull();expect(f.owner.token).toBe('old');expect(f.report).toHaveBeenCalled();expect(f.cleanup).not.toHaveBeenCalled()
 })
 it.each(['false','throw'] as const)('retains custody and producer when exact-owner removal returns %s',async kind=>{
  const f=fixture(),work=f.service.prepare(f.owner);await dispatched(f);f.respond();const receipt=(await work)!
  if(kind==='false')expect(f.service.complete(f.owner,receipt,()=>false)).toBe(false)
  else expect(()=>f.service.complete(f.owner,receipt,()=>{throw new Error('view replaced')})).toThrow('view replaced')
  expect(f.owner.token).toBe('old');expect(f.cleanup).not.toHaveBeenCalled();expect(f.queue.query({module:'docs'})[0]?.phase).toBe('canceled')
 })
 it('returns captured cleanup status after synchronous owner destruction and after terminal cleanup',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner);await dispatched(f);f.respond();const receipt=(await work)!
  expect(f.service.complete(f.owner,receipt,()=>{f.owner.alive=false;f.service.destroy(f.owner);return true})).toBe(true)
  if(receipt.kind!=='lease')throw new Error('Expected held receipt')
  const status=await f.service.cleanup(String(f.owner.id),receipt.closeLease);expect(status?.phase).toBe('complete')
  await Promise.resolve();expect((await f.service.cleanup(String(f.owner.id),receipt.closeLease))?.id).toBe(status?.id)
  expect(await f.service.cleanup('different-owner',receipt.closeLease)).toBeUndefined()
 })
 it('uses the same stage/cleanup path for final MCP Save while ordinary publication remains separate',async()=>{
  const f=fixture(),ticket=f.leases.reserve(f.owner,'mcp'),stamp=f.state.stamp!;expect(f.leases.claim(f.owner,ticket)).toBe(true);f.leases.settle(f.owner,ticket)
  const receipt=(await f.service.stageSaved(f.owner,{ticket,stamp},true,17))!;expect(f.cleanup).not.toHaveBeenCalled()
  expect(f.service.completeEnvelope(f.owner,{ticket,stamp},()=>true)).toBe(true)
  expect((await f.service.cleanup(String(f.owner.id),{ticket,stamp}))?.phase).toBe('complete');expect(receipt.published).toBe(true)
 })
 it('preserves explicit individual force without claiming clean or deleting recovery',async()=>{
  const f=fixture();f.state.unresponsive=true;f.choose.mockResolvedValue('force');const receipt=(await f.service.prepare(f.owner))!
  expect(receipt).toMatchObject({kind:'force',published:false,clean:false});expect(f.service.complete(f.owner,receipt,()=>true)).toBe(true);expect(f.preserve).toHaveBeenCalledTimes(1);expect(f.stage).not.toHaveBeenCalled()
 })
 it('whole-window/MCP refuse force and individual force rechecks source/writer ownership',async()=>{
  const f=fixture();f.state.unresponsive=true;f.choose.mockResolvedValue('force');expect(await f.service.prepare(f.owner,undefined,false)).toBeNull();expect(await f.service.prepareDiscard(f.owner)).toBeNull()
  const receipt=(await f.service.prepare(f.owner))!;f.owner.source='B';expect(f.service.complete(f.owner,receipt,()=>true)).toBe(false)
  f.owner.source='A';f.leases.reserve(f.owner,'still-writing');expect(await f.service.prepare(f.owner)).toBeNull()
 })
 it('invalidates force before callback and restores its retention policy on refused removal',async()=>{
  const f=fixture();f.state.unresponsive=true;f.choose.mockResolvedValue('force');const receipt=(await f.service.prepare(f.owner))!
  expect(f.service.complete(f.owner,receipt,()=>false)).toBe(false);expect(f.restore).toHaveBeenCalledTimes(1);expect(f.service.complete(f.owner,receipt,()=>true)).toBe(false)
 })
})

describe('Docs deferred final seal and real staging lifetime',()=>{
 it('keeps preparation through a later prompt beyond five seconds and starts ready only at synchronous seal',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner,undefined,false,{deferSeal:true,isCurrent:()=>true})
  await dispatched(f);f.respond();const prepared=(await work)!
  expect(prepared).toMatchObject({kind:'lease',phase:'prepared'})
  await vi.advanceTimersByTimeAsync(9_000)
  expect(f.service.isPrepared(f.owner,prepared)).toBe(true)
  const remove=vi.fn(()=>true)
  expect(f.service.complete(f.owner,prepared,remove)).toBe(false)
  const ready=f.service.seal(f.owner,prepared)!
  expect(ready).toMatchObject({phase:'ready'});expect(ready).not.toBe(prepared)
  expect(f.service.isPrepared(f.owner,prepared)).toBe(false)
  expect(f.service.seal(f.owner,prepared)).toBeNull()
  expect(f.service.complete(f.owner,ready,remove)).toBe(false)
  // Duplicate sealing invalidates that permission; it never silently extends ready.
  expect(remove).not.toHaveBeenCalled()
 })
 it('a coherent final seal can immediately remove the captured owner exactly once',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner,undefined,false,{deferSeal:true})
  await dispatched(f);f.respond();const prepared=(await work)!
  await vi.advanceTimersByTimeAsync(10_000)
  const ready=f.service.seal(f.owner,prepared)!,remove=vi.fn(()=>true)
  expect(f.service.complete(f.owner,ready,remove)).toBe(true);expect(remove).toHaveBeenCalledOnce()
  expect(f.service.complete(f.owner,ready,remove)).toBe(false)
 })
 it('ordinary individual preparation does not spend ready lifetime on an unfinished custody copy',async()=>{
  const f=fixture(),gate=deferred();f.prepareCustody.mockImplementation(async()=>{await gate.promise;return true})
  const work=f.service.prepare(f.owner);await dispatched(f);f.respond()
  await vi.advanceTimersByTimeAsync(8_000);expect(f.owner.token).toBeNull()
  gate.resolve();const ready=(await work)!
  expect(ready).toMatchObject({phase:'ready'});expect(f.service.complete(f.owner,ready,()=>true)).toBe(true)
 })
 it('local prepared validation never calls the group predicate and final seal does',async()=>{
  const f=fixture();let checks=0
  const permit=()=>{++checks;return true},work=f.service.prepare(f.owner,undefined,false,{deferSeal:true,isCurrent:permit})
  await dispatched(f);f.respond();const prepared=(await work)!,before=checks
  expect(f.service.isPrepared(f.owner,prepared)).toBe(true);expect(checks).toBe(before)
  expect(f.service.seal(f.owner,prepared)?.phase).toBe('ready');expect(checks).toBeGreaterThan(before)
 })
 it('never dispatches Save after a later prompt outlives cancellation or source replacement',async()=>{
  const f=fixture(),dialog=deferred(),controller=new AbortController()
  f.choose.mockImplementation(async()=>{await dialog.promise;return 'save'})
  const work=f.service.prepare(f.owner,undefined,false,{deferSeal:true,signal:controller.signal})
  for(let i=0;i<6;i++)await Promise.resolve()
  controller.abort('Return');f.owner.source='replacement';dialog.resolve()
  expect(await work).toBeNull();expect(f.sent).toHaveLength(0);expect(f.stage).not.toHaveBeenCalled()
 })
 it('uses the original finite preparing lifetime and refuses a late seal after expiry',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner,undefined,false,{deferSeal:true})
  await dispatched(f);f.respond();const prepared=(await work)!
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.service.isPrepared(f.owner,prepared)).toBe(false);expect(f.service.seal(f.owner,prepared)).toBeNull();expect(f.owner.token).toBe('old')
 })
 it('abort cancels only permission while an actual renderer save remains owned',async()=>{
  const f=fixture(),controller=new AbortController(),work=f.service.prepare(f.owner,undefined,false,{deferSeal:true,signal:controller.signal})
  await dispatched(f);controller.abort('later family refused');expect(await work).toBeNull()
  expect(f.leases.hasWriter(f.owner)).toBe(true);expect(()=>f.leases.reserve(f.owner,'new-writer')).toThrow()
  f.respond();expect(f.leases.hasWriter(f.owner)).toBe(false);expect(f.stage).not.toHaveBeenCalled()
 })
 it('retains actual custody admission after ready rejects and cancellation resumes the producer',async()=>{
  const f=fixture(),actual=deferred();f.setActual(actual.promise);f.prepareCustody.mockRejectedValue(new Error('copy timed out'))
  const work=f.service.prepare(f.owner,undefined,false,{deferSeal:true})
  await dispatched(f);f.respond();expect(await work).toBeNull();expect(f.owner.token).toBe('old')
  const before=f.sent.length;expect(await f.service.prepare(f.owner)).toBeNull();expect(f.sent).toHaveLength(before)
  actual.resolve();for(let i=0;i<8;i++)await Promise.resolve()
  f.prepareCustody.mockResolvedValue(true)
  const later=f.service.prepare(f.owner);for(let i=0;i<10&&f.sent.length===before;i++)await Promise.resolve()
  expect(f.sent.length).toBe(before+1);f.respond();expect((await later)?.phase).toBe('ready')
 })
 it('source replacement or a new writer cannot convert a prepared receipt to removal authority',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner,undefined,false,{deferSeal:true})
  await dispatched(f);f.respond();const prepared=(await work)!
  f.owner.source='B';expect(f.service.seal(f.owner,prepared)).toBeNull()
  const writer=f.leases.reserve(f.owner,'new-source-writer')
  expect(f.service.complete(f.owner,prepared,()=>true)).toBe(false);expect(f.leases.hasWriter(f.owner)).toBe(true)
  f.leases.cancel(f.owner,writer);f.leases.settle(f.owner,writer)
 })
})

it('does not emit prepared until successful custody actual admission really settles',async()=>{
 const f=fixture(),actual=deferred();f.setActual(actual.promise)
 let resolved=false
 const work=f.service.prepare(f.owner,undefined,false,{deferSeal:true}).then(value=>{resolved=true;return value})
 await dispatched(f);f.respond();for(let i=0;i<20;i++)await Promise.resolve()
 expect(resolved).toBe(false);await vi.advanceTimersByTimeAsync(8_000);expect(resolved).toBe(false)
 actual.resolve();const prepared=(await work)!
 expect(prepared.phase).toBe('prepared');const sealed=f.service.seal(f.owner,prepared)!
 expect(f.service.complete(f.owner,sealed,()=>true)).toBe(true)
})

describe('actual Docs native prompt/write admission',()=>{
 it('suppresses blur AutoSave before query and while the native dialog is pending',async()=>{
  const f=fixture(),queryGate=deferred(),dialog=deferred()
  f.query.mockImplementation(async()=>{await queryGate.promise;return f.state})
  f.choose.mockImplementation(async()=>{await dialog.promise;return 'discard'})
  const work=f.service.prepare(f.owner,undefined,false,{deferSeal:true})
  expect(f.service.beginWrite(f.owner,true)).toBeNull()
  queryGate.resolve();for(let i=0;i<8;i++)await Promise.resolve()
  expect(f.service.beginWrite(f.owner,true)).toBeNull()
  dialog.resolve();await dispatched(f);f.respond({published:false,clean:false})
  const receipt=(await work)!
  expect(f.service.beginWrite(f.owner,true)).toBeNull()
  f.service.cancel(f.owner,receipt);const finish=f.service.beginWrite(f.owner,true)
  expect(finish).not.toBeNull();finish!()
 })
 it('manual Save invalidates a parked dialog and remains actually owned until its finally release',async()=>{
  const f=fixture(),dialog=deferred();f.choose.mockImplementation(async()=>{await dialog.promise;return 'save'})
  const work=f.service.prepare(f.owner,undefined,false,{deferSeal:true})
  for(let i=0;i<8;i++)await Promise.resolve()
  const finish=f.service.beginWrite(f.owner,false)!
  expect(finish).toBeTypeOf('function');expect(await f.service.prepare(f.owner)).toBeNull()
  dialog.resolve();expect(await work).toBeNull();expect(f.sent).toHaveLength(0)
  expect(await f.service.prepare(f.owner)).toBeNull();finish()
  const later=f.service.prepare(f.owner);await dispatched(f);f.respond();expect((await later)?.phase).toBe('ready')
 })
 it('only a correlated live native save ticket exempts its own prompt from manual invalidation',async()=>{
  const f=fixture(),work=f.service.prepare(f.owner,undefined,false,{deferSeal:true})
  await dispatched(f);const ticket=f.sent[0].ticket
  expect(f.service.beginWrite(f.other,false,ticket)).toBeNull()
  expect(f.service.beginWrite(f.owner,false,{...ticket,id:'unknown'})).toBeNull()
  const finish=f.service.beginWrite(f.owner,false,ticket)!
  expect(finish).toBeTypeOf('function');expect(f.service.beginWrite(f.owner,true)).toBeNull()
  finish();f.respond();const receipt=(await work)!
  expect(receipt.phase).toBe('prepared');expect(f.service.isPrepared(f.owner,receipt)).toBe(true)
  f.service.cancel(f.owner,receipt)
 })
 it('owner destruction invalidates prompt decisions without freeing an actual write',async()=>{
  const f=fixture(),finish=f.service.beginWrite(f.owner,false)!
  f.service.destroy(f.owner);expect(await f.service.prepare(f.owner)).toBeNull()
  finish();const work=f.service.prepare(f.owner);await dispatched(f);f.respond();expect((await work)?.phase).toBe('ready')
 })
})

it('a separately main-minted MCP ticket can publish without invalidating its own close broker reservation',()=>{
 const f=fixture(),ticket=f.leases.reserve(f.owner,'mcp-owned-save'),finish=f.service.beginWrite(f.owner,false,ticket)
 expect(finish).toBeTypeOf('function');expect(f.leases.claim(f.owner,ticket)).toBe(true)
 finish!();f.leases.settle(f.owner,ticket);expect(f.leases.ready(f.owner,ticket,f.state.stamp!)).toBe(true)
 f.leases.cancel(f.owner,ticket)
})

it('rechecks main-correlated close authority after awaited preparation without freeing its actual writer',async()=>{
 const f=fixture(),work=f.service.prepare(f.owner,undefined,false,{deferSeal:true})
 await dispatched(f);const ticket=f.sent[0].ticket,finish=f.service.beginWrite(f.owner,false,ticket)!
 expect(f.service.canPublish(f.owner,ticket)).toBe(true)
 f.service.cancel(f.owner,undefined,'later family denied')
 expect(f.service.canPublish(f.owner,ticket)).toBe(false);expect(f.leases.hasWriter(f.owner)).toBe(true)
 finish();f.respond();expect(await work).toBeNull();expect(f.leases.hasWriter(f.owner)).toBe(false)
})
