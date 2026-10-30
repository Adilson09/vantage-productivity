import {
  installMcpReplyQuitGuard,
  type McpQuitApp,
  type McpQuitReport,
  type McpReplyQuitGuard,
} from './mcp-reply-drain'
import { McpServerService, DEFAULT_MCP_PORT, type McpToolDefinition } from './mcp-server'
import { McpLogger } from './mcp-logger'
import type { CliRunner } from './cli-runner'
import { createDocumentTools, documentDriver, type DocsControl } from './tools/document-tools'
import { createPdfTools } from './tools/pdf-tools'
import { createSlidesTools, slidesDriver, type SlidesControl } from './tools/slides-tools'
import { createSheetsTools, sheetsDriver, type SheetsControl } from './tools/sheets-tools'
import {
  createSessionHost,
  createSessionTools,
  type FamilyDriver,
  type TargetResolver,
} from './tools/session-tools'
import { createOpenDocumentTools, type OpenDocumentsControl } from './tools/open-documents-tools'

/**
 * Main-process wiring for the MCP server.
 *
 * Owns the single service instance, reads the enable/port settings, and exposes
 * the small surface the shell's IPC handlers and lifecycle hooks need. Deps are
 * injected (`configureMcpRuntime`) so this module never imports `index.ts`
 * back, and stays testable.
 */

export interface McpRuntimeDeps {
  /** app version reported by get_app_info */
  version: string
  /** default folder for generated files */
  defaultSaveDir: () => string
  /** open a file in the UI (routed to the matching tab) */
  openPath: (filePath: string) => boolean
  /** drive a visible docs editor (live document session); absent in headless runs */
  docsControl?: DocsControl
  /** drive a visible slides deck (main-process session); absent in headless runs */
  slidesControl?: SlidesControl
  /** drive a visible sheets grid (renderer workbook session); absent in headless runs */
  sheetsControl?: SheetsControl
  /** the bundled vantage CLI, backing the headless create/read tools; absent when unavailable */
  cliRunner?: CliRunner
  /**
   * documents the user has open (list/read/close); absent in headless runs,
   * where there is no tab manager to ask
   */
  openDocumentsControl?: OpenDocumentsControl
  /**
   * resolves a `document` argument (tab id or path) to the webContents of that
   * open tab, so the content tools can edit what the user is looking at instead
   * of only the session's own blank tab; absent in headless runs, which drops
   * the argument from the tool schemas
   */
  resolveTarget?: TargetResolver
  /** where the MCP log file lives (userData); logging is unavailable without it */
  logFilePath?: string
}

export interface McpSettings {
  enabled: boolean
  port: number
  /** headless create_docx (no UI) is exposed to clients; default off */
  background: boolean
  /** server/tool activity is written to the log file; default off */
  logging: boolean
}

export interface McpStatus {
  running: boolean
  enabled: boolean
  port: number
  background: boolean
  logging: boolean
  url: string | null
  /** capability families the current build exposes (settings pane rows) */
  capabilities: string[]
}

let deps: McpRuntimeDeps | null = null
let service: McpServerService | null = null
const ownedServices = new Set<McpServerService>()
let configurationEpoch = 0
let reconciliation: Promise<unknown> = Promise.resolve()
let quitGuard: McpReplyQuitGuard | undefined
let terminalEpoch = 0,
  terminalStopping = false
function pruneOwned(instance: McpServerService): void {
  if (instance !== service && !instance.isRunning() && !instance.replyDrainStatus().owned)
    ownedServices.delete(instance)
}
function serializeMcp<Result>(action: () => Promise<Result>): Promise<Result> {
  const next = reconciliation.catch(() => {}).then(action)
  reconciliation = next.then(
    () => {},
    () => {},
  )
  return next
}
export function installMcpQuitGuard(
  app: McpQuitApp,
  options: {
    onQuitDeferred?: (report: McpQuitReport) => void
    onQuitBlocked: (report: McpQuitReport) => void
    onQuitInterrupted?: (report: McpQuitReport, reason: string) => void
  },
): void {
  quitGuard ??= installMcpReplyQuitGuard(app, {
    services: () => [...ownedServices],
    epoch: () => configurationEpoch,
    onQuitDeferred: options.onQuitDeferred,
    onQuitBlocked: options.onQuitBlocked,
    onQuitInterrupted: options.onQuitInterrupted,
  })
}
/** User return or any canceled outer close cancels the old quit intent without releasing actual handlers. */
export function cancelMcpQuitDrain(): void {
  configurationEpoch++
  quitGuard?.cancel()
  if (!quitGuard) for (const instance of ownedServices) instance.cancelQuitDrain()
}
export function mcpReplyDrainStatus() {
  return [...ownedServices].map((instance) => instance.replyDrainStatus())
}
let logger: McpLogger | null = null
let currentSettings: McpSettings = {
  enabled: false,
  port: DEFAULT_MCP_PORT,
  background: false,
  logging: false,
}

export function configureMcpRuntime(runtimeDeps: McpRuntimeDeps): void {
  deps = runtimeDeps
  logger = runtimeDeps.logFilePath ? new McpLogger(runtimeDeps.logFilePath) : null
}

/** drops a line into the log ring + file when logging is on; no-op otherwise */
function mcpLogger(message: string): void {
  if (!currentSettings.logging) return
  logger?.append(message)
}

/** the configured log file path, when logging is available at all */
export function mcpLogFilePath(): string | null {
  return deps?.logFilePath ?? null
}

/** recent log lines for the settings pane */
export function getMcpRecentLogs(): string[] {
  return logger?.recent() ?? []
}

export function clearMcpLogs(): void {
  logger?.clear()
}

/** reveal the log file in the file manager; creates it when missing */
export function revealMcpLogFile(): void {
  logger?.ensureFile()
}

function buildTools(): McpToolDefinition[] {
  if (!deps) throw new Error('MCP runtime not configured')
  // get_app_info advertises what the registered tool families can generate
  const extraFormats = [
    ...(deps.slidesControl ? ['pptx'] : []),
    ...(deps.sheetsControl ? ['xlsx'] : []),
  ]
  // one session host per tool set: create_session / save_session drive whichever
  // family is active, and each family's content tools address that same tab.
  // buildTools runs once per client session (see the server's toolsFactory), so
  // each connected client gets its own active session rather than sharing one.
  const host = createSessionHost()
  const drivers: FamilyDriver[] = [
    ...(deps.docsControl ? [documentDriver(deps.docsControl)] : []),
    ...(deps.slidesControl ? [slidesDriver(deps.slidesControl)] : []),
    ...(deps.sheetsControl ? [sheetsDriver(deps.sheetsControl)] : []),
  ]
  const cli = deps.cliRunner
  return [
    // the session entry point first: an agent picking a tool sees create_session
    ...createSessionTools(drivers, host),
    ...createDocumentTools(
      {
        version: deps.version,
        defaultSaveDir: deps.defaultSaveDir,
        // headless create_docx is opt-in: off by default so the default surface is
        // the visible document session
        background: currentSettings.background,
        // open_in_vantage reports ok only when the file routed to a tab
        openInTab: (filePath) => {
          if (!deps) return
          const opened = deps.openPath(filePath)
          if (!opened) throw new Error(`could not open ${filePath} in Vantage`)
        },
        docs: deps.docsControl,
        extraFormats,
        ...(cli ? { cli } : {}),
        ...(deps.resolveTarget ? { resolveTarget: deps.resolveTarget } : {}),
      },
      host,
    ),
    ...createSlidesTools(
      {
        defaultSaveDir: deps.defaultSaveDir,
        background: currentSettings.background,
        slides: deps.slidesControl,
        ...(cli ? { cli } : {}),
        ...(deps.resolveTarget ? { resolveTarget: deps.resolveTarget } : {}),
      },
      host,
    ),
    ...createSheetsTools(
      {
        defaultSaveDir: deps.defaultSaveDir,
        background: currentSettings.background,
        sheets: deps.sheetsControl,
        ...(cli ? { cli } : {}),
        ...(deps.resolveTarget ? { resolveTarget: deps.resolveTarget } : {}),
      },
      host,
    ),
    // headless, session-free read access (read_pdf); registered whenever the
    // pdf workspace is bundled in, which the shell always does
    ...createPdfTools(),
    // documents the user has open, independent of the session above
    ...createOpenDocumentTools({
      defaultSaveDir: deps.defaultSaveDir,
      ...(deps.openDocumentsControl ? { control: deps.openDocumentsControl } : {}),
    }),
  ]
}

function assertStarting(epoch: number): void {
  if (terminalStopping || epoch !== terminalEpoch)
    throw new Error('MCP terminal shutdown canceled pending settings/start work.')
}
async function startOwned(instance: McpServerService, port: number, epoch: number): Promise<void> {
  assertStarting(epoch)
  quitGuard?.ownershipChanged()
  await instance.start(port)
  if (terminalStopping || epoch !== terminalEpoch) {
    instance.stopSync()
    throw new Error('MCP terminal shutdown canceled this started service.')
  }
  quitGuard?.ownershipChanged()
}
function ensureService(): McpServerService {
  assertStarting(terminalEpoch)
  if (!deps) throw new Error('MCP runtime not configured')
  if (!service) {
    if (ownedServices.size >= 8)
      throw new Error(
        'Earlier MCP services still own pending tool work; no replacement service was started.',
      )
    const created = new McpServerService({
      port: currentSettings.port,
      // built per client session so concurrent clients do not share one
      // active editing session; the factory re-reads settings at connect time
      toolsFactory: buildTools,
      logger: mcpLogger,
      version: deps.version,
      onReplyStateChanged: () => pruneOwned(created),
    })
    service = created
    ownedServices.add(created)
    quitGuard?.ownershipChanged()
  }
  return service
}

/** Start the server if settings say it should be on. Safe to call at boot. */
export async function startMcpFromSettings(settings: McpSettings): Promise<void> {
  const epoch = terminalEpoch
  await serializeMcp(async () => {
    assertStarting(epoch)
    currentSettings = normalize(settings)
    if (currentSettings.enabled) await startOwned(ensureService(), currentSettings.port, epoch)
  })
}

/**
 * Apply a settings change: persist semantics are the caller's job (index.ts
 * writes app-settings.json); here we reconcile the running server with the new
 * values — start, stop, or restart when the port or the exposed tool set changes.
 */
export function applyMcpSettings(settings: McpSettings): Promise<McpStatus> {
  const epoch = terminalEpoch
  cancelMcpQuitDrain()
  return serializeMcp(() => {
    assertStarting(epoch)
    return reconcileMcpSettings(settings, epoch)
  })
}
async function reconcileMcpSettings(settings: McpSettings, epoch: number): Promise<McpStatus> {
  assertStarting(epoch)
  const next = normalize(settings)
  const wasRunning = service?.isRunning() ?? false
  // both comparisons read the OLD settings: they must happen before currentSettings is overwritten
  const portChanged = next.port !== currentSettings.port
  const backgroundChanged = next.background !== currentSettings.background
  currentSettings = next

  if (!next.enabled) {
    await service?.stop()
    return mcpStatus()
  }
  // a background flip changes the exposed tool list, so live sessions must be
  // dropped and rebuilt — same treatment as a port change
  if (!wasRunning) {
    await startOwned(ensureService(), next.port, epoch)
  } else if (portChanged || backgroundChanged) {
    const retiring = service
    await retiring?.stop()
    assertStarting(epoch)
    if (service === retiring) service = null
    if (retiring) pruneOwned(retiring)
    await startOwned(ensureService(), next.port, epoch)
  }
  return mcpStatus()
}

export async function stopMcp(): Promise<void> {
  cancelMcpQuitDrain()
  await serializeMcp(async () => {
    await Promise.allSettled([...ownedServices].map((instance) => instance.stop()))
    for (const instance of ownedServices) pruneOwned(instance)
  })
}

/** Terminal teardown belongs in will-quit, after every before-quit ownership guard. */
export function stopMcpSync(): void {
  terminalStopping = true
  terminalEpoch++
  for (const instance of ownedServices) instance.stopSync()
}

export function mcpStatus(): McpStatus {
  const running = service?.isRunning() ?? false
  return {
    running,
    enabled: currentSettings.enabled,
    port: currentSettings.port,
    background: currentSettings.background,
    logging: currentSettings.logging,
    url: running ? service!.getUrl() : null,
    capabilities: [
      'docs',
      ...(deps?.slidesControl ? ['slides'] : []),
      ...(deps?.sheetsControl ? ['sheets'] : []),
      // read_pdf is headless and always registered, so the family is always
      // visible (read-only until the pdf editor is driven)
      'pdf',
    ],
  }
}

function normalize(settings: McpSettings): McpSettings {
  const port =
    Number.isInteger(settings.port) && settings.port > 0 && settings.port < 65536
      ? settings.port
      : DEFAULT_MCP_PORT
  return {
    enabled: settings.enabled === true,
    port,
    background: settings.background === true,
    logging: settings.logging === true,
  }
}
