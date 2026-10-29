// Vantage Productivity: side-by-side storage defaults without changing explicit overrides.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vantageCliStateDir } from '../src/vantage-profile'

describe('Vantage CLI storage isolation', () => {
  it('uses the fork directory without reading or writing the upstream directory', () => {
    expect(vantageCliStateDir({})).toBe(join(homedir(), '.vantage-productivity'))
    expect(vantageCliStateDir({ HOME: '/home/test', USERPROFILE: 'C:\\Users\\Test' })).toBe(
      join(
        process.platform === 'win32' ? 'C:\\Users\\Test' : '/home/test',
        '.vantage-productivity',
      ),
    )
  })
  it('preserves an explicit auth-directory override', () => {
    expect(vantageCliStateDir({ VANTAGE_AUTH_DIR: '/custom/legacy-opt-in' })).toBe(
      '/custom/legacy-opt-in',
    )
  })
  it('lets an explicit directory take precedence over the home default', () => {
    expect(
      vantageCliStateDir({
        VANTAGE_AUTH_DIR: '/vantage',
        HOME: '/home/test',
        USERPROFILE: 'C:\\Users\\Test',
      }),
    ).toBe('/vantage')
  })
})
