import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const permission = vi.hoisted(() => ({ refusedPath: '' }))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return { ...real, accessSync: (...args: Parameters<typeof real.accessSync>) => {
    if (String(args[0]) === permission.refusedPath) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    return real.accessSync(...args)
  } }
})

import {
  configuredDefaultSaveDir,
  readDefaultSaveDirSetting,
  resolveDefaultSaveDir,
} from '../src/index'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vantage-save-dir-'))
  permission.refusedPath = ''
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readDefaultSaveDirSetting', () => {
  const settingsPath = () => join(root, 'app-settings.json')

  it('returns the configured absolute path', () => {
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: '/some/where' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBe('/some/where')
  })

  it('returns null when the file is missing, corrupt, or the key is absent', () => {
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), 'not json')
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), JSON.stringify({ language: 'en' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
  })

  it('rejects non-string and relative values', () => {
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: 42 }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: 'relative/dir' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
  })
})

describe('resolveDefaultSaveDir', () => {
  it('uses the configured folder when it is usable (creating it on demand)', () => {
    const configured = join(root, 'custom', 'nested')
    const resolved = resolveDefaultSaveDir(configured, join(root, 'fallback'))
    expect(resolved).toBe(configured)
    expect(existsSync(configured)).toBe(true)
  })

  it('creates and returns the fallback when nothing is configured', () => {
    const fallback = join(root, 'Documents', 'Vantage')
    expect(resolveDefaultSaveDir(null, fallback)).toBe(fallback)
    expect(existsSync(fallback)).toBe(true)
  })

  it('degrades to the fallback when the configured folder is not writable', () => {
    const readOnly = join(root, 'read-only')
    mkdirSync(readOnly)
    // chmod does not revoke Windows directory write permissions (and root can
    // bypass it on Unix). Inject the actual EACCES boundary deterministically.
    permission.refusedPath = readOnly
    const fallback = join(root, 'fallback')
    try {
      expect(resolveDefaultSaveDir(readOnly, fallback)).toBe(fallback)
    } finally {
      permission.refusedPath = ''
    }
  })

  it('throws a descriptive error when the fallback itself is unusable', () => {
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')
    expect(() => resolveDefaultSaveDir(null, blocker)).toThrow(/default save dir not usable/)
  })
})

describe('configuredDefaultSaveDir', () => {
  it('reads the setting from userData/app-settings.json and honors it', () => {
    const userData = join(root, 'userData')
    const documents = join(root, 'Documents')
    mkdirSync(userData, { recursive: true })
    const custom = join(root, 'my-files')
    writeFileSync(join(userData, 'app-settings.json'), JSON.stringify({ defaultSaveDir: custom }))
    const app = {
      getPath: (name: 'userData' | 'documents') => (name === 'userData' ? userData : documents),
    }
    expect(configuredDefaultSaveDir(app)).toBe(custom)
  })

  it('falls back to <Documents>/Vantage without a setting', () => {
    const userData = join(root, 'userData')
    const documents = join(root, 'Documents')
    mkdirSync(userData, { recursive: true })
    const app = {
      getPath: (name: 'userData' | 'documents') => (name === 'userData' ? userData : documents),
    }
    expect(configuredDefaultSaveDir(app)).toBe(join(documents, 'Vantage'))
    expect(existsSync(join(documents, 'Vantage'))).toBe(true)
  })
})
