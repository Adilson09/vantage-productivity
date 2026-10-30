import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

import { z } from 'zod'
import {
  AtomicSaveError,
  publishCompletedFile,
  withAtomicSaveQueue,
} from '../../../electron-utils/src/atomic-write'
import { withAttestedFilePublication } from '../../../electron-utils/src/file-publication-exclusion'

import { MAX_PATCH_ENTRY_BYTES } from '../shared/edit-schemas'
import type { WorkbookChartEdit, WorkbookVisualEdit } from '../shared/edit-schemas'
import type { SheetFilterState } from './xlsx-filter'
import type { DefinedNamesState } from './xlsx-defined-names'
import type { SheetPageSetupState } from './xlsx-page-setup'
import type { SheetRedactionState } from './xlsx-redaction'
import type {
  CellEdit,
  BulkConstantFill,
  EntrySource,
  MutationPlan,
  PivotRefreshUpdate,
  SheetCfState,
  SheetDvState,
  SheetHyperlinkEdits,
  SheetNoteState,
  SheetProtectedRangesState,
  SheetProtectionState,
  SheetTabColorState,
  SheetPivotAddition,
  SheetSparklineAddition,
  SheetStructuralOps,
  SheetTableAddition,
  SheetTableEdit,
  SheetVisualAddition,
  SheetFormulaValues,
  SheetCellImageAddition,
} from './xlsx-gateway'
import { planCellEditsToXlsx, syncFileBestEffort } from './xlsx-gateway'
import { normalizeOoxmlPartPrefix } from './xlsx-namespace'
import type { WorkbookThemeState } from './xlsx-theme'
import type { SheetEditPlan } from './xlsx-sheets'

const archiveEntrySchema = z.object({
  name: z.string(),
  crc32: z.number(),
  compressedSize: z.number(),
  uncompressedSize: z.number(),
})

export type ArchiveEntry = z.infer<typeof archiveEntrySchema>

const manifestResultSchema = z.object({ entries: z.array(archiveEntrySchema) })
const readEntriesResultSchema = z.object({
  entries: z.array(z.object({ name: z.string(), path: z.string() })),
})
const scanEntriesResultSchema = z.object({ matches: z.array(z.string()) })
const saveArchiveResultSchema = z.object({
  beforeEntries: z.array(archiveEntrySchema),
  afterEntries: z.array(archiveEntrySchema),
})

export interface ArchiveNativeRequestAdmission {
  readonly result: Promise<unknown>
  readonly completion: Promise<unknown>
  readonly actualSettled: Promise<void>
}

/// The subset of XlsxSidecarClient the streaming save path needs; tests can
/// substitute a stub.
export interface ArchiveClient {
  /** Optional for other consumers; the streaming/native I/O path requires it. */
  requestAttested?(
    command: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): ArchiveNativeRequestAdmission
  archiveManifest(path: string): Promise<unknown>
  readEntries(input: {
    readonly path: string
    readonly entries: readonly string[]
    readonly outputDir: string
  }): Promise<unknown>
  scanEntries(input: {
    readonly path: string
    readonly entries: readonly string[]
    readonly needle: string
  }): Promise<unknown>
  saveArchive(input: {
    readonly sourcePath: string
    readonly targetPath: string
    readonly replacements: readonly { name: string; contentPath: string }[]
    readonly removals: readonly string[]
    readonly additions: readonly { name: string; contentPath: string }[]
  }): Promise<unknown>
}

const ARCHIVE_TIMEOUT_MS = 180_000
type ArchiveRequest = NonNullable<ArchiveClient['requestAttested']>

function requireArchiveAttestation(client: ArchiveClient): ArchiveRequest {
  if (typeof client.requestAttested !== 'function')
    throw new Error(
      'Native archive I/O requires definitive request attestation; no legacy dispatch was started.',
    )
  return client.requestAttested.bind(client)
}

/** Owns real requests and extraction tasks, including siblings after a planner rejects early. */
class ArchiveNativeWork {
  readonly mainActualSettled: Promise<void>
  private resolveMainActual!: () => void
  private readonly actual = new Set<Promise<unknown>>()
  private closed = false
  private unattested = false
  constructor(private readonly dispatch: ArchiveRequest) {
    this.mainActualSettled = new Promise<void>((resolve) => {
      this.resolveMainActual = resolve
    })
  }

  private hold<T>(work: Promise<T>): Promise<T> {
    this.actual.add(work)
    void work.then(
      () => this.actual.delete(work),
      () => this.actual.delete(work),
    )
    return work
  }

  track<T>(start: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('The archive operation is no longer admitting work.'))
    return this.hold(start())
  }

  request(command: Readonly<Record<string, unknown>>): ArchiveNativeRequestAdmission {
    if (this.closed) throw new Error('The archive operation is no longer admitting native work.')
    let operation: ArchiveNativeRequestAdmission
    try {
      operation = this.dispatch(command, ARCHIVE_TIMEOUT_MS)
      if (
        !operation ||
        typeof operation.result?.catch !== 'function' ||
        typeof operation.completion?.then !== 'function' ||
        typeof operation.actualSettled?.then !== 'function' ||
        typeof operation.actualSettled?.catch !== 'function'
      )
        throw new Error(
          'The native archive dispatch did not return definitive settlement attestation.',
        )
      void operation.result.catch(() => undefined)
      this.hold(operation.actualSettled)
      void operation.actualSettled.catch(() => {
        this.unattested = true
      })
      return operation
    } catch (error) {
      // Dispatch may have accepted bytes before throwing. No cleanup permission
      // is inferred from its failure; retained staging is safer than deletion.
      this.unattested = true
      throw error
    }
  }

  completed(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.request(command).completion
  }

  async closeAndDrain(): Promise<boolean> {
    this.closed = true
    for (;;) {
      const pending = [...this.actual]
      if (pending.length) await Promise.allSettled(pending)
      await Promise.resolve()
      if (!this.actual.size) return !this.unattested
    }
  }

  /** Called only after the owned JS pipeline's real filesystem finalizers finish. */
  finishMainFinalizers(): void {
    if (this.closed && !this.actual.size && !this.unattested) this.resolveMainActual()
  }
}

export interface StreamingSaveRequest {
  readonly client: ArchiveClient
  readonly sourcePath: string
  readonly targetPath: string
  readonly edits: readonly CellEdit[]
  readonly bulkConstantFills?: readonly BulkConstantFill[] | undefined
  readonly structuralOps?: readonly SheetStructuralOps[] | undefined
  readonly chartEdits?: readonly WorkbookChartEdit[] | undefined
  readonly sheetPlan?: SheetEditPlan | undefined
  readonly filterStates?: readonly SheetFilterState[] | undefined
  readonly hyperlinkEdits?: readonly SheetHyperlinkEdits[] | undefined
  readonly cfStates?: readonly SheetCfState[] | undefined
  readonly dvStates?: readonly SheetDvState[] | undefined
  readonly sheetProtections?: readonly SheetProtectionState[] | undefined
  readonly definedNamesState?: DefinedNamesState | null | undefined
  readonly visualAdditions?: readonly SheetVisualAddition[] | undefined
  readonly pageSetupStates?: readonly SheetPageSetupState[] | undefined
  readonly noteStates?: readonly SheetNoteState[] | undefined
  readonly tableAdditions?: readonly SheetTableAddition[] | undefined
  readonly tableEdits?: readonly SheetTableEdit[] | undefined
  /// Session-created pictures in cells ("Place in Cell").
  readonly cellImageAdditions?: readonly SheetCellImageAddition[] | undefined
  readonly pivotAdditions?: readonly SheetPivotAddition[] | undefined
  readonly pivotCacheRefreshPaths?: readonly string[] | undefined
  readonly pivotRefreshUpdates?: readonly PivotRefreshUpdate[] | undefined
  readonly visualEdits?: readonly WorkbookVisualEdit[] | undefined
  readonly sparklineAdditions?: readonly SheetSparklineAddition[] | undefined
  /// Recalculated formula-cell values written into <v>
  readonly formulaValues?: readonly SheetFormulaValues[] | undefined
  readonly themeState?: WorkbookThemeState | null | undefined
  readonly workbookProtectionState?: { readonly lockStructure: boolean } | null | undefined
  readonly protectedRangeStates?: readonly SheetProtectedRangesState[] | undefined
  readonly tabColorStates?: readonly SheetTabColorState[] | undefined
  /** null/undefined = the caller does not know the marks; the part is left as it is */
  readonly redactionStates?: readonly SheetRedactionState[] | null | undefined
}

export interface StreamingSaveResult {
  readonly touchedEntries: readonly string[]
  readonly removedEntries: readonly string[]
  readonly addedEntries: readonly string[]
}

/// One-shot text read of an archive entry via the sidecar (extract to a
/// temp dir, read, clean up).
export async function readArchiveEntryText(
  client: ArchiveClient,
  sourcePath: string,
  entryName: string,
): Promise<string> {
  const native = new ArchiveNativeWork(requireArchiveAttestation(client))
  const workDir = await mkdtemp(join(tmpdir(), 'ai-excel-read-'))
  try {
    const extracted = readEntriesResultSchema.parse(
      await native.completed({
        command: 'read_entries',
        path: sourcePath,
        entries: [entryName],
        outputDir: workDir,
      }),
    )
    const filePath = extracted.entries[0]?.path
    if (!filePath) throw new Error(`Workbook is missing ${entryName}.`)
    return normalizeOoxmlPartPrefix(readFileSync(filePath, 'utf8'))
  } finally {
    if (await native.closeAndDrain()) await rm(workDir, { recursive: true, force: true })
  }
}

/// Streaming save channel: the gateway plans patched entry contents in
/// memory, the sidecar reassembles the archive on disk — untouched entries
/// are raw-copied compressed bytes, verified afterwards via CRC manifests.
export async function saveWorkbookViaSidecar(
  request: StreamingSaveRequest,
): Promise<StreamingSaveResult> {
  const native = new ArchiveNativeWork(requireArchiveAttestation(request.client))
  const temporaryTarget = join(
    dirname(request.targetPath),
    `${basename(request.targetPath)}.${randomUUID()}.tmp`,
  )
  const start = () => {
    const result = (async () => {
      try {
        return await withAtomicSaveQueue(request.targetPath, () =>
          saveWorkbookViaSidecarQueued(request, native, temporaryTarget),
        )
      } finally {
        if (await native.closeAndDrain()) native.finishMainFinalizers()
      }
    })()
    return { result, actualSettled: native.mainActualSettled }
  }
  return withAttestedFilePublication(
    { targetPath: request.targetPath, sourcePaths: [request.sourcePath] },
    () => {
      // This is the genuine full JS pipeline, not a caller's bounded result. The
      // native temporary target is admitted BEFORE the first pipeline await, so
      // its later native publisher is a continuation during a source/target move.
      try {
        return {
          result: withAttestedFilePublication(
            { targetPath: temporaryTarget, sourcePaths: [request.sourcePath] },
            start,
          ),
          actualSettled: native.mainActualSettled,
        }
      } catch (error) {
        const result = (async (): Promise<StreamingSaveResult> => {
          if (await native.closeAndDrain()) native.finishMainFinalizers()
          throw error
        })()
        return { result, actualSettled: native.mainActualSettled }
      }
    },
  )
}

async function saveWorkbookViaSidecarQueued(
  request: StreamingSaveRequest,
  native: ArchiveNativeWork,
  temporaryTarget: string,
): Promise<StreamingSaveResult> {
  const workDir = await mkdtemp(join(tmpdir(), 'ai-excel-save-'))
  try {
    const manifest = manifestResultSchema.parse(
      await native.completed({ command: 'archive_manifest', path: request.sourcePath }),
    ).entries
    const source = createSidecarEntrySource(native, request.sourcePath, manifest, workDir)
    const plan = await planCellEditsToXlsx(
      source,
      request.edits,
      request.structuralOps ?? [],
      request.chartEdits ?? [],
      request.sheetPlan,
      request.filterStates ?? [],
      request.hyperlinkEdits ?? [],
      request.cfStates ?? [],
      request.dvStates ?? [],
      request.sheetProtections ?? [],
      request.definedNamesState ?? null,
      request.visualAdditions ?? [],
      request.pageSetupStates ?? [],
      request.noteStates ?? [],
      request.tableAdditions ?? [],
      request.pivotAdditions ?? [],
      request.pivotCacheRefreshPaths ?? [],
      request.pivotRefreshUpdates ?? [],
      request.visualEdits ?? [],
      request.sparklineAdditions ?? [],
      request.formulaValues ?? [],
      request.themeState ?? null,
      request.workbookProtectionState ?? null,
      request.protectedRangeStates ?? [],
      request.bulkConstantFills ?? [],
      request.tabColorStates ?? [],
      request.tableEdits ?? [],
      request.cellImageAdditions ?? [],
      request.redactionStates ?? null,
    )

    const replacements = await writePlanContents(workDir, 'replace', plan.replaced)
    const additions = [
      ...(await writePlanContents(workDir, 'add', plan.added)),
      ...(await writePlanContents(workDir, 'add-bin', plan.addedBinary)),
    ]
    const result = saveArchiveResultSchema.parse(
      await withAttestedFilePublication(
        {
          targetPath: temporaryTarget,
          sourcePaths: [
            request.sourcePath,
            ...replacements.map((item) => item.contentPath),
            ...additions.map((item) => item.contentPath),
          ],
        },
        () => {
          const operation = native.request({
            command: 'save_archive',
            sourcePath: request.sourcePath,
            targetPath: temporaryTarget,
            replacements,
            removals: plan.removedEntries,
            additions,
          })
          // The streaming writer intentionally waits for the definitive archive
          // response. A bounded caller timeout cannot release its input files.
          // Own validation, atomic promotion and all main cleanup as well as the
          // native command. A move cannot start in the reply-to-promotion gap.
          return { result: operation.completion, actualSettled: native.mainActualSettled }
        },
      ),
    )

    // The source manifest was read before planning; if the file changed on
    // disk in between, the save's own before-manifest exposes the drift.
    if (!manifestsEqual(manifest, result.beforeEntries)) {
      throw new Error('The workbook changed on disk while saving — aborted.')
    }
    assertManifestPreserved(plan, result.beforeEntries, result.afterEntries)

    await promoteFileAtomically(temporaryTarget, request.targetPath)
    return {
      touchedEntries: plan.touchedEntries,
      removedEntries: plan.removedEntries,
      addedEntries: plan.addedEntries,
    }
  } catch (error: unknown) {
    // A completed rescue file belongs to the user after publication refusal.
    // Only incomplete/invalid archive output is disposable here.
    if ((await native.closeAndDrain()) && !(error instanceof AtomicSaveError))
      await rm(temporaryTarget, { force: true })
    throw error
  } finally {
    if (await native.closeAndDrain()) await rm(workDir, { recursive: true, force: true })
  }
}

function createSidecarEntrySource(
  native: ArchiveNativeWork,
  sourcePath: string,
  manifest: readonly ArchiveEntry[],
  workDir: string,
): EntrySource {
  const entryByName = new Map(manifest.map((entry) => [entry.name, entry]))
  const cache = new Map<string, string>()
  let extractionCount = 0
  return {
    paths: async () => manifest.map((entry) => entry.name),
    has: async (path) => entryByName.has(path),
    canPatch: async (path) =>
      (entryByName.get(path)?.uncompressedSize ?? 0) <= MAX_PATCH_ENTRY_BYTES,
    containsText: async (path, needle) => {
      const scanned = scanEntriesResultSchema.parse(
        await native.completed({
          command: 'scan_entries',
          path: sourcePath,
          entries: [path],
          needle,
        }),
      )
      return scanned.matches.includes(path)
    },
    releaseText: (path) => {
      cache.delete(path)
    },
    readText: (path) =>
      native.track(async () => {
        const cached = cache.get(path)
        if (cached !== undefined) return cached
        const entry = entryByName.get(path)
        if (!entry) throw new Error(`Workbook is missing ${path}.`)
        if (entry.uncompressedSize > MAX_PATCH_ENTRY_BYTES) {
          throw new Error(
            `${path} is ${entry.uncompressedSize} bytes uncompressed — too large to edit. ` +
              'Entries above 500MB can be preserved but not patched.',
          )
        }
        const extractDir = join(workDir, `extract-${extractionCount}`)
        extractionCount += 1
        await mkdir(extractDir, { recursive: true })
        const extracted = readEntriesResultSchema.parse(
          await native.completed({
            command: 'read_entries',
            path: sourcePath,
            entries: [path],
            outputDir: extractDir,
          }),
        )
        const filePath = extracted.entries[0]?.path
        if (!filePath) throw new Error(`Sidecar did not extract ${path}.`)
        const content = normalizeOoxmlPartPrefix(readFileSync(filePath, 'utf8'))
        cache.set(path, content)
        return content
      }),
  }
}

async function writePlanContents(
  workDir: string,
  prefix: string,
  contents: ReadonlyMap<string, string | Uint8Array>,
): Promise<{ name: string; contentPath: string }[]> {
  const written: { name: string; contentPath: string }[] = []
  let index = 0
  for (const [name, content] of contents) {
    const contentPath = join(workDir, `${prefix}-${index}.bin`)
    index += 1
    if (typeof content === 'string') writeUtf8StringChunked(contentPath, content)
    else writeFileSync(contentPath, content)
    written.push({ name, contentPath })
  }
  return written
}

function writeUtf8StringChunked(path: string, content: string): void {
  const descriptor = openSync(path, 'wx')
  try {
    const chunkCharacters = 1024 * 1024
    // One reusable buffer (4 bytes/char upper bound) instead of a fresh
    // Buffer per chunk — a 300MB entry otherwise churns hundreds of MB of
    // external allocations while the GC is already under string pressure.
    const buffer = Buffer.allocUnsafe(4 * chunkCharacters)
    for (let start = 0; start < content.length;) {
      let end = Math.min(content.length, start + chunkCharacters)
      // Do not split a Unicode surrogate pair between independently encoded
      // chunks, or a non-BMP character would be replaced on disk.
      if (end < content.length) {
        const last = content.charCodeAt(end - 1)
        if (last >= 0xd800 && last <= 0xdbff) end -= 1
      }
      const bytes = buffer.write(content.slice(start, end), 0, 'utf8')
      for (let offset = 0; offset < bytes;) {
        const written = writeSync(descriptor, buffer, offset, bytes - offset)
        if (written === 0) throw new Error(`Could not finish writing ${path}.`)
        offset += written
      }
      start = end
    }
  } finally {
    closeSync(descriptor)
  }
}

function manifestsEqual(left: readonly ArchiveEntry[], right: readonly ArchiveEntry[]): boolean {
  if (left.length !== right.length) return false
  const key = (entry: ArchiveEntry): string =>
    `${entry.name}\u0000${entry.crc32}\u0000${entry.compressedSize}\u0000${entry.uncompressedSize}`
  const leftKeys = new Set(left.map(key))
  return right.every((entry) => leftKeys.has(key(entry)))
}

/// Fails closed when the saved archive differs from the source anywhere the
/// plan did not declare: untouched entries must survive byte-preserving raw
/// copy (identical CRC and sizes), removals must vanish, additions must
/// appear, and nothing else may exist.
export function assertManifestPreserved(
  plan: Pick<MutationPlan, 'replaced' | 'added' | 'removedEntries'> &
    Partial<Pick<MutationPlan, 'addedBinary'>>,
  before: readonly ArchiveEntry[],
  after: readonly ArchiveEntry[],
): void {
  const removed = new Set(plan.removedEntries)
  const replaced = new Set(plan.replaced.keys())
  const added = new Set([...plan.added.keys(), ...(plan.addedBinary?.keys() ?? [])])
  const beforeByName = new Map(before.map((entry) => [entry.name, entry]))
  const afterByName = new Map(after.map((entry) => [entry.name, entry]))

  for (const entry of before) {
    const saved = afterByName.get(entry.name)
    if (removed.has(entry.name)) {
      if (saved) throw new Error(`Saving should have removed ${entry.name} but did not — aborted.`)
      continue
    }
    if (!saved) throw new Error(`Saving would drop ${entry.name} — aborted.`)
    if (replaced.has(entry.name)) continue
    if (
      saved.crc32 !== entry.crc32 ||
      saved.compressedSize !== entry.compressedSize ||
      saved.uncompressedSize !== entry.uncompressedSize
    ) {
      throw new Error(`Saving would unexpectedly modify ${entry.name} — aborted.`)
    }
  }
  for (const name of added) {
    if (beforeByName.has(name)) {
      throw new Error(`Saving should have created ${name} but it already existed — aborted.`)
    }
    if (!afterByName.has(name)) {
      throw new Error(`Saving should have created ${name} but did not — aborted.`)
    }
  }
  for (const entry of after) {
    if (!beforeByName.has(entry.name) && !added.has(entry.name)) {
      throw new Error(`Saving would unexpectedly create ${entry.name} — aborted.`)
    }
  }
}

/** Publish completed native archive bytes through the shared non-truncating save contract.
 * A refused replacement retains the completed temporary file and reports its path.
 */
export async function promoteFileAtomically(temporaryPath: string, path: string): Promise<void> {
  return publishCompletedFile(temporaryPath, path)
}
