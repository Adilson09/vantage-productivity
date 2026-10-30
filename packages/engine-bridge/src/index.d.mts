export interface EngineOptions {
  processEnv?: Record<string, string | undefined>
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
  jarSha256?: string
  launch?: { kind: 'java-jar'; jar: string; sha256: string }
  validation?: { status: string; detail: string }
  version?: string
  reason?: string
  license: string
  url: string
  capabilities: string[]
}
export interface PdfProfileResult {
  id: string
  name: string
  compliant: boolean
  passedRules: number
  failedRules: number
  passedChecks: number
  failedChecks: number
}
export interface PdfConformanceResult {
  complete: boolean
  requestedFlavour: string
  profiles: PdfProfileResult[]
  reason: string
}
export function parseVeraPdfReport(
  result: EngineProcessResult,
  options?: { flavour?: string; expectedPath?: string; expectedBytes?: number },
): { status: 'pass' | 'fail' | 'incomplete'; conformance: PdfConformanceResult; report?: unknown }
export const VERAPDF_PROFILES: ReadonlyArray<string>
export interface EngineProcessResult {
  code: number | null
  stdout: string
  stderr: string
  stopped?: 'cancelled' | 'timeout' | 'output-limit' | 'unavailable'
  cleanup?: {
    status: 'confirmed' | 'pending'
    processClosed: boolean
    temporaryFilesRetained?: true
  }
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
    status: 'incomplete' | 'pass' | 'warning' | 'fail'
    report?: unknown
    conformance?: PdfConformanceResult
    sourceSha256?: string
    sourceUnchanged?: boolean
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
