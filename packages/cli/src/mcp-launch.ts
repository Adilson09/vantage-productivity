// Vantage Productivity modification (2026): target this fork runtime and isolated profile.
/**
 * How an MCP client starts `vantage mcp`. Shared by the app's Settings snippet
 * and `vantage mcp install` so the two cannot drift. Clients spawn without a
 * shell, so on Windows neither vantage.cmd nor `cmd /c` is safe (a path with
 * a space splits); the entry does what vantage.cmd does instead: the app
 * binary as Node on the bundled CLI. Pure string code: the renderer imports it.
 */
export interface McpLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
}

export { MCP_SERVER_NAME, SKILL_NAME } from './integration-identity'

const isWindowsPath = (p: string) => p.includes('\\')

/** The app's snippet: the bare name once vantage is on the PATH, else the launcher itself. */
export function mcpLaunch(cli: {
  status: string
  launcherDir: string
  pathHint?: string
}): McpLaunch {
  const dir = cli.launcherDir
  if (isWindowsPath(dir)) return windowsAppLaunch(dir)
  const onPath = cli.status === 'present' && !cli.pathHint
  return { command: onPath ? 'vantage' : `${dir}/vantage`, args: ['mcp'] }
}

function windowsAppLaunch(dir: string): McpLaunch {
  return {
    command: `${dir}\\..\\..\\Vantage Productivity.exe`,
    args: [`${dir}\\vantage.cjs`, 'mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

export interface LauncherLaunchOptions {
  platform?: string
  /** test seam for the packaged-app probe */
  exists?: (path: string) => boolean
}

/**
 * `mcp install`: always the absolute launcher, never the bare name. On Windows
 * the packaged app is run as Node (same entry as the app's snippet); a checkout
 * has no Vantage Productivity.exe beside it and runs the bundle on the system node, as the
 * bin/vantage script does.
 */
export function mcpLaunchFromLauncher(
  launcher: string,
  opts: LauncherLaunchOptions = {},
): McpLaunch {
  const win = isWindowsPath(launcher) || opts.platform === 'win32'
  if (!win) return { command: launcher, args: ['mcp'] }
  const sep = isWindowsPath(launcher) ? '\\' : '/'
  const dir = launcher.slice(0, Math.max(launcher.lastIndexOf('\\'), launcher.lastIndexOf('/')))
  const exists = opts.exists ?? (() => false)
  if (exists(`${dir}${sep}..${sep}..${sep}Vantage Productivity.exe`)) return windowsAppLaunch(dir)
  const bundle = exists(`${dir}${sep}vantage.cjs`)
    ? `${dir}${sep}vantage.cjs`
    : `${dir}${sep}..${sep}dist${sep}vantage.cjs`
  return { command: 'node', args: [bundle, 'mcp'] }
}
