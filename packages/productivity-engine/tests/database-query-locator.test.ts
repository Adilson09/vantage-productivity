import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveQueryWorkerPath } from '../src/database-isolated'

const scratch: string[] = []
const initialResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const executable =
  process.platform === 'win32' ? 'vantage-query-worker.exe' : 'vantage-query-worker'
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'vantage-native-locator-'))
  scratch.push(path)
  return path
}
afterEach(() => {
  vi.unstubAllEnvs()
  if (initialResources) Object.defineProperty(process, 'resourcesPath', initialResources)
  else delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  for (const path of scratch.splice(0)) {
    if (
      !resolve(path).startsWith(resolve(tmpdir()) + '/vantage-native-locator-') &&
      !resolve(path).startsWith(resolve(tmpdir()) + '\\vantage-native-locator-')
    )
      throw new Error('Unsafe temporary directory.')
    rmSync(path, { recursive: true, force: true })
  }
})
describe('fixed native query helper locations', () => {
  it('uses the Electron packaged native resource before development artifacts', () => {
    vi.stubEnv('VANTAGE_QUERY_WORKER_PATH', '')
    const resources = directory()
    mkdirSync(join(resources, 'native'))
    const helper = join(resources, 'native', executable)
    writeFileSync(helper, 'locator-only fixture; never executed')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources })
    expect(resolveQueryWorkerPath()).toBe(realpathSync(helper))
  })
  it('honors the configured Cargo target directory and target triple for development', () => {
    vi.stubEnv('VANTAGE_QUERY_WORKER_PATH', '')
    const target = directory()
    const triple =
      process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu'
    vi.stubEnv('CARGO_TARGET_DIR', target)
    vi.stubEnv('CARGO_BUILD_TARGET', triple)
    const release = join(target, triple, 'release')
    mkdirSync(release, { recursive: true })
    const helper = join(release, executable)
    writeFileSync(helper, 'locator-only fixture; never executed')
    expect(resolveQueryWorkerPath()).toBe(realpathSync(helper))
  })
})
