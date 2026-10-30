// @vitest-environment node
import {mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {DocumentPublication,absentPublicationTarget,readPublicationFile} from '../../../packages/electron-utils/src/document-publication'
import {publishSlidesDocument} from '../src/main/slides-publication'
let root='',previousVault:string|undefined
function gate(){let done!:()=>void;const promise=new Promise<void>(resolve=>{done=resolve});return{promise,done}}
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'slides-publication-'));previousVault=process.env.VANTAGE_RECOVERY_ROOT;process.env.VANTAGE_RECOVERY_ROOT=join(root,'history')})
afterEach(async()=>{if(previousVault===undefined)delete process.env.VANTAGE_RECOVERY_ROOT;else process.env.VANTAGE_RECOVERY_ROOT=previousVault;if(!root.startsWith(join(tmpdir(),'slides-publication-')))throw new Error('Unexpected test directory');await rm(root,{recursive:true,force:true})})
describe('actual Slides captured-package conditional publisher',()=>{
 it('streams only a captured inert package into a sibling temporary file while leaving the original complete',async()=>{
  const path=join(root,'deck.pptx');await writeFile(path,'ORIGINAL DECK');const loaded=await readPublicationFile(path,()=>readFile(path)),publication=new DocumentPublication(loaded.binding),live={body:'CAPTURED PACKAGE'},entered=gate(),resume=gate();let temporary=''
  const saving=publishSlidesDocument(publication,path,{source:publication.snapshot()},()=>({...live}),async(snapshot,tmp)=>{temporary=tmp;await writeFile(tmp,snapshot.body);entered.done();await resume.promise});await entered.promise
  expect(temporary).not.toBe(path);expect(await readFile(path,'utf8')).toBe('ORIGINAL DECK');live.body='NEWER UNSAVED PACKAGE';resume.done();const captured=await saving;expect(captured.body).toBe('CAPTURED PACKAGE');expect(live.body).toBe('NEWER UNSAVED PACKAGE');expect(await readFile(path,'utf8')).toBe('CAPTURED PACKAGE')
 })
 it('cannot recreate a deck moved during the actual serializer await and retains the complete serialized rescue',async()=>{
  const path=join(root,'deck.pptx'),moved=join(root,'moved.pptx');await writeFile(path,'ORIGINAL DECK');const loaded=await readPublicationFile(path,()=>readFile(path)),publication=new DocumentPublication(loaded.binding),entered=gate(),resume=gate()
  const saving=publishSlidesDocument(publication,path,{source:publication.snapshot()},()=>({body:'FULL SERIALIZED DECK'}),async(snapshot,tmp)=>{await writeFile(tmp,snapshot.body);entered.done();await resume.promise}).then(()=>null,error=>error);await entered.promise;await rename(path,moved);resume.done();const error=await saving;expect(error).toBeTruthy();await expect(readFile(path)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(moved,'utf8')).toBe('ORIGINAL DECK');expect(await readFile(error.recoveryPath,'utf8')).toBe('FULL SERIALIZED DECK')
 })
 it('refuses a pre-renderer Save ticket after a verified Root move instead of treating the old path as new',async()=>{const path=join(root,'deck.pptx'),moved=join(root,'moved.pptx');await writeFile(path,'ORIGINAL');const loaded=await readPublicationFile(path,()=>readFile(path)),publication=new DocumentPublication(loaded.binding),source=publication.snapshot();await rename(path,moved);await publication.rebindMoved(path,moved);await expect(publishSlidesDocument(publication,path,{source},()=>({}),async(_snapshot,tmp)=>{await writeFile(tmp,'STALE')})).rejects.toThrow(/lineage changed/);await expect(readFile(path)).rejects.toMatchObject({code:'ENOENT'})})
 it('supports a new SaveAs copy with expected absence while the loaded deck stays complete',async()=>{const original=join(root,'deck.pptx'),copy=join(root,'copy.pptx');await writeFile(original,'ORIGINAL');const loaded=await readPublicationFile(original,()=>readFile(original)),publication=new DocumentPublication(loaded.binding);await publishSlidesDocument(publication,copy,{source:publication.snapshot(),target:absentPublicationTarget(copy)},()=>({body:'COPY'}),async(snapshot,tmp)=>{await writeFile(tmp,snapshot.body)});expect(await readFile(original,'utf8')).toBe('ORIGINAL');expect(await readFile(copy,'utf8')).toBe('COPY')})
})
