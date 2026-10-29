// Vantage Productivity addition: local document checks, recovery history and native mail handoff.
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

export interface VantageMailLaunchResult {
  opened: boolean
  error?: string
}

export interface VantageApi {
  onSaveWarning(listener: (message: string) => void): () => void
  draftList(): Promise<DraftPreview[]>
  restoreDraft(id: string): Promise<string | null>
  discardDraft(id: string): Promise<void>
  exportRecoveryBackup(password: string): Promise<string | null>
  inspectRecoveryBackup(
    password: string,
  ): Promise<{ createdAt: string; entries: RecoveryEntry[] } | null>
  restoreBackupCopy(password: string, id: string): Promise<string | null>
  saveCalendarEvent(event: {
    summary: string
    start: string
    end: string
    location: string
  }): Promise<string | null>
  engineeringStatus(): Promise<EngineeringStatus>
  updateNetworkPolicy(value: unknown): Promise<EngineeringStatus['networkPolicy']>
  convertDocument(): Promise<{
    destinationPath: string
    sourceSha256: string
    sha256: string
    scope: string
  } | null>
  checkSpecialistPdf(engine: 'qpdf' | 'verapdf'): Promise<{
    engine: string
    status: string
    stdout: string
    stderr: string
    scope: string
  } | null>
  importCalendar(): Promise<CalendarPreview | null>
  importContacts(): Promise<ContactPreview | null>
  openDatabase(create: boolean): Promise<DatabasePreview | null>
  queryDatabase(sql: string): Promise<DatabaseQueryResult>
  createDatabaseTable(
    name: string,
    columns: { name: string; type: 'TEXT' | 'INTEGER' | 'REAL' }[],
  ): Promise<DatabasePreview>
  insertDatabaseRows(table: string, rows: Record<string, unknown>[]): Promise<DatabasePreview>
  recoveryStatus(): Promise<RecoveryStatus>
  updateRecoveryPolicy(value: Record<string, number>): Promise<RecoveryStatus>
  setRecoveryEncryption(): Promise<RecoveryStatus>
  /** Opens the Vantage Mail companion in its separate native window. */
  openMail(): Promise<VantageMailLaunchResult>
  inspectFile(): Promise<WorkspaceAuditResult | null>
  cancelInspection(): Promise<void>
  recoveryList(): Promise<RecoveryEntry[]>
  /** Opens a Save dialog; the destination must differ from the original. */
  recoveryRestoreCopy(id: string): Promise<string | null>
}

export const VANTAGE_CHANNELS = {
  saveWarning: 'vantage:save-warning',
  draftList: 'vantage:draft-list',
  restoreDraft: 'vantage:restore-draft',
  discardDraft: 'vantage:discard-draft',
  exportRecoveryBackup: 'vantage:export-recovery-backup',
  inspectRecoveryBackup: 'vantage:inspect-recovery-backup',
  restoreBackupCopy: 'vantage:restore-backup-copy',
  saveCalendarEvent: 'vantage:save-calendar-event',
  engineeringStatus: 'vantage:engineering-status',
  updateNetworkPolicy: 'vantage:update-network-policy',
  convertDocument: 'vantage:convert-document',
  checkSpecialistPdf: 'vantage:check-specialist-pdf',
  importCalendar: 'vantage:import-calendar',
  importContacts: 'vantage:import-contacts',
  openDatabase: 'vantage:open-database',
  queryDatabase: 'vantage:query-database',
  createDatabaseTable: 'vantage:create-database-table',
  insertDatabaseRows: 'vantage:insert-database-rows',
  recoveryStatus: 'vantage:recovery-status',
  updateRecoveryPolicy: 'vantage:update-recovery-policy',
  setRecoveryEncryption: 'vantage:set-recovery-encryption',
  openMail: 'vantage:open-mail',
  inspectFile: 'vantage:inspect-file',
  cancelInspection: 'vantage:cancel-inspection',
  recoveryList: 'vantage:recovery-list',
  recoveryRestoreCopy: 'vantage:recovery-restore-copy',
} as const

export interface EngineeringStatus {
  version: string
  runtime: { node: string; electron: string; platform: string }
  networkPolicy: import('../../../../packages/electron-utils/src/network-policy').NetworkPolicy
  engines: {
    id: string
    name: string
    available: boolean
    path?: string
    version?: string
    reason?: string
    validation?: { status: string; detail: string }
    license: string
  }[]
  metrics: { processes: number; workingSetKiB: number; cpuPercent: number }
}
export interface CalendarPreview {
  fileName: string
  occurrences: {
    uid: string
    summary: string
    start: string
    end: string
    timeZone: string
    allDay: boolean
    location: string
  }[]
  warnings: string[]
}
export interface ContactPreview {
  fileName: string
  contacts: {
    uid: string
    name: string
    emails: string[]
    phones: string[]
    organization: string
  }[]
  warnings: string[]
}
export interface DatabasePreview {
  path: string
  tables: { name: string; columns: { name: string; type: string }[] }[]
}
export interface DatabaseQueryResult {
  columns: string[]
  rows: Record<string, string | number | boolean | null>[]
  truncated: boolean
}
export interface RecoveryStatus {
  policy: {
    maxVaultBytes: number
    maxEntries: number
    maxRevisionsPerFile: number
    minFreeBytes: number
    [key: string]: unknown
  }
  entries: number
  payloadBytes: number
  occupiedBytes: number
  orphanBytes: number
  availableBytes: number | null
  encryptionEnabled: boolean
  plaintextEntries: number
}
export interface DraftPreview {
  id: string
  module: string
  documentPath: string | null
  extension: string
  updatedAt: string
  bytes: number
  encrypted: boolean
}

declare global {
  interface Window {
    vantage?: VantageApi
  }
}
