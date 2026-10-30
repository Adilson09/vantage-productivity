// @vitest-environment node
import { createServer, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServerService } from '../../src/main/mcp/mcp-server'
import { installMcpReplyQuitGuard } from '../../src/main/mcp/mcp-reply-drain'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
class App {
  listeners: Array<(event: { preventDefault: () => void }) => void> = []
  attempts = 0
  exits = 0
  terminalStop = vi.fn()
  on(_event: 'before-quit', listener: (event: { preventDefault: () => void }) => void) {
    this.listeners.push(listener)
  }
  quit() {
    this.attempts++
    let prevented = false
    for (const listener of this.listeners)
      listener({
        preventDefault: () => {
          prevented = true
        },
      })
    if (!prevented) {
      this.exits++
      this.terminalStop()
    }
  }
}
const services: McpServerService[] = [],
  clients: Client[] = [],
  release: Array<() => void> = [],
  restore: Array<() => void> = []
afterEach(async () => {
  for (const done of release.splice(0)) done()
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const service of services.splice(0)) await service.stop()
  for (const undo of restore.splice(0).reverse()) undo()
})
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address(),
        port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}
async function fixture(
  kind: 'streamable' | 'legacy',
  handler: (app: App) => Promise<unknown> | unknown,
  timeout = 300,
) {
  const port = await freePort(),
    app = new App(),
    blocked = vi.fn(),
    service = new McpServerService({
      port,
      replyTimeoutMs: timeout,
      tools: [
        {
          name: 'close_now',
          description: 'owned reply test',
          inputSchema: {},
          handler: () => handler(app),
        },
      ],
    })
  services.push(service)
  const scope = { services: [service], epoch: 0 }
  installMcpReplyQuitGuard(app, {
    services: () => scope.services,
    epoch: () => scope.epoch,
    onQuitBlocked: blocked,
  })
  await service.start()
  const gate = gateReply(port, kind)
  const client = new Client({ name: 'reply-test', version: '1' })
  clients.push(client)
  await client.connect(
    kind === 'legacy'
      ? new SSEClientTransport(new URL(service.getUrl() + '/sse'))
      : new StreamableHTTPClientTransport(new URL(service.getUrl() + '/mcp')),
  )
  return { port, app, blocked, service, client, gate, scope }
}
/** Delay actual owned Node IO, not SDK send resolution or a fabricated finish event. */
function gateReply(port: number, kind: 'streamable' | 'legacy', marker = 'owned-reply-marker') {
  const gate = deferred(),
    hit = deferred()
  release.push(gate.resolve)
  let enabled = false,
    post202 = 0,
    lastId: string | undefined
  const matching = new WeakSet<ServerResponse>(),
    tails = new WeakMap<ServerResponse, string>(),
    pendingChunks = new WeakMap<ServerResponse, unknown[][]>()
  const end = ServerResponse.prototype.end,
    write = ServerResponse.prototype.write
  const owned = (response: ServerResponse) => response.req.socket.localPort === port
  const inspect = (response: ServerResponse, chunk: unknown) => {
    const text = ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString()
      : String(chunk ?? '')
    const tail = ((tails.get(response) ?? '') + text).slice(-4096)
    tails.set(response, tail)
    if (tail.includes(marker)) {
      matching.add(response)
      lastId = [...tail.matchAll(/"id":([0-9]+)/g)].at(-1)?.[1]
    }
  }
  const observedEnd = function (this: ServerResponse, ...args: unknown[]) {
    if (owned(this)) inspect(this, args[0])
    if (owned(this) && this.req.url?.startsWith('/messages') && this.statusCode === 202)
      this.once('finish', () => {
        post202++
      })
    if (
      enabled &&
      kind === 'streamable' &&
      owned(this) &&
      this.req.url === '/mcp' &&
      this.req.method === 'POST' &&
      matching.has(this)
    ) {
      hit.resolve()
      void gate.promise.then(() => {
        try {
          for (const chunk of pendingChunks.get(this) ?? []) Reflect.apply(write, this, chunk)
          pendingChunks.delete(this)
          Reflect.apply(end, this, args)
        } catch {}
      })
      return this
    }
    return Reflect.apply(end, this, args)
  }
  const observedWrite = function (this: ServerResponse, ...args: unknown[]) {
    if (owned(this)) inspect(this, args[0])
    if (
      enabled &&
      kind === 'streamable' &&
      owned(this) &&
      this.req.url === '/mcp' &&
      this.req.method === 'POST' &&
      matching.has(this)
    ) {
      const chunks = pendingChunks.get(this) ?? []
      chunks.push(args)
      pendingChunks.set(this, chunks)
      hit.resolve()
      return true
    }
    if (
      enabled &&
      kind === 'legacy' &&
      owned(this) &&
      this.req.url === '/sse' &&
      matching.has(this)
    ) {
      hit.resolve()
      void gate.promise.then(() => {
        try {
          Reflect.apply(write, this, args)
        } catch {}
      })
      return true
    }
    return Reflect.apply(write, this, args)
  }
  ServerResponse.prototype.end = observedEnd as typeof end
  ServerResponse.prototype.write = observedWrite as typeof write
  restore.push(() => {
    ServerResponse.prototype.end = end
    ServerResponse.prototype.write = write
  })
  return {
    enable: () => {
      enabled = true
    },
    hit: hit.promise,
    resolve: gate.resolve,
    get post202() {
      return post202
    },
    get id() {
      return lastId
    },
  }
}
describe.each(['streamable', 'legacy'] as const)(
  'actual SDK %s local reply quit ownership',
  (kind) => {
    it('defers terminal stop until actual response finish or the specific SSE write callback', async () => {
      const f = await fixture(kind, (app) => {
          app.quit()
          return 'owned-reply-marker'
        }),
        gate = f.gate
      gate.enable()
      const result = f.client.callTool({ name: 'close_now', arguments: {} })
      void result.catch(() => {})
      await gate.hit
      expect(f.app.terminalStop).not.toHaveBeenCalled()
      expect(f.service.replyDrainStatus().owned).toBe(1)
      if (kind === 'legacy') {
        await vi.waitFor(() => expect(gate.post202).toBeGreaterThan(0))
        expect(f.app.exits).toBe(0)
      }
      gate.resolve()
      expect(JSON.stringify(await result)).toContain('owned-reply-marker')
      await vi.waitFor(() => expect(f.app.terminalStop).toHaveBeenCalledOnce())
      expect(f.service.replyDrainStatus().owned).toBe(0)
    })
    it('keeps a legitimate handler live beyond the bounded quit wait and starts a fresh flush deadline at emission', async () => {
      const work = deferred()
      release.push(work.resolve)
      const f = await fixture(
          kind,
          async (app) => {
            app.quit()
            await work.promise
            return 'owned-reply-marker'
          },
          100,
        ),
        gate = f.gate
      gate.enable()
      const result = f.client.callTool({ name: 'close_now', arguments: {} })
      void result.catch(() => {})
      await vi.waitFor(() => expect(f.blocked).toHaveBeenCalledOnce())
      expect(f.service.replyDrainStatus()).toMatchObject({
        owned: 1,
        running: 1,
        pendingReplies: 1,
        failures: [],
      })
      expect(f.app.exits).toBe(0)
      work.resolve()
      await gate.hit
      expect(f.service.replyDrainStatus().failures).toEqual([])
      expect(f.app.exits).toBe(0)
      gate.resolve()
      await result
      await vi.waitFor(() => expect(f.app.exits).toBe(1))
    })
    it('bounds a never-flushing emitted reply by destroying the owned connection, without calling it delivery', async () => {
      const f = await fixture(
          kind,
          (app) => {
            app.quit()
            return 'owned-reply-marker'
          },
          100,
        ),
        gate = f.gate
      gate.enable()
      const result = f.client.callTool({ name: 'close_now', arguments: {} })
      void result.catch(() => {})
      await gate.hit
      await vi.waitFor(() =>
        expect(f.service.replyDrainStatus().failures).toEqual(
          expect.arrayContaining([expect.objectContaining({ outcome: 'timeout' })]),
        ),
      )
      await vi.waitFor(() => expect(f.app.exits).toBe(1))
      expect(f.service.replyDrainStatus().owned).toBe(0)
      await f.client.close()
      await expect(result).rejects.toThrow()
    })
    it('disconnect does not release an executing handler or authorize early quit', async () => {
      const work = deferred()
      release.push(work.resolve)
      const f = await fixture(
        kind,
        async (app) => {
          app.quit()
          await work.promise
          return 'late result'
        },
        100,
      )
      const result = f.client.callTool({ name: 'close_now', arguments: {} })
      void result.catch(() => {})
      await vi.waitFor(() => expect(f.service.replyDrainStatus().running).toBe(1))
      await f.client.close()
      await vi.waitFor(() => expect(f.service.replyDrainStatus().pendingReplies).toBe(0))
      expect(f.service.replyDrainStatus().owned).toBe(1)
      expect(f.app.exits).toBe(0)
      work.resolve()
      await vi.waitFor(() => expect(f.service.replyDrainStatus().owned).toBe(0))
      await vi.waitFor(() => expect(f.app.exits).toBe(1))
      await expect(result).rejects.toThrow()
    })

    it('equal request ids in simultaneous real sessions retain independent reply ownership', async () => {
      const both = deferred()
      let entered = 0
      const f = await fixture(kind, async (app) => {
        const order = ++entered
        if (entered === 2) both.resolve()
        await both.promise
        app.quit()
        return order === 1 ? 'owned-reply-marker' : 'second-owned-marker'
      })
      const secondGate = gateReply(f.port, kind, 'second-owned-marker'),
        second = new Client({ name: 'peer', version: '1' })
      clients.push(second)
      await second.connect(
        kind === 'legacy'
          ? new SSEClientTransport(new URL(f.service.getUrl() + '/sse'))
          : new StreamableHTTPClientTransport(new URL(f.service.getUrl() + '/mcp')),
      )
      f.gate.enable()
      secondGate.enable()
      const firstReply = f.client.callTool({ name: 'close_now', arguments: {} }),
        secondReply = second.callTool({ name: 'close_now', arguments: {} })
      void firstReply.catch(() => {})
      void secondReply.catch(() => {})
      await Promise.all([f.gate.hit, secondGate.hit])
      expect(f.gate.id).toBe(secondGate.id)
      expect(f.gate.id).toBeDefined()
      expect(f.service.replyDrainStatus().owned).toBe(2)
      f.gate.resolve()
      await firstReply
      expect(f.app.exits).toBe(0)
      expect(f.service.replyDrainStatus().owned).toBe(1)
      secondGate.resolve()
      await secondReply
      await vi.waitFor(() => expect(f.app.exits).toBe(1))
    })
    it('an old service generation cannot quit or release a replacement server request', async () => {
      const oldWork = deferred(),
        newWork = deferred()
      release.push(oldWork.resolve, newWork.resolve)
      const f = await fixture(
        kind,
        async (app) => {
          app.quit()
          await oldWork.promise
          return 'old result'
        },
        100,
      )
      const oldReply = f.client.callTool({ name: 'close_now', arguments: {} })
      void oldReply.catch(() => {})
      await vi.waitFor(() => expect(f.service.replyDrainStatus().running).toBe(1))
      await f.service.stop()
      f.scope.epoch++
      const next = new McpServerService({
        port: f.port,
        replyTimeoutMs: 100,
        tools: [
          {
            name: 'replacement',
            description: 'replacement owner',
            inputSchema: {},
            handler: async () => {
              await newWork.promise
              return 'new result'
            },
          },
        ],
      })
      services.push(next)
      f.scope.services.push(next)
      await next.start()
      const client = new Client({ name: 'replacement', version: '1' })
      clients.push(client)
      await client.connect(
        kind === 'legacy'
          ? new SSEClientTransport(new URL(next.getUrl() + '/sse'))
          : new StreamableHTTPClientTransport(new URL(next.getUrl() + '/mcp')),
      )
      const reply = client.callTool({ name: 'replacement', arguments: {} })
      void reply.catch(() => {})
      await vi.waitFor(() => expect(next.replyDrainStatus().running).toBe(1))
      oldWork.resolve()
      await vi.waitFor(() => expect(f.service.replyDrainStatus().owned).toBe(0))
      expect(next.replyDrainStatus().owned).toBe(1)
      expect(next.isRunning()).toBe(true)
      expect(f.app.exits).toBe(0)
      newWork.resolve()
      await reply
      expect(f.app.exits).toBe(0)
      f.app.quit()
      expect(f.app.exits).toBe(1)
    })
  },
)
