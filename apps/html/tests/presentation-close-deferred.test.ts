// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {HtmlPresentationClose} from '../src/main/html-presentation-close'
let close:HtmlPresentationClose
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{close?.destroy(1);vi.useRealTimers()})
function fixture(){let owner:number|undefined=7;close=new HtmlPresentationClose({alive:()=>true,sourceOwner:()=>owner});return{close,replace:()=>{owner=8}}}
it('read-only display holds explicit preparing authority beyond5s then starts ready5s only at seal',async()=>{const f=fixture(),prepared=f.close.prepare(1,{deferSeal:true});expect(prepared.phase).toBe('prepared');await vi.advanceTimersByTimeAsync(6_000);expect(f.close.isPrepared(1,prepared)).toBe(true);const ready=f.close.seal(1,prepared)!;expect(ready.phase).toBe('ready');expect(f.close.complete(1,ready,()=>true)).toBe(true)})
it('cannot close from a Boolean-era, missing-phase or copied/forged display receipt',()=>{const f=fixture(),prepared=f.close.prepare(1,{deferSeal:true}),remove=vi.fn(()=>true);expect(f.close.complete(1,{...prepared,phase:'ready'},remove)).toBe(false);expect(f.close.complete(1,{...prepared,phase:undefined},remove)).toBe(false);expect(remove).not.toHaveBeenCalled()})
it('display owner replacement invalidates local preparation and final seal',()=>{const f=fixture(),prepared=f.close.prepare(1,{deferSeal:true});f.replace();expect(f.close.isPrepared(1,prepared)).toBe(false);expect(f.close.seal(1,prepared)).toBe(null)})
it('display expiry and operation-specific abort retain no future removal permission',async()=>{const f=fixture(),prepared=f.close.prepare(1,{deferSeal:true});await vi.advanceTimersByTimeAsync(120_000);expect(f.close.seal(1,prepared)).toBe(null);const abort=new AbortController(),fresh=f.close.prepare(1,{deferSeal:true,signal:abort.signal});abort.abort();expect(f.close.isPrepared(1,fresh)).toBe(false)})
