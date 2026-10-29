import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './helpers'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vantage-provider-cli-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + '\\vantage-provider-cli-') &&
    !resolve(directory).startsWith(resolve(tmpdir()) + '/vantage-provider-cli-')
  )
    throw new Error('Unsafe temporary path.')
  rmSync(directory, { recursive: true, force: true })
})
const context = () => ({
  env: { ...process.env, VANTAGE_AUDIT_LOG: join(directory, 'audit.jsonl') },
})

describe('cooperative checkout CLI', () => {
  it('reserves, verifies, publishes and releases without printing its bearer token', async () => {
    const path = join(directory, 'document.md'),
      registry = join(directory, 'locks.sqlite'),
      lease = join(directory, 'lease.json'),
      prepared = join(directory, 'prepared.md')
    writeFileSync(path, 'original')
    writeFileSync(prepared, 'new document')
    const reserved = await run(
      [
        'checkout',
        'reserve',
        path,
        '--registry',
        registry,
        '--lease',
        lease,
        '--owner',
        'Editor',
        '--json',
      ],
      context(),
    )
    expect(reserved.code).toBe(0)
    const token = JSON.parse(readFileSync(lease, 'utf8')).token as string
    expect(reserved.stdout).not.toContain(token)
    expect(
      (
        await run(
          ['checkout', 'verify', '--registry', registry, '--lease', lease, '--json'],
          context(),
        )
      ).json().detail.unchanged,
    ).toBe(true)
    const published = await run(
      [
        'checkout',
        'publish',
        '--registry',
        registry,
        '--lease',
        lease,
        '--source',
        prepared,
        '--json',
      ],
      context(),
    )
    expect(published.code).toBe(0)
    expect(published.json().detail.status).toBe('published')
    expect(published.stdout).not.toContain(token)
    expect(readFileSync(path, 'utf8')).toBe('new document')
    expect(
      (
        await run(
          ['checkout', 'release', '--registry', registry, '--lease', lease, '--json'],
          context(),
        )
      ).code,
    ).toBe(0)
    expect(readFileSync(join(directory, 'audit.jsonl'), 'utf8')).not.toContain(token)
  })

  it('writes a conflict copy while preserving the outside edit', async () => {
    const path = join(directory, 'document.md'),
      registry = join(directory, 'locks.sqlite'),
      lease = join(directory, 'lease.json'),
      prepared = join(directory, 'prepared.md')
    writeFileSync(path, 'original')
    writeFileSync(prepared, 'local unsaved work')
    await run(
      ['checkout', 'reserve', path, '--registry', registry, '--lease', lease, '--json'],
      context(),
    )
    writeFileSync(path, 'outside edit')
    const result = await run(
      [
        'checkout',
        'publish',
        '--registry',
        registry,
        '--lease',
        lease,
        '--source',
        prepared,
        '--json',
      ],
      context(),
    )
    expect(result.json().status).toBe('partial')
    expect(readFileSync(path, 'utf8')).toBe('outside edit')
    expect(readFileSync(result.json().detail.conflictPath, 'utf8')).toBe('local unsaved work')
  })
})

describe('explicit read-only provider CLI (no real accounts)', () => {
  it('lists requirements and refuses a sync without an environment token before networking', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network must not run'))
    expect(
      (await run(['provider', 'info', '--json'], context())).json().detail.providers['graph-mail']
        .tokenEnvironment,
    ).toBe('VANTAGE_GRAPH_TOKEN')
    const result = await run(
      [
        'provider',
        'sync',
        'graph-mail',
        '--enable',
        '--out',
        join(directory, 'records.json'),
        '--json',
      ],
      { env: { ...context().env, VANTAGE_GRAPH_TOKEN: '' } },
    )
    expect(result.code).not.toBe(0)
    expect(network).not.toHaveBeenCalled()
  })

  it('publishes records before a complete checkpoint and keeps credentials out of outputs/audit', async () => {
    const delta =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=complete'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          value: [{ id: 'one', subject: 'Synthetic test subject' }],
          '@odata.deltaLink': delta,
        }),
      ),
    )
    const output = join(directory, 'records.json'),
      checkpoint = join(directory, 'state.json'),
      token = 'synthetic-private-token'
    const result = await run(
      [
        'provider',
        'sync',
        'graph-mail',
        '--enable',
        '--out',
        output,
        '--checkpoint-out',
        checkpoint,
        '--json',
      ],
      { env: { ...context().env, VANTAGE_GRAPH_TOKEN: token } },
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(output, 'utf8')).items[0].id).toBe('one')
    expect(JSON.parse(readFileSync(checkpoint, 'utf8')).url).toBe(delta)
    expect(
      result.stdout +
        readFileSync(output, 'utf8') +
        readFileSync(checkpoint, 'utf8') +
        readFileSync(join(directory, 'audit.jsonl'), 'utf8'),
    ).not.toContain(token)
  })

  it('does not advance an existing checkpoint after partial paging', async () => {
    const next =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=next'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: [{ id: 'one' }], '@odata.nextLink': next })),
    )
    const checkpoint = join(directory, 'state.json')
    writeFileSync(checkpoint, 'existing checkpoint bytes')
    const result = await run(
      [
        'provider',
        'sync',
        'graph-mail',
        '--enable',
        '--out',
        join(directory, 'partial.json'),
        '--checkpoint-out',
        checkpoint,
        '--pages',
        '1',
        '--json',
      ],
      { env: { ...context().env, VANTAGE_GRAPH_TOKEN: 'synthetic-token' } },
    )
    expect(result.json().status).toBe('partial')
    expect(readFileSync(checkpoint, 'utf8')).toBe('existing checkpoint bytes')
  })
  it('refuses an account read without per-invocation enablement even when a token exists', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network must not run'))
    const result = await run(
      ['provider', 'sync', 'graph-mail', '--out', join(directory, 'disabled.json'), '--json'],
      { env: { ...context().env, VANTAGE_GRAPH_TOKEN: 'synthetic-token' } },
    )
    expect(result.code).not.toBe(0)
    expect(result.json().message).toContain('--enable')
    expect(network).not.toHaveBeenCalled()
  })
})
