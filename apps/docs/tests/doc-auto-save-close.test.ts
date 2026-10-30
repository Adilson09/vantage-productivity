import {afterEach,expect,it,vi} from 'vitest'
import {save,type FileActionContext} from '../src/renderer/file-actions'
import {docCloseBarrier,setDocCloseSourceReader} from '../src/renderer/doc-close-lease'
const original=Object.getOwnPropertyDescriptor(window,'desktop')
afterEach(()=>{const ticket=docCloseBarrier.ticket;if(ticket)docCloseBarrier.release(ticket);setDocCloseSourceReader(()=> '0');if(original)Object.defineProperty(window,'desktop',original);else Reflect.deleteProperty(window,'desktop')})
it('actual blur/timer AutoSave refuses a held close instead of queuing a publication after cancellation',async()=>{
 const saveDocx=vi.fn(),settleFontSettings=vi.fn(),setStatus=vi.fn()
 Object.defineProperty(window,'desktop',{configurable:true,value:{claimDocCloseLease:async()=>true,cancelDocCloseLease:async()=>{},saveDocx}})
 setDocCloseSourceReader(()=> 'auto-save-close-source')
 const ticket={id:'auto-save-close',sequence:1,source:'main-source'}
 expect(await docCloseBarrier.acquire(ticket,()=>true)).not.toBeNull()
 let settled=false
 const work=save({settleFontSettings,setStatus} as unknown as FileActionContext,false,true).then(value=>{settled=true;return value})
 try{
  for(let i=0;i<8;i++)await Promise.resolve()
  expect(settled).toBe(true);expect(settleFontSettings).not.toHaveBeenCalled();expect(saveDocx).not.toHaveBeenCalled()
 }finally{docCloseBarrier.release(ticket)}
 expect(await work).toBe(false)
 for(let i=0;i<8;i++)await Promise.resolve()
 expect(settleFontSettings).not.toHaveBeenCalled();expect(saveDocx).not.toHaveBeenCalled()
})
