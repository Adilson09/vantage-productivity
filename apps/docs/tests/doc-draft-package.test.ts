// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import {
  listDraftJournal,
  readDraftJournal,
  restoreDraftCopy,
} from '../../../packages/electron-utils/src/draft-journal'
import {
  createRecoveryCipher,
  isEncryptedRecoveryPayload,
  setRecoveryCipher,
} from '../../../packages/electron-utils/src/recovery-encryption'
import { DocDraftController } from '../src/main/doc-draft-controller'
import { captureDocDraftProtection } from '../src/main/doc-draft-protection'
import {
  decryptDocx,
  forgetDocPasswords,
  isEncryptedDocx,
  markDiskEncrypted,
  rememberDocPassword,
  setDocPassword,
  snapshotDocPassword,
} from '../src/main/docx-encryption'
import { forgetLazyMediaOwner, materializeLazyDocx, openLazyDocx } from '../src/main/lazy-media'

vi.mock('electron', () => ({ protocol: {} }))
vi.mock('@vantage/electron-utils', async () => ({
  ...(await import('../../../packages/electron-utils/src/ooxml-encryption')),
  DOCX_MEDIA_SCHEME_PRIVILEGE: { scheme: 'vantage-docx-media' },
}))

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    setRecoveryCipher(join(directory, 'recovery'), null)
    await rm(directory, { recursive: true, force: true })
  }
  forgetLazyMediaOwner(401)
  forgetLazyMediaOwner(402)
  forgetDocPasswords(401)
})

async function fixture(withMedia = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vantage-doc-draft-package-'))
  directories.push(directory)
  const path = join(directory, 'original.docx')
  const root = join(directory, 'recovery')
  const media = withMedia ? randomBytes(1024 * 1024 + 17) : null
  const original = Buffer.from(
    await buildDocx({
      bodyXml: '<w:p><w:r><w:t>Private draft package content</w:t></w:r></w:p>',
      ...(media
        ? {
            binaryParts: [
              {
                path: 'word/media/recovery.png',
                base64: media.toString('base64'),
                extension: 'png',
                contentType: 'image/png',
              },
            ],
          }
        : {}),
    }),
  )
  await writeFile(path, original)
  const controller = new DocDraftController({
    recoveryRoot: () => root,
    isLive: (owner) => owner === 401 || owner === 402,
    canWritePath: (_owner, candidate) => candidate === path,
    prepare: async (owner, documentPath, bytes, encrypted) => {
      const protect = captureDocDraftProtection(owner, documentPath, encrypted)
      const complete = await materializeLazyDocx(bytes, {
        strict: true,
        ownerId: owner,
        maxReferencedBytes: 16 * 1024 * 1024,
      })
      return protect(complete.bytes)
    },
  })
  const snapshot = (
    token: string,
    sequence: number,
    bytes: Buffer,
    documentPath: string | null = null,
    encrypted = false,
    owner = 401,
  ) =>
    controller.snapshot(owner, {
      token,
      sequence,
      documentPath,
      encrypted,
      data: Uint8Array.from(bytes).buffer,
    })
  return { directory, path, root, original, media, controller, snapshot }
}

describe('complete DOCX journal package and password protection', () => {
  it('preserves a good draft when real journal quota and input size limits reject its replacement', async () => {
    const f = await fixture()
    const token = f.controller.activate(401, null)
    await f.snapshot(token, 1, f.original)
    await expect(f.snapshot(token, 2, Buffer.alloc(16 * 1024 * 1024 + 1))).rejects.toThrow(/16 MiB/)
    const occupied = await open(join(f.root, 'drafts', 'quota.bin'), 'wx')
    try {
      await occupied.truncate(128 * 1024 * 1024)
    } finally {
      await occupied.close()
    }
    const changed = Buffer.from(
      await buildDocx({ bodyXml: '<w:p><w:r><w:t>Quota replacement</w:t></w:r></w:p>' }),
    )
    await expect(f.snapshot(token, 3, changed)).rejects.toThrow(/journal is full/)
    expect((await readDraftJournal(f.root, token)).bytes).toEqual(f.original)
  })
  it('restores self-contained lazy media after the original file moves', async () => {
    const f = await fixture(true)
    const lazy = await openLazyDocx(f.path, 401)
    expect(lazy).not.toBeNull()
    expect(lazy!.bytes.length).toBeLessThan(10 * 1024)
    const token = f.controller.activate(401, f.path)
    expect(await f.snapshot(token, 1, lazy!.bytes, f.path)).toBe(true)
    await rename(f.path, join(f.directory, 'original-moved.docx'))
    forgetLazyMediaOwner(401)
    const restored = join(f.directory, 'recovered.docx')
    await restoreDraftCopy(f.root, token, restored)
    const zip = await JSZip.loadAsync(await readFile(restored))
    expect(await zip.file('word/media/recovery.png')!.async('nodebuffer')).toEqual(f.media)
    expect(await zip.file('word/document.xml')!.async('string')).toContain(
      'Private draft package content',
    )
    expect(
      (
        await materializeLazyDocx(await readFile(restored), {
          strict: true,
          ownerId: 402,
          maxReferencedBytes: 1,
        })
      ).hashes.size,
    ).toBe(0)
  })

  it('rejects missing/cross-view media, invalid ZIPs, and pre-allocation media budget overflow while preserving the last good draft', async () => {
    const f = await fixture(true)
    const lazy = (await openLazyDocx(f.path, 401))!
    const token = f.controller.activate(401, f.path)
    await f.snapshot(token, 1, lazy.bytes, f.path)
    const good = (await readDraftJournal(f.root, token)).bytes
    await expect(
      materializeLazyDocx(lazy.bytes, {
        strict: true,
        ownerId: 402,
        maxReferencedBytes: 16 * 1024 * 1024,
      }),
    ).rejects.toThrow(/unavailable/)
    await expect(
      materializeLazyDocx(lazy.bytes, { strict: true, ownerId: 401, maxReferencedBytes: 1 }),
    ).rejects.toThrow(/budget/)
    await expect(
      materializeLazyDocx(lazy.bytes, {
        strict: true,
        ownerId: 401,
        maxReferencedBytes: f.media!.length,
      }),
    ).rejects.toThrow(/budget/)
    await expect(f.snapshot(token, 2, Buffer.from('not a ZIP'), f.path)).rejects.toThrow()
    await rename(f.path, join(f.directory, 'missing-original.docx'))
    await expect(f.snapshot(token, 3, lazy.bytes, f.path)).rejects.toThrow()
    expect((await readDraftJournal(f.root, token)).bytes).toEqual(good)
  })

  it.each([false, true])(
    'encrypts a pending unnamed password before optional OS storage encryption (OS layer %s)',
    async (osLayer) => {
      const f = await fixture()
      if (osLayer) setRecoveryCipher(f.root, createRecoveryCipher(randomBytes(32)))
      setDocPassword(401, null, 'Draft secret 401')
      const intent = snapshotDocPassword(401, null)
      const token = f.controller.activate(401, null)
      await f.snapshot(token, 1, f.original)
      const result = await readDraftJournal(f.root, token)
      expect(isEncryptedDocx(result.bytes)).toBe(true)
      expect(await decryptDocx(result.bytes, 'Draft secret 401')).toEqual(f.original)
      expect(snapshotDocPassword(401, null)).toEqual(intent)
      const payload = await readFile(join(f.root, 'drafts', result.entry.payload))
      expect(isEncryptedRecoveryPayload(payload)).toBe(osLayer)
      expect(payload.includes(f.original)).toBe(false)
      expect(payload.includes(Buffer.from('Private draft package content'))).toBe(false)
    },
  )

  it('keeps named protected recovery encrypted while password removal awaits an explicit save', async () => {
    const f = await fixture()
    rememberDocPassword(401, f.path, 'Old disk secret')
    markDiskEncrypted(401, f.path, true)
    setDocPassword(401, f.path, null)
    const token = f.controller.activate(401, f.path)
    await f.snapshot(token, 1, f.original, f.path, true)
    expect(
      await decryptDocx((await readDraftJournal(f.root, token)).bytes, 'Old disk secret'),
    ).toEqual(f.original)
    expect(snapshotDocPassword(401, f.path).password).toBeNull()
    forgetDocPasswords(401)
    await expect(f.snapshot(token, 2, f.original, f.path, true)).rejects.toThrow(
      /password is unavailable/,
    )
    expect(await listDraftJournal(f.root)).toHaveLength(1)
    expect(isEncryptedDocx((await readDraftJournal(f.root, token)).bytes)).toBe(true)
  })
})
