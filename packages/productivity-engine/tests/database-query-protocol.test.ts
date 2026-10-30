import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryDatabaseIsolated } from '../src/database-isolated'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const databasePath = join(tmpdir(), 'protocol database with spaces.vdb')
const options = { workerPath: process.execPath }
const children: FakeChild[] = []
class FakeChild extends EventEmitter {
  pid = 12345
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  unref = vi.fn()
}
type Request = {
  nonce: string
  protocol: number
  path: string
  sql: string
  parameters: unknown[]
  maxRows: number
  deadlineMs: number
}
function success(request: Request, rows: unknown[] = [{ value: 1 }]) {
  return {
    protocol: 1,
    nonce: request.nonce,
    ok: true,
    limits: { sqliteHeapBytes: 67108864, sqliteHighwaterBytes: 65536 },
    result: { columns: ['value'], rows, truncated: false },
  }
}
function mockNative(
  reply: (request: Request, child: FakeChild, bytes: Buffer) => void,
  exitOnCancel = true,
): void {
  vi.mocked(spawn).mockImplementation(() => {
    const child = new FakeChild()
    children.push(child)
    child.stdin.once('data', (bytes: Buffer) =>
      reply(JSON.parse(bytes.toString('utf8')), child, bytes),
    )
    if (exitOnCancel) child.stdin.once('close', () => child.emit('close', 125, null))
    return child as never
  })
}
function emit(child: FakeChild, value: unknown, code = 0): void {
  child.stdout.write(JSON.stringify(value))
  child.emit('close', code, null)
}
afterEach(() => {
  for (const child of children.splice(0)) child.emit('close', 1, null)
  vi.mocked(spawn).mockReset()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('native database query protocol', () => {
  it('uses the trusted helper with literal argv and holds stdin open until completion', async () => {
    mockNative((request, child, bytes) => {
      expect(bytes.at(-1)).toBe(10)
      expect(request.path).toBe(resolve(databasePath))
      expect(request.parameters).toEqual(["'; DELETE FROM Sales; --"])
      expect(child.stdin.writableEnded).toBe(false)
      emit(child, success(request))
    })
    expect(
      await queryDatabaseIsolated(databasePath, 'SELECT ? AS value', {
        ...options,
        parameters: ["'; DELETE FROM Sales; --"],
      }),
    ).toEqual({ columns: ['value'], rows: [{ value: 1 }], truncated: false })
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([])
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ shell: false, windowsHide: true })
  })
  it.each([
    'nonce',
    'extra-field',
    'missing-cell',
    'extra-cell',
    'wrong-exit',
    'invalid-json',
    'invalid-utf8',
  ])('rejects malformed or mismatched native completion: %s', async (kind) => {
    mockNative((request, child) => {
      const value = success(request)
      if (kind === 'nonce') value.nonce = 'not-the-request'
      if (kind === 'extra-field') Object.assign(value, { unexpected: true })
      if (kind === 'missing-cell') value.result.rows = [{}]
      if (kind === 'extra-cell') value.result.rows = [{ value: 1, extra: 2 }]
      if (kind === 'invalid-json') child.stdout.write('not JSON')
      else if (kind === 'invalid-utf8') child.stdout.write(Buffer.from([0xc3]))
      else child.stdout.write(JSON.stringify(value))
      child.emit('close', kind === 'wrong-exit' ? 1 : 0, null)
    })
    await expect(queryDatabaseIsolated(databasePath, 'SELECT 1', options)).rejects.toMatchObject({
      code: 'QUERY_PROTOCOL',
    })
  })
  it('preserves the native allocation refusal code instead of accepting timeout or output failure', async () => {
    mockNative((request, child) =>
      emit(
        child,
        {
          protocol: 1,
          nonce: request.nonce,
          ok: false,
          limits: { sqliteHeapBytes: 67108864, sqliteHighwaterBytes: 65536 },
          error: { code: 'QUERY_MEMORY_LIMIT', message: 'allocation refused', sqliteCode: 7 },
        },
        1,
      ),
    )
    await expect(
      queryDatabaseIsolated(databasePath, 'SELECT randomblob(100000000)', options),
    ).rejects.toMatchObject({
      code: 'QUERY_MEMORY_LIMIT',
      details: { sqliteCode: 7, sqliteHeapBytes: 67108864 },
    })
  })
  it('rejects an allocation-limit label without the matching native SQLITE_NOMEM code', async () => {
    mockNative((request, child) =>
      emit(
        child,
        {
          protocol: 1,
          nonce: request.nonce,
          ok: false,
          limits: { sqliteHeapBytes: 67108864, sqliteHighwaterBytes: 65536 },
          error: { code: 'QUERY_MEMORY_LIMIT', message: 'allocation refused', sqliteCode: 9 },
        },
        1,
      ),
    )
    await expect(
      queryDatabaseIsolated(databasePath, 'SELECT randomblob(100000000)', options),
    ).rejects.toMatchObject({ code: 'QUERY_PROTOCOL' })
  })
  it('counts the framing newline in the exact 256 KiB request boundary', async () => {
    const sql = 'SELECT ? AS value'
    const empty = {
      protocol: 1,
      nonce: '0'.repeat(36),
      path: resolve(databasePath),
      sql,
      parameters: [''],
      maxRows: 1000,
      deadlineMs: 3000,
    }
    const padding = 'x'.repeat(262144 - 1 - Buffer.byteLength(JSON.stringify(empty)))
    mockNative((request, child, bytes) => {
      expect(bytes.length).toBe(262144)
      emit(child, success(request))
    })
    await queryDatabaseIsolated(databasePath, sql, { ...options, parameters: [padding] })
    expect(spawn).toHaveBeenCalledTimes(1)
    await expect(
      queryDatabaseIsolated(databasePath, sql, { ...options, parameters: [padding + 'x'] }),
    ).rejects.toMatchObject({ code: 'QUERY_INPUT_LIMIT' })
    expect(spawn).toHaveBeenCalledTimes(1)
  })
  it.each(['stdout', 'stderr', 'stdin'] as const)(
    'turns a %s pipe error into a typed failure',
    async (pipe) => {
      mockNative((_request, child) => child[pipe].emit('error', new Error('pipe failed')))
      await expect(queryDatabaseIsolated(databasePath, 'SELECT 1', options)).rejects.toMatchObject({
        code: 'QUERY_IO',
      })
    },
  )
  it('bounds output before retaining an oversized native chunk', async () => {
    mockNative((_request, child) => child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1)))
    await expect(queryDatabaseIsolated(databasePath, 'SELECT 1', options)).rejects.toMatchObject({
      code: 'QUERY_OUTPUT_LIMIT',
    })
  })
  it('cancels the exact held pipe and waits for normal cleanup without launching a shell', async () => {
    mockNative(() => undefined)
    const controller = new AbortController()
    const result = queryDatabaseIsolated(databasePath, 'SELECT 1', {
      ...options,
      signal: controller.signal,
    })
    controller.abort()
    await expect(result).rejects.toMatchObject({
      code: 'QUERY_CANCELLED',
      details: { cleanupPending: false },
    })
    expect(children[0].stdin.destroyed).toBe(true)
  })
  it('settles a deadline with explicit pending cleanup, unrefs the child, and refuses replacement jobs until exit', async () => {
    vi.useFakeTimers()
    mockNative(() => undefined, false)
    const first = queryDatabaseIsolated(databasePath, 'SELECT 1', {
      ...options,
      timeoutMs: 100,
    }).catch((error: unknown) => error)
    const second = queryDatabaseIsolated(databasePath, 'SELECT 1', {
      ...options,
      timeoutMs: 100,
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1101)
    expect(await first).toMatchObject({ code: 'QUERY_TIMEOUT', details: { cleanupPending: true } })
    expect(await second).toMatchObject({ code: 'QUERY_TIMEOUT', details: { cleanupPending: true } })
    expect(children[0].unref).toHaveBeenCalledTimes(1)
    expect(children[0].stdout.destroyed).toBe(true)
    await expect(queryDatabaseIsolated(databasePath, 'SELECT 1', options)).rejects.toMatchObject({
      code: 'QUERY_BUSY',
    })
    expect(spawn).toHaveBeenCalledTimes(2)
    children[0].emit('close', 125, null)
    children[1].emit('close', 125, null)
    mockNative((request, child) => emit(child, success(request)))
    await expect(queryDatabaseIsolated(databasePath, 'SELECT 1', options)).resolves.toMatchObject({
      rows: [{ value: 1 }],
    })
  })
  it('does not substitute Node SQLite when the configured helper is absent', async () => {
    await expect(
      queryDatabaseIsolated(databasePath, 'SELECT 1', {
        workerPath: join(tmpdir(), 'missing-query-provider-' + Date.now()),
      }),
    ).rejects.toMatchObject({ code: 'QUERY_RUNTIME_UNAVAILABLE' })
    expect(spawn).not.toHaveBeenCalled()
  })
})
