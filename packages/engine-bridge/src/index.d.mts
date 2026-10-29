export interface EngineOptions {
  processEnv?: Record<string, string>
  paths?: Record<string, string>
  env?: NodeJS.ProcessEnv
  manifestPath?: string
  tempRoot?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  cwd?: string
}
export interface EngineAvailability {
  id: string
  name: string
  available: boolean
  path?: string
  executableSha256?: string
  validation?: { status: string; detail: string }
  version?: string
  reason?: string
  license: string
  url: string
  capabilities: string[]
}
export interface EngineProcessResult {
  code: number | null
  stdout: string
  stderr: string
  stopped?: 'cancelled' | 'timeout' | 'output-limit' | 'unavailable'
}
export const ENGINE_CATALOG: ReadonlyArray<{
  id: string
  name: string
  license: string
  url: string
  commands: string[]
  env: string
  capabilities: string[]
}>
export function discoverEngines(options?: EngineOptions): Promise<EngineAvailability[]>
export function runBounded(
  executable: string,
  args: string[],
  options?: EngineOptions,
): Promise<EngineProcessResult>
export function checkPdf(
  filePath: string,
  options?: EngineOptions & { engine?: 'qpdf' | 'verapdf'; flavour?: string },
): Promise<
  EngineProcessResult & {
    engine: string
    version?: string
    filePath: string
    status: 'incomplete' | 'pass' | 'warning' | 'fail' | 'report'
    report?: unknown
    scope: string
  }
>
export function convertDocument(
  sourcePath: string,
  destinationPath: string,
  options?: EngineOptions,
): Promise<{
  engine: string
  version?: string
  sourcePath: string
  destinationPath: string
  format: string
  bytes: number
  sourceSha256: string
  sha256: string
  scope: string
  diagnostics: string
}>
