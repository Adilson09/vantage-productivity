/** Main-owned suppression of background publication while a native close decision is unresolved.
 * This grants no close permission. Actual writes stay owned until their finally callback. */
export interface NativeClosePromptHold {current():boolean;release():void}
interface Hold<Domain>{owner:unknown;domain:Domain;current:boolean;released:boolean}
interface DomainState<Domain>{holds:Set<Hold<Domain>>;writers:number}
export class NativeCloseAdmission<Domain> {
 private readonly owners=new Map<unknown,Hold<Domain>>()
 private readonly domains=new Map<Domain,DomainState<Domain>>()
 private state(domain:Domain):DomainState<Domain>{let state=this.domains.get(domain);if(!state){state={holds:new Set(),writers:0};this.domains.set(domain,state)}return state}
 private prune(domain:Domain,state:DomainState<Domain>):void{if(!state.writers&&!state.holds.size&&this.domains.get(domain)===state)this.domains.delete(domain)}
 hold(owner:unknown,domain:Domain):NativeClosePromptHold|null{
  const state=this.state(domain);if(this.owners.has(owner)||state.writers){this.prune(domain,state);return null}
  const entry:Hold<Domain>={owner,domain,current:true,released:false};this.owners.set(owner,entry);state.holds.add(entry)
  return Object.freeze({current:()=>!entry.released&&entry.current&&this.owners.get(owner)===entry,release:()=>{if(entry.released)return;entry.released=true;entry.current=false;if(this.owners.get(owner)===entry)this.owners.delete(owner);state.holds.delete(entry);this.prune(domain,state)}})
 }
 write(domain:Domain,automatic=false,ownedCloseOwner?:unknown):(()=>void)|null{
  const state=this.state(domain);if(automatic&&state.holds.size)return null
  if(!automatic)for(const entry of state.holds)if(ownedCloseOwner===undefined||entry.owner!==ownedCloseOwner)entry.current=false
  state.writers++;let finished=false
  return()=>{if(finished)return;finished=true;state.writers--;this.prune(domain,state)}
 }
 busy(domain:Domain):boolean{return(this.domains.get(domain)?.writers??0)>0}
 destroy(owner:unknown):void{const entry=this.owners.get(owner);if(!entry)return;entry.current=false;entry.released=true;this.owners.delete(owner);const state=this.domains.get(entry.domain);if(state){state.holds.delete(entry);this.prune(entry.domain,state)}}
}
