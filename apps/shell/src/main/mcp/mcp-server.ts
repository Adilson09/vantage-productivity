import {McpReplyDrain,toolRequestIds,requestMessageIds,type McpReplyTicket,type McpReplyDrainStatus} from './mcp-reply-drain'
import {observeStreamableReply,observeLegacyPostRejection,observeTransportReplies} from './mcp-reply-observer'
import { randomUUID } from 'node:crypto'
import {setTimeout as startupDelay} from 'node:timers/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ZodRawShape } from 'zod'

/**
 * Local MCP server for Vantage.
 *
 * Lives in the Electron main process, so it only exists while the app runs.
 * Speaks both the current Streamable HTTP transport (`/mcp`) and the legacy SSE
 * transport (`/sse` + `/messages`) for older clients, and binds loopback only.
 *
 * Implemented on plain `node:http` (the same shape as the sheets capture
 * server) rather than express: the SDK transports accept Node request/response
 * objects directly, so express would add a dependency for nothing.
 */

export interface McpToolDefinition {
  name: string
  description: string
  /** zod raw shape, as the SDK expects (not a z.object()) */
  inputSchema?: ZodRawShape
  /** return value is serialized as JSON text; a thrown error becomes isError */
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface McpServerOptions {
  port: number
  /** fixed tool set shared by every client session (omit when using toolsFactory) */
  tools?: McpToolDefinition[]
  /**
   * Build a fresh tool set per client session instead of sharing `tools`.
   * Tools that hold session state (the visible-editing session host) pass this
   * so two connected clients never fight over one active session. Read the
   * current settings inside the factory: it runs at connect time.
   */
  toolsFactory?: () => McpToolDefinition[]
  logger?: (message: string) => void
  /** reported to clients in the initialize handshake; defaults to the app version when wired */
  version?: string
  /** EADDRINUSE retry tuning (exposed so tests do not wait out the backoff) */
  maxListenAttempts?: number
  listenRetryDelayMs?: number
  /** Local flush deadline starts only after terminal result emission while quitting; never an operation deadline. */
  replyTimeoutMs?:number
  onReplyStateChanged?:()=>void
}

export const DEFAULT_MCP_PORT = 3093
const LISTEN_RETRY_DELAY_MS = 1500
const MAX_BODY_BYTES = 32 * 1024 * 1024

export class McpServerService {
  private readonly tools: McpToolDefinition[]
  private readonly toolsFactory?: () => McpToolDefinition[]
  private readonly logger: (message: string) => void
  private readonly version: string
  private readonly maxListenAttempts: number
  private readonly listenRetryDelayMs: number
  private httpServer?: Server
  private port: number
  private running = false
  private readonly replies:McpReplyDrain
  private readonly replyListeners=new Set<()=>void>()
  private readonly sessionContexts=new WeakMap<object,{session:string;generation:number;response?:ServerResponse}>()
  private stopInFlight?:Promise<void>
  private quitAdmissionBlocked=false
  private terminalStopping=false
  private readonly terminalStartAbort=new AbortController()

  /** per-session servers/transports, keyed by session id */
  private readonly sessionServers = new Map<string, McpServer>()
  private readonly streamableTransports = new Map<string, StreamableHTTPServerTransport>()
  private readonly legacyTransports = new Map<string, SSEServerTransport>()
  private readonly sockets = new Set<Socket>()

  /** bumps on stop so an in-flight start cannot bind after cancellation */
  private lifecycleGeneration = 0

  constructor(options: McpServerOptions) {
    const replyTimeout=options.replyTimeoutMs??5000
    if(!Number.isSafeInteger(replyTimeout)||replyTimeout<10||replyTimeout>5000)throw new Error('Invalid MCP local reply deadline.')
    this.replies=new McpReplyDrain({timeoutMs:replyTimeout,changed:()=>{try{options.onReplyStateChanged?.()}catch{}for(const listener of this.replyListeners)try{listener()}catch{}}})
    this.tools = options.tools ?? []
    this.toolsFactory = options.toolsFactory
    this.port = options.port
    this.logger = options.logger ?? (() => undefined)
    this.version = options.version ?? '0.1.0'
    this.maxListenAttempts = options.maxListenAttempts ?? 5
    this.listenRetryDelayMs = options.listenRetryDelayMs ?? LISTEN_RETRY_DELAY_MS
  }

  isRunning(): boolean {
    return this.running
  }

  getPort(): number {
    return this.port
  }

  /** URL a client should connect to */
  getUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  // ── tool registration ─────────────────────────────────────────────────────

  replyDrainStatus():McpReplyDrainStatus{return this.replies.status()}
  beginQuitDrain():Promise<McpReplyDrainStatus>{this.quitAdmissionBlocked=true;return this.replies.beginDrain()}
  cancelQuitDrain():void{this.quitAdmissionBlocked=false;this.replies.cancelDrain()}
  onReplyStateChange(listener:()=>void):()=>void{this.replyListeners.add(listener);return()=>this.replyListeners.delete(listener)}

  private createSessionServer(session:string,generation:number): McpServer {
    const server = new McpServer({ name: 'Vantage', version: this.version })
    // a factory gives each connected client its own tool instances (session
    // state lives in their closures); otherwise the fixed set is shared
    const tools = this.toolsFactory ? this.toolsFactory() : this.tools
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        },
        (async (args: Record<string, unknown>,extra?:{requestId?:unknown}) => {
          const started = Date.now()
          let owned:McpReplyTicket|undefined
          try {
            owned=this.replies.begin(generation,session,tool.inputSchema?extra?.requestId:args?.requestId)
            const result = await tool.handler(args ?? {})
            this.logger(`[mcp] tool ${tool.name} ok (${Date.now() - started}ms)`)
            return { content: [{ type: 'text' as const, text: stringifyResult(result) }] }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.logger(`[mcp] tool ${tool.name} error (${Date.now() - started}ms): ${message}`)
            return { content: [{ type: 'text' as const, text: message }], isError: true }
          }finally{if(owned)this.replies.settle(owned)}
        }) as never,
      )
    }
    return server
  }

  // ── request handling ──────────────────────────────────────────────────────

  private handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void this.route(req, res).catch((error) => {
      this.logger(`[mcp] unhandled request error: ${String(error)}`)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'internal error' }))
      }else if(!res.writableEnded)res.destroy(error instanceof Error?error:new Error(String(error)))
    })
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    // DNS-rebinding defense: the server has no auth, so only loopback host
    // headers are accepted. Requests without an Origin (curl, local CLI) pass.
    if (!this.checkHost(req, res) || !this.checkOrigin(req, res)) return

    if (url.pathname === '/health' && req.method === 'GET') {
      return this.json(res, 200, {
        status: 'ok',
        server: 'Vantage',
        transport: 'StreamableHTTP + SSE',
        port: this.port,
      })
    }

    if (url.pathname === '/mcp') return this.handleStreamable(req, res)

    if (url.pathname === '/sse' && req.method === 'GET') return this.handleLegacySse(req, res)

    if (url.pathname === '/messages' && req.method === 'POST') {
      return this.handleLegacyMessage(req, res, url)
    }

    this.json(res, 404, { error: 'not found' })
  }

  private async handleStreamable(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const generation=this.lifecycleGeneration
    const method = req.method ?? 'GET'
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST, DELETE')
      res.end()
      return
    }

    const sessionId = headerValue(req.headers['mcp-session-id'])

    // GET/DELETE must belong to a live session
    if (method === 'GET' || method === 'DELETE') {
      const transport = sessionId ? this.streamableTransports.get(sessionId) : undefined
      if (!transport) {
        this.json(res, sessionId ? 404 : 400, {
          jsonrpc: '2.0',
          error: {
            code: sessionId ? -32001 : -32000,
            message: sessionId ? 'Session not found' : 'Mcp-Session-Id header is required',
          },
          id: null,
        })
        return
      }
      await transport.handleRequest(req, res)
      return
    }

    // POST
    const read = await this.readBodyOrReject(req, res)
    if (!read) return
    const body = read.body
    const existing = sessionId ? this.streamableTransports.get(sessionId) : undefined
    if (sessionId && !existing) {
      this.json(res, 404, {
        jsonrpc: '2.0',
        error: { code: -32001, message: `Session not found: ${sessionId}` },
        id: null,
      })
      return
    }
    if (!existing && !isInitializeRequest(body)) {
      this.json(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Initialize the session before sending MCP messages' },
        id: null,
      })
      return
    }

    let transport = existing
    if (!transport) {
      if(this.sessionServers.size>=128){this.json(res,503,{error:'MCP client-session capacity is full.'});return}
      const newSessionId = sessionId ?? randomUUID(),session='streamable:'+newSessionId
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: sid => this.logger('[mcp] session initialized: '+sid),
      })
      const server=this.createSessionServer(session,generation)
      const dispose=observeTransportReplies(created,this.replies,generation,session)
      this.sessionContexts.set(created,{session,generation})
      created.onclose=()=>{dispose();this.replies.sessionEnded(generation,session);if(this.streamableTransports.get(newSessionId)===created){this.streamableTransports.delete(newSessionId);if(this.sessionServers.get(newSessionId)===server)this.sessionServers.delete(newSessionId)}}
      this.streamableTransports.set(newSessionId,created);this.sessionServers.set(newSessionId,server)
      try{await server.connect(created)}catch(error){created.onclose?.();throw error}
      transport=created
    }
    const context=this.sessionContexts.get(transport)
    if(!context||context.generation!==generation||generation!==this.lifecycleGeneration){this.json(res,503,{error:'The MCP service generation ended before dispatch.'});return}
    const tickets=this.admitTools(res,body,context,()=>res.destroy())
    if(!tickets)return
    observeStreamableReply(res,tickets,this.replies)
    await transport.handleRequest(req,res,body)
  }

  private async handleLegacySse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if(this.sessionServers.size>=128){this.json(res,503,{error:'MCP client-session capacity is full.'});return}
    res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');res.setHeader('connection','keep-alive');res.setHeader('x-accel-buffering','no')
    const generation=this.lifecycleGeneration,transport=new SSEServerTransport('/messages',res),sessionId=transport.sessionId,session='legacy:'+sessionId
    const server=this.createSessionServer(session,generation),dispose=observeTransportReplies(transport,this.replies,generation,session,res)
    this.sessionContexts.set(transport,{session,generation,response:res});this.legacyTransports.set(sessionId,transport);this.sessionServers.set(sessionId,server)
    const heartbeat=setInterval(()=>{if(!res.writableEnded)try{res.write(': heartbeat\n\n')}catch{clearInterval(heartbeat)}},15000)
    const cleanup=()=>{clearInterval(heartbeat);dispose();this.replies.sessionEnded(generation,session);if(this.legacyTransports.get(sessionId)===transport){this.legacyTransports.delete(sessionId);if(this.sessionServers.get(sessionId)===server)this.sessionServers.delete(sessionId)}}
    transport.onclose=cleanup;const networkClosed=()=>{cleanup();this.replies.sessionClosed(generation,session)};res.once('close',networkClosed);res.once('error',networkClosed)
    try{await server.connect(transport)}catch(error){cleanup();this.logger('[mcp] legacy SSE connect failed: '+String(error));if(!res.headersSent)res.statusCode=500;res.end()}
  }

  private async handleLegacyMessage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) {
      this.json(res, 400, { error: 'Missing sessionId parameter' })
      return
    }
    const transport = this.legacyTransports.get(sessionId)
    if (!transport) {
      this.json(res, 400, { error: `No transport found for sessionId ${sessionId}` })
      return
    }
    const read = await this.readBodyOrReject(req, res)
    if (!read) return
    const body = read.body
    const context=this.sessionContexts.get(transport)
    if(!context||context.generation!==this.lifecycleGeneration){this.json(res,503,{error:'The MCP service generation ended before dispatch.'});return}
    const tickets=this.admitTools(res,body,context,()=>context.response?.destroy())
    if(!tickets)return
    observeLegacyPostRejection(res,tickets,this.replies)
    // express.json() would have consumed the stream; passing the parsed body
    // keeps the SDK from re-reading an exhausted request
    await transport.handlePostMessage(req, res, body)
  }

  private admitTools(res:ServerResponse,body:unknown,context:{session:string;generation:number},abort:()=>void):McpReplyTicket[]|null{
    try{return this.replies.admit(context.generation,context.session,toolRequestIds(body),abort,requestMessageIds(body))}
    catch(error){const message=error instanceof Error?error.message:String(error),duplicate=message.includes('Duplicate'),invalid=message.includes('requires'),capacity=message.includes('limit')||message.includes('too many');this.json(res,duplicate||invalid?400:capacity?429:503,{jsonrpc:'2.0',id:null,error:{code:duplicate||invalid?-32600:-32000,message}});return null}
  }

  /**
   * A malformed body is a client error, not a server fault: answering 500
   * "internal error" hides the actual problem (bad JSON) from the caller and
   * reads as a Vantage bug. Answers the JSON-RPC parse error itself and
   * returns null; the caller stops there.
   */
  private async readBodyOrReject(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ body: unknown } | null> {
    try {
      return { body: await readJsonBody(req) }
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'request body too large'
      this.json(res, tooLarge ? 413 : 400, {
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
        },
        id: null,
      })
      return null
    }
  }

  // ── guards ────────────────────────────────────────────────────────────────

  private checkHost(req: IncomingMessage, res: ServerResponse): boolean {
    const host = req.headers.host
    try {
      const parsed = new URL(`http://${host ?? ''}`)
      const validHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
      const validPort = parsed.port === String(this.port)
      if (validHost && validPort) return true
    } catch {
      // fall through to rejection
    }
    this.logger(`[mcp] rejected invalid Host header: ${host ?? '(missing)'}`)
    this.json(res, 403, { error: 'Invalid host' })
    return false
  }

  private checkOrigin(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const parsed = new URL(origin)
      const ok =
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        parsed.port === String(this.port)
      if (ok) return true
    } catch {
      // fall through to rejection
    }
    this.logger(`[mcp] rejected invalid Origin header: ${origin}`)
    this.json(res, 403, { error: 'Invalid origin' })
    return false
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(port = this.port): Promise<void> {
    if(this.terminalStopping)throw new Error('MCP terminal shutdown canceled this server start.')
    if(this.stopInFlight)await this.stopInFlight
    if(this.terminalStopping)throw new Error('MCP terminal shutdown canceled this server start.')
    if (this.running) return
    this.port = port
    const generation = ++this.lifecycleGeneration
    this.replies.activate(generation)
    if(this.quitAdmissionBlocked)void this.replies.beginDrain()

    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxListenAttempts; attempt++) {
      if(this.terminalStopping||generation!==this.lifecycleGeneration)throw new Error('MCP server start canceled by its lifecycle.')
      try {
        await this.listenOnce(generation)
        this.running = true
        this.logger(`[mcp] listening on ${this.getUrl()} (streamable /mcp, legacy /sse)`)
        return
      } catch (error) {
        lastError = error
        if (generation !== this.lifecycleGeneration) {
          throw new Error('MCP server start cancelled', { cause: error })
        }
        if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error
        this.logger(`[mcp] port ${this.port} in use, retry ${attempt}/${this.maxListenAttempts}`)
        if (attempt < this.maxListenAttempts) {
          await startupDelay(this.listenRetryDelayMs,undefined,{signal:this.terminalStartAbort.signal})
        }
      }
    }
    throw lastError
  }

  private listenOnce(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(this.handleRequest)
      let settled = false

      server.on('connection', (socket: Socket) => {
        if(generation!==this.lifecycleGeneration){socket.destroy();return}
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })

      server.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) {
          this.logger(`[mcp] server error after listen: ${String(error)}`)
          return
        }
        settled = true
        try {
          server.close()
        } catch {
          // nothing to clean up
        }
        reject(error)
      })

      // loopback only: the server is unauthenticated, so it must never be
      // reachable from another machine
      server.listen(this.port, '127.0.0.1', () => {
        if (generation !== this.lifecycleGeneration) {
          settled = true
          server.close()
          reject(new Error('MCP server start cancelled'))
          return
        }
        settled = true
        this.httpServer = server
        resolve()
      })
    })
  }

  /** Best-effort synchronous teardown for app shutdown. */
  stopSync(): void {
    this.terminalStopping=true;this.terminalStartAbort.abort()
    void this.stop()
  }

  stop():Promise<void>{
    if(this.stopInFlight)return this.stopInFlight
    const stopping=this.stopOwnedGeneration();this.stopInFlight=stopping
    void stopping.finally(()=>{if(this.stopInFlight===stopping)this.stopInFlight=undefined}).catch(()=>{})
    return stopping
  }
  private async stopOwnedGeneration():Promise<void>{
    const generation=this.lifecycleGeneration;++this.lifecycleGeneration;this.replies.stopGeneration(generation)
    const server=this.httpServer;this.httpServer=undefined;this.running=false
    const transports=[...this.legacyTransports.values(),...this.streamableTransports.values()]
    this.legacyTransports.clear();this.streamableTransports.clear();this.sessionServers.clear()
    const sockets=[...this.sockets];this.sockets.clear();for(const socket of sockets)socket.destroy()
    const closed=server?new Promise<void>(resolve=>{try{server.close(()=>resolve())}catch{resolve()}}):Promise.resolve()
    await Promise.allSettled([closed,...transports.map(async transport=>{await transport.close()})])
    this.logger('[mcp] stopped')
  }

}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body))
    return body.some((msg) => (msg as { method?: string })?.method === 'initialize')
  return (body as { method?: string })?.method === 'initialize'
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
