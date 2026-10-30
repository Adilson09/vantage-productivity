import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
type Resource = { from: string; to: string }
type Config = {
  extraResources: Resource[]
  mac: { extraResources: Resource[] }
  win: { extraResources: Resource[] }
  linux: { extraResources: Resource[] }
  beforePack(context: { electronPlatformName: string }): Promise<void>
}
function load(missing: string) {
  const execute = vi.fn(() => {
    throw new Error('Config metadata must not execute or build tools.')
  })
  const module = { exports: {} as Config }
  runInNewContext(readFileSync(resolve(root, 'electron-builder.cjs'), 'utf8'), {
    module,
    __dirname: root,
    process: { platform: 'linux', arch: 'x64', env: {}, execPath: '/usr/bin/node' },
    require: (id: string) => {
      if (id === 'node:child_process') return { execFileSync: execute }
      if (id === 'node:fs')
        return {
          ...require(id),
          existsSync: (path: string) => !String(path).replaceAll('\\', '/').endsWith(missing),
          realpathSync: (path: string) => path,
        }
      return id === './package.json' ? require(resolve(root, 'package.json')) : require(id)
    },
  })
  return { config: module.exports, execute }
}

describe('mandatory native query resources', () => {
  it('ships the helper on every desktop platform and preserves the Cargo-relative source path', () => {
    const { config, execute } = load('/not-a-real-missing-file')
    for (const platform of ['mac', 'linux', 'win'] as const) {
      expect(
        config[platform].extraResources.some(
          (resource) =>
            resource.to === 'native/vantage-query-worker' + (platform === 'win' ? '.exe' : ''),
        ),
      ).toBe(true)
    }
    expect(config.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'legal/query-worker/src/bin/vantage-query-worker.rs' }),
        expect.objectContaining({ to: 'legal/query-worker/Cargo.toml' }),
        expect.objectContaining({ to: 'legal/query-worker/Cargo.lock' }),
        expect.objectContaining({ to: 'legal/query-worker/NOTICE.txt' }),
        expect.objectContaining({ to: 'legal/query-worker/LICENSE-rusqlite-MIT.txt' }),
      ]),
    )
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(['linux', 'darwin', 'win32'])(
    'refuses a missing %s helper before invoking any packaging tool',
    async (platform) => {
      const suffix = '/vantage-query-worker' + (platform === 'win32' ? '.exe' : '')
      const { config, execute } = load(suffix)
      await expect(config.beforePack({ electronPlatformName: platform })).rejects.toThrow(
        'Required query engine resource missing:',
      )
      expect(execute).not.toHaveBeenCalled()
    },
  )
  it('refuses missing redistribution notice before invoking any packaging tool', async () => {
    const { config, execute } = load('/QUERY-WORKER-NOTICE.txt')
    await expect(config.beforePack({ electronPlatformName: 'linux' })).rejects.toThrow(
      'QUERY-WORKER-NOTICE.txt',
    )
    expect(execute).not.toHaveBeenCalled()
  })
})
