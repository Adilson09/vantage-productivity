import type { CloseLeaseTicket } from '../../../../../packages/electron-utils/src/close-lease'
import { beforeHtmlMutation, htmlCloseStamp, registerHtmlCloseLock } from '../close-lease'
import { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef } from 'react'
import type { HtmlOp } from '../document/ops'
import { isFromInspector, type FromInspector, type ToInspector } from './inspector-protocol'
import { DraftPreview } from './DraftPreview'
import { useI18n } from '../i18n/locale'

interface RecoveryFrameState {
  version: number
  ops: HtmlOp[]
  composing: boolean
  busy: boolean
}
export interface PreviewFrameHandle {
  readRecovery(): Promise<RecoveryFrameState>
  prepareClose(ticket:CloseLeaseTicket,validatedProof:string):Promise<RecoveryFrameState>
  commitCloseCapture(ticket:CloseLeaseTicket):Promise<RecoveryFrameState>
  releaseClose(ticket:CloseLeaseTicket):void
  closeCaptureCurrent(ticket:CloseLeaseTicket):boolean
  post(msg: ToInspector): void
}

interface Props {
  name?:string
  /** html-preview:// URL bound to this view; null until the main process reports it */
  url: string | null
  /** bump to reload the frame after the buffer was pushed to the main process */
  nonce: number
  zoom: number
  onMessage: (msg: FromInspector) => void
  /** fires for every document the frame loads, link navigations included */
  onLoad?: () => void
  /** page the AI is still writing: mirrored over the frame until it lands */
  draft?: string | null
}

/**
 * The document runs in a sandboxed frame with an opaque origin: scripts and
 * network are allowed (CDN-dependent pages must render), the app itself is out
 * of reach. Reloads go through the src attribute because the frame's window is
 * cross-origin to us; the inspector talks back over postMessage.
 */
export const PreviewFrame = forwardRef<PreviewFrameHandle, Props>(function PreviewFrame(
  { name='html-presentation',url, nonce, zoom, onMessage, onLoad, draft },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const recoverySequence = useRef(0)
  const closeTicketRef=useRef<CloseLeaseTicket|null>(null)
  const frameGeneration=useRef(0),loaded=useRef(false),capturedGeneration=useRef(-1),requestGenerations=useRef(new Map<number,number>())
  const closeRequests=useRef(new Map<number,CloseLeaseTicket>())
  const recoveryWaiters = useRef(
    new Map<
      number,
      {
        resolve: (value: RecoveryFrameState) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout>
      }
    >(),
  )
  const { t } = useI18n()
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const src=useMemo(()=>{if(!url)return 'about:blank';const target=new URL(url);target.searchParams.set('v',String(nonce));return target.href},[url,nonce])

  useLayoutEffect(()=>{frameGeneration.current++;loaded.current=false;const ticket=closeTicketRef.current;if(ticket)void window.htmlApi.cancelCloseLease(ticket,'The preview URL changed during close.').catch(error=>console.error(error))},[src])

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (!isFromInspector(event.data)) return
      const message = event.data
      if(message.type==='gx:closeInvalidated'){
        const ticket=closeTicketRef.current
        if(ticket&&ticket.id===message.ticket?.id&&ticket.sequence===message.ticket.sequence&&ticket.source===message.ticket.source)void window.htmlApi.cancelCloseLease(ticket,message.reason).then(()=>{frameRef.current?.contentWindow?.postMessage({type:'gx:closeRelease',ticket},'*');closeTicketRef.current=null;return beforeHtmlMutation(htmlCloseStamp().source)}).catch(error=>console.error(error))
        return
      }
      if (message.type === 'gx:recoveryState'||message.type==='gx:closeState') {
        if(message.type==='gx:closeState'){const expected=closeRequests.current.get(message.nonce);if(!expected||expected.id!==message.ticket?.id||expected.sequence!==message.ticket.sequence||expected.source!==message.ticket.source)return;closeRequests.current.delete(message.nonce)}
        const waiter = recoveryWaiters.current.get(message.nonce)
        if (!waiter) return
        recoveryWaiters.current.delete(message.nonce)
        clearTimeout(waiter.timer)
        const generation=requestGenerations.current.get(message.nonce);requestGenerations.current.delete(message.nonce)
        if(generation!==frameGeneration.current||!loaded.current){waiter.reject(new Error('The frame changed during pending-edit capture.'));return}
        if(message.type==='gx:closeState')capturedGeneration.current=generation
        if(message.type==='gx:closeState'&&message.error){waiter.reject(new Error(message.error));return}
        if (
          !Array.isArray(message.ops) ||
          message.ops.length > 1 ||
          typeof message.composing !== 'boolean' ||
          typeof message.busy !== 'boolean' ||
          message.ops.some(
            (op) =>
              !op ||
              !Number.isSafeInteger(op.sid) ||
              (op.op !== 'set_inner_html' && op.op !== 'set_text_node') ||
              (op.op === 'set_inner_html'
                ? typeof op.html !== 'string' || op.html.length > 8 * 1024 * 1024
                : typeof op.text !== 'string' ||
                  op.text.length > 8 * 1024 * 1024 ||
                  !Number.isSafeInteger(op.index) ||
                  op.index < 0),
          )
        )
          waiter.reject(new Error('Invalid pending visual edit.'))
        else waiter.resolve(message)
        return
      }
      onMessageRef.current(message)
    }
    window.addEventListener('message', listener)
    return () => {
      window.removeEventListener('message', listener)
      for (const waiter of recoveryWaiters.current.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('Preview closed before recovery capture.'))
      }
      recoveryWaiters.current.clear()
      closeRequests.current.clear()
      requestGenerations.current.clear()
    }
  }, [])

  useEffect(()=>registerHtmlCloseLock(()=>{
    const frame=frameRef.current;if(!frame)return()=>{}
    const visibility=frame.style.visibility,tabIndex=frame.getAttribute('tabindex');frame.style.visibility='hidden';frame.setAttribute('tabindex','-1')
    return()=>{if(frame.isConnected){frame.style.visibility=visibility;if(tabIndex===null)frame.removeAttribute('tabindex');else frame.setAttribute('tabindex',tabIndex)}}
  }),[])
  const requestState=(type:'gx:recoveryRead'|'gx:closePrepare'|'gx:closeCommit',ticket?:CloseLeaseTicket):Promise<RecoveryFrameState>=>{
    if(!loaded.current)return Promise.reject(new Error('The preview is still loading; retry close after it is ready.'))
    if(recoveryWaiters.current.size)return Promise.reject(new Error('A preview capture is already pending.'))
    const nonce=++recoverySequence.current
    requestGenerations.current.set(nonce,frameGeneration.current)
    if(ticket){closeRequests.current.set(nonce,{...ticket});closeTicketRef.current={...ticket}}
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{recoveryWaiters.current.delete(nonce);closeRequests.current.delete(nonce);requestGenerations.current.delete(nonce);reject(new Error('The preview did not acknowledge its close barrier.'))},1000)
      recoveryWaiters.current.set(nonce,{resolve,reject,timer})
      frameRef.current?.contentWindow?.postMessage({type,nonce,...(ticket?{ticket}:{})},'*')
    })
  }
  useImperativeHandle(ref, () => ({
    readRecovery:()=>requestState('gx:recoveryRead'),
    prepareClose:(ticket,validatedProof)=>{if(!/^[0-9a-f-]{36}$/.test(validatedProof))return Promise.reject(new Error('The loaded frame source has not been verified by main.'));return requestState('gx:closePrepare',ticket)},
    commitCloseCapture:ticket=>requestState('gx:closeCommit',ticket),
    closeCaptureCurrent:ticket=>loaded.current&&capturedGeneration.current===frameGeneration.current&&closeTicketRef.current?.id===ticket.id&&closeTicketRef.current.sequence===ticket.sequence&&closeTicketRef.current.source===ticket.source,
    releaseClose:ticket=>{frameRef.current?.contentWindow?.postMessage({type:'gx:closeRelease',ticket},'*');if(closeTicketRef.current?.id===ticket.id&&closeTicketRef.current.sequence===ticket.sequence&&closeTicketRef.current.source===ticket.source)closeTicketRef.current=null},
    post(msg) {
      frameRef.current?.contentWindow?.postMessage(msg, '*')
    },
  }))

  return (
    <div className="preview-host" style={{ zoom: zoom / 100 }}>
      <iframe
        ref={frameRef}
        name={name}
        className="preview-frame"
        title={t('viewPreview')}
        src={src}
        onLoad={()=>{loaded.current=true;frameGeneration.current++;const ticket=closeTicketRef.current;if(ticket)void window.htmlApi.cancelCloseLease(ticket,'The preview source changed while close was held.').catch(error=>console.error(error));onLoad?.()}}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        referrerPolicy="no-referrer"
      />
      {draft != null && <DraftPreview html={draft} />}
    </div>
  )
})
