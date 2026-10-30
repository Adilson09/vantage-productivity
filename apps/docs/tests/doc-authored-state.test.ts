import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, startTransition, StrictMode, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DocAuthoredStateProvider, useDocAuthoredScope, useDocAuthoredState, withDocAuthoredContext } from '../src/renderer/doc-authored-state'
import { docCloseBarrier, setDocCloseSourceReader } from '../src/renderer/doc-close-lease'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => {resolve=done}); return {promise,resolve} }
let source = '', sequence = 0, root: Root, host: HTMLDivElement
let append!: Dispatch<SetStateAction<string[]>>, live!: {values:string[]}
const ticket = () => ({id:`react-${++sequence}`,sequence,source:`main-${source}`})
function Projection() {
  const [values,set] = useDocAuthoredState<string[]>('values', [])
  append=set
  live=withDocAuthoredContext({values},useDocAuthoredScope())
  return createElement('output',null,values.join(','))
}
function tree() { return createElement(StrictMode,null,createElement(DocAuthoredStateProvider,null,createElement(Projection))) }
beforeEach(async () => {
  source=`source-${++sequence}`
  setDocCloseSourceReader(()=>source)
  window.desktop={claimDocCloseLease:vi.fn(async()=>true),cancelDocCloseLease:vi.fn(async()=>{})} as unknown as typeof window.desktop
  ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>{root.render(tree())})
})
afterEach(async()=>{const held=docCloseBarrier.ticket;if(held)docCloseBarrier.release(held);await act(async()=>root.unmount());host.remove()})

describe('actual Docs authored hook in StrictMode',()=>{
  it('projects a deferred transition without authoring a second time behind a ready lease',async()=>{
    const author=vi.fn((prior:string[])=>[...prior,'one'])
    await act(async()=>{
      startTransition(()=>append(author))
      expect(live.values).toEqual(['one'])
      expect(await docCloseBarrier.acquire(ticket(),()=>live.values.length===1)).not.toBeNull()
      root.render(tree())
    })
    expect(host.textContent).toBe('one');expect(live.values).toEqual(['one']);expect(author).toHaveBeenCalledTimes(1)
  })
  it('queues one held append across repeated projections and applies once after main cancellation',async()=>{
    const gate=deferred();vi.mocked(window.desktop.cancelDocCloseLease).mockImplementation(()=>gate.promise)
    const author=vi.fn((prior:string[])=>[...prior,'one'])
    await docCloseBarrier.acquire(ticket(),()=>true)
    await act(async()=>{startTransition(()=>append(author));root.render(tree());root.render(tree())})
    expect(live.values).toEqual([]);expect(author).not.toHaveBeenCalled()
    await act(async()=>{gate.resolve();await gate.promise})
    await vi.waitFor(()=>expect(live.values).toEqual(['one']))
    expect(author).toHaveBeenCalledTimes(1)
  })
  it('retires a deferred source-A submission when source B is adopted before cancellation completes',async()=>{
    const gate=deferred();vi.mocked(window.desktop.cancelDocCloseLease).mockImplementation(()=>gate.promise)
    await docCloseBarrier.acquire(ticket(),()=>true)
    const author=vi.fn((prior:string[])=>[...prior,'obsolete'])
    await act(async()=>{append(author)})
    source='replacement-B'
    await act(async()=>{gate.resolve();await gate.promise})
    expect(live.values).toEqual([]);expect(author).not.toHaveBeenCalled()
  })
  it('exposes coherent canonical functional ordering before React projection catches up',async()=>{
    await act(async()=>{
      startTransition(()=>{append(prior=>[...prior,'first']);append(prior=>[...prior,'second'])})
      const represented={...live}
      expect(represented.values).toEqual(['first','second'])
      append(prior=>[...prior,'third'])
      expect(represented.values).toEqual(['first','second'])
      expect(live.values).toEqual(['first','second','third'])
    })
  })
})
