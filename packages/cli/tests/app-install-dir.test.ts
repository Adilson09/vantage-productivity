// Vantage Productivity modification (2026): independent app executable expectations.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appBinaryForResources } from '../src/resources'

describe('appBinaryForResources', () => {
  it('finds the app in a custom Windows install directory', () => {
    expect(appBinaryForResources(join('D:\\Apps\\Vantage', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\Vantage', 'Vantage Productivity.exe'),
    )
  })

  it('resolves the same binary for the default Windows install directory', () => {
    const localAppData = 'C:\\Users\\test\\AppData\\Local'
    const resources = join(localAppData, 'Programs', 'Vantage', 'resources')
    expect(appBinaryForResources(resources, 'win32')).toBe(
      join(localAppData, 'Programs', 'Vantage', 'Vantage Productivity.exe'),
    )
  })

  it('finds the app in a custom macOS bundle location', () => {
    expect(
      appBinaryForResources(join('/Volumes/Work/Vantage Productivity.app/Contents/Resources'), 'darwin'),
    ).toBe(join('/Volumes/Work/Vantage Productivity.app/Contents/MacOS/Vantage Productivity'))
  })

  it('finds the app in a custom Linux prefix', () => {
    expect(appBinaryForResources(join('/opt/vantage-custom/resources'), 'linux')).toBe(
      join('/opt/vantage-custom/vantage'),
    )
  })
})
