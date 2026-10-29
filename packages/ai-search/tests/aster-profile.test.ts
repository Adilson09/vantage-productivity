// Aster Office: side-by-side storage defaults without changing explicit overrides.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { asterCliStateDir } from '../src/aster-profile'

describe('Aster CLI storage isolation', () => {
  it('uses the fork directory without reading or writing the upstream directory', () => {
    expect(asterCliStateDir({})).toBe(join(homedir(), '.aster-office'))
    expect(asterCliStateDir({ HOME: '/home/test', USERPROFILE: 'C:\\Users\\Test' })).toBe(
      join(process.platform === 'win32' ? 'C:\\Users\\Test' : '/home/test', '.aster-office'),
    )
  })
  it('preserves an explicit legacy auth-directory override', () => {
    expect(asterCliStateDir({ GENOFFICE_AUTH_DIR: '/custom/legacy-opt-in' })).toBe(
      '/custom/legacy-opt-in',
    )
  })
  it('lets an explicit Aster directory take precedence', () => {
    expect(asterCliStateDir({ ASTER_AUTH_DIR: '/aster', GENOFFICE_AUTH_DIR: '/legacy' })).toBe(
      '/aster',
    )
  })
})
