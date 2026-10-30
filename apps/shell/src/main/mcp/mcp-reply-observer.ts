import type {ServerResponse} from 'node:http'
import type {Socket} from 'node:net'
import {McpReplyDrain,type McpReplyTicket} from './mcp-reply-drain'

interface SocketCloseObserver {callbacks:Set<()=>void>;listener:()=>void}
const socketCloseObservers=new WeakMap<Socket,SocketCloseObserver>()
function observeSocketClose(socket:Socket,callback:()=>void):()=>void{
 if(socket.closed){callback();return()=>{}}
 let observer=socketCloseObservers.get(socket)
 if(!observer){
  const created:SocketCloseObserver={callbacks:new Set(),listener:()=>{
   socketCloseObservers.delete(socket)
   for(const notify of [...created.callbacks])notify()
   created.callbacks.clear()
  }}
  observer=created;socketCloseObservers.set(socket,created);socket.once('close',created.listener)
 }
 observer.callbacks.add(callback)
 const owned=observer
 return()=>{
  owned.callbacks.delete(callback)
  if(!owned.callbacks.size&&socketCloseObservers.get(socket)===owned){socket.off('close',owned.listener);socketCloseObservers.delete(socket)}
 }
}

/** Must be installed before the SDK/Hono request listener can write or end this response. */
export function observeStreamableReply(response:ServerResponse,tickets:readonly McpReplyTicket[],drain:McpReplyDrain):void{
 if(!tickets.length)return
 let detachSocket=()=>{}
 const disconnected=()=>{detachSocket();for(const ticket of tickets)drain.disconnected(ticket)}
 response.once('finish',()=>{detachSocket();if(response.writableFinished)for(const ticket of tickets)drain.finished(ticket);else disconnected()})
 response.once('close',disconnected)
 response.once('error',error=>{detachSocket();for(const ticket of tickets)drain.writeError(ticket,error)})
 if(response.closed){disconnected();return}
 // Hono may still be assembling its response when this generation stops. The
 // owned socket can close without a later ServerResponse terminal event.
 detachSocket=observeSocketClose(response.req.socket,disconnected)
}
/** The legacy POST's202 only acknowledges dispatch. Its actual reply belongs to the persistent SSE writer. */
export function observeLegacyPostRejection(response:ServerResponse,tickets:readonly McpReplyTicket[],drain:McpReplyDrain):void{
 response.once('finish',()=>{if(response.statusCode!==202)for(const ticket of tickets)drain.finished(ticket)})
}
interface LegacyEmission {ticket:McpReplyTicket;writes:number;callbacks:number;closed:boolean;failed:boolean}

/**
 * The installed SDK writes legacy framing synchronously inside send(). Observe
 * those exact owned writes and add callbacks; do not reproduce or parse framing.
 * A future SDK that stops exposing such writes fails closed, never certifies a
 * resolved send Promise as local flush.
 */
export function observeTransportReplies<Message,SendOptions>(
 transport:{send:(message:Message,options?:SendOptions)=>Promise<void>},
 drain:McpReplyDrain,generation:number,session:string,legacyResponse?:ServerResponse,
):()=>void{
 const originalSend=transport.send
 const originalWrite=legacyResponse?.write
 let current:LegacyEmission|undefined
 const maybeFlushed=(emission:LegacyEmission)=>{if(emission.closed&&!emission.failed&&emission.writes>0&&emission.callbacks===emission.writes)drain.writeFlushed(emission.ticket)}
 const observedWrite=function(this:ServerResponse,...args:unknown[]):boolean{
  const emission=current
  if(!emission)return Reflect.apply(originalWrite!,this,args) as boolean
  emission.writes++
  const existingIndex=typeof args[args.length-1]==='function'?args.length-1:-1
  const existing=existingIndex>=0?args[existingIndex] as (...values:unknown[])=>void:undefined
  const callback=(...values:unknown[])=>{
   emission.callbacks++
   if(values[0]){emission.failed=true;drain.writeError(emission.ticket,values[0])}
   try{existing?.(...values)}finally{maybeFlushed(emission)}
  }
  if(existingIndex>=0)args[existingIndex]=callback;else args.push(callback)
  try{return Reflect.apply(originalWrite!,this,args) as boolean}
  catch(error){emission.failed=true;drain.fail(emission.ticket,'write-error',String(error));throw error}
 }
 if(legacyResponse)legacyResponse.write=observedWrite as typeof legacyResponse.write
 const observedSend=async(message:Message,options?:SendOptions):Promise<void>=>{
  const ticket=drain.emission(generation,session,message)
  if(!ticket){await originalSend.call(transport,message,options);return}
  if(!legacyResponse){try{await originalSend.call(transport,message,options)}catch(error){drain.fail(ticket,'write-error',String(error));throw error}return}
  const emission:LegacyEmission={ticket,writes:0,callbacks:0,closed:false,failed:false},previous=current
  let sending:Promise<void>
  current=emission
  try{sending=originalSend.call(transport,message,options)}
  catch(error){emission.failed=true;drain.fail(ticket,'write-error',String(error));throw error}
  finally{current=previous}
  try{await sending;emission.closed=true;if(!emission.writes){emission.failed=true;drain.fail(ticket,'write-error','The legacy SDK exposed no owned terminal response write.')}else maybeFlushed(emission)}
  catch(error){emission.failed=true;drain.fail(ticket,'write-error',String(error));throw error}
 }
 transport.send=observedSend
 return()=>{if(transport.send===observedSend)transport.send=originalSend;if(legacyResponse&&legacyResponse.write===observedWrite)legacyResponse.write=originalWrite!}
}
