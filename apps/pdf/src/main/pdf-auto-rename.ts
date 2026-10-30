import { dirname, join } from 'node:path'
import { reserveFileMutation } from '@vantage/electron-utils/file-publication-exclusion'
import { readPinnedPdf, type PdfLoadedFile } from './pdf-publication'

type MoveResult='moved'|'occupied'|'failed'
/** Same-process exclusion only; external editors still require version/hash refusal. */
export async function renameOwnedPdf(options:{
  source:PdfLoadedFile
  baseName:string
  current():void
  cancelClose():void
  move(source:string,target:string):MoveResult
  adopt(target:string):void|Promise<void>
}):Promise<string|null>{
  const source=options.source,dir=dirname(source.path)
  options.current()
  // Revoke old close tickets before even queuing an own path mutation.
  options.cancelClose()
  const mutation=reserveFileMutation([{path:source.path,kind:'file'},{path:dir,kind:'directory'}])
  return mutation.run(async()=>{
    options.current()
    const pinned=await readPinnedPdf(source.path)
    const a=pinned.version,b=source.version
    if(a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs||a.ino!==b.ino||a.dev!==b.dev||pinned.sha256!==source.sha256)throw new Error('The PDF changed before its automatic rename. Reopen or retry after saving.')
    options.current()
    for(let suffix=1;suffix<=10_000;suffix++){
      const target=join(dir,suffix===1?`${options.baseName}.pdf`:`${options.baseName}-${suffix}.pdf`)
      if(target===source.path)return null
      const result=options.move(source.path,target)
      if(result==='failed')throw new Error('PDF automatic rename failed; pending content was kept.')
      if(result==='occupied')continue
      await options.adopt(target)
      return target
    }
    return null
  })
}
