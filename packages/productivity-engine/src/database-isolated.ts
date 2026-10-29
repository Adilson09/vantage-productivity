import { spawn } from 'node:child_process'

export interface IsolatedQueryOptions {
  timeoutMs?: number
  maxRows?: number
  parameters?: (null | string | number)[]
  signal?: AbortSignal
}
export interface IsolatedQueryResult {
  columns: string[]
  rows: Record<string, null | string | number>[]
  truncated: boolean
}

// A fixed child program ships inside the bundle; queries and paths only cross
// stdin as JSON. No shell or generated command text contains user input.
const QUERY_CHILD = String.raw`
'use strict';
const { DatabaseSync } = require('node:sqlite');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > 262144) process.exit(2); });
process.stdin.on('end', () => {
 let db;
 try {
  const { path, sql, parameters, maxRows } = JSON.parse(input);
  db = new DatabaseSync(path, {readOnly:true,allowExtension:false,enableDoubleQuotedStringLiterals:false});
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA hard_heap_limit=67108864; PRAGMA busy_timeout=1000;');
  if(db.prepare('PRAGMA application_id').get().application_id !== 0x56414e54 || db.prepare('PRAGMA user_version').get().user_version !== 1) throw Error('This is not a supported Vantage database.');
  const statement = db.prepare(sql);
  const columns = typeof statement.columns === 'function' ? statement.columns().map(c=>c.name) : [];
  const rows = [];
  let bytes = 0, truncated = false;
  for(const record of statement.iterate(...parameters)) {
   if(rows.length === maxRows) {truncated=true;break;}
   const row = Object.fromEntries(Object.entries(record).map(([k,v])=>[k,typeof v==='bigint'?String(v):v instanceof Uint8Array?'base64:'+Buffer.from(v).toString('base64'):v]));
   bytes += Buffer.byteLength(JSON.stringify(row));
   if(bytes>2097152) {truncated=true;break;}
   if(columns.length===0) columns.push(...Object.keys(row));
   rows.push(row);
  }
  db.close();db=null;
  process.stdout.write(JSON.stringify({ok:true,result:{columns,rows,truncated}}));
 } catch(error) {
  if(db) {try{db.close()}catch{}}
  process.stdout.write(JSON.stringify({ok:false,error:String(error.message||error)}));
  process.exitCode=1;
 }
});
`

/** Query in a separate Node process with a wall deadline, SQLite allocator cap, JS heap cap and output bounds. */
export async function queryDatabaseIsolated(path: string, sql: string, options: IsolatedQueryOptions = {}): Promise<IsolatedQueryResult> {
  const timeoutMs = options.timeoutMs ?? 3000
  const maxRows = options.maxRows ?? 1000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Query timeout must be 100 to 30,000 ms.')
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10000) throw new Error('Result limit must be 1 to 10,000 rows.')
  if (!path || path === ':memory:') throw new Error('Isolated queries need a saved database file.')
  if (typeof sql !== 'string' || Buffer.byteLength(sql) > 32768 || !/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Enter one SELECT or WITH query, at most 32 KiB.')
  if (options.signal?.aborted) throw new Error('Query cancelled.')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=96', '--input-type=commonjs', '-e', QUERY_CHILD], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    })
    let output = ''
    let diagnostics = ''
    let settled = false
    let terminalError: Error | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancelled)
      if (error) { reject(error); return }
      try {
        const parsed = JSON.parse(output) as { ok: boolean; error?: string; result: IsolatedQueryResult }
        if (!parsed.ok) reject(new Error(parsed.error ?? 'Database query failed.'))
        else resolve(parsed.result)
      } catch { reject(new Error(`The database process returned no valid result.${diagnostics ? ` ${diagnostics.slice(-500)}` : ''}`)) }
    }
    const stop = (error: Error): void => {
      if (settled || terminalError) return
      terminalError = error
      child.kill()
      // Resolve only after close: on Windows the child can still hold the
      // SQLite file handle for a short interval after kill() returns.
    }
    const timer = setTimeout(() => stop(new Error(`Query exceeded its ${timeoutMs} ms time limit.`)), timeoutMs)
    const cancelled = (): void => stop(new Error('Query cancelled.'))
    options.signal?.addEventListener('abort', cancelled, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk; if (Buffer.byteLength(output) > 3 * 1024 * 1024) stop(new Error('Database query output exceeded 3 MiB.')) })
    child.stderr.on('data', (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-2000) })
    child.on('error', (error) => finish(error))
    child.on('close', () => finish(terminalError))
    child.stdin.on('error', () => { /* exit/error event reports a child which closed stdin early */ })
    const request = JSON.stringify({ path, sql, parameters: options.parameters ?? [], maxRows })
    if (Buffer.byteLength(request) > 262144) { stop(new Error('Query parameters exceed 256 KiB.')); return }
    child.stdin.end(request)
  })
}
