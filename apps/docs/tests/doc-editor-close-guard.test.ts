import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor, Node } from '@tiptap/core'
import { DocCloseGuard } from '../src/renderer/editor/close-guard'
import { docCloseBarrier, installDocCloseLease, setDocCloseSourceReader } from '../src/renderer/doc-close-lease'
const Doc=Node.create({name:'doc',topNode:true,content:'paragraph+'})
const Paragraph=Node.create({name:'paragraph',group:'block',content:'text*',parseHTML:()=>[{tag:'p'}],renderHTML:()=>['p',0]})
const Text=Node.create({name:'text',group:'inline'})
let source='A',sequence=10000,dispose:()=>void
const editors:Editor[]=[]
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}
function editor(){const host=document.createElement('div');document.body.append(host);const value=new Editor({element:host,extensions:[Doc,Paragraph,Text,DocCloseGuard],content:'<p>Original</p>'});editors.push(value);return value}
const ticket=()=>({id:`editor-${++sequence}`,sequence,source:'main-A'})
beforeEach(()=>{
 source=`A-${++sequence}`;setDocCloseSourceReader(()=>source)
 window.desktop={claimDocCloseLease:async()=>true,cancelDocCloseLease:async()=>{},onDocCloseRelease:()=>()=>{}} as unknown as typeof window.desktop
 dispose=installDocCloseLease(()=>{})
})
afterEach(()=>{const held=docCloseBarrier.ticket;if(held)docCloseBarrier.release(held);dispose();for(const value of editors.splice(0))value.destroy();document.body.replaceChildren()})
describe('production ProseMirror close extension',()=>{
 it('locks body and registered auxiliary editors, then restores their own editability on main release',async()=>{
   const body=editor(),textbox=editor(),header=editor();header.setEditable(false)
   await new Promise(resolve=>setTimeout(resolve,0))
   const lease=ticket();expect(await docCloseBarrier.acquire(lease,()=>true)).not.toBeNull()
   expect(body.isEditable).toBe(false);expect(textbox.isEditable).toBe(false);expect(header.isEditable).toBe(false)
   docCloseBarrier.release(lease)
   expect(body.isEditable).toBe(true);expect(textbox.isEditable).toBe(true);expect(header.isEditable).toBe(false)
 })
 it('a late programmatic transaction cancels authority before replay and authors exactly once',async()=>{
   const body=editor(),gate=deferred();await new Promise(resolve=>setTimeout(resolve,0))
   window.desktop.cancelDocCloseLease=vi.fn(()=>gate.promise)
   await docCloseBarrier.acquire(ticket(),()=>true)
   body.view.dispatch(body.state.tr.insertText('Late ',1))
   expect(body.getText()).toBe('Original');expect(docCloseBarrier.busy).toBe(true)
   gate.resolve();await vi.waitFor(()=>expect(body.getText()).toBe('Late Original'))
   expect(body.getText().match(/Late/g)).toHaveLength(1)
 })
 it('retires an old-source deferred transaction rather than applying it to a replacement document',async()=>{
   const body=editor(),gate=deferred();await new Promise(resolve=>setTimeout(resolve,0))
   window.desktop.cancelDocCloseLease=vi.fn(()=>gate.promise)
   await docCloseBarrier.acquire(ticket(),()=>true)
   body.view.dispatch(body.state.tr.insertText('Old ',1));source='B';gate.resolve()
   await vi.waitFor(()=>expect(docCloseBarrier.busy).toBe(false))
   expect(body.getText()).toBe('Original')
 })
})
