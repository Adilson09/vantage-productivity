// @vitest-environment node
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { selectCurrentSlidesOutput, SlidesExportAdmission, SlidesHeadlessExportLifecycle } from '../src/main/export-output-lifecycle'
import { UserOutputSelections } from '../../../packages/electron-utils/src/user-output-publication'
import { atomicWriteFile } from '../../../packages/electron-utils/src/atomic-write'
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
const prefix=join(tmpdir(),'vantage-slides-export-lifecycle-');let dir:string
beforeEach(()=>{dir=mkdtempSync(prefix)})
afterEach(()=>{vi.useRealTimers();if(!dir.startsWith(prefix))throw new Error('Unexpected test root');rmSync(dir,{recursive:true,force:true})})
it('does not adopt a sibling edit while the real native picker is outstanding',async()=>{
 const picker=deferred<string|null>(),path=join(dir,'selected.pdf');writeFileSync(path,'peer');let revision=1
 const pin=vi.fn(async()=> 'must not pin')
 const result=selectCurrentSlidesOutput({captureProof:()=>{const captured=revision;return{assertCurrent:()=>{if(captured!==revision)throw new Error('source changed')}}},pick:()=>picker.promise,pin})
 revision=2;picker.resolve(path)
 await expect(result).rejects.toThrow('source changed');expect(pin).not.toHaveBeenCalled();expect(readFileSync(path,'utf8')).toBe('peer')
})
it('retains the original proof through picker metadata capture and selected version claim',async()=>{
 const picker=deferred<string|null>(),path=join(dir,'selected.pdf');writeFileSync(path,'selected');const owner={},selections=new UserOutputSelections<object>();let current=true
 const proof={assertCurrent:()=>{if(!current)throw new Error('source changed')}}
 const result=selectCurrentSlidesOutput({captureProof:()=>proof,pick:()=>picker.promise,pin:(picked,captured)=>selections.capture(owner,[picked],captured)})
 picker.resolve(path);const id=await result;expect(id).not.toBeNull();current=false
 expect(()=>selections.claim(owner,id,[path])).toThrow('source changed')
})
it('a headless terminal report closes admission and joins actual final rename plus adoption cleanup before owner destruction',async()=>{
 const gate=new SlidesExportAdmission(),entered=deferred(),publish=deferred(),adopted=deferred(),cleanup=deferred();const path=join(dir,'selected.pdf');writeFileSync(path,'original')
 const actual=gate.run(async()=>{const temp=join(dir,'actual.tmp');writeFileSync(temp,'published');entered.resolve();await publish.promise;renameSync(temp,path);adopted.resolve();await cleanup.promise})
 await entered.promise;gate.close();let destroyed=false
 const terminal=(async()=>{try{await gate.drain()}finally{destroyed=true}})()
 await Promise.resolve();expect(destroyed).toBe(false)
 const late=vi.fn(async()=>atomicWriteFile(path,Buffer.from('late')))
 await expect(gate.run(late)).rejects.toThrow('ended');expect(late).not.toHaveBeenCalled()
 publish.resolve();await adopted.promise;expect(readFileSync(path,'utf8')).toBe('published');expect(destroyed).toBe(false)
 cleanup.resolve();await actual;await terminal;expect(destroyed).toBe(true)
})
it('a crash terminal path still joins a rejected actual operation and its finally cleanup',async()=>{
 const gate=new SlidesExportAdmission(),entered=deferred(),fail=deferred(),cleaning=deferred(),cleanup=deferred();let destroyed=false
 const work=gate.run(async()=>{try{entered.resolve();await fail.promise;throw new Error('actual failed')}finally{cleaning.resolve();await cleanup.promise}})
 const rejection=expect(work).rejects.toThrow('actual failed');await entered.promise;gate.close()
 const terminal=gate.drain().finally(()=>{destroyed=true});const terminalRejection=expect(terminal).rejects.toThrow('actual failed')
 fail.resolve();await cleaning.promise;expect(destroyed).toBe(false);cleanup.resolve();await rejection;await terminalRejection;expect(destroyed).toBe(true)
})
it('a canceled native picker does not dispatch pinning or output work',async()=>{
 const pin=vi.fn(async()=> 'unexpected')
 expect(await selectCurrentSlidesOutput({captureProof:()=>({}),pick:async()=>null,pin})).toBeNull();expect(pin).not.toHaveBeenCalled()
})

it('the original absolute300s budget owns deferred pin and waits its late actual finalizer before destruction',async()=>{
 vi.useFakeTimers();const startedAt=Date.now();await vi.advanceTimersByTimeAsync(90_000)
 const lifecycle=new SlidesHeadlessExportLifecycle(300_000,startedAt),metadata=deferred<string>(),cleaning=deferred(),cleanup=deferred(),load=vi.fn()
 const pin=lifecycle.pin(async()=>{try{return await metadata.promise}finally{cleaning.resolve();await cleanup.promise}}).then(value=>{load();return value})
 const pinFailure=expect(pin).rejects.toThrow('timed out after 300000ms')
 let destroyed=false
 const terminal=lifecycle.report.then(async report=>{expect(report.ok).toBe(false);try{await lifecycle.admission.drain()}finally{destroyed=true;lifecycle.dispose()}})
 const terminalFailure=expect(terminal).rejects.toThrow('timed out after 300000ms')
 await vi.advanceTimersByTimeAsync(209_999);expect(destroyed).toBe(false)
 await vi.advanceTimersByTimeAsync(1);expect(destroyed).toBe(false)
 await expect(lifecycle.admission.run(async()=> 'late export')).rejects.toThrow('ended')
 metadata.resolve('late selection');await cleaning.promise;expect(destroyed).toBe(false);expect(load).not.toHaveBeenCalled()
 cleanup.resolve();await pinFailure;await terminalFailure;expect(destroyed).toBe(true);expect(load).not.toHaveBeenCalled()
})
it('a renderer crash during pin closes permission immediately but retains the actual pin until settlement',async()=>{
 const lifecycle=new SlidesHeadlessExportLifecycle(300_000),metadata=deferred<string>(),load=vi.fn()
 const pin=lifecycle.pin(()=>metadata.promise).then(value=>{load();return value})
 const failure=expect(pin).rejects.toThrow('renderer stopped (crashed)')
 lifecycle.terminal({ok:false,error:'slides renderer stopped (crashed)'})
 expect(await lifecycle.report).toEqual({ok:false,error:'slides renderer stopped (crashed)'})
 let settled=false;const drain=lifecycle.admission.drain().finally(()=>{settled=true;lifecycle.dispose()})
 const drainedFailure=expect(drain).rejects.toThrow('renderer stopped (crashed)')
 await Promise.resolve();expect(settled).toBe(false)
 await expect(lifecycle.admission.run(async()=> 'late export')).rejects.toThrow('ended')
 metadata.resolve('late selection');await failure;await drainedFailure;expect(load).not.toHaveBeenCalled()
})
it('an early terminal report cannot let a late pin reopen rendering or output admission',async()=>{
 const lifecycle=new SlidesHeadlessExportLifecycle(300_000),metadata=deferred<string>(),load=vi.fn()
 const pin=lifecycle.pin(()=>metadata.promise).then(value=>{load();return value})
 const failure=expect(pin).rejects.toThrow('registered headless export ended')
 lifecycle.terminal({ok:true});lifecycle.terminal({ok:false,error:'later report'})
 expect(await lifecycle.report).toEqual({ok:true})
 metadata.resolve('late selection');await failure
 await expect(lifecycle.admission.drain()).rejects.toThrow('registered headless export ended')
 lifecycle.dispose();expect(load).not.toHaveBeenCalled()
})
it('an overdue success report cannot outrun the absolute deadline while its timer callback is delayed',async()=>{
 vi.useFakeTimers();const lifecycle=new SlidesHeadlessExportLifecycle(300_000)
 vi.setSystemTime(Date.now()+300_000)
 lifecycle.terminal({ok:true})
 expect(await lifecycle.report).toEqual({ok:false,error:'slides export timed out after 300000ms'})
 await expect(lifecycle.admission.run(async()=> 'late export')).rejects.toThrow('ended')
 await lifecycle.admission.drain();lifecycle.dispose()
})
