import type { CloseMutationBarrier } from '../../../../packages/electron-utils/src/renderer-close-barrier'

/** Existing drags and IME sessions must finish before a document becomes close-ready. */
export function installDocInputReservations(
  barrier:CloseMutationBarrier,
  source:()=>string,
  report:(error:unknown)=>void,
  root:Document=document,
  focus:Window=window,
):()=>void {
  const pending=new Map<string,()=>void>()
  const key=(event:Event)=>event.type.startsWith('composition') ? 'composition' : `pointer:${(event as PointerEvent).pointerId ?? 0}`
  const start=(event:Event)=>{
    if(barrier.locked)return
    const id=key(event)
    if(pending.has(id))return
    try {
      const work=barrier.runMutationWork(()=>new Promise<void>(resolve=>{pending.set(id,resolve)}),source())
      void Promise.resolve(work).catch(report)
    } catch(error){report(error)}
  }
  const end=(event:Event)=>{const id=key(event),resolve=pending.get(id);pending.delete(id);resolve?.()}
  const endAll=()=>{const resolvers=[...pending.values()];pending.clear();for(const resolve of resolvers)resolve()}
  const starts=['pointerdown','compositionstart'],ends=['pointerup','pointercancel','lostpointercapture','compositionend']
  for(const name of starts)root.addEventListener(name,start,true)
  for(const name of ends)root.addEventListener(name,end,true)
  focus.addEventListener('blur',endAll)
  return()=>{
    for(const name of starts)root.removeEventListener(name,start,true)
    for(const name of ends)root.removeEventListener(name,end,true)
    focus.removeEventListener('blur',endAll)
    endAll()
  }
}
