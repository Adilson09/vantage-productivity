import {ipcMain,type IpcMainInvokeEvent} from 'electron'
type Handler=(event:IpcMainInvokeEvent,...args:any[])=>any
let execute=(channel:string,event:IpcMainInvokeEvent,args:any[],handler:Handler):any=>handler(event,...args)
export function configureSlidesOwnedInvokes(next:typeof execute):void{execute=next}
/** Keep the normal channel names for compatibility, with one strict main-owned source envelope. */
export function slidesOwnedHandle(channel:string,handler:Handler):void{ipcMain.handle(channel,(event,...args)=>execute(channel,event,args,handler))}
