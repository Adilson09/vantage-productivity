import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {afterEach,describe,expect,it} from 'vitest'
import {discardPendingOwnedAssets,pendingOwnedAssetsForDocument,prepareAssetsForSaveAs,readOwnedAssetManifest,reconcileOwnedAssets,resolveSourcePendingAfterSaveAs,rollbackPreparedSaveAsAssets,writeImageIntoOwnedAssets} from '../src/main/asset-lifecycle'

const directories:string[]=[]
async function document(name='note.md'){const directory=await mkdtemp(join(tmpdir(),'Markdown-retained-assets-'));directories.push(directory);const path=join(directory,name);await writeFile(path,'initial');return path}
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})))})

describe('Markdown ambiguous asset custody',()=>{
 it('keeps an image used by an older open alias or saved history after a newer publication omits it',async()=>{
  const path=await document(),source=await writeImageIntoOwnedAssets(path,'history.png',Buffer.from('history bytes'))
  const olderAlias='![history]('+source+')',retained:string[]=[]
  await reconcileOwnedAssets(path,[source])
  await writeFile(path,'newer published content without image')
  const result=await reconcileOwnedAssets(path,[],{retainUnproven:true,onRetained:names=>retained.push(...names)})
  expect(olderAlias).toContain(source);expect(result.deleted).toEqual([]);expect(result.preserved).toContain('history.png');expect(retained).toContain('history.png')
  expect(await readFile(join(dirname(path),source),'utf8')).toBe('history bytes')
  expect(await readFile(path,'utf8')).toBe('newer published content without image')
  expect((await readOwnedAssetManifest(path)).files.map(file=>file.name)).toContain('history.png')
 })
 it('does not treat a filename pending key as proof that another process released the candidate',async()=>{
  const path=await document(),source=await writeImageIntoOwnedAssets(path,'pending.png',Buffer.from('foreign alias pending')),retained:string[]=[]
  const options={retainUnproven:true,onRetained:(names:readonly string[])=>retained.push(...names)}
  const pending=await pendingOwnedAssetsForDocument(path)
  await reconcileOwnedAssets(path,[],{...options,pendingNames:pending})
  expect(await resolveSourcePendingAfterSaveAs(path,pending,options)).toMatchObject({deleted:[],preserved:['pending.png']})
  expect(await discardPendingOwnedAssets(path,options)).toMatchObject({deleted:[],preserved:['pending.png']})
  expect(await pendingOwnedAssetsForDocument(path)).toEqual(['pending.png']);expect(await readFile(join(dirname(path),source),'utf8')).toBe('foreign alias pending');expect(retained).toContain('pending.png')
 })
 it('keeps prepared Save As copies on publication rollback instead of guessing cross-process ownership',async()=>{
  const sourcePath=await document(),targetPath=await document('copy.md'),source=await writeImageIntoOwnedAssets(sourcePath,'pending.png',Buffer.from('copy bytes')),retained:string[]=[]
  const text='![history]('+source+')'
  const plan=await prepareAssetsForSaveAs(sourcePath,targetPath,text,[source],{retainUnproven:true})
  expect(plan.created).toHaveLength(1)
  await rollbackPreparedSaveAsAssets(plan,{retainUnproven:true,onRetained:names=>retained.push(...names)})
  expect(retained).toEqual(['pending.png']);expect(await readFile(join(dirname(targetPath),'assets','pending.png'),'utf8')).toBe('copy bytes')
  expect(await pendingOwnedAssetsForDocument(targetPath)).toEqual(['pending.png']);expect(await readFile(targetPath,'utf8')).toBe('initial')
 })
})
