import {resolve} from 'node:path'
import {createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {atomicWriteFile,readAtomicFileVersion,type AtomicFileVersion} from '@vantage/electron-utils/atomic-write'
export {readAtomicFileVersion,type AtomicFileVersion}
/** Missing/read-error loaded authority never silently becomes a new destination. */
export function loadedDocVersion(value:AtomicFileVersion|undefined):AtomicFileVersion{
 if(!value)throw new Error('The original file version is unavailable. Keep this document open and use Save As to a separate file.')
 return Object.freeze({...value})
}
/** The prepared snapshot and its originally selected/loaded destination travel together. */
export async function prepareAndPublishDocx<T extends {bytes:Buffer}>(filePath:string,expected:AtomicFileVersion|null,prepare:()=>Promise<T>,beforePublication?:()=>void):Promise<T>{
 const version=expected===null?null:loadedDocVersion(expected)
 const result=await prepare()
 beforePublication?.()
 await atomicWriteFile(filePath,result.bytes,{expectedVersion:version})
 return result
}

/** An owned rename may change inode/timestamps; only identical loaded bytes can rebind it. */
export async function rebindDocRename(filePath:string,previous:AtomicFileVersion,expectedSha256:string):Promise<AtomicFileVersion>{
 if(!/^[a-f0-9]{64}$/i.test(expectedSha256))throw new Error('The renamed document has no verified original digest.')
 const before=await readAtomicFileVersion(filePath)
 if(!before||before.size!==previous.size)throw new Error('The renamed file differs from the original document; keep the unsaved document open.')
 let digest=before.sha256
 if(digest===undefined){
  const hash=createHash('sha256');let total=0
  for await(const chunk of createReadStream(filePath,{highWaterMark:128*1024})){
   total+=chunk.length;if(total>previous.size)throw new Error('The renamed file changed during verification.')
   hash.update(chunk)
  }
  if(total!==previous.size)throw new Error('The renamed file changed during verification.')
  digest=hash.digest('hex')
 }
 const after=await readAtomicFileVersion(filePath)
 if(digest!==expectedSha256||!after||(['size','mtimeMs','ctimeMs','ino','dev'] as const).some(key=>before[key]!==after[key]))throw new Error('The renamed file differs from the original document; keep the unsaved document open.')
 return Object.freeze({...after})
}

export function sameDocPublicationPath(a:string,b:string):boolean{
 const key=(value:string)=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value)
 return key(a)===key(b)
}
