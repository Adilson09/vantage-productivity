import type { Node as PmNode } from '@tiptap/pm/model'
import type { CommentInfo } from '@vantage/docx-engine'
import { docCloseBarrier, docMutationSource } from './doc-close-lease'

export interface CommentDraftAnchor { from:number; to:number; quote:string; before:string; after:string }
export interface CommentDraftTarget { id:string; parentId:string|null; author:string; date:string; text:string; anchor:string }
export interface CommentDraft { id:string; kind:'new'|'reply'|'edit'; text:string; anchor?:CommentDraftAnchor; target?:CommentDraftTarget; recovered?:boolean }
interface DraftState { readonly source:number; readonly revision:number; readonly recordedRevision:number; readonly drafts:readonly CommentDraft[]; readonly error:string|null }
const MAX_TEXT=64*1024,MAX_TOTAL=256*1024,MAX_DRAFTS=24
let state:DraftState={source:0,revision:0,recordedRevision:0,drafts:[],error:null}
const listeners=new Set<()=>void>()
function limitError(drafts:readonly CommentDraft[]):string|null{return drafts.length>MAX_DRAFTS||drafts.some(draft=>draft.text.length>MAX_TEXT)||JSON.stringify(drafts).length>MAX_TOTAL?'This comment draft is too large for recovery. Its visible text and the previous recovery copy are kept.':null}
function emit(next:DraftState):void{state=next;for(const listener of listeners)listener()}
export const subscribeCommentDrafts=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}
export const commentDraftSnapshot=()=>state
export const isCommentDraftSource=(source:number)=>source===state.source
export const hasCommentDrafts=()=>!!state.error||state.drafts.some(draft=>draft.text.trim().length>0)
export const hasUnrecordedCommentDrafts=()=>state.revision>state.recordedRevision
export function noteCommentDraftRecorded(source:number,revision:number):void{if(isCommentDraftSource(source)&&revision>state.recordedRevision&&revision<=state.revision)emit({...state,recordedRevision:revision})}
export function commentDraftAnchorText(doc:PmNode,comments:CommentInfo[],id:string):string{
 const parent=comments.find(comment=>comment.id===id)?.parentId??id
 const pieces:string[]=[];let from:number|undefined,to:number|undefined
 doc.descendants((node,position)=>{
  if(node.isText&&node.marks.some(mark=>mark.type.name==='comment'&&String(mark.attrs.ids??'').split(' ').includes(parent)))pieces.push(node.text??'')
  if(Array.isArray(node.attrs.commentStarts)&&node.attrs.commentStarts.includes(parent))from=position+1
  if(Array.isArray(node.attrs.commentEnds)&&node.attrs.commentEnds.includes(parent))to=position+node.nodeSize-1
 })
 return from!==undefined&&to!==undefined&&to>from?doc.textBetween(from,to,'\n'):pieces.join('')
}
export function captureDraftAnchor(doc:PmNode,range:{from:number;to:number}):CommentDraftAnchor|undefined{
 const {from,to}=range
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to>doc.content.size)return
 const quote=doc.textBetween(from,to,'\n');if(!quote||quote.length>MAX_TEXT)return
 return{from,to,quote,before:doc.textBetween(Math.max(0,from-40),from,'\n'),after:doc.textBetween(to,Math.min(doc.content.size,to+40),'\n')}
}
export function matchesDraftAnchor(doc:PmNode,anchor:CommentDraftAnchor|undefined):boolean{
 if(!anchor)return false
 const current=captureDraftAnchor(doc,anchor)
 return !!current&&current.quote===anchor.quote&&current.before===anchor.before&&current.after===anchor.after
}
export function captureDraftTarget(comments:CommentInfo[],id:string,anchor:string):CommentDraftTarget|undefined{
 const target=comments.find(comment=>comment.id===id)
 return target&&anchor.length<=MAX_TEXT?{id:target.id,parentId:target.parentId??null,author:target.author??'',date:target.date??'',text:target.text,anchor}:undefined
}
export function matchesDraftTarget(comments:CommentInfo[],target:CommentDraftTarget|undefined,anchor:string):boolean{
 if(!target)return false
 const current=captureDraftTarget(comments,target.id,anchor)
 return !!current&&current.parentId===target.parentId&&current.author===target.author&&current.date===target.date&&current.text===target.text&&current.anchor===target.anchor&&!!anchor
}
/** No truncation: oversized input remains visible in its composer and the prior complete journal survives. */
export function putCommentDraft(source:number,draft:CommentDraft):boolean{
 if(!isCommentDraftSource(source))return false
 return docCloseBarrier.mutate(()=>{
 const drafts=[...state.drafts.filter(value=>value.id!==draft.id),{...draft}]
 emit({...state,source,revision:state.revision+1,drafts,error:limitError(drafts)});return true
 },docMutationSource())
}
export function removeCommentDraft(source:number,id:string):void{if(isCommentDraftSource(source))docCloseBarrier.mutate(()=>{const drafts=state.drafts.filter(draft=>draft.id!==id);emit({...state,revision:state.revision+1,drafts,error:limitError(drafts)})},docMutationSource())}
export function captureCommentDraftRecovery():unknown{
 if(state.error)throw new Error(state.error)
 return JSON.parse(JSON.stringify({version:1,drafts:state.drafts.map(draft=>({...draft,recovered:undefined}))})) as unknown
}
export function assertCommentDraftRecovery(value:unknown):void{
 if(value===undefined)return
 const candidate=value as {version?:unknown;drafts?:unknown}
 if(!candidate||candidate.version!==1||!Array.isArray(candidate.drafts)||candidate.drafts.length>MAX_DRAFTS||JSON.stringify(candidate).length>MAX_TOTAL||candidate.drafts.some(item=>!item||typeof item!=='object'||typeof item.id!=='string'||item.id.length>160||!['new','reply','edit'].includes(item.kind)||typeof item.text!=='string'||item.text.length>MAX_TEXT))throw new Error('The unsent comment recovery data is invalid. The current document and previous recovery copy are kept.')
}
/** Called only inside an actual document-model commit; obsolete reads cannot reset the active store. */
export function adoptCommentDraftRecovery(value?:unknown):boolean{
 assertCommentDraftRecovery(value)
 const candidate=value as {version?:unknown;drafts?:unknown}|undefined
 let drafts:CommentDraft[]=[]
 if(candidate?.version===1&&Array.isArray(candidate.drafts)&&candidate.drafts.length<=MAX_DRAFTS&&JSON.stringify(candidate).length<=MAX_TOTAL){
  drafts=candidate.drafts.filter((item):item is CommentDraft=>!!item&&typeof item==='object'&&typeof item.id==='string'&&item.id.length<=160&&['new','reply','edit'].includes(item.kind)&&typeof item.text==='string'&&item.text.length<=MAX_TEXT).map((item,index)=>({id:'recovered:'+index,kind:item.kind,text:item.text,recovered:true,
   ...(item.anchor&&Number.isSafeInteger(item.anchor.from)&&Number.isSafeInteger(item.anchor.to)&&typeof item.anchor.quote==='string'&&typeof item.anchor.before==='string'&&typeof item.anchor.after==='string'?{anchor:{from:item.anchor.from,to:item.anchor.to,quote:item.anchor.quote,before:item.anchor.before,after:item.anchor.after}}:{}),
   ...(item.target&&typeof item.target.id==='string'&&typeof item.target.author==='string'&&typeof item.target.date==='string'&&typeof item.target.text==='string'&&typeof item.target.anchor==='string'&&(item.target.parentId===null||typeof item.target.parentId==='string')?{target:{...item.target}}:{})
  }))
 }
 // Recovered text always starts without publication authority. The reader explicitly chooses a current range/thread.
 emit({source:state.source+1,revision:drafts.length?1:0,recordedRevision:0,drafts,error:null});return drafts.length>0
}
