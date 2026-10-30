import { docCloseBarrier, setDocCloseSourceReader } from '../src/renderer/doc-close-lease'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpCommandMessage, McpCommandResult } from '../src/shared/ipc'
import type { FileActionContext } from '../src/renderer/file-actions'

const controls = vi.hoisted(() => ({
  generation: 1,
  save: vi.fn(),
  canClose: vi.fn(),
}))
vi.mock('../src/renderer/file-actions', () => ({
  save: controls.save,
  currentDocGeneration: () => controls.generation,
  currentRecoverySequence:()=>0,
  canCloseSavedDocument: controls.canClose,
}))
vi.mock('../src/renderer/ai/tools', () => ({ executeTool: vi.fn(), markDocSeen: vi.fn() }))
vi.mock('../src/renderer/ai/protocol', () => ({ findNumId: vi.fn(() => null) }))

import { installMcpBridge } from '../src/renderer/mcp-bridge'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

type LiveEditor = {
  doc: { filePath: string | null }
  editor: object
  dirty: boolean
  pending: boolean
  compositeDirty: boolean
  saveIncompleteRef: { current: boolean }
}
const cleanups: (() => void)[] = []
let requestSequence=0
beforeEach(() => {
  const held=docCloseBarrier.ticket;if(held)docCloseBarrier.release(held)
  setDocCloseSourceReader(()=>`renderer-${controls.generation}`)
  controls.generation = 1
  controls.save.mockReset()
  controls.canClose.mockReset()
  controls.canClose.mockImplementation((ctx: LiveEditor, generation: number) =>
    generation === controls.generation && !ctx.dirty && !ctx.pending && !ctx.compositeDirty,
  )
})
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose() })

function fixture(dirty = true) {
  const state: LiveEditor = {
    doc: { filePath: '/private/source.docx' }, editor: {}, dirty,
    pending: false, compositeDirty: false, saveIncompleteRef: { current: false },
  }
  let live = state, receive!: (message: McpCommandMessage) => void
  const completions = new Map<string, (result: McpCommandResult) => void>()
  window.desktop = {
    onMcpCommand: (handler: typeof receive) => { receive = handler; return () => {} },
    reportMcpResult: (result: McpCommandResult) => completions.get(result.requestId)?.(result),
    signalMcpReady: vi.fn(),
    claimDocCloseLease:vi.fn(async()=>true), cancelDocCloseLease:vi.fn(async()=>{}), onDocCloseRelease:()=>()=>{},
  } as unknown as typeof window.desktop
  cleanups.push(installMcpBridge({ getCtx: () => live as unknown as FileActionContext }))
  return {
    state,
    replace() {
      controls.generation++
      live = { ...state, doc: { filePath: '/private/replacement.docx' }, dirty: true }
    },
    request(payload: Record<string, unknown>) {
      const requestId = `save-${++requestSequence}`
      return new Promise<McpCommandResult>((resolve) => {
        completions.set(requestId, resolve)
        const bound=payload.requireClean ? {...payload,closeTicket:{id:requestId,sequence:requestSequence,source:`main-${controls.generation}`}} : payload
        receive({ requestId, command: 'save_document', payload:bound })
      })
    },
  }
}
const normal = { path: '/private/output.docx', overwrite: true }
const closing = { ...normal, requireClean: true, sourcePath: '/private/source.docx' }

describe('Docs MCP publication and close completion', () => {
  it('preserves ordinary Save publication success when typing arrives during the final wait', async () => {
    const f = fixture(), entered = deferred(), gate = deferred()
    controls.save.mockImplementation(async () => {
      f.state.dirty = false
      entered.resolve()
      await gate.promise
      return true
    })
    const response = f.request(normal)
    try {
      await entered.promise
      f.state.dirty = true
      gate.resolve()
      await expect(response).resolves.toMatchObject({ ok: true, result: {
        published: true, current: true, clean: false, path: normal.path,
      } })
      expect(controls.save).toHaveBeenCalledTimes(1)
      expect(f.state.dirty).toBe(true)
    } finally { gate.resolve(); await response }
  })

  it('persists later typing before granting automated close permission', async () => {
    const f = fixture(), entered = deferred(), gate = deferred()
    controls.save.mockImplementation(async () => {
      f.state.dirty = false
      if (controls.save.mock.calls.length === 1) { entered.resolve(); await gate.promise }
      return true
    })
    const response = f.request(closing)
    try {
      await entered.promise
      f.state.dirty = true
      gate.resolve()
      await expect(response).resolves.toMatchObject({ ok: true, result: {
        published: true, current: true, clean: true,
      } })
      expect(controls.save).toHaveBeenCalledTimes(2)
    } finally { gate.resolve(); await response }
  })

  it('reports publication but refuses close when newer typing never converges', async () => {
    const f = fixture()
    controls.save.mockResolvedValue(true)
    await expect(f.request(closing)).resolves.toMatchObject({ ok: true, result: {
      published: true, current: true, clean: false,
    } })
    expect(controls.save).toHaveBeenCalledTimes(3)
    expect(f.state.dirty).toBe(true)
  })

  it('does not retry a close request into a source replaced during acknowledgment', async () => {
    const f = fixture(), entered = deferred(), gate = deferred()
    controls.save.mockImplementation(async () => { entered.resolve(); await gate.promise; return true })
    const response = f.request(closing)
    try {
      await entered.promise
      f.replace()
      gate.resolve()
      await expect(response).resolves.toMatchObject({ ok: true, result: {
        published: true, current: false, clean: false,
      } })
      expect(controls.save).toHaveBeenCalledTimes(1)
    } finally { gate.resolve(); await response }
  })

  it('keeps ordinary Save successful when its published document has since been replaced', async () => {
    const f = fixture()
    controls.save.mockImplementation(async () => { f.replace(); return true })
    await expect(f.request(normal)).resolves.toMatchObject({ ok: true, result: {
      published: true, current: false, clean: false, path: normal.path,
    } })
    expect(controls.save).toHaveBeenCalledTimes(1)
  })

  it('confirms an already clean editor without inventing a new publication', async () => {
    const f = fixture(false)
    await expect(f.request(closing)).resolves.toMatchObject({ ok: true, result: {
      published: false, current: true, clean: true, path: '/private/source.docx',
    } })
    expect(controls.save).not.toHaveBeenCalled()
  })

  it.each(['pending', 'compositeDirty'] as const)('honors the full renderer close gate for %s state', async (surface) => {
    const f = fixture(false)
    f.state[surface] = true
    controls.save.mockResolvedValue(true)
    await expect(f.request(closing)).resolves.toMatchObject({ ok: true, result: {
      published: true, current: true, clean: false,
    } })
    expect(controls.save).toHaveBeenCalledTimes(3)
    expect(f.state[surface]).toBe(true)
  })

  it('refuses a stale source path before writing any document', async () => {
    const f = fixture(false)
    await expect(f.request({ ...closing, sourcePath: '/private/obsolete.docx' })).resolves.toMatchObject({
      ok: true, result: { published: false, current: false, clean: false },
    })
    expect(controls.save).not.toHaveBeenCalled()
  })

  it('does not run a queued old-source close against the replacement document', async () => {
    const f = fixture(), entered = deferred(), gate = deferred()
    controls.save.mockImplementation(async () => { entered.resolve(); await gate.promise; return true })
    const first = f.request(normal)
    await entered.promise
    const queued = f.request(closing)
    f.replace()
    gate.resolve()
    await first
    await expect(queued).resolves.toMatchObject({ ok: true, result: {
      published: false, current: false, clean: false,
    } })
    expect(controls.save).toHaveBeenCalledTimes(1)
  })

  it('retains the existing ordinary Save error for a genuine failed save', async () => {
    const f = fixture()
    controls.save.mockResolvedValue(false)
    await expect(f.request(normal)).resolves.toMatchObject({ ok: false, error: 'the document could not be saved' })
  })

  it('requires the internal close source binding', async () => {
    const f = fixture()
    await expect(f.request({ ...normal, requireClean: true })).resolves.toMatchObject({ ok: false })
    expect(controls.save).not.toHaveBeenCalled()
  })
})
