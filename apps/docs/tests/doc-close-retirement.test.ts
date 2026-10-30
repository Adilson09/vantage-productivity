import { describe, expect, it, vi } from 'vitest'
import { docCloseBarrier, docMutationSource, isDocAuthoringActive, retireDocAuthoring, setDocCloseSourceReader } from '../src/renderer/doc-close-lease'
describe('removed Docs owner retirement',()=>{
 it('retires pending and future authored callbacks before the final renderer is destroyed',async()=>{
  let resolve!:()=>void
  const gate=new Promise<void>(done=>{resolve=done}),author=vi.fn(),report=vi.spyOn(console,'error').mockImplementation(()=>{})
  setDocCloseSourceReader(()=> 'source-A')
  window.desktop={claimDocCloseLease:async()=>true,cancelDocCloseLease:()=>gate} as unknown as typeof window.desktop
  const ticket={id:'retire',sequence:90000,source:'main-A'}
  await docCloseBarrier.acquire(ticket,()=>true)
  docCloseBarrier.mutate(author,docMutationSource())
  retireDocAuthoring();resolve()
  await vi.waitFor(()=>expect(docCloseBarrier.busy).toBe(false))
  expect(isDocAuthoringActive()).toBe(false);expect(author).not.toHaveBeenCalled()
  expect(docCloseBarrier.mutate(author,docMutationSource())).toBe(false)
  expect(()=>docCloseBarrier.runMutationWork(author,docMutationSource())).toThrow('document changed')
  report.mockRestore()
 })
})
