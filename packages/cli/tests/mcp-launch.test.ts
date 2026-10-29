// Vantage Productivity modification (2026): target this fork runtime and isolated profile.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isVantageLauncher, mcpSnippet, readMcpEntry, writeMcpEntry } from '../src/agent-mcp'
import { mcpLaunch, mcpLaunchFromLauncher, type McpLaunch } from '../src/mcp-launch'
import { tempDir } from './helpers'

const WIN_DIR = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Vantage\\resources\\cli'
const WIN_APP: McpLaunch = {
  command: `${WIN_DIR}\\..\\..\\Vantage Productivity.exe`,
  args: [`${WIN_DIR}\\vantage.cjs`, 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}

describe('mcp launch entry', () => {
  it('is the absolute launcher on macOS and Linux', () => {
    expect(
      mcpLaunchFromLauncher('/Applications/Vantage.app/Contents/Resources/cli/vantage'),
    ).toEqual({
      command: '/Applications/Vantage.app/Contents/Resources/cli/vantage',
      args: ['mcp'],
    })
  })

  it('uses the absolute launcher while the linked dir is still off the PATH (vantage#1019)', () => {
    const launcherDir = '/Applications/Vantage.app/Contents/Resources/cli'
    expect(mcpLaunch({ status: 'present', launcherDir })).toEqual({
      command: 'vantage',
      args: ['mcp'],
    })
    expect(
      mcpLaunch({
        status: 'present',
        launcherDir,
        pathHint: 'export PATH="$HOME/.local/bin:$PATH"',
      }),
    ).toEqual({ command: `${launcherDir}/vantage`, args: ['mcp'] })
  })

  it('runs the packaged Windows app as Node on the bundle, exactly as the app snippet does', () => {
    const exists = (p: string) => p === `${WIN_DIR}\\..\\..\\Vantage Productivity.exe`
    const fromCli = mcpLaunchFromLauncher(`${WIN_DIR}\\vantage.cmd`, { exists })
    expect(fromCli).toEqual(WIN_APP)
    expect(fromCli).toEqual(mcpLaunch({ status: 'missing', launcherDir: WIN_DIR }))
    expect(fromCli).toEqual(mcpLaunch({ status: 'present', launcherDir: WIN_DIR }))
  })

  it('runs a Windows checkout on the system node with the built bundle', () => {
    const dir = 'D:\\src\\vantage\\packages\\cli\\bin'
    expect(mcpLaunchFromLauncher(`${dir}\\vantage`, { exists: () => false })).toEqual({
      command: 'node',
      args: [`${dir}\\..\\dist\\vantage.cjs`, 'mcp'],
    })
    expect(
      mcpLaunchFromLauncher('/mnt/src/packages/cli/bin/vantage', {
        platform: 'win32',
        exists: (p) => p.endsWith('/bin/vantage.cjs'),
      }),
    ).toEqual({ command: 'node', args: ['/mnt/src/packages/cli/bin/vantage.cjs', 'mcp'] })
  })

  it('recognises only the Vantage runtime or a launcher with a real fork marker', () => {
    expect(isVantageLauncher('/opt/Vantage/resources/cli/vantage')).toBe(false)
    expect(isVantageLauncher('C:\\Vantage\\resources\\cli\\vantage.cmd')).toBe(false)
    expect(isVantageLauncher('C:\\Program Files\\Vantage\\Vantage Productivity.exe')).toBe(true)
    expect(isVantageLauncher(WIN_APP.command, WIN_APP.args)).toBe(true)
    expect(isVantageLauncher(join(__dirname, '..', 'bin', 'vantage'))).toBe(true)
    expect(isVantageLauncher('node', ['C:\\src\\packages\\cli\\dist\\vantage.cjs', 'mcp'])).toBe(
      false,
    )
    expect(isVantageLauncher('node', [join(__dirname, '..', 'dist', 'vantage.cjs'), 'mcp'])).toBe(
      true,
    )
    expect(
      isVantageLauncher('C:\\Vantage\\Vantage.exe', [
        'C:\\Vantage\\resources\\cli\\vantage.cjs',
        'mcp',
      ]),
    ).toBe(false)
    expect(isVantageLauncher('npx', ['-y', 'other-mcp'])).toBe(false)
    expect(isVantageLauncher(null)).toBe(false)
  })

  it('carries env in every config format', () => {
    const home = tempDir()
    for (const d of ['.cursor', '.gemini', '.copilot', '.codex', 'opencode'])
      mkdirSync(join(home, d))
    const cursor = join(home, '.cursor', 'mcp.json')
    writeMcpEntry('cursor', cursor, WIN_APP)
    expect(JSON.parse(readFileSync(cursor, 'utf-8')).mcpServers['vantage-productivity']).toEqual({
      type: 'stdio',
      ...WIN_APP,
    })
    const gemini = join(home, '.gemini', 'settings.json')
    writeMcpEntry('gemini', gemini, WIN_APP)
    expect(JSON.parse(readFileSync(gemini, 'utf-8')).mcpServers['vantage-productivity']).toEqual(
      WIN_APP,
    )
    const copilot = join(home, '.copilot', 'mcp-config.json')
    writeMcpEntry('copilot', copilot, WIN_APP)
    expect(JSON.parse(readFileSync(copilot, 'utf-8')).mcpServers['vantage-productivity']).toEqual({
      type: 'local',
      ...WIN_APP,
      tools: ['*'],
    })
    const opencode = join(home, 'opencode', 'opencode.json')
    writeMcpEntry('opencode', opencode, WIN_APP)
    expect(JSON.parse(readFileSync(opencode, 'utf-8')).mcp['vantage-productivity']).toEqual({
      type: 'local',
      command: [WIN_APP.command, ...WIN_APP.args],
      enabled: true,
      environment: WIN_APP.env,
    })
    const codex = join(home, '.codex', 'config.toml')
    writeFileSync(codex, '[mcp_servers.other]\ncommand = "npx"\n')
    writeMcpEntry('codex', codex, WIN_APP)
    expect(readFileSync(codex, 'utf-8')).toBe(
      '[mcp_servers.other]\ncommand = "npx"\n\n' +
        `[mcp_servers.vantage-productivity]\ncommand = ${JSON.stringify(WIN_APP.command)}\nargs = ${JSON.stringify(WIN_APP.args)}\n\n` +
        '[mcp_servers.vantage-productivity.env]\nELECTRON_RUN_AS_NODE = "1"\n',
    )
    for (const [id, file] of [
      ['cursor', cursor],
      ['gemini', gemini],
      ['copilot', copilot],
      ['opencode', opencode],
      ['codex', codex],
    ] as const) {
      expect(readMcpEntry(id, file, WIN_APP).status, id).toBe('registered')
      expect(
        readMcpEntry(id, file, { command: '/elsewhere/cli/vantage', args: ['mcp'] }).status,
        id,
      ).toBe('stale')
    }
    expect(mcpSnippet('codex', WIN_APP)).toContain('[mcp_servers.vantage-productivity.env]')
  })

  it('treats the app snippet entry (Vantage Productivity.exe on vantage.cjs) as ours, not occupied', () => {
    const home = tempDir()
    const file = join(home, 'mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { 'vantage-productivity': WIN_APP } }))
    const posix = { command: '/opt/Vantage/resources/cli/vantage', args: ['mcp'] }
    expect(readMcpEntry('cursor', file, posix)).toEqual({
      status: 'stale',
      command: WIN_APP.command,
    })
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          'vantage-productivity': { command: 'node', args: ['/src/dist/vantage.cjs', 'mcp'] },
        },
      }),
    )
    expect(readMcpEntry('cursor', file, posix).status).toBe('occupied')
    const toml = join(home, 'config.toml')
    writeFileSync(
      toml,
      `[mcp_servers.vantage-productivity]\ncommand = ${JSON.stringify(WIN_APP.command)}\nargs = ${JSON.stringify(WIN_APP.args)}\n[mcp_servers.vantage-productivity.env]\nELECTRON_RUN_AS_NODE = "1"\n`,
    )
    expect(readMcpEntry('codex', toml, posix).status).toBe('stale')
    expect(readMcpEntry('codex', toml, WIN_APP).status).toBe('registered')
  })
})
