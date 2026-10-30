// @vitest-environment jsdom
import {act,createElement} from 'react'
import {createRoot} from 'react-dom/client'
import type {Editor} from '@tiptap/core'
import {describe,expect,it,vi} from 'vitest'
const dialog=vi.hoisted(()=>({submit:null as null|((label:string)=>void)}))
vi.mock('../src/renderer/i18n/locale',()=>({useI18n:()=>({t:(key:string)=>key})}))
vi.mock('../src/renderer/editor/Redaction',()=>({hasRedactionIn:()=>false}))
vi.mock('../src/renderer/editor/RedactDialog',()=>({RedactDialog:(props:{onSubmit:(label:string)=>void})=>{dialog.submit=props.onSubmit;return null}}))
import {RedactMenu} from '../src/renderer/components/RedactMenu'
describe('captured Markdown redaction dialog ownership',()=>{
 it.each(['source replacement','approved discard generation'])('ignores a late submit after %s',async()=>{const host=document.createElement('div'),editorDom=document.createElement('div');document.body.append(host,editorDom);const root=createRoot(host),apply=vi.fn(),chain={focus:()=>chain,setRedaction:()=>chain,run:apply};let current=true;const editor={view:{dom:editorDom},state:{selection:{empty:false,from:0,to:4},doc:{textBetween:()=> 'text'}},chain:()=>chain} as unknown as Editor;try{await act(async()=>root.render(createElement(RedactMenu,{editor,enabled:true,sourceCurrent:()=>current})));await act(async()=>{editorDom.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:1,clientY:2}))});await act(async()=>{host.querySelector<HTMLButtonElement>('.redact-menu-item')!.click()});expect(dialog.submit).toBeTypeOf('function');current=false;await act(async()=>{dialog.submit!('late label')});expect(apply).not.toHaveBeenCalled()}finally{await act(async()=>root.unmount());host.remove();editorDom.remove();dialog.submit=null}})
})
