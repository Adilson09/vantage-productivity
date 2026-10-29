// Vantage Productivity addition (2026): launch the bundled, isolated Depesha companion.
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { VantageMailLaunchResult } from '../shared/vantage-api'

export interface MailLocation {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  platform: NodeJS.Platform
}

export function mailExecutablePath(location: MailLocation): string {
  if (location.platform !== 'win32') {
    throw new Error('Vantage Mail is currently included in the Windows version of Vantage Productivity.')
  }
  return location.isPackaged
    ? join(location.resourcesPath, 'mail', 'vantage-mail.exe')
    : join(location.appPath, '..', '..', 'companions', 'depesha-bin', 'vantage-mail.exe')
}

interface MailLaunchDependencies {
  checkFile?: typeof lstat
  start?: (executable: string) => ChildProcess
  startupDelayMs?: number
}

/** No mailbox, recipient, credential or compose arguments cross this boundary. */
export async function openVantageMail(
  location: MailLocation,
  dependencies: MailLaunchDependencies = {},
): Promise<VantageMailLaunchResult> {
  try {
    const executable = mailExecutablePath(location)
    const file = await (dependencies.checkFile ?? lstat)(executable)
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error('The bundled mail client is not a regular application file.')
    }
    return await new Promise<VantageMailLaunchResult>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: VantageMailLaunchResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      let child: ChildProcess
      try {
        child = dependencies.start
          ? dependencies.start(executable)
          : spawn(executable, [], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
              // Keep the companion independent of the Electron command-line mode.
              env: Object.fromEntries(
                Object.entries(process.env).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE'),
              ),
            })
      } catch {
        finish({
          opened: false,
          error: 'Vantage Mail could not start. Please try opening it again.',
        })
        return
      }
      child.once('error', () => {
        finish({
          opened: false,
          error:
            'Vantage Mail could not start. Check that the full Vantage Productivity folder was extracted.',
        })
      })
      child.once('exit', (code, signal) => {
        if (code === 0 && !signal) {
          // A second launch hands focus to the existing companion, then exits.
          finish({ opened: true })
        } else {
          finish({
            opened: false,
            error: 'Vantage Mail closed before opening. Microsoft Edge WebView2 Runtime is required.',
          })
        }
      })
      child.once('spawn', () => {
        child.unref()
        timer = setTimeout(() => finish({ opened: true }), dependencies.startupDelayMs ?? 1200)
      })
    })
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      opened: false,
      error: missing
        ? 'Vantage Mail is missing from this Vantage Productivity folder. Extract the full updated ZIP.'
        : error instanceof Error
          ? error.message
          : 'Vantage Mail is unavailable in this build.',
    }
  }
}
