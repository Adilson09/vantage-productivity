import { rootQuitIntent } from '../../src/main/root-quit-intent'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
type IpcHandler = (...args: unknown[]) => unknown
const electron = vi.hoisted(() => ({
  listeners: new Map<string, IpcHandler>(),
  handlers: new Map<string, IpcHandler>(),
  owners: new Map<number, unknown>(),
}))
vi.mock('electron', () => ({
  ipcMain: {
    on: (name: string, handler: IpcHandler) => {
      electron.listeners.set(name, handler)
    },
    handle: (name: string, handler: IpcHandler) => {
      electron.handlers.set(name, handler)
    },
  },
  webContents: { fromId: (id: number) => electron.owners.get(id) },
}))
import { createDocsControl, installDocsBridge } from '../../src/main/mcp/docs-bridge'
import {
  docsCloseLeases,
  setDocsCloseSourceReader,
  setDocsCloseStampValidator,
  setDocsCloseCompletionHooks,
} from '../../../docs/src/main/doc-close-service'

class Owner extends EventEmitter {
  alive = true
  source = 'main-A'
  renderer = 'renderer-A'
  messages: Array<{ channel: string; args: unknown[] }> = []
  constructor(readonly id: number) {
    super()
  }
  isDestroyed() {
    return !this.alive
  }
  send(channel: string, ...args: unknown[]) {
    this.messages.push({ channel, args })
  }
}
let nextId = 19000
const owners: Owner[] = []
function owner() {
  const value = new Owner(++nextId)
  owners.push(value)
  electron.owners.set(value.id, value)
  return value
}
function ready(value: Owner) {
  electron.listeners.get('docs:mcp-ready')!({ sender: value })
}
function fixture() {
  const a = owner(),
    b = owner(),
    authorizeSave = vi.fn()
  const control = createDocsControl({
    openBlankTab: () => a.id,
    authorizeSave,
    sourceToken: (id) => (electron.owners.get(id) as Owner).source,
  })
  return { a, b, control, authorizeSave }
}
function command(value: Owner) {
  return value.messages.find((message) => message.channel === 'docs:mcp-command')!.args[0] as {
    requestId: string
    payload: { closeTicket: unknown }
  }
}
function reply(
  value: Owner,
  request: ReturnType<typeof command>,
  patch: Record<string, unknown> = {},
) {
  electron.listeners.get('docs:mcp-result')!(
    { sender: value },
    {
      requestId: request.requestId,
      ok: true,
      result: {
        ok: true,
        published: true,
        current: true,
        clean: true,
        throughSequence: 0,
        closeLease: {
          ticket: request.payload.closeTicket,
          stamp: { source: value.renderer, revision: '1' },
        },
        ...patch,
      },
    },
  )
}
const closePayload = {
  path: 'C:/private/target.docx',
  overwrite: true,
  requireClean: true,
  sourcePath: 'C:/private/source.docx',
}
beforeEach(() => {
  vi.useFakeTimers()
  installDocsBridge()
  setDocsCloseSourceReader((value) => (value as unknown as Owner).source)
  setDocsCloseStampValidator(
    (value, stamp) => (value as unknown as Owner).renderer === stamp.source,
  )
  setDocsCloseCompletionHooks({
    stage: async (value, lease) =>
      docsCloseLeases.ready(value, lease.ticket, lease.stamp) ? {} : null,
    complete: (value, lease, remove) =>
      docsCloseLeases.complete(value, lease.ticket, lease.stamp, remove),
    cancel: (value, lease) => {
      docsCloseLeases.cancel(value, lease.ticket)
    },
    cleanup: async () => undefined,
  })
})
afterEach(() => {
  for (const value of owners.splice(0)) {
    value.alive = false
    value.emit('destroyed')
    electron.owners.delete(value.id)
  }
  vi.useRealTimers()
})
async function dispatched(value: Owner) {
  for (
    let i = 0;
    i < 12 && !value.messages.some((message) => message.channel === 'docs:mcp-command');
    i++
  )
    await Promise.resolve()
  expect(value.messages.some((message) => message.channel === 'docs:mcp-command')).toBe(true)
  return command(value)
}
describe('actual Docs main MCP lease plumbing', () => {
  it('rejects a replaced source after readiness wait without dispatching an obsolete close into it', async () => {
    const f = fixture(),
      work = f.control.runCommand(f.a.id, 'save_document', closePayload)
    f.a.source = 'main-B'
    ready(f.a)
    await expect(work).rejects.toThrow('document changed')
    expect(f.a.messages.filter((message) => message.channel === 'docs:mcp-command')).toEqual([])
  })
  it('correlates sender/ticket and only removes inside a live synchronous complete callback', async () => {
    const f = fixture()
    ready(f.a)
    const work = f.control.runCommand(f.a.id, 'save_document', closePayload),
      request = await dispatched(f.a)
    reply(f.b, request)
    expect(docsCloseLeases.hasWriter(f.a as unknown as WebContents)).toBe(true)
    reply(f.a, request)
    const receipt = (await work) as { closeLease: unknown },
      remove = vi.fn(() => true)
    expect(f.control.completeSaveClose!(f.a.id, receipt.closeLease, remove)).toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(f.control.completeSaveClose!(f.a.id, receipt.closeLease, remove)).toBe(false)
  })
  it('does not report an old successful publication as a failed physical write when close readiness is false', async () => {
    const f = fixture()
    ready(f.a)
    const work = f.control.runCommand(f.a.id, 'save_document', closePayload),
      request = await dispatched(f.a)
    reply(f.a, request, { clean: false })
    await expect(work).resolves.toMatchObject({
      published: true,
      current: false,
      clean: false,
      closeLease: undefined,
    })
  })
  it('retains real writer ownership after timeout until the late correlated result arrives', async () => {
    const f = fixture()
    ready(f.a)
    const work = f.control.runCommand(f.a.id, 'save_document', closePayload),
      rejection = expect(work).rejects.toThrow('timed out'),
      request = await dispatched(f.a)
    await vi.advanceTimersByTimeAsync(120_000)
    await rejection
    expect(docsCloseLeases.hasWriter(f.a as unknown as WebContents)).toBe(true)
    reply(f.a, request)
    expect(docsCloseLeases.hasWriter(f.a as unknown as WebContents)).toBe(false)
  })
  it('refuses a main-source change between ready response and actual tab removal', async () => {
    const f = fixture()
    ready(f.a)
    const work = f.control.runCommand(f.a.id, 'save_document', closePayload),
      request = await dispatched(f.a)
    reply(f.a, request)
    const receipt = (await work) as { closeLease: unknown },
      remove = vi.fn(() => true)
    f.a.source = 'main-B'
    expect(f.control.completeSaveClose!(f.a.id, receipt.closeLease, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  })
})

it('the real Docs MCP bridge holds preparing through delayed custody and seals only after it settles', async () => {
  const f = fixture()
  ready(f.a)
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const stage = vi.fn(
    async (value: WebContents, lease: import('../../../docs/src/shared/ipc').DocCloseEnvelope) => {
      await gate
      return docsCloseLeases.ready(value, lease.ticket, lease.stamp) ? {} : null
    },
  )
  setDocsCloseCompletionHooks({
    stage,
    complete: (value, lease, remove) =>
      docsCloseLeases.complete(value, lease.ticket, lease.stamp, remove),
    cancel: (value, lease) => {
      docsCloseLeases.cancel(value, lease.ticket)
    },
    cleanup: async () => undefined,
  })
  const work = f.control.runCommand(f.a.id, 'save_document', closePayload),
    request = await dispatched(f.a)
  reply(f.a, request)
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(stage).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(8_000)
  const remove = vi.fn(() => true)
  expect(
    f.control.completeSaveClose!(
      f.a.id,
      { ticket: request.payload.closeTicket, stamp: { source: f.a.renderer, revision: '1' } },
      remove,
    ),
  ).toBe(false)
  // An early complete call invalidates permission by contract; do not recycle it.
  finish()
  const result = (await work) as { published: boolean; current: boolean; clean: boolean }
  expect(result).toMatchObject({ published: true, current: false, clean: false })
  expect(remove).not.toHaveBeenCalled()
})
it('the real Docs MCP bridge remains close-capable after custody takes longer than ready lifetime', async () => {
  const f = fixture()
  ready(f.a)
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  setDocsCloseCompletionHooks({
    stage: async (value, lease) => {
      await gate
      return docsCloseLeases.ready(value, lease.ticket, lease.stamp) ? {} : null
    },
    complete: (value, lease, remove) =>
      docsCloseLeases.complete(value, lease.ticket, lease.stamp, remove),
    cancel: (value, lease) => {
      docsCloseLeases.cancel(value, lease.ticket)
    },
    cleanup: async () => undefined,
  })
  const work = f.control.runCommand(f.a.id, 'save_document', closePayload),
    request = await dispatched(f.a)
  reply(f.a, request)
  await vi.advanceTimersByTimeAsync(8_000)
  finish()
  const result = (await work) as {
      published: boolean
      current: boolean
      clean: boolean
      closeLease: unknown
    },
    remove = vi.fn(() => true)
  expect(result).toMatchObject({ published: true, current: true, clean: true })
  expect(f.control.completeSaveClose!(f.a.id, result.closeLease, remove)).toBe(true)
  expect(remove).toHaveBeenCalledOnce()
})

it('a Root path refresh starting during renderer readiness prevents save-session dispatch', async () => {
  const f = fixture(),
    work = f.control.runCommand(f.a.id, 'save_document', closePayload)
  const rejection = expect(work).rejects.toThrow('file move')
  const release = rootQuitIntent.beginMutation('test held path refresh')
  try {
    ready(f.a)
    await rejection
    expect(f.a.messages.some((message) => message.channel === 'docs:mcp-command')).toBe(false)
  } finally {
    release()
  }
})
it('a pending Root path refresh blocks direct MCP completion without misreporting old publication', async () => {
  const f = fixture()
  ready(f.a)
  const work = f.control.runCommand(f.a.id, 'save_document', closePayload),
    request = await dispatched(f.a)
  reply(f.a, request)
  const receipt = (await work) as { published: boolean; closeLease: unknown },
    remove = vi.fn(() => true)
  const release = rootQuitIntent.beginMutation('test exact-source refresh')
  try {
    expect(receipt.published).toBe(true)
    expect(f.control.completeSaveClose!(f.a.id, receipt.closeLease, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  } finally {
    f.control.cancelSaveClose!(f.a.id, receipt.closeLease)
    release()
  }
})
