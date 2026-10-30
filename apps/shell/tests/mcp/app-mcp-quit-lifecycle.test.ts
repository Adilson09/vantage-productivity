// @vitest-environment node
import {createServer,request as httpRequest} from 'node:http'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {McpServerService} from '../../src/main/mcp/mcp-server'
import type {McpSettings} from '../../src/main/mcp/app-mcp'
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}
class App{
 listeners:Array<(event:{preventDefault():void})=>void>=[];attempts=0;exits=0;terminal:()=>void=()=>{}
 on(_event:'before-quit',listener:(event:{preventDefault():void})=>void){this.listeners.push(listener)}
 quit(){this.attempts++;let prevented=false;for(const listener of this.listeners)listener({preventDefault:()=>{prevented=true}});if(!prevented){this.exits++;this.terminal()}}
}
let runtime:typeof import('../../src/main/mcp/app-mcp'),Service:typeof import('../../src/main/mcp/mcp-server').McpServerService
const clients:Client[]=[],release:Array<()=>void>=[]
beforeEach(async()=>{vi.resetModules();runtime=await import('../../src/main/mcp/app-mcp');Service=(await import('../../src/main/mcp/mcp-server')).McpServerService})
afterEach(async()=>{for(const done of release.splice(0))done();for(const client of clients.splice(0))await client.close().catch(()=>{});await runtime.stopMcp();vi.restoreAllMocks()})
async function freePort(){return new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address(),port=typeof address==='object'&&address?address.port:0;server.close(()=>resolve(port))})})}
async function freshHealth(port:number):Promise<void>{await new Promise<void>((resolve,reject)=>{const request=httpRequest({host:'127.0.0.1',port,path:'/health',method:'GET',agent:false,headers:{connection:'close'}},response=>{response.resume();response.on('error',reject);response.on('end',()=>{try{expect(response.statusCode).toBe(200);resolve()}catch(error){reject(error)}})});request.on('error',reject);request.end()})}
const settings=(port:number,background=false):McpSettings=>({enabled:true,port,background,logging:false})
async function connect(port:number,kind:'streamable'|'legacy'){const client=new Client({name:'actual-app-lifecycle',version:'1'});clients.push(client);await client.connect(kind==='legacy'?new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)):new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));return client}
function configure(read:()=>Promise<unknown>){runtime.configureMcpRuntime({version:'test',defaultSaveDir:()=>process.cwd(),openPath:()=>false,openDocumentsControl:{list:async()=>[{id:'visible',kind:'docs',title:'Visible',active:true,dirty:true}],read,save:async()=>({savedPath:'unused'}),close:async()=>({})}})}
describe.each(['streamable','legacy'] as const)('actual app-mcp %s settings/quit ownership',kind=>{
 it('joins replacement ownership published after awaited settings stop and blocks uncaptured replacement work',async()=>{
  const work=deferred(),entered=deferred(),allowStop=deferred(),stopEntered=deferred();release.push(work.resolve,allowStop.resolve)
  const read=vi.fn(async()=>{entered.resolve();await work.promise;return 'owned live content'});configure(read)
  const port=await freePort();await runtime.applyMcpSettings(settings(port));const first=await connect(port,kind).catch(error=>{throw new Error('Initial client connection failed',{cause:error})})
  const oldReply=first.callTool({name:'open_documents',arguments:{action:'read',target:'visible'}});void oldReply.catch(()=>{});await entered.promise
  const stop=Service.prototype.stop
  vi.spyOn(Service.prototype,'stop').mockImplementationOnce(async function(this:McpServerService){stopEntered.resolve();await allowStop.promise;return stop.call(this)})
  const changing=runtime.applyMcpSettings(settings(port,true));void changing.catch(()=>{});await stopEntered.promise
  const app=new App(),interrupted=vi.fn();app.terminal=()=>runtime.stopMcpSync()
  runtime.installMcpQuitGuard(app,{onQuitBlocked:vi.fn(),onQuitInterrupted:interrupted});app.quit();expect(app.exits).toBe(0)
  allowStop.resolve();await changing;expect(app.exits).toBe(0);expect(runtime.mcpStatus().running).toBe(true);await first.close().catch(error=>{throw new Error('Old client close failed',{cause:error})})
  await freshHealth(port);const replacement=await connect(port,kind).catch(error=>{throw new Error('Replacement client connection failed',{cause:error})})
  await expect(replacement.callTool({name:'open_documents',arguments:{action:'read',target:'visible'}})).rejects.toThrow(/draining|503/i)
  expect(read).toHaveBeenCalledTimes(1);expect(app.exits).toBe(0)
  expect(runtime.mcpReplyDrainStatus().reduce((count,status)=>count+status.running,0)).toBe(1)
  work.resolve();await vi.waitFor(()=>expect(app.exits).toBe(1))
  expect(runtime.mcpReplyDrainStatus().every(status=>status.owned===0)).toBe(true);expect(interrupted).not.toHaveBeenCalled()
  await expect(oldReply).rejects.toThrow()
 })
})
describe('actual app-mcp terminal startup cancellation',()=>{
 it('cancels a real occupied-port listen retry immediately at terminal teardown',async()=>{
  const occupied=createServer();await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve))
  const address=occupied.address();if(!address||typeof address!=='object')throw new Error('No occupied test port')
  const retry=deferred(),lines:string[]=[],instance=new Service({port:address.port,maxListenAttempts:5,listenRetryDelayMs:5_000,logger:message=>{lines.push(message);if(message.includes('retry'))retry.resolve()}})
  let settled=false
  const starting=instance.start(),refused=expect(starting).rejects.toThrow(/abort|terminal|canceled/i)
  void starting.then(()=>{settled=true},()=>{settled=true})
  try{
   await retry.promise;instance.stopSync()
   await vi.waitFor(()=>expect(settled).toBe(true),{timeout:500,interval:10});await refused
   expect(lines.filter(message=>message.includes('retry'))).toHaveLength(1);expect(instance.isRunning()).toBe(false)
  }finally{await instance.stop();await new Promise<void>(resolve=>occupied.close(()=>resolve()))}
 })
 it('cancels an already-published delayed start and every queued settings start at terminal teardown',async()=>{
  configure(async()=>null)
  const gate=deferred(),entered=deferred();release.push(gate.resolve)
  const start=Service.prototype.start
  vi.spyOn(Service.prototype,'start').mockImplementationOnce(async function(this:McpServerService,port?:number){entered.resolve();await gate.promise;return start.call(this,port)})
  const port=await freePort(),first=runtime.applyMcpSettings(settings(port)),firstRefused=expect(first).rejects.toThrow(/terminal|canceled/i)
  await entered.promise
  const queued=runtime.applyMcpSettings(settings(port,true)),queuedRefused=expect(queued).rejects.toThrow(/terminal|canceled/i)
  runtime.stopMcpSync();gate.resolve();await firstRefused;await queuedRefused
  expect(runtime.mcpStatus().running).toBe(false)
  await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  expect(runtime.mcpReplyDrainStatus().every(status=>status.owned===0)).toBe(true)
 })
})
