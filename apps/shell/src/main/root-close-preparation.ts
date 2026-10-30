/** No Electron dependency: permission collection and final sealing are separate phases. */
export interface RootReadyClose {
  phase:'ready'
  complete(removeSync:()=>boolean):boolean
  cancel(reason:string):void|Promise<void>
}
export interface RootPreparedClose {
  phase:'prepared'
  /** Local authority only; MUST NOT call the group's isCurrent predicate. */
  isPrepared():boolean
  seal():RootReadyClose|null
  cancel(reason:string):void|Promise<void>
}
export interface RootClosePrepareOptions {deferSeal:true;signal:AbortSignal;isCurrent:()=>boolean}
export interface RootCloseParticipant {key:string;prepare(options:RootClosePrepareOptions):Promise<RootPreparedClose|null>}
export interface RootCloseGroupOptions {
  participants:readonly RootCloseParticipant[]
  isCurrent():boolean
  subscribeCancel(listener:(reason:string)=>void):()=>void
  removeSync():boolean
  blocked(reason:string):void
  report(error:unknown):void
  /** Same finite preparing budget as the leaf brokers, never a ready extension. */
  preparingMs?:number
}
export async function closeRootDocumentGroup(options:RootCloseGroupOptions):Promise<boolean>{
  const controller=new AbortController(),prepared:RootPreparedClose[]=[],ready:RootReadyClose[]=[]
  let phase:'collecting'|'sealing'|'completing'|'finished'='collecting',reason='Close preparation was canceled.'
  const abort=(message:string)=>{reason=message;if(!controller.signal.aborted)controller.abort(message)}
  const unsubscribe=options.subscribeCancel(abort)
  const timer=setTimeout(()=>abort('Close preparation expired; the workspace remains open.'),Math.min(120_000,Math.max(1,options.preparingMs??120_000)))
  const baseCurrent=()=>!controller.signal.aborted&&options.isCurrent()
  // Once sealing starts the previous receipt is ready, not prepared. Do not recursively
  // rescan it as prepared from the next leaf's isCurrent callback.
  let checkingPrepared=false,recursivePermit=false
  const isCurrent=():boolean=>{
    if(!baseCurrent())return false
    if(phase!=='collecting')return true
    // A malformed leaf that calls the group from its local predicate is refused,
    // even if it ignores the recursive false result. Never traverse permutations.
    if(checkingPrepared){recursivePermit=true;return false}
    checkingPrepared=true;recursivePermit=false
    try{return prepared.every(value=>value.isPrepared())&&!recursivePermit}
    finally{checkingPrepared=false}
  }
  let removed=false
  try{
    for(const participant of options.participants){
      if(!isCurrent())return false
      const work=participant.prepare({deferSeal:true,signal:controller.signal,isCurrent})
      // A native dialog can outlive cancellation; its late result owns no removal grant.
      let removeAbort=()=>{}
      const canceled=new Promise<null>(resolve=>{
        const listener=()=>resolve(null)
        controller.signal.addEventListener('abort',listener,{once:true})
        removeAbort=()=>controller.signal.removeEventListener('abort',listener)
        if(controller.signal.aborted)resolve(null)
      })
      const value=await Promise.race([work,canceled])
      removeAbort()
      if(controller.signal.aborted)void work.then(late=>late?.cancel(reason),options.report).catch(options.report)
      if(value)prepared.push(value)
      if(!value||value.phase!=='prepared'||!isCurrent()){reason=`Close was declined or became obsolete (${participant.key}).`;return false}
    }
    if(!isCurrent())return false
    phase='sealing'
    // There is deliberately no await from the first seal through actual removal.
    for(const value of prepared){
      if(!baseCurrent())return false
      const sealed=value.seal()
      if(!sealed||sealed.phase!=='ready'){reason='A document could not seal its final close permission.';return false}
      ready.push(sealed)
    }
    phase='completing'
    const complete=(index:number):boolean=>{
      if(!baseCurrent())return false
      return index===ready.length?options.removeSync():ready[index].complete(()=>complete(index+1))
    }
    removed=complete(0)
    if(typeof removed!=='boolean')throw new Error('Actual workspace removal must return a synchronous Boolean.')
    return removed
  }catch(error){reason='Close preparation failed; the workspace remains open.';options.report(error);return false}
  finally{
    phase='finished';clearTimeout(timer);unsubscribe()
    if(!removed){abort(reason);options.blocked(reason)}
    // Release permissions, not actual writer ownership. Leaf cancellation owns its drain.
    for(const value of [...ready,...prepared]){
      try{void Promise.resolve(value.cancel(removed?'actual removal finished':reason)).catch(options.report)}catch(error){options.report(error)}
    }
  }
}
