import { readFileSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.0.0' } }))

import { isEphemeralInstall, launcherFilePath, writeLauncherFile } from '../src/main/cli-link'

describe('Vantage launcher file', () => {
  it('lives in the fork auth directory, with explicit overrides preserved', () => {
    expect(launcherFilePath({})).toBe(join(homedir(), '.vantage-productivity', 'launcher'))
    expect(launcherFilePath({ VANTAGE_AUTH_DIR: '/tmp/x' })).toBe(join('/tmp/x', 'launcher'))
    expect(launcherFilePath({ VANTAGE_AUTH_DIR: '/tmp/vantage' })).toBe(join('/tmp/vantage', 'launcher'))
  })

  it('writes one line, creates the directory, and only rewrites on change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vantage-launcher-'))
    const file = join(dir, 'nested', 'launcher')
    expect(writeLauncherFile(file, '/Applications/Vantage.app/Contents/Resources/cli')).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('/Applications/Vantage.app/Contents/Resources/cli\n')
    const before = statSync(file).mtimeMs
    expect(writeLauncherFile(file, '/Applications/Vantage.app/Contents/Resources/cli')).toBe(
      false,
    )
    expect(statSync(file).mtimeMs).toBe(before)
    expect(writeLauncherFile(file, 'C:\\Programs\\Vantage\\resources\\vantage')).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('C:\\Programs\\Vantage\\resources\\vantage\n')
  })

  it('treats dmg and AppImage mounts as temporary', () => {
    expect(isEphemeralInstall('/Volumes/Vantage/Vantage.app/Contents/Resources', {})).toBe(true)
    expect(isEphemeralInstall('/tmp/.mount_GenOfxyz/resources', {})).toBe(true)
    expect(isEphemeralInstall('/opt/Vantage/resources', { APPIMAGE: '/home/u/G.AppImage' })).toBe(
      true,
    )
    expect(isEphemeralInstall('/Applications/Vantage.app/Contents/Resources', {})).toBe(false)
  })
})
