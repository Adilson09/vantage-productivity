import { assertZipPartInflatesWithinLimit } from '@vantage/zip-gate'
import { loadDocxZip } from './zip-load'

const PART='customXml/vantage-unsent-comments.xml',MAX_CHARS=256*1024
async function loadRecoveryPackage(bytes:Uint8Array){
 // A lying declaration is rejected during bounded streaming inflation, before JSZip normalization or string extraction.
 await assertZipPartInflatesWithinLimit(bytes,PART,MAX_CHARS*6+256)
 return loadDocxZip(bytes)
}
const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
/** Inert recovery-only metadata: never inserts a published Word comment. */
export async function readDocxRecoveryData(bytes:Uint8Array):Promise<unknown>{
 if(bytes.length===0)return undefined
 const zip=await loadRecoveryPackage(bytes),part=zip.file(PART)
 if(!part)return undefined
 const xml=await part.async('string')
 if(xml.length>MAX_CHARS*6+256)throw new Error('The recovered comment data exceeds its limit.')
 const match=/^<vantage-unsent-comments version="1">([\s\S]*)<\/vantage-unsent-comments>$/.exec(xml)
 if(!match)throw new Error('The recovered comment data is invalid.')
 const json=match[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
 if(json.length>MAX_CHARS)throw new Error('The recovered comment data exceeds its limit.')
 return JSON.parse(json)
}
/** Undefined removes recovery metadata from ordinary Save output. */
export async function writeDocxRecoveryData(bytes:Uint8Array,value?:unknown):Promise<Uint8Array>{
 const zip=await loadRecoveryPackage(bytes)
 if(value===undefined){if(!zip.file(PART))return bytes;zip.remove(PART)}
 else{const json=JSON.stringify(value);if(json.length>MAX_CHARS)throw new Error('The comment drafts exceed the recovery limit.');zip.file(PART,'<vantage-unsent-comments version="1">'+escape(json)+'</vantage-unsent-comments>')}
 return zip.generateAsync({type:'uint8array',compression:'DEFLATE'})
}
