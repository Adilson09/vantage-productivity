import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { resolveQueryWorkerPath } from '../../productivity-engine/src/database-isolated'

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) {
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + '/vantage query package ') &&
      !resolve(directory).startsWith(resolve(tmpdir()) + '\\vantage query package ')
    )
      throw new Error('Unsafe test directory.')
    rmSync(directory, { recursive: true, force: true })
  }
})

it('queries through a relocated CLI sibling helper under plain Node with space-containing paths and no resourcesPath', async () => {
  // Build only the shipped query client, then exercise its real fixed-location
  // resolver outside the repository. The existing CLI pretest builds the helper.
  const directory = mkdtempSync(join(tmpdir(), 'vantage query package '))
  scratch.push(directory)
  const cli = join(directory, 'relocated application', 'resources', 'cli')
  const native = join(directory, 'relocated application', 'resources', 'native')
  const unrelated = join(directory, 'unrelated working directory')
  mkdirSync(cli, { recursive: true })
  mkdirSync(native, { recursive: true })
  mkdirSync(unrelated)
  const workerSource = resolveQueryWorkerPath()
  const executable =
    process.platform === 'win32' ? 'vantage-query-worker.exe' : 'vantage-query-worker'
  const worker = join(native, executable)
  copyFileSync(workerSource, worker)
  chmodSync(worker, statSync(workerSource).mode)
  const hash = (path: string): string =>
    createHash('sha256').update(readFileSync(path)).digest('hex')
  expect(hash(worker)).toBe(hash(workerSource))
  const source = join(directory, 'source database with spaces.vdb')
  const database = new DatabaseSync(source)
  database.exec(
    "PRAGMA application_id=1447120468; PRAGMA user_version=1; CREATE TABLE Sales(name TEXT,amount REAL); INSERT INTO Sales VALUES ('Ada',7.5)",
  )
  database.close()
  const before = hash(source)
  await build({
    entryPoints: [
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../productivity-engine/src/database-isolated.ts',
      ),
    ],
    outfile: join(cli, 'query-client.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  })
  const launcher = join(cli, 'query-proof.cjs')
  writeFileSync(
    launcher,
    `const {queryDatabaseIsolated,resolveQueryWorkerPath}=require('./query-client.cjs');
if(process.resourcesPath!==undefined)throw new Error('This proof requires plain Node without Electron resourcesPath');
queryDatabaseIsolated(process.argv[2],'SELECT name,amount FROM Sales',{timeoutMs:30000}).then(result=>process.stdout.write(JSON.stringify({worker:resolveQueryWorkerPath(),result}))).catch(error=>{process.stderr.write(String(error));process.exitCode=1});\n`,
  )
  const result = spawnSync(process.execPath, [launcher, source], {
    cwd: unrelated,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 35000,
    maxBuffer: 3 * 1024 * 1024,
    env: {
      ...process.env,
      VANTAGE_QUERY_WORKER_PATH: '',
      XLSX_SIDECAR_PATH: '',
      CARGO_TARGET_DIR: '',
      CARGO_BUILD_TARGET: '',
    },
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    worker: realpathSync(worker),
    result: { columns: ['name', 'amount'], rows: [{ name: 'Ada', amount: 7.5 }], truncated: false },
  })
  expect(hash(source)).toBe(before)
}, 60000)
