import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CheckoutPermissionError,
  DocumentCheckoutRegistry,
  DocumentLockedError,
} from '../src/collaboration'

let directory: string
let path: string
let registry: string
let handles: DocumentCheckoutRegistry[]
let now: number
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vantage-checkout-'))
  path = join(directory, 'document.md')
  registry = join(directory, 'leases.sqlite')
  writeFileSync(path, 'original saved version')
  handles = []
  now = 1793290000000
})
afterEach(() => {
  for (const handle of handles) handle.close()
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + '\\vantage-checkout-') &&
    !resolve(directory).startsWith(resolve(tmpdir()) + '/vantage-checkout-')
  )
    throw new Error('Unsafe temporary path.')
  rmSync(directory, { recursive: true, force: true })
})
function manager(): DocumentCheckoutRegistry {
  const handle = new DocumentCheckoutRegistry(registry, () => now)
  handles.push(handle)
  return handle
}

describe('100 deterministic multi-session checkout, disconnect, expiry and conflict trials', () => {
  for (let seed = 0; seed < 25; seed++) {
    it(`denies another editor and invalid permission token; transfers checkout on release (${seed})`, () => {
      const alice = manager(),
        bob = manager()
      const lease = alice.checkout(path, `Alice ${seed}`)
      expect(() => bob.checkout(path, 'Bob')).toThrow(DocumentLockedError)
      expect(() => bob.verify({ ...lease, token: 'forged' })).toThrow(CheckoutPermissionError)
      expect(() => bob.release({ ...lease, owner: 'Bob' })).toThrow(CheckoutPermissionError)
      expect(alice.list()[0]).not.toHaveProperty('token')
      alice.release(lease)
      const next = bob.checkout(path, 'Bob')
      expect(next.token).not.toBe(lease.token)
      expect(bob.publish(next, Buffer.from(`Bob edit ${seed}`)).status).toBe('published')
      expect(readFileSync(path, 'utf8')).toBe(`Bob edit ${seed}`)
    })

    it(`resumes the exact lease after a client disconnect and prevents stale same-token edits (${seed})`, () => {
      const first = manager()
      const lease = first.checkout(path, 'Alice')
      first.close()
      const reconnect = manager()
      expect(reconnect.verify(lease).unchanged).toBe(true)
      const renewed = reconnect.renew(lease, 5000)
      expect(renewed.token).toBe(lease.token)
      const result = reconnect.publish(renewed, Buffer.from(`reconnected edit ${seed}`))
      expect(result.status).toBe('published')
      expect(reconnect.verify(lease).unchanged).toBe(false)
      const stale = reconnect.publish(lease, Buffer.from('stale editor state'))
      expect(stale.status).toBe('conflict')
      expect(readFileSync(path, 'utf8')).toBe(`reconnected edit ${seed}`)
      if (stale.status === 'conflict')
        expect(readFileSync(stale.conflictPath, 'utf8')).toBe('stale editor state')
    })

    it(`rejects a disconnected expired lease after another editor takes over (${seed})`, () => {
      const alice = manager(),
        bob = manager()
      const old = alice.checkout(path, 'Alice', { ttlMs: 1000 })
      now += 1001
      const next = bob.checkout(path, 'Bob')
      expect(() => alice.renew(old)).toThrow(CheckoutPermissionError)
      expect(() => alice.publish(old, Buffer.from('late offline edit'))).toThrow(
        CheckoutPermissionError,
      )
      expect(() => alice.release(old)).toThrow(CheckoutPermissionError)
      expect(bob.publish(next, Buffer.from(`current owner ${seed}`)).status).toBe('published')
      expect(readFileSync(path, 'utf8')).toBe(`current owner ${seed}`)
    })

    it(`preserves outside changes and exports a separate conflict copy on reconnect (${seed})`, () => {
      const alice = manager()
      const lease = alice.checkout(path, 'Alice')
      writeFileSync(path, `external change ${seed}`)
      expect(alice.verify(lease).unchanged).toBe(false)
      const result = alice.publish(lease, Buffer.from(`unsaved local work ${seed}`))
      expect(result.status).toBe('conflict')
      expect(readFileSync(path, 'utf8')).toBe(`external change ${seed}`)
      if (result.status === 'conflict') {
        expect(result.conflictPath).not.toBe(path)
        expect(readFileSync(result.conflictPath, 'utf8')).toBe(`unsaved local work ${seed}`)
      }
    })
  }
})

it('enforces the same checkout registry from an independent operating-system process', () => {
  const first = manager()
  first.checkout(path, 'First process')
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const source = pathToFileURL(join(repo, 'packages/productivity-engine/src/collaboration.ts')).href
  const loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href
  const child = `import {DocumentCheckoutRegistry} from ${JSON.stringify(source)}; let r; try{r=new DocumentCheckoutRegistry(process.argv[1],()=>1793290000000);r.checkout(process.argv[2],'Second process');process.stdout.write('unexpected')}catch(e){process.stdout.write(e.name)}finally{r?.close()}`
  const result = execFileSync(
    process.execPath,
    ['--import', loader, '--input-type=module', '-e', child, registry, path],
    { windowsHide: true, encoding: 'utf8', timeout: 5000 },
  )
  expect(result).toBe('DocumentLockedError')
})
