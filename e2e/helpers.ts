// Vantage Productivity modification (2026): keep test profiles and command-tool state in scratch directories.
/**
 * Shared launcher for Electron E2E tests.
 *
 * Each test boots the built shell (`apps/shell/out`) against a scratch
 * userData dir (via VANTAGE_USER_DATA) so runs never touch real settings
 * and never collide with a running install's single-instance lock.
 * Build first: `npm run build:all`.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { observeChildClose, runBoundedCleanup, type ChildCloseObservation } from './cleanup-harness'

export const SHELL_DIR = resolve(__dirname, '../apps/shell')
export const ARTIFACTS_DIR = resolve(__dirname, 'artifacts')

const SHELL_MAIN = join(SHELL_DIR, 'out/main/index.js')

interface LaunchOptions {
  /** reuse a previous scratch dir to simulate a second launch */
  userDataDir?: string
  /** UI language override (VANTAGE_LANG); defaults to English for stable assertions */
  lang?: string
  /** pre-seed app-settings.json with onboardingSeen=true to start at the home screen */
  onboardingSeen?: boolean
  /** extra app-settings.json keys (e.g. defaultSaveDir) written before launch */
  settings?: Record<string, unknown>
  /** subdir of e2e/artifacts to store this launch's video in */
  videoDir: string
  /** Disable optional recording for crash/restart or recorder-independent shutdown checks. */
  recordVideo?: boolean
  /** absolute document path passed as argv, opened in an editor tab on launch */
  openFile?: string
  /** extra environment variables for the launched app */
  env?: Record<string, string>
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
  closeObservation: ChildCloseObservation
}

export async function launchShell(options: LaunchOptions): Promise<LaunchedApp> {
  if (!existsSync(SHELL_MAIN)) {
    throw new Error(`Missing build output at ${SHELL_MAIN} — run \`npm run build:all\` first`)
  }
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'vantage-e2e-')))
  const safeDefaults = options.userDataDir
    ? {}
    : { defaultSaveDir: join(userDataDir, 'test-documents') }
  if (!options.userDataDir) await mkdir(join(userDataDir, 'test-documents'), { recursive: true })
  if (options.onboardingSeen || options.settings || !options.userDataDir) {
    await writeFile(
      join(userDataDir, 'app-settings.json'),
      JSON.stringify({
        ...safeDefaults,
        ...(options.onboardingSeen ? { onboardingSeen: true } : {}),
        ...options.settings,
      }),
    )
  }
  const require = createRequire(join(SHELL_DIR, 'package.json'))
  const executablePath = require('electron') as unknown as string
  // ELECTRON_RUN_AS_NODE (set by VS Code/CI hosts) would boot Electron as
  // plain Node with no windows — strip it so the app always starts as an app
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...hostEnv } = process.env
  // Linux CI runners restrict unprivileged user namespaces (no usable SUID
  // sandbox) and run under xvfb without GPU — without these the window opens
  // but the renderer never loads. The suite drives trusted local builds only.
  // Switches go before the app path so Chromium is guaranteed to consume them
  // and they never leak into the argv the app parses for documents to open.
  const args: string[] = []
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu')
  args.push(SHELL_DIR)
  if (options.openFile) args.push(options.openFile)
  const app = await electron.launch({
    executablePath,
    args,
    env: {
      ...hostEnv,
      VANTAGE_USER_DATA: userDataDir,
      VANTAGE_AUTH_DIR: join(userDataDir, 'cli'),
      VANTAGE_NO_SPARE_VIEW: '1',
      VANTAGE_LANG: options.lang ?? 'en',
      ...(options.env ?? {}),
      ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
    },
    // Playwright's Electron screencast wedges the page CDP session on Linux
    // (page.url() stays empty, no lifecycle events, evaluate hangs) — record
    // only where it works
    recordVideo:
      process.platform === 'linux' || options.recordVideo === false
        ? undefined
        : {
            dir: join(ARTIFACTS_DIR, options.videoDir),
            size: { width: 1280, height: 800 },
          },
  })
  const closeObservation = observeChildClose(app.process())
  await app.firstWindow()
  const page = await waitForPageWithUrl(app, '/shell/out/')
  const startupErrors: string[] = []
  page.on('pageerror', (error) => startupErrors.push(error.message))
  page.on('crash', () => startupErrors.push('The workspace renderer crashed.'))
  await waitForDocumentReady(app, page)
  if (options.onboardingSeen && !options.openFile && !options.userDataDir) {
    try {
      await page.locator('.vantage-create-grid').waitFor({ state: 'visible', timeout: 30_000 })
    } catch {
      throw new Error(`Workspace did not become ready at ${page.url()}. ${startupErrors.join(' ')}`)
    }
  }
  return { app, page, userDataDir, closeObservation }
}

/**
 * Playwright can attach to the Electron window mid-navigation and miss the
 * load lifecycle events entirely (Linux timing) — waitForLoadState then hangs
 * on a page that is actually loaded. Polling through evaluate uses the live
 * CDP session instead of the missed events.
 */
async function waitForDocumentReady(
  app: ElectronApplication,
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // the pre-navigation about:blank document also reports readyState complete
    const ready = await page
      .evaluate(() =>
        document.readyState !== 'loading' && window.location.href !== 'about:blank'
          ? document.readyState
          : null,
      )
      .catch(() => null)
    if (ready) return
    await new Promise((r) => setTimeout(r, 100))
  }
  // process list tells renderer-spawn failures apart from slow loads
  const diag = await app
    .evaluate(({ app: electronApp, BrowserWindow }) => ({
      processes: electronApp.getAppMetrics().map((m) => m.type),
      contents: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
    }))
    .catch((e) => String(e))
  throw new Error(`Shell window never loaded (url: ${page.url()}, diag: ${JSON.stringify(diag)})`)
}

/**
 * Close the app and return the recorded video path for the given page.
 *
 * Open editor tabs trigger a native Save/Don't Save/Cancel dialog on close,
 * which would block app.close() forever — stub the dialog to answer
 * "Don't Save" (button index 1) so shutdown stays unattended. If close still
 * hangs, bound each RPC/video phase and force-kill only the test-owned process.
 * A soft cleanup failure preserves an assertion already unwinding through finally.
 */
export async function closeAndSaveVideo(
  launched: LaunchedApp,
  name: string,
): Promise<string | undefined> {
  const video = launched.page.video()
  const target = join(ARTIFACTS_DIR, 'videos', `${name}.webm`)
  const receipt = await runBoundedCleanup({
    child: launched.closeObservation.child,
    closeObservation: launched.closeObservation,
    evaluate: () =>
      launched.app.evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({
          response: 1,
          checkboxChecked: false,
        })) as typeof dialog.showMessageBox
      }),
    close: () => launched.app.close(),
    ...(video
      ? {
          saveVideo: async () => {
            await video.saveAs(target)
            return target
          },
        }
      : {}),
  })
  let attachmentTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      test.info().attach(`cleanup-${name}`, {
        body: JSON.stringify(receipt, null, 2),
        contentType: 'application/json',
      }),
      new Promise<never>((_, reject) => {
        attachmentTimer = setTimeout(
          () => reject(new Error('Cleanup receipt attachment timed out.')),
          5_000,
        )
      }),
    ])
  } catch (error) {
    receipt.failures.push(`Cleanup receipt attachment failed: ${String(error).slice(0, 2_000)}`)
    console.warn(`[cleanup:${name}] ${JSON.stringify(receipt)}`)
  } finally {
    clearTimeout(attachmentTimer)
  }
  if (receipt.video.status === 'omitted') console.warn(`[cleanup:${name}] ${receipt.video.reason}`)
  expect.soft(receipt.failures, `App cleanup failed; see cleanup-${name} attachment.`).toEqual([])
  return receipt.video.path
}

export function screenshotPath(name: string): string {
  return join(ARTIFACTS_DIR, 'screenshots', `${name}.png`)
}

/**
 * Wait for a page whose URL contains `urlPart` (e.g. an editor WebContentsView).
 * Checks windows that already exist before listening, so it never races the
 * view being created between launch and the first waitForEvent call.
 */
export async function waitForPageWithUrl(
  app: ElectronApplication,
  urlPart: string,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const candidate of app.windows()) {
      if (candidate.url().includes(urlPart)) return candidate
      // page.url() stays empty when attach raced navigation; ask the document
      const href = await candidate.evaluate(() => window.location.href).catch(() => '')
      if (href.includes(urlPart)) return candidate
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`No window with URL containing "${urlPart}"`)
    await app.waitForEvent('window', { timeout: Math.min(remaining, 1_000) }).catch(() => {})
  }
}
