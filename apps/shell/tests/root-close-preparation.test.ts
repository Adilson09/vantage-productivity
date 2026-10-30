import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {CloseLeaseBroker,type CloseLeaseStamp} from '../../../packages/electron-utils/src/close-lease'
import {RootQuitIntent} from '../src/main/root-quit-intent'
import {closeRootDocumentGroup,type RootCloseParticipant,type RootClosePrepareOptions,type RootPreparedClose} from '../src/main/root-close-preparation'
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
function fixture(){
 const owners=[{source:'A',revision:'1',alive:true},{source:'B',revision:'1',alive:true},{source:'C',revision:'1',alive:true}]
 const releases=vi.fn(),broker=new CloseLeaseBroker<typeof owners[number]>({alive:o=>o.alive,source:o=>o.source,validate:(o,_t,s)=>o.revision===s.revision&&o.source===s.source,release:releases})
 const intent=new RootQuitIntent(),epoch=intent.capture(),remove=vi.fn(()=>true),blocked=vi.fn((reason:string)=>intent.cancel(reason,false)),report=vi.fn(),seals:string[]=[]
 let sequence=0,ownerSetCurrent=true
 const leaf=(index:number,dialog?:Promise<void>):RootCloseParticipant=>({key:String(index),prepare:async(options:RootClosePrepareOptions):Promise<RootPreparedClose|null>=>{
  if(dialog)await dialog
  if(options.signal.aborted||!options.isCurrent())return null
  const owner=owners[index],ticket=broker.reserve(owner,`request-${++sequence}`),stamp:CloseLeaseStamp={source:owner.source,revision:owner.revision}
  broker.settle(owner,ticket)
  const abort=()=>broker.cancel(owner,ticket,'group canceled')
  options.signal.addEventListener('abort',abort,{once:true})
  const cancel=()=>{options.signal.removeEventListener('abort',abort);broker.cancel(owner,ticket,'finished')}
  return{phase:'prepared',isPrepared:()=>broker.claim(owner,ticket),seal:()=>{
   if(!options.isCurrent()||!broker.ready(owner,ticket,stamp))return null
   seals.push(String(index))
   return{phase:'ready',complete:close=>broker.complete(owner,ticket,stamp,close),cancel}
  },cancel}
 }})
 const start=(participants:RootCloseParticipant[])=>closeRootDocumentGroup({participants,isCurrent:()=>ownerSetCurrent&&intent.current(epoch),subscribeCancel:listener=>intent.subscribe(listener),removeSync:remove,blocked,report})
 return{owners,broker,releases,intent,remove,blocked,report,seals,leaf,start,replaceViews:()=>{ownerSetCurrent=false}}
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers())
describe('Root collect, final seal, actual removal',()=>{
 it('keeps first approval preparing across a later prompt longer than ready lifetime, then seals all without awaiting',async()=>{
  const f=fixture(),dialog=deferred<void>(),work=f.start([f.leaf(0),f.leaf(1,dialog.promise)])
  for(let i=0;i<8;i++)await Promise.resolve()
  await vi.advanceTimersByTimeAsync(10_000);expect(f.seals).toEqual([]);expect(f.remove).not.toHaveBeenCalled()
  dialog.resolve();expect(await work).toBe(true);expect(f.seals).toEqual(['0','1']);expect(f.remove).toHaveBeenCalledOnce();expect(f.blocked).not.toHaveBeenCalled()
 })
 it('does not recursively treat an already-sealed receipt as prepared while sealing the next',async()=>{
  const f=fixture();expect(await f.start([f.leaf(0),f.leaf(1)])).toBe(true);expect(f.seals).toEqual(['0','1'])
 })
 it.each(['source','revision','views'] as const)('refuses actual removal if %s changes while another prompt is pending',async kind=>{
  const f=fixture(),dialog=deferred<void>(),work=f.start([f.leaf(0),f.leaf(1,dialog.promise)])
  for(let i=0;i<8;i++)await Promise.resolve()
  if(kind==='source')f.owners[0].source='replacement'
  if(kind==='revision')f.owners[0].revision='2'
  if(kind==='views')f.replaceViews()
  dialog.resolve();expect(await work).toBe(false);expect(f.remove).not.toHaveBeenCalled();expect(f.blocked).toHaveBeenCalledOnce()
 })
 it('expires under the original finite preparing budget and rejects late prompt Save dispatch',async()=>{
  const f=fixture(),dialog=deferred<void>(),work=f.start([f.leaf(0),f.leaf(1,dialog.promise)])
  for(let i=0;i<8;i++)await Promise.resolve()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await work).toBe(false);expect(f.remove).not.toHaveBeenCalled()
  dialog.resolve();for(let i=0;i<8;i++)await Promise.resolve()
  expect(f.seals).toEqual([]);expect(f.broker.hasWriter(f.owners[1])).toBe(false)
 })
 it('Return cancels pending preparations and keeps an unsettled writer actually owned',async()=>{
  const f=fixture(),dialog=deferred<void>(),work=f.start([f.leaf(0),f.leaf(1,dialog.promise)])
  for(let i=0;i<8;i++)await Promise.resolve()
  f.intent.cancel('Return to workspace',false);expect(await work).toBe(false)
  const ticket=f.broker.reserve(f.owners[0],'real-new-writer');expect(f.broker.hasWriter(f.owners[0])).toBe(true)
  f.broker.cancel(f.owners[0],ticket,'later family veto');expect(f.broker.hasWriter(f.owners[0])).toBe(true)
  dialog.resolve();for(let i=0;i<8;i++)await Promise.resolve()
  expect(f.remove).not.toHaveBeenCalled();f.broker.settle(f.owners[0],ticket)
 })
 it('missing prepared phase cannot become an approval through a Boolean or ready receipt',async()=>{
  const f=fixture(),cancel=vi.fn(),malformed={key:'legacy',prepare:async()=>({phase:'ready',cancel}) as unknown as RootPreparedClose}
  expect(await f.start([malformed])).toBe(false);expect(cancel).toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled()
 })
 it('a failed final nested authority check never reaches the actual removal callback',async()=>{
  const f=fixture(),first=f.leaf(0),second=f.leaf(1)
  const bad:RootCloseParticipant={key:'bad',prepare:async options=>{
   const value=await second.prepare(options);if(!value)return null
   return{...value,seal:()=>{const sealed=value.seal();return sealed?{...sealed,complete:()=>false}:null}}
  }}
  expect(await f.start([first,bad])).toBe(false);expect(f.remove).not.toHaveBeenCalled()
 })
})

it('collects three local participants and seals all without recursive sibling permutations',async()=>{
 const f=fixture(),dialog=deferred<void>(),work=f.start([f.leaf(0),f.leaf(1),f.leaf(2,dialog.promise)])
 for(let i=0;i<20;i++)await Promise.resolve()
 await vi.advanceTimersByTimeAsync(9_000);expect(f.seals).toEqual([])
 dialog.resolve();expect(await work).toBe(true);expect(f.seals).toEqual(['0','1','2']);expect(f.remove).toHaveBeenCalledOnce()
})
it('fails closed on a malformed local predicate that recursively calls the group permit',async()=>{
 const f=fixture(),local=vi.fn(),cancel=vi.fn()
 const malformed:RootCloseParticipant={key:'recursive',prepare:async options=>({phase:'prepared',isPrepared:()=>{local();options.isCurrent();return true},seal:()=>{throw new Error('must never seal')},cancel})}
 expect(await f.start([malformed,f.leaf(1),f.leaf(2)])).toBe(false)
 expect(local).toHaveBeenCalledOnce();expect(f.remove).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalled()
})
