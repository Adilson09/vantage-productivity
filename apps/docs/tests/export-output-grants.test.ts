import {mkdir} from 'node:fs/promises'
// @vitest-environment node
import { realpathSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DocsOutputGrants,configuredDocsExportTarget } from '../src/main/export-output-grants'
import { reserveFileMutation } from '../../../packages/electron-utils/src/file-publication-exclusion'
import { mergeOutputPath } from '../src/main/merge-output'
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();return{...actual,mkdir:vi.fn(actual.mkdir)}})
const prefix=join(realpathSync(tmpdir()),'vantage-docs-output-grants-');let dir:string
beforeEach(async()=>{dir=mkdtempSync(prefix);const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');vi.mocked(mkdir).mockImplementation(actual.mkdir)})
afterEach(()=>{if(!dir.startsWith(prefix))throw new Error('Unexpected test root');rmSync(dir,{recursive:true,force:true})})
it('pins the chosen existing output before materialization and preserves a peer replacement',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'chosen.pdf');writeFileSync(path,'chosen')
 const selectionId=await grants.captureFile(owner,path,{})
 const entered=deferred(),render=deferred()
 const job=grants.runFile(owner,path,selectionId,async lease=>{entered.resolve();await render.promise;await lease.publish(Buffer.from('rendered'))})
 await entered.promise;writeFileSync(path,'peer');render.resolve()
 await expect(job).rejects.toMatchObject({vantageCode:'SAVE_NOT_PUBLISHED'});expect(readFileSync(path,'utf8')).toBe('peer')
})
it('owns document, bounded media namespace and actual adoption before an enclosing Root move',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},folder=join(dir,'selected'),moved=join(dir,'moved');mkdirSync(folder)
 const path=join(folder,'export.md'),entered=deferred(),render=deferred(),adopted=deferred(),cleanup=deferred()
 const selectionId=await grants.captureFile(owner,path,{})
 const job=grants.runFile(owner,path,selectionId,async lease=>{entered.resolve();await render.promise;await lease.ensureMediaDirectory();await lease.publishAdditional(join(folder,'export_files','image1.png'),Buffer.from('image'));await lease.publish(Buffer.from('![](export_files/image1.png)'));adopted.resolve();await cleanup.promise})
 await entered.promise;const mutation=reserveFileMutation([{path:folder,kind:'directory'},{path:moved,kind:'directory'}]);let movedAlready=false
 const move=mutation.run(async()=>{renameSync(folder,moved);movedAlready=true})
 render.resolve();await adopted.promise;expect(movedAlready).toBe(false);cleanup.resolve();await job;await move
 expect(existsSync(folder)).toBe(false);expect(readFileSync(join(moved,'export_files','image1.png'),'utf8')).toBe('image')
})
it('keeps Markdown media versions captured before renderer materialization even when names arrive later',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'export.md'),media=join(dir,'export_files');mkdirSync(media);writeFileSync(path,'old document');writeFileSync(join(media,'image1.png'),'selected image')
 const selectionId=await grants.captureFile(owner,path,{})
 writeFileSync(join(media,'image1.png'),'peer image')
 await expect(grants.runFile(owner,path,selectionId,async lease=>{await lease.publishAdditional(join(media,'image1.png'),Buffer.from('rendered image'));await lease.publish(Buffer.from('new document'))})).rejects.toMatchObject({vantageCode:'SAVE_NOT_PUBLISHED'})
 expect(readFileSync(path,'utf8')).toBe('old document');expect(readFileSync(join(media,'image1.png'),'utf8')).toBe('peer image')
})
it('rejects an old renderer image selection id after another picker grants the same directory',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={}
 const old=await grants.captureDirectory(owner,dir,{}),current=await grants.captureDirectory(owner,dir,{})
 await expect(grants.publishDirectoryImage(owner,dir,'page-01.png',Buffer.from('obsolete'),old)).rejects.toThrow('unavailable')
 await grants.publishDirectoryImage(owner,dir,'page-01.png',Buffer.from('current'),current)
 expect(readFileSync(join(dir,'page-01.png'),'utf8')).toBe('current')
})
it('uses image versions selected before pagination rather than a late first-page observation',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'page-01.png');writeFileSync(path,'selected image')
 const id=await grants.captureDirectory(owner,dir,{})
 writeFileSync(path,'peer image')
 await expect(grants.publishDirectoryImage(owner,dir,'page-01.png',Buffer.from('rendered image'),id)).rejects.toMatchObject({vantageCode:'SAVE_NOT_PUBLISHED'})
 expect(readFileSync(path,'utf8')).toBe('peer image')
})
it('a completed move and recreated old directory never grant old image callbacks fresh authority',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},folder=join(dir,'selected'),moved=join(dir,'moved');mkdirSync(folder)
 const id=await grants.captureDirectory(owner,folder,{})
 renameSync(folder,moved);mkdirSync(folder)
 expect(()=>grants.publishDirectoryImage(owner,folder,'page-01.png',Buffer.from('obsolete'),id)).toThrow('changed')
 expect(existsSync(join(folder,'page-01.png'))).toBe(false)
})
it('the selected fresh file also pins its parent identity across move and old-directory replacement',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},folder=join(dir,'selected'),moved=join(dir,'moved');mkdirSync(folder);const path=join(folder,'fresh.pdf')
 const selectionId=await grants.captureFile(owner,path,{})
 renameSync(folder,moved);mkdirSync(folder);const materialize=vi.fn(async()=>{})
 expect(()=>grants.runFile(owner,path,selectionId,materialize)).toThrow('changed');expect(materialize).not.toHaveBeenCalled();expect(existsSync(path)).toBe(false)
})
it('terminal owner admission closure joins already accepted actual publication and cleanup',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'headless.pdf'),entered=deferred(),render=deferred(),written=deferred(),cleanup=deferred()
 const selectionId=await grants.captureFile(owner,path,{})
 const job=grants.runFile(owner,path,selectionId,async lease=>{entered.resolve();await render.promise;await lease.publish(Buffer.from('actual output'));written.resolve();await cleanup.promise})
 await entered.promise;grants.closeAdmission(owner);let terminal=false
 const drain=grants.drain(owner).then(()=>{terminal=true});await Promise.resolve();expect(terminal).toBe(false)
 expect(()=>grants.runFile(owner,path,selectionId,async()=>{})).toThrow('ended')
 render.resolve();await written.promise;expect(readFileSync(path,'utf8')).toBe('actual output');expect(terminal).toBe(false)
 cleanup.resolve();await job;await drain;expect(terminal).toBe(true)
})
it('a serializer failure before dispatch retains only the original immutable retry version',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'chosen.docx');writeFileSync(path,'selected')
 const selectionId=await grants.captureFile(owner,path,{})
 await expect(grants.runFile(owner,path,selectionId,async()=>{throw new Error('serializer failed')})).rejects.toThrow('serializer failed')
 await grants.runFile(owner,path,selectionId,async lease=>lease.publish(Buffer.from('retry output')))
 expect(readFileSync(path,'utf8')).toBe('retry output')
})
it('fresh merge planning cannot adopt a peer-winning generated name or exceed bounded metadata admission',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'generated.docx');writeFileSync(path,'peer')
 await expect(grants.captureFile(owner,path,{}, {fresh:true})).rejects.toThrow('changed')
 await expect(grants.captureFile(owner,path,{}, {additionalPaths:Array.from({length:4096},(_,index)=>join(dir,`${index}.docx`))})).rejects.toThrow('Too many')
 expect(readFileSync(path,'utf8')).toBe('peer')
})
it('mail merge plans duplicate record names uniquely before the first file is materialized',()=>{
 const reserved=new Set<string>(),first=mergeOutputPath(dir,'Same',reserved);reserved.add(process.platform==='win32'?first.toLowerCase():first)
 const second=mergeOutputPath(dir,'Same',reserved)
 expect(first).toBe(join(dir,'Same.docx'));expect(second).toBe(join(dir,'Same-2.docx'));expect(existsSync(first)).toBe(false)
})

it('refuses a selected media directory swapped and recreated while lazy media work waits',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'export.md'),media=join(dir,'export_files'),moved=media+'-moved';mkdirSync(media);writeFileSync(path,'selected doc')
 const selectionId=await grants.captureFile(owner,path,{})
 const entered=deferred(),materialize=deferred()
 const job=grants.runFile(owner,path,selectionId,async lease=>{entered.resolve();await materialize.promise;await lease.ensureMediaDirectory();await lease.publishAdditional(join(media,'image2.png'),Buffer.from('obsolete'));await lease.publish(Buffer.from('obsolete doc'))})
 await entered.promise;renameSync(media,moved);mkdirSync(media);writeFileSync(join(media,'peer.txt'),'peer');materialize.resolve()
 await expect(job).rejects.toThrow('media directory changed')
 expect(existsSync(join(media,'image2.png'))).toBe(false);expect(readFileSync(path,'utf8')).toBe('selected doc');expect(readFileSync(join(media,'peer.txt'),'utf8')).toBe('peer')
})
it('an absent media grant creates only its own directory and refuses a peer-winning collision',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'export.md'),media=join(dir,'export_files');writeFileSync(path,'selected doc')
 const selectionId=await grants.captureFile(owner,path,{})
 const entered=deferred(),materialize=deferred()
 const job=grants.runFile(owner,path,selectionId,async lease=>{entered.resolve();await materialize.promise;await lease.ensureMediaDirectory();await lease.publishAdditional(join(media,'image1.png'),Buffer.from('rendered'))})
 await entered.promise;mkdirSync(media);writeFileSync(join(media,'peer.txt'),'peer');materialize.resolve()
 await expect(job).rejects.toThrow('media directory changed');expect(existsSync(join(media,'image1.png'))).toBe(false);expect(readFileSync(join(media,'peer.txt'),'utf8')).toBe('peer')
})
it('an old actual publisher retirement cannot erase a newer selection for the same owner and path',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'selected.pdf');writeFileSync(path,'original')
 const old=await grants.captureFile(owner,path,{}),published=deferred(),cleanup=deferred()
 const job=grants.runFile(owner,path,old,async lease=>{await lease.publish(Buffer.from('first export'));published.resolve();await cleanup.promise})
 await published.promise;const next=await grants.captureFile(owner,path,{})
 cleanup.resolve();await job
 expect(grants.fileSelection(owner,path)).toBe(next)
 await grants.runFile(owner,path,next,async lease=>lease.publish(Buffer.from('newly selected export')))
 expect(readFileSync(path,'utf8')).toBe('newly selected export')
})
it('an old failed preparation or chunked retry cannot borrow a newer same-path file grant',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'selected.pdf');writeFileSync(path,'original')
 const old=await grants.captureFile(owner,path,{})
 await expect(grants.runFile(owner,path,old,async()=>{throw new Error('print failed')})).rejects.toThrow('print failed')
 writeFileSync(path,'peer chosen in the newer dialog');const next=await grants.captureFile(owner,path,{}),prepare=vi.fn(async()=>{})
 await expect(grants.runFile(owner,path,old,prepare)).rejects.toThrow('Select the export destination again');expect(prepare).not.toHaveBeenCalled()
 expect(grants.fileSelection(owner,path)).toBe(next);expect(readFileSync(path,'utf8')).toBe('peer chosen in the newer dialog')
})

it('exclusive media creation never adopts a peer directory winning after its absence check',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'export.md'),media=join(dir,'export_files');writeFileSync(path,'selected doc')
 const selection=await grants.captureFile(owner,path,{})
 const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
 vi.mocked(mkdir).mockImplementation(async(path,options)=>{if(String(path)===media){mkdirSync(media);writeFileSync(join(media,'peer.txt'),'peer won exclusive namespace')}return actual.mkdir(path,options as Parameters<typeof actual.mkdir>[1])})
 await expect(grants.runFile(owner,path,selection,async lease=>{await lease.ensureMediaDirectory();await lease.publishAdditional(join(media,'image1.png'),Buffer.from('must not publish'))})).rejects.toMatchObject({code:'EEXIST'})
 expect(readFileSync(join(media,'peer.txt'),'utf8')).toBe('peer won exclusive namespace');expect(existsSync(join(media,'image1.png'))).toBe(false);expect(readFileSync(path,'utf8')).toBe('selected doc')
})

it('the explicit fidelity capability rejects absent config, sibling prefixes and escaped targets',()=>{
 const root=join(dir,'exports')
 expect(configuredDocsExportTarget(null,join(root,'selected.pdf'))).toBe(false)
 expect(configuredDocsExportTarget(root,join(dir,'exports-other','selected.pdf'))).toBe(false)
 expect(configuredDocsExportTarget(root,join(root,'..','outside.pdf'))).toBe(false)
 expect(configuredDocsExportTarget(root,join(root,'selected.pdf'))).toBe(true)
})
it('Markdown with a chosen nonstandard filename still owns only its exact derived media namespace',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'unusual.data'),media=join(dir,'unusual.data_files')
 const selection=await grants.captureFile(owner,path,{}, {mediaDirectory:media})
 await grants.runFile(owner,path,selection,async lease=>{await lease.ensureMediaDirectory();await lease.publishAdditional(join(media,'image1.png'),Buffer.from('image'));await lease.publish(Buffer.from('Markdown bytes'))})
 expect(readFileSync(path,'utf8')).toBe('Markdown bytes');expect(readFileSync(join(media,'image1.png'),'utf8')).toBe('image')
})
it('a media option cannot widen output authority outside its exact file-derived namespace',async()=>{
 const grants=new DocsOutputGrants<object>(),owner={},path=join(dir,'chosen.md')
 await expect(grants.captureFile(owner,path,{}, {mediaDirectory:join(dir,'unrelated')})).rejects.toThrow('derived from this exact output')
 expect(existsSync(join(dir,'unrelated'))).toBe(false)
})
