// Vantage Productivity addition: recovery provenance, bounded retention and copy-only restore tests.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureRecoverySnapshot,
  listRecoveryEntries,
  RECOVERY_POLICY,
  restoreRecoveryCopy,
} from '../src/recovery-vault'

const prefix = join(tmpdir(), 'vantage-vault-')
let dir = '',
  root = '',
  target = ''
beforeEach(() => {
  dir = mkdtempSync(prefix)
  root = join(dir, 'vault')
  target = join(dir, 'Report.docx')
})
afterEach(() => {
  if (!dir.startsWith(prefix)) throw new Error('Refusing cleanup outside named test directory')
  rmSync(dir, { recursive: true, force: true })
})

describe('bounded local recovery vault', () => {
  it('does not invent a first-save version or snapshot app settings', async () => {
    expect(await captureRecoverySnapshot(target, root)).toBeNull()
    const settings = join(dir, 'settings.json')
    writeFileSync(settings, '{}')
    expect(await captureRecoverySnapshot(settings, root)).toBeNull()
    expect(await listRecoveryEntries(root)).toEqual([])
  })

  it('records the original bytes with their full path, size, time and SHA256', async () => {
    writeFileSync(target, 'version one')
    const entry = await captureRecoverySnapshot(target, root)
    expect(entry).toMatchObject({
      originalPath: target,
      fileName: 'Report.docx',
      bytes: 11,
      sha256: createHash('sha256').update('version one').digest('hex'),
    })
    expect(Number.isFinite(Date.parse(entry!.createdAt))).toBe(true)
    expect(await listRecoveryEntries(root)).toEqual([entry])
    expect(readFileSync(target, 'utf8')).toBe('version one')
  })

  it('excludes application-data documents and caches without excluding similarly named sibling folders', async () => {
    const previous = process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT
    const dataRoot = join(dir, 'app-data')
    const siblingRoot = `${dataRoot}-documents`
    mkdirSync(dataRoot)
    mkdirSync(siblingRoot)
    const cached = join(dataRoot, 'autosave.docx')
    const document = join(siblingRoot, 'report.docx')
    writeFileSync(cached, 'temporary crash cache')
    writeFileSync(document, 'real document')
    process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT = dataRoot
    try {
      expect(await captureRecoverySnapshot(cached, root)).toBeNull()
      expect(await captureRecoverySnapshot(document, root)).toMatchObject({
        originalPath: document,
      })
      expect(await listRecoveryEntries(root)).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT
      else process.env.VANTAGE_RECOVERY_EXCLUDE_ROOT = previous
    }
  })

  it('deduplicates unchanged content', async () => {
    writeFileSync(target, 'unchanged')
    const first = await captureRecoverySnapshot(target, root)
    const second = await captureRecoverySnapshot(target, root)
    expect(second!.id).toBe(first!.id)
    expect(await listRecoveryEntries(root)).toHaveLength(1)
  })

  it('serializes simultaneous captures without duplicate entries', async () => {
    writeFileSync(target, 'shared content')
    const entries = await Promise.all(
      Array.from({ length: 5 }, () => captureRecoverySnapshot(target, root)),
    )
    expect(new Set(entries.map((entry) => entry!.id)).size).toBe(1)
    expect(await listRecoveryEntries(root)).toHaveLength(1)
  })

  it('keeps only the configured number of prior revisions for a file', async () => {
    const captured: Awaited<ReturnType<typeof captureRecoverySnapshot>>[] = []
    for (let i = 0; i < RECOVERY_POLICY.maxRevisionsPerFile + 3; i += 1) {
      writeFileSync(target, `version ${i}`)
      captured.push(await captureRecoverySnapshot(target, root))
    }
    const entries = await listRecoveryEntries(root)
    expect(entries).toHaveLength(RECOVERY_POLICY.maxRevisionsPerFile)
    expect(entries.some((entry) => entry.id === captured.at(-1)!.id)).toBe(true)
    expect(readdirSync(root).filter((name) => name.endsWith('.bin'))).toHaveLength(
      RECOVERY_POLICY.maxRevisionsPerFile,
    )
  }, 20000)

  it('skips files above the per-file byte budget before reading their contents', async () => {
    writeFileSync(target, '')
    truncateSync(target, RECOVERY_POLICY.maxFileBytes + 1)
    expect(await captureRecoverySnapshot(target, root)).toBeNull()
    expect(await listRecoveryEntries(root)).toEqual([])
  })

  it('includes an existing version exactly at the per-file byte budget', async () => {
    writeFileSync(target, '')
    truncateSync(target, RECOVERY_POLICY.maxFileBytes)
    const entry = await captureRecoverySnapshot(target, root)
    expect(entry?.bytes).toBe(RECOVERY_POLICY.maxFileBytes)
    expect(await listRecoveryEntries(root)).toHaveLength(1)
  }, 20000)

  it('prunes the oldest indexed payload before allocating above the total byte budget', async () => {
    mkdirSync(root)
    const seeded: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const id = randomUUID()
      seeded.push(id)
      const originalPath = join(dir, `old-${i}.docx`)
      writeFileSync(join(root, `${id}.bin`), '')
      truncateSync(join(root, `${id}.bin`), RECOVERY_POLICY.maxFileBytes)
      writeFileSync(
        join(root, `${id}.json`),
        JSON.stringify({
          id,
          originalPath,
          fileName: `old-${i}.docx`,
          createdAt: `2020-01-0${i + 1}T00:00:00.000Z`,
          bytes: RECOVERY_POLICY.maxFileBytes,
          sha256: 'a'.repeat(64),
        }),
      )
    }
    writeFileSync(target, 'new prior version')
    await captureRecoverySnapshot(target, root)
    const entries = await listRecoveryEntries(root)
    expect(entries).toHaveLength(4)
    expect(entries.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThanOrEqual(
      RECOVERY_POLICY.maxVaultBytes,
    )
    expect(existsSync(join(root, `${seeded[0]}.bin`))).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('new prior version')
  }, 20000)

  it('counts incomplete orphan payloads against the vault budget instead of growing indefinitely', async () => {
    mkdirSync(root)
    const orphan = join(root, `${randomUUID()}.bin`)
    writeFileSync(orphan, '')
    truncateSync(orphan, RECOVERY_POLICY.maxVaultBytes)
    writeFileSync(target, 'keep this original')
    await expect(captureRecoverySnapshot(target, root)).rejects.toThrow('full of incomplete')
    expect(readFileSync(target, 'utf8')).toBe('keep this original')
    expect(readdirSync(root)).toHaveLength(1)
  })

  it('caps entry count across different documents, including zero-byte versions', async () => {
    mkdirSync(root)
    const emptyHash = createHash('sha256').update('').digest('hex')
    let oldest = ''
    for (let i = 0; i < RECOVERY_POLICY.maxEntries; i += 1) {
      const id = randomUUID()
      if (i === 0) oldest = id
      const fileName = `document-${i}.docx`
      writeFileSync(join(root, `${id}.bin`), '')
      writeFileSync(
        join(root, `${id}.json`),
        JSON.stringify({
          id,
          originalPath: join(dir, fileName),
          fileName,
          createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
          bytes: 0,
          sha256: emptyHash,
        }),
      )
    }
    writeFileSync(target, 'new version')
    const added = await captureRecoverySnapshot(target, root)
    const entries = await listRecoveryEntries(root)
    expect(entries).toHaveLength(RECOVERY_POLICY.maxEntries)
    expect(entries.some((entry) => entry.id === added!.id)).toBe(true)
    expect(entries.some((entry) => entry.id === oldest)).toBe(false)
    expect(readdirSync(root).filter((name) => name.endsWith('.bin'))).toHaveLength(
      RECOVERY_POLICY.maxEntries,
    )
  }, 30000)

  it('does not deduplicate against a corrupted existing snapshot', async () => {
    writeFileSync(target, 'before')
    const entry = await captureRecoverySnapshot(target, root)
    writeFileSync(join(root, `${entry!.id}.bin`), 'damage')
    await expect(captureRecoverySnapshot(target, root)).rejects.toThrow('integrity check')
    expect(readFileSync(target, 'utf8')).toBe('before')
  })

  it('restores verified bytes into a new file without changing the original', async () => {
    writeFileSync(target, 'before')
    const entry = await captureRecoverySnapshot(target, root)
    writeFileSync(target, 'after')
    const recovered = join(dir, 'Recovered.docx')
    await restoreRecoveryCopy(root, entry!.id, recovered)
    expect(readFileSync(recovered, 'utf8')).toBe('before')
    expect(readFileSync(target, 'utf8')).toBe('after')
  })

  it('refuses both original-path recovery and overwriting an unrelated existing file', async () => {
    writeFileSync(target, 'before')
    const entry = await captureRecoverySnapshot(target, root)
    await expect(restoreRecoveryCopy(root, entry!.id, target)).rejects.toThrow('new copy')
    const other = join(dir, 'Occupied.docx')
    writeFileSync(other, 'keep')
    await expect(restoreRecoveryCopy(root, entry!.id, other)).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(readFileSync(other, 'utf8')).toBe('keep')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses traversal identifiers and corrupted recovery bytes', async () => {
    writeFileSync(target, 'before')
    const entry = await captureRecoverySnapshot(target, root)
    await expect(restoreRecoveryCopy(root, '../Report', join(dir, 'No.docx'))).rejects.toThrow(
      'Invalid',
    )
    writeFileSync(join(root, `${entry!.id}.bin`), 'damage')
    await expect(restoreRecoveryCopy(root, entry!.id, join(dir, 'No.docx'))).rejects.toThrow(
      'integrity',
    )
  })

  it('ignores malformed metadata rather than presenting it as a recoverable file', async () => {
    writeFileSync(target, 'before')
    const entry = await captureRecoverySnapshot(target, root)
    writeFileSync(join(root, `${entry!.id}.json`), '{broken')
    expect(await listRecoveryEntries(root)).toEqual([])
  })
})
