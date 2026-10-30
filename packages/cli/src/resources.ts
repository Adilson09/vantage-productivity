// Vantage Productivity modification (2026): target this fork runtime and isolated profile.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_NAME } from './integration-identity'

/**
 * Two layouts: packaged (Resources/cli/vantage.cjs next to Resources/wasm,
 * Resources/native, Resources/ocr — see apps/shell/electron-builder.cjs) and
 * the dev checkout (packages/cli/{src,dist} inside the monorepo).
 */
function scriptDir(): string {
  if (typeof __dirname === 'string') return __dirname
  return dirname(fileURLToPath(import.meta.url))
}

let cachedResources: string | null | undefined
export function packagedResourcesDir(): string | null {
  if (cachedResources !== undefined) return cachedResources
  const candidate = resolve(scriptDir(), '..')
  cachedResources = existsSync(join(candidate, 'wasm', 'pdfium.wasm')) ? candidate : null
  return cachedResources
}

let cachedRepo: string | null | undefined
export function repoRoot(): string | null {
  if (cachedRepo !== undefined) return cachedRepo
  let dir = scriptDir()
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        if (
          ['vantage-productivity', 'vantage'].includes(JSON.parse(readFileSync(pkg, 'utf-8')).name)
        ) {
          cachedRepo = dir
          return dir
        }
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  cachedRepo = null
  return null
}

export function pdfiumWasmPath(): string {
  if (process.env.VANTAGE_PDFIUM_WASM) return process.env.VANTAGE_PDFIUM_WASM
  const packaged = packagedResourcesDir()
  if (packaged) return join(packaged, 'wasm', 'pdfium.wasm')
  const root = repoRoot()
  if (root) {
    try {
      return createRequire(join(root, 'package.json')).resolve('@embedpdf/pdfium/pdfium.wasm')
    } catch {}
  }
  throw new Error('pdfium.wasm not found (set VANTAGE_PDFIUM_WASM)')
}

export function xlsxSidecarPath(): string | null {
  if (process.env.XLSX_SIDECAR_PATH) return process.env.XLSX_SIDECAR_PATH
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  const packaged = packagedResourcesDir()
  const candidates = [
    ...(packaged ? [join(packaged, 'native', executable)] : []),
    ...(repoRoot()
      ? [join(repoRoot()!, 'apps/sheets/native/xlsx-engine/target/release', executable)]
      : []),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function ocrHelperPath(): string | null {
  const helper = process.platform === 'darwin' ? 'vision-ocr' : 'win-ocr.exe'
  const packaged = packagedResourcesDir()
  const candidates = [
    ...(packaged ? [join(packaged, 'ocr', helper)] : []),
    ...(repoRoot() ? [join(repoRoot()!, 'packages/pdf2docx/ocr-helper', helper)] : []),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** This fork's skill as shipped beside this bundle or in the checkout. */
export function bundledSkillPath(): string | null {
  const packaged = packagedResourcesDir()
  const candidates = [
    ...(packaged ? [join(packaged, 'cli', 'skills', SKILL_NAME, 'SKILL.md')] : []),
    ...(repoRoot() ? [join(repoRoot()!, 'skills', SKILL_NAME, 'SKILL.md')] : []),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export interface AppLaunch {
  command: string
  args: string[]
}

/** How to start the Vantage GUI: the app binary that hosts this CLI, an installed app, or the dev checkout. */
export function appLaunch(env: NodeJS.ProcessEnv = process.env): AppLaunch | null {
  if (env.VANTAGE_APP_BIN) return { command: env.VANTAGE_APP_BIN, args: [] }
  if (packagedResourcesDir() && process.versions.electron) {
    return { command: process.execPath, args: [] }
  }
  // a checkout drives its own build: an installed app may be older than this CLI
  const root = repoRoot()
  if (root) {
    const electron = devElectronBinary(root)
    if (electron) return { command: electron, args: [join(root, 'apps', 'shell')] }
  }
  const installed = installedAppBinaries(env).find((p) => existsSync(p))
  if (installed) return { command: installed, args: [] }
  return null
}

function installedAppBinaries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  resources: string | null = packagedResourcesDir(),
): string[] {
  const shipped = resources ? appBinaryForResources(resources, platform) : null
  switch (platform) {
    case 'darwin':
      return [
        ...(shipped ? [shipped] : []),
        '/Applications/Vantage Productivity.app/Contents/MacOS/Vantage Productivity',
        join(
          homedir(),
          'Applications/Vantage Productivity.app/Contents/MacOS/Vantage Productivity',
        ),
      ]
    case 'win32':
      return [
        ...(shipped ? [shipped] : []),
        env.LOCALAPPDATA
          ? join(env.LOCALAPPDATA, 'Programs', 'Vantage Productivity', 'Vantage Productivity.exe')
          : '',
        env.ProgramFiles
          ? join(env.ProgramFiles, 'Vantage Productivity', 'Vantage Productivity.exe')
          : '',
      ].filter(Boolean)
    default:
      return [...(shipped ? [shipped] : []), '/opt/Vantage/vantage', '/usr/bin/vantage']
  }
}

export function appBinaryForResources(resources: string, platform: NodeJS.Platform): string {
  const install = dirname(resources)
  if (platform === 'darwin') return join(install, 'MacOS', 'Vantage Productivity')
  if (platform === 'win32') return join(install, 'Vantage Productivity.exe')
  return join(install, 'vantage')
}

/**
 * The real Electron executable of the checkout, not the npm shim in
 * node_modules/.bin: the shim is a Node script that cannot be executed on
 * Windows and that swallows SIGKILL, orphaning the binary it spawned.
 */
function devElectronBinary(root: string): string | null {
  try {
    const resolved = createRequire(join(root, 'package.json'))('electron') as unknown
    return typeof resolved === 'string' && existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}
