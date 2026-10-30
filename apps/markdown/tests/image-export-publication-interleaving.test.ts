// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImageExportSessions } from '../src/main/image-export'
import { reserveFileMutation } from '../../../packages/electron-utils/src/file-publication-exclusion'
vi.mock('node:fs/promises',async importOriginal=>{const real=await importOriginal<typeof import('node:fs/promises')>();return{...real,rename:vi.fn(real.rename)}})
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}
const prefix=join(tmpdir(),'vantage-image-export-actual-');let dir:string
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='
beforeEach(async()=>{dir=mkdtempSync(prefix);const real=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');vi.mocked(rename).mockImplementation(real.rename)})
afterEach(()=>{if(!dir.startsWith(prefix))throw new Error('Unexpected test root');rmSync(dir,{recursive:true,force:true})})
it('holds an actual page final rename before an enclosing move and never recreates the old folder',async()=>{
 const sessions=new ImageExportSessions(),id=await sessions.start(1,dir,'Report');const folder=join(dir,readdirSync(dir)[0]!),moved=folder+'-moved'
 const entered=deferred(),release=deferred(),real=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
 vi.mocked(rename).mockImplementation(async(a,b)=>{if(String(b).endsWith('page-01.png')){entered.resolve();await release.promise}return real.rename(a,b)})
 const write=sessions.write(1,id,1,png);await entered.promise
 const mutation=reserveFileMutation([{path:folder,kind:'directory'},{path:moved,kind:'directory'}]);let didMove=false
 const job=mutation.run(async()=>{renameSync(folder,moved);didMove=true});expect(didMove).toBe(false)
 release.resolve();await write;await job
 expect(readFileSync(join(moved,'page-01.png'))).toEqual(Buffer.from(png,'base64'));expect(existsSync(folder)).toBe(false)
 await expect(sessions.write(1,id,2,png)).rejects.toThrow();await sessions.finish(1,id,false)
 expect(existsSync(folder)).toBe(false)
})
it('cancellation awaits the actual write and preserves peer additions or replacements',async()=>{
 const sessions=new ImageExportSessions(),id=await sessions.start(1,dir,'Report');const folder=join(dir,readdirSync(dir)[0]!)
 const entered=deferred(),release=deferred(),real=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
 vi.mocked(rename).mockImplementation(async(a,b)=>{if(String(b).endsWith('page-01.png')){entered.resolve();await release.promise}return real.rename(a,b)})
 const write=sessions.write(1,id,1,png);await entered.promise;let canceled=false
 const cancel=sessions.finish(1,id,false).then(()=>{canceled=true});await Promise.resolve();expect(canceled).toBe(false)
 writeFileSync(join(folder,'peer.txt'),'peer');release.resolve();await write;await cancel
 expect(readFileSync(join(folder,'peer.txt'),'utf8')).toBe('peer');expect(existsSync(join(folder,'page-01.png'))).toBe(false)
})
it('rejects stale source authority before creating a new selected-directory child',async()=>{
 const sessions=new ImageExportSessions()
 await expect(sessions.start(1,dir,'Report',{assertCurrent:()=>{throw new Error('source moved')}})).rejects.toThrow('source moved')
 expect(readdirSync(dir)).toEqual([])
})
