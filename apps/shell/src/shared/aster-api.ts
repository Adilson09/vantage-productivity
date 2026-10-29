// Aster Office addition: local document checks, recovery history and native mail handoff.
export type AuditStatus = 'pass' | 'warning' | 'fail' | 'info'
export type AuditedFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md' | 'html'

export interface WorkspaceAuditCheck {
  id: string
  title: string
  status: AuditStatus
  detail: string
  count?: number
}

export interface WorkspaceAuditResult {
  fileName: string
  filePath: string
  kind: AuditedFormat
  scannedAt: string
  bytes: number
  checks: WorkspaceAuditCheck[]
  summary: { passed: number; warnings: number; failed: number; informational: number }
  /** A structural check is not a rendering, accessibility or Office-compatibility certification. */
  scope: string
}

export interface RecoveryEntry {
  id: string
  originalPath: string
  fileName: string
  createdAt: string
  bytes: number
  sha256: string
}

export interface AsterMailLaunchResult {
  opened: boolean
  error?: string
}

export interface AsterApi {
  /** Opens the Aster Mail companion in its separate native window. */
  openMail(): Promise<AsterMailLaunchResult>
  inspectFile(): Promise<WorkspaceAuditResult | null>
  recoveryList(): Promise<RecoveryEntry[]>
  /** Opens a Save dialog; the destination must differ from the original. */
  recoveryRestoreCopy(id: string): Promise<string | null>
}

export const ASTER_CHANNELS = {
  openMail: 'aster:open-mail',
  inspectFile: 'aster:inspect-file',
  recoveryList: 'aster:recovery-list',
  recoveryRestoreCopy: 'aster:recovery-restore-copy',
} as const

declare global {
  interface Window {
    aster?: AsterApi
  }
}
