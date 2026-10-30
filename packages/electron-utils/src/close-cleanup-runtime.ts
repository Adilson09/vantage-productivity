import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  CloseCleanupQueue,
  type CloseCleanupCapturedEntry,
  type CloseCleanupFilter,
  type CloseCleanupHandle,
  type CloseCleanupAdmission,
  type CloseCleanupRetirementAdmission,
  type CloseCleanupRetirementActivity,
  type CloseCleanupLineage,
  type CloseCleanupStatus,
  type CloseCleanupTask,
} from './close-cleanup'
import {
  captureDraftJournalCustody,
  restoreDraftCustodyCopy,
  type DraftEntry,
} from './draft-journal'
import {
  registeredCloseCustodyProvider,
  copyCloseCustodyReceipt,
  type CloseCustodyJson,
  type CloseCustodyProvider,
} from './close-custody-providers'
export { registerCloseCustodyProvider } from './close-custody-providers'
export interface CloseCleanupQuitApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
  whenReady(): Promise<unknown>
}
export interface CloseCleanupRuntimeOptions {
  app: CloseCleanupQuitApp
  userDataRoot: string
  warning(status: CloseCleanupStatus): void
  timeoutMs?: number
  restoreIoTimeoutMs?: number
  restoreHandoffTimeoutMs?: number
}
export interface PreparedCloseCleanupRestore {
  destination: string
  status: CloseCleanupStatus
  entry: DraftEntry
  sha256: string
  commitHandoff(action: () => boolean): boolean
  cancel(reason?: string): void
}
export interface PreparedProviderCloseCleanupRestore {
  destination: string
  status: CloseCleanupStatus
  binding: CloseCleanupCapturedEntry
  receipt?: { [key: string]: CloseCustodyJson }
  commitHandoff(action: () => boolean): boolean
  cancel(reason?: string): void
}
const ID = /^[a-zA-Z0-9:._-]{1,240}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA = /^[a-f0-9]{64}$/
const MAX_RECORDS = 128,
  MAX_PENDING_STATUS_FILES = 256,
  MAX_STATUS_BYTES = 16 * 1024
const JOURNAL_LIMITS = {
  maxEntryBytes: 17 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 128,
}
const canonical = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const samePath = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : canonical(a) === canonical(b)
const key = (id: string) => createHash('sha256').update(id).digest('hex')
const phases = new Set([
  'preparing',
  'staged',
  'committing',
  'running',
  'complete',
  'retained',
  'canceled',
  'purging',
  'purged',
])
const unresolved = new Set(['preparing', 'publishing', 'pending-handoff', 'uncertain'])
interface Runtime {
  root: string
  queue: CloseCleanupQueue
  stage(task: CloseCleanupTask): Promise<CloseCleanupHandle>
  begin(task: CloseCleanupTask): CloseCleanupAdmission
  warning(status: CloseCleanupStatus): void
  providerRoot(status: CloseCleanupStatus): string
  cancelQuitDrain(): void
}
const scope = globalThis as typeof globalThis & { __vantageCloseCleanupRuntime?: Runtime }
function required() {
  if (!scope.__vantageCloseCleanupRuntime)
    throw new Error('Recovery close cleanup is not configured.')
  return scope.__vantageCloseCleanupRuntime
}
function validPath(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && isAbsolute(value) && value.length <= 4096)
}
function validBinding(value: unknown): value is CloseCleanupCapturedEntry {
  const b = value as CloseCleanupCapturedEntry | null
  return !!b && /^[a-z]{2,20}$/.test(b.module) && validPath(b.documentPath) && SHA.test(b.sha256)
}
function validate(value: unknown): value is CloseCleanupStatus {
  const s = value as CloseCleanupStatus | null
  if (
    !s ||
    !ID.test(s.id) ||
    typeof s.module !== 'string' ||
    !/^[a-z]{2,20}$/.test(s.module) ||
    typeof s.ownerKey !== 'string' ||
    s.ownerKey.length > 256 ||
    typeof s.source !== 'string' ||
    !s.source ||
    s.source.length > 1024 ||
    !Number.isSafeInteger(s.generation) ||
    s.generation < 0 ||
    !UUID.test(s.token) ||
    !validPath(s.documentPath) ||
    !phases.has(s.phase) ||
    typeof s.custody !== 'boolean' ||
    !Number.isFinite(Date.parse(s.updatedAt)) ||
    (s.error !== undefined && (typeof s.error !== 'string' || s.error.length > 4096))
  )
    return false
  if (s.capturedEntry && (!validBinding(s.capturedEntry) || s.capturedEntry.module !== s.module))
    return false
  if (s.custodyProvider !== undefined && !/^[a-z][a-z0-9-]{1,40}$/.test(s.custodyProvider))
    return false
  const r = s.restoration
  return (
    !r ||
    (UUID.test(r.id) &&
      typeof r.destination === 'string' &&
      isAbsolute(r.destination) &&
      r.destination.length <= 4096 &&
      [
        'preparing',
        'publishing',
        'pending-handoff',
        'handed-off',
        'canceled',
        'uncertain',
      ].includes(r.phase) &&
      typeof r.created === 'boolean' &&
      (r.publicationAttempted === undefined || typeof r.publicationAttempted === 'boolean'))
  )
}
function readStatus(path: string): CloseCleanupStatus {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATUS_BYTES)
    throw new Error('Cleanup status exceeds its inspection limit.')
  const fd = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(MAX_STATUS_BYTES + 1)
    let length = 0
    for (;;) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
      if (length > MAX_STATUS_BYTES) throw new Error('Cleanup status grew beyond its limit.')
    }
    const status: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    if (!validate(status)) throw new Error('Invalid cleanup custody status.')
    return status
  } finally {
    closeSync(fd)
  }
}
function owned(root: string, path: string): void {
  if (!canonical(path).startsWith(canonical(root) + sep))
    throw new Error('Cleanup custody escaped its private root.')
}
/** Missing children never terminate an otherwise successful quota inventory. */
async function directorySize(path: string, maximum: number): Promise<number> {
  let size = 0,
    entries = 0
  const visit = async (dir: string): Promise<void> => {
    let items: string[]
    try {
      items = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      throw error
    }
    for (const name of items) {
      if (++entries > 4096) throw new Error('Custody exceeds its inventory entry limit.')
      const file = join(dir, name)
      const info = await lstat(file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw error
      })
      if (!info) continue
      if (info.isSymbolicLink()) throw new Error('Custody cannot contain symbolic links.')
      if (info.isDirectory()) await visit(file)
      else if (info.isFile()) {
        size += info.size
        if (size > maximum) throw new Error('Custody exceeds its provider quota.')
      }
    }
  }
  await visit(path)
  return size
}
function providerId(status: Pick<CloseCleanupStatus, 'custodyProvider'>) {
  return status.custodyProvider ?? 'draft-journal'
}
function nativeProvider(id: string): CloseCustodyProvider {
  const provider = registeredCloseCustodyProvider(id)
  if (!provider)
    throw new Error(
      `The main-owned custody provider ${id} is unavailable; its primary authority is retained.`,
    )
  return provider
}

/** One profile/main singleton. Terminal process teardown must run after all quit guards. */
export function registerCloseCleanupRuntime(options: CloseCleanupRuntimeOptions): void {
  for (const budget of [options.restoreIoTimeoutMs, options.restoreHandoffTimeoutMs])
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1 || budget > 120_000))
      throw new Error('Invalid main-owned restoration budget.')
  if (!isAbsolute(options.userDataRoot))
    throw new Error('Cleanup requires an absolute user-data root.')
  const root = resolve(options.userDataRoot),
    previous = scope.__vantageCloseCleanupRuntime
  if (previous) {
    if (canonical(previous.root) !== canonical(root))
      throw new Error('Cleanup already owns another profile.')
    previous.warning = options.warning
    return
  }
  const area = join(root, 'close-cleanup'),
    statuses = join(area, 'status'),
    journal = join(area, 'custody'),
    providers = join(area, 'providers')
  for (const dir of [statuses, journal, providers]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const dir of [area, statuses, journal, providers])
    if (lstatSync(dir).isSymbolicLink())
      throw new Error('Custody cannot use linked internal directories.')
  const statusNames = () =>
    readdirSync(statuses).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
  const persist = (status: CloseCleanupStatus) => {
    const normalized = {
      ...status,
      ...(status.error ? { error: status.error.slice(0, 4096) } : {}),
    }
    if (!validate(normalized)) throw new Error('Invalid cleanup lineage/status.')
    const path = join(statuses, `${key(status.id)}.json`)
    if (!existsSync(path) && statusNames().length >= MAX_RECORDS)
      throw new Error('Recovery status needs bounded completed-record maintenance.')
    if (
      readdirSync(statuses).filter((name) =>
        /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36})?\.pending$/.test(name),
      ).length >= MAX_PENDING_STATUS_FILES
    )
      throw new Error(
        'Interrupted status files reached their review limit; ambiguous files are retained.',
      )
    const data = Buffer.from(JSON.stringify(normalized))
    if (data.length > MAX_STATUS_BYTES)
      throw new Error('Cleanup status exceeds its bounded record size.')
    const temp = path + `.${randomUUID()}.pending`
    owned(statuses, path)
    owned(statuses, temp)
    let fd: number | undefined,
      created = false
    try {
      fd = openSync(temp, 'wx', 0o600)
      created = true
      writeFileSync(fd, data)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temp, path)
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (created && existsSync(temp)) unlinkSync(temp)
    }
  }
  const recovered: CloseCleanupStatus[] = []
  if (statusNames().length > MAX_RECORDS)
    throw new Error(
      'Cleanup status inventory exceeds its bound; retained recovery requires review.',
    )
  for (const name of statusNames()) {
    const status = readStatus(join(statuses, name))
    if (key(status.id) + '.json' !== name)
      throw new Error('Cleanup identity does not match its record.')
    const pending = ['preparing', 'staged', 'committing', 'running', 'purging'].includes(
        status.phase,
      ),
      restore = status.restoration && unresolved.has(status.restoration.phase)
    let safe: CloseCleanupStatus =
      pending || restore
        ? {
            ...status,
            phase: 'retained',
            ...(restore
              ? { restoration: { ...status.restoration!, phase: 'uncertain' as const } }
              : {}),
            error: restore
              ? `A prior restoration may have produced a separate output needing review: ${status.restoration!.destination}`
              : 'The previous session ended before cleanup completed; protected custody/primary authority is retained.',
          }
        : status
    if (pending || restore)
      try {
        persist(safe)
      } catch (error) {
        safe = {
          ...safe,
          error:
            `Earlier cleanup intent remains durable; its status could not be updated: ${String(error)}`.slice(
              0,
              4096,
            ),
        }
      }
    recovered.push(safe)
  }
  const locks = new Map<string, Promise<unknown>>()
  const withProvider = <Result>(id: string, action: () => Promise<Result>): Promise<Result> => {
    const prior = locks.get(id) ?? Promise.resolve(),
      work = prior.catch(() => {}).then(action)
    locks.set(id, work)
    return work.finally(() => {
      if (locks.get(id) === work) locks.delete(id)
    })
  }
  const baseFor = (id: string) => (id === 'draft-journal' ? journal : join(providers, id))
  const pathFor = (status: CloseCleanupStatus) => {
    const base = baseFor(providerId(status)),
      target = join(base, key(status.id))
    owned(base, target)
    return target
  }
  let runtime!: Runtime, queue!: CloseCleanupQueue
  const purge = (status: CloseCleanupStatus) =>
    withProvider(providerId(status), async () => {
      const id = providerId(status),
        target = pathFor(status),
        info = await lstat(target).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
          throw error
        })
      if (!info) return
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Invalid custody directory.')
      if (id === 'draft-journal') await rm(target, { recursive: true, force: false })
      else {
        const provider = nativeProvider(id),
          signal = new AbortController().signal
        if (status.custody) {
          if (!provider.validateReceipt(status.custodyReceipt))
            throw new Error('Native custody receipt no longer validates.')
          await provider.purge({
            status,
            targetRoot: target,
            receipt: status.custodyReceipt,
            signal,
          })
        } else {
          if (!provider.purgePartial)
            throw new Error(
              'Unverified partial native custody is retained until its registered checked ownership cleanup is available.',
            )
          await provider.purgePartial({ status, targetRoot: target, signal })
        }
      }
    })
  class ProviderSpaceNeeded extends Error {
    constructor(readonly bytes: number) {
      super('The measured captured snapshot needs provider admission space.')
    }
  }
  interface MaintenanceNeed {
    slots?: number
    provider?: { id: string; maxTotalBytes: number; maxEntries: number; entryBytes: number }
  }
  let maintenance: Promise<unknown> = Promise.resolve()
  const maintain = (need: MaintenanceNeed): Promise<void> => {
    const work = maintenance
      .catch(() => {})
      .then(async () => {
        const stillNeeded = async () => {
          if (need.slots && statusNames().length + need.slots > MAX_RECORDS) return true
          if (need.provider) {
            const p = need.provider,
              base = baseFor(p.id)
            if ((await directorySize(base, p.maxTotalBytes)) > p.maxTotalBytes - p.entryBytes)
              return true
            if (
              (await readdir(base, { withFileTypes: true })).filter((item) => item.isDirectory())
                .length >= p.maxEntries
            )
              return true
          }
          return false
        }
        if (!(await stillNeeded())) return
        for (const name of statusNames()) {
          const status = readStatus(join(statuses, name))
          if (
            !['complete', 'purged'].includes(status.phase) ||
            (status.restoration && unresolved.has(status.restoration.phase))
          )
            continue
          const needsSlot = !!need.slots && statusNames().length + need.slots > MAX_RECORDS
          if (!needsSlot && need.provider && providerId(status) !== need.provider.id) continue
          try {
            if (status.phase !== 'purged')
              await queue.retire(
                { module: status.module, ids: [status.id] },
                'Completed automatic custody maintenance for the next admission.',
              )
            if (queue.forgetCompleted(status.id)) unlinkSync(join(statuses, name))
          } catch {
            /* Retained/unresolved copies are never erased just to admit new work. */
          }
          // Admission needs one slot/snapshot, not a sweep of every successful record.
          if (!(await stillNeeded())) return
        }
        if (await stillNeeded())
          throw new Error(
            'Retained or unresolved custody is full; review existing copies before closing more drafts.',
          )
      })
    maintenance = work
    return work
  }
  queue = new CloseCleanupQueue({
    timeoutMs: options.timeoutMs,
    restoreIoTimeoutMs: options.restoreIoTimeoutMs,
    restoreHandoffTimeoutMs: options.restoreHandoffTimeoutMs,
    preparationTimeoutMs: (task) =>
      task.custody.provider && task.custody.provider !== 'draft-journal'
        ? (registeredCloseCustodyProvider(task.custody.provider)?.captureTimeoutMs ??
          options.timeoutMs ??
          5_000)
        : (options.timeoutMs ?? 5_000),
    persist,
    recovered,
    sameDocument: samePath,
    maintenanceAdmission: async () => maintain({ slots: 1 }),
    warning: (status) => runtime.warning(status),
    prepare: async (task, signal) => {
      const id = task.custody.provider ?? 'draft-journal',
        provider = id === 'draft-journal' ? undefined : nativeProvider(id),
        limits = { ...(provider?.limits ?? JOURNAL_LIMITS) }
      const base = baseFor(id)
      mkdirSync(base, { recursive: true, mode: 0o700 })
      if (lstatSync(base).isSymbolicLink())
        throw new Error('Linked provider custody roots are refused.')
      // Capture measures one complete snapshot before reserve() admits any write.
      // If needed, leave the provider lock, free only that measured headroom and
      // retry once. A genuinely absent journal needs no snapshot quota at all.
      const capture = () =>
        withProvider(id, async () => {
          signal.throwIfAborted()
          const total = await directorySize(base, limits.maxTotalBytes),
            count = (await readdir(base, { withFileTypes: true })).filter((item) =>
              item.isDirectory(),
            ).length
          let reserved = 0
          const reserve = (bytes: number) => {
            if (reserved) throw new Error('Reserve one complete consistent snapshot charge.')
            if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limits.maxEntryBytes)
              throw new Error('The captured snapshot exceeds its provider admission quota.')
            if (total + bytes > limits.maxTotalBytes || count >= limits.maxEntries)
              throw new ProviderSpaceNeeded(bytes)
            reserved = bytes
          }
          const target = join(base, key(task.id))
          owned(base, target)
          if (
            await lstat(target).then(
              () => true,
              (error: unknown) => {
                if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
                throw error
              },
            )
          )
            throw new Error('The custody destination already exists; existing bytes are retained.')
          if (provider) {
            const capture = await provider.capture({ task, targetRoot: target, signal, reserve })
            if (!capture) return false
            const bytes = capture.bytes,
              binding = { ...capture.binding },
              receipt = copyCloseCustodyReceipt(capture.receipt)
            if (
              !reserved ||
              !Number.isSafeInteger(bytes) ||
              bytes < 1 ||
              bytes > reserved ||
              (await directorySize(target, limits.maxEntryBytes)) > bytes ||
              !validBinding(binding) ||
              binding.module !== task.module ||
              !provider.validateReceipt(receipt)
            )
              throw new Error(
                'Native custody did not provide a validated main-owned bounded receipt.',
              )
            return { capturedEntry: binding, provider: id, receipt }
          }
          if (
            typeof task.custody.recoveryRoot !== 'string' ||
            task.custody.draftId !== task.token ||
            canonical(task.custody.recoveryRoot) !== canonical(join(root, 'recovery'))
          )
            throw new Error('Journal custody must use the captured UUID in this profile vault.')
          const attestation = task.custody.attest?.(),
            expected = attestation
              ? {
                  module: task.module,
                  documentPath: attestation.expectedDocumentPath,
                  sha256: attestation.expectedSha256,
                }
              : task.custody.attest
                ? null
                : { module: task.module, documentPath: task.documentPath }
          const capture = await captureDraftJournalCustody(
            task.custody.recoveryRoot,
            task.token,
            target,
            signal,
            expected,
            reserve,
          )
          if (!capture) return false
          return {
            capturedEntry: {
              module: capture.module,
              documentPath: capture.documentPath,
              sha256: capture.sha256,
            },
            provider: 'draft-journal',
            receipt: {
              bytes: capture.bytes,
              metadataSha256: capture.metadataSha256,
              payloadSha256: capture.payloadSha256,
            },
          }
        })
      try {
        return await capture()
      } catch (error) {
        if (!(error instanceof ProviderSpaceNeeded)) throw error
        signal.throwIfAborted()
        await maintain({
          provider: {
            id,
            maxTotalBytes: limits.maxTotalBytes,
            maxEntries: limits.maxEntries,
            entryBytes: error.bytes,
          },
        })
        signal.throwIfAborted()
        return capture()
      }
    },
    purge,
  })
  let quitEpoch = 0,
    activeQuit: { epoch: number; revision: number } | undefined,
    resumingQuit:
      { epoch: number; revision: number; event?: { preventDefault(): void } } | undefined
  const cancelQuitDrain = () => {
    quitEpoch++
    activeQuit = undefined
    // A later synchronous before-quit listener can cancel this actual retry,
    // even after our listener already observed it. No work is marked settled.
    resumingQuit?.event?.preventDefault()
  }
  runtime = {
    root,
    queue,
    stage: (task) => queue.stage(task),
    begin: (task) => queue.begin(task),
    warning: options.warning,
    providerRoot: pathFor,
    cancelQuitDrain,
  }
  scope.__vantageCloseCleanupRuntime = runtime
  options.app.on('before-quit', (event) => {
    if (resumingQuit) {
      resumingQuit.event = event
      if (resumingQuit.epoch !== quitEpoch) {
        event.preventDefault()
        return
      }
      // A later listener may register another actual owner during the retry.
      // Join that new work rather than borrowing the old bounded-drain permission.
      if (resumingQuit.revision === queue.activityRevision() || !queue.hasPending()) return
      resumingQuit = undefined
    }
    if (!queue.hasPending()) return
    event.preventDefault()
    if (activeQuit?.epoch === quitEpoch) return
    const attempt = { epoch: quitEpoch, revision: queue.activityRevision() }
    activeQuit = attempt
    void queue
      .drain()
      .catch((error) =>
        console.error('[recovery cleanup] durable intent retained after drain failure:', error),
      )
      .finally(() => {
        if (activeQuit !== attempt || quitEpoch !== attempt.epoch) return
        activeQuit = undefined
        const resumed = { epoch: attempt.epoch, revision: attempt.revision }
        resumingQuit = resumed
        try {
          options.app.quit()
        } finally {
          if (resumingQuit === resumed) resumingQuit = undefined
        }
      })
  })
  void options.app.whenReady().then(() => {
    for (const status of recovered) if (status.phase === 'retained') runtime.warning({ ...status })
  })
}
export function beginCloseCleanup(task: CloseCleanupTask): CloseCleanupAdmission {
  return required().begin(task)
}
export function stageCloseCleanup(task: CloseCleanupTask): Promise<CloseCleanupHandle> {
  return required().stage(task)
}
/** Main-owned lineage only. Failure propagates if durable admission is unavailable. */
export function recordCloseCleanupFailure(
  lineage: CloseCleanupLineage,
  error: string,
): CloseCleanupStatus {
  if (
    !validate({
      ...lineage,
      phase: 'retained',
      updatedAt: new Date().toISOString(),
      custody: false,
      error: error.slice(0, 4096),
    })
  )
    throw new Error('Invalid owned cleanup failure lineage.')
  return required().queue.recordFailure(lineage, error)
}
export function getCloseCleanupStatus(id: string): CloseCleanupStatus | undefined {
  return required().queue.status(id)
}
export function awaitCloseCleanup(id: string): Promise<CloseCleanupStatus | undefined> {
  return required().queue.outcome(id)
}
export function queryCloseCleanupCustody(filter: CloseCleanupFilter): CloseCleanupStatus[] {
  return required().queue.query(filter)
}
export function beginRetireCloseCleanupCustody(
  filter: CloseCleanupFilter,
  reason: string,
): CloseCleanupRetirementAdmission {
  return required().queue.beginRetirement(filter, reason)
}
export function getCloseCleanupRetirementActivity(id: string): CloseCleanupRetirementActivity {
  return required().queue.retirementActivity(id)
}
export function retireCloseCleanupCustody(
  filter: CloseCleanupFilter,
  reason: string,
): Promise<void> {
  return required().queue.retire(filter, reason)
}
/** Common user Return/later-family veto invalidates only quit intention, never actual I/O ownership. */
export function cancelCloseCleanupQuitDrain(): void {
  scope.__vantageCloseCleanupRuntime?.cancelQuitDrain()
}
function restoreDestination(runtime: Runtime, destination: string): string {
  if (
    !isAbsolute(destination) ||
    canonical(destination) === canonical(runtime.root) ||
    canonical(destination).startsWith(canonical(runtime.root) + sep)
  )
    throw new Error('Restore a separate user-owned output outside private engine storage.')
  const physicalRoot = realpathSync.native(runtime.root),
    physicalParent = realpathSync.native(dirname(resolve(destination)))
  if (
    canonical(physicalParent) === canonical(physicalRoot) ||
    canonical(physicalParent).startsWith(canonical(physicalRoot) + sep)
  )
    throw new Error('Restore a separate user-owned output outside private engine storage.')
  return join(physicalParent, basename(resolve(destination)))
}
function verifyPhysicalDestination(runtime: Runtime, destination: string): void {
  if (canonical(restoreDestination(runtime, destination)) !== canonical(destination))
    throw new Error(
      'The verified restoration parent changed before publication; no trusted handoff was granted.',
    )
}
/** Held through read/decrypt/exclusive publication AND the final synchronous owner handoff. */
export async function prepareCloseCleanupRestore(
  id: string,
  destination: string,
): Promise<PreparedCloseCleanupRestore> {
  const runtime = required(),
    status = runtime.queue.status(id),
    target = restoreDestination(runtime, destination)
  if (!status || providerId(status) !== 'draft-journal' || !status.capturedEntry)
    throw new Error('That journal custody has no verified stored binding.')
  const reservation = runtime.queue.reserveRestore(id, target, randomUUID())
  const restored = await reservation.run(() =>
    restoreDraftCustodyCopy(
      runtime.providerRoot(status),
      join(runtime.root, 'recovery'),
      status.token,
      target,
      {
        expected: status.capturedEntry!,
        signal: reservation.signal,
        beforePublication: () => {
          verifyPhysicalDestination(runtime, target)
          reservation.beforePublication()
        },
        created: () => reservation.created(),
      },
    ),
  )
  return {
    destination: target,
    status: reservation.status(),
    entry: Object.freeze({ ...restored.entry }),
    sha256: restored.sha256,
    commitHandoff: (action) => reservation.commitHandoff(action),
    cancel: (reason) => reservation.cancel(reason),
  }
}
export async function prepareProviderCloseCleanupRestore(
  id: string,
  destination: string,
): Promise<PreparedProviderCloseCleanupRestore> {
  const runtime = required(),
    status = runtime.queue.status(id),
    target = restoreDestination(runtime, destination)
  if (!status || !status.capturedEntry || providerId(status) === 'draft-journal')
    throw new Error('That native custody has no verified provider binding.')
  const expected = Object.freeze({ ...status.capturedEntry })
  const context = Object.freeze({
    ...status,
    capturedEntry: Object.freeze({ ...expected }),
    ...(status.custodyReceipt
      ? { custodyReceipt: copyCloseCustodyReceipt(status.custodyReceipt) }
      : {}),
    ...(status.restoration ? { restoration: Object.freeze({ ...status.restoration }) } : {}),
  })
  const provider = nativeProvider(providerId(status))
  if (!provider.restore || !provider.validateReceipt(context.custodyReceipt))
    throw new Error('That native custody has no registered verified restore route.')
  const reservation = runtime.queue.reserveRestore(id, target, randomUUID(), {
    ioTimeoutMs: provider.restoreIoTimeoutMs,
  })
  const restored = await reservation.run(() =>
    provider.restore!({
      status: context,
      targetRoot: runtime.providerRoot(status),
      receipt: context.custodyReceipt,
      destination: target,
      signal: reservation.signal,
      beforePublication: () => {
        verifyPhysicalDestination(runtime, target)
        reservation.beforePublication()
      },
      created: () => reservation.created(),
    }),
  )
  try {
    const binding = Object.freeze({ ...restored.binding }),
      current = reservation.status().capturedEntry
    const same = (actual: CloseCleanupCapturedEntry | undefined) =>
      !!actual &&
      actual.module === expected.module &&
      samePath(actual.documentPath, expected.documentPath) &&
      actual.sha256 === expected.sha256
    if (!validBinding(binding) || !same(binding) || !same(current))
      throw new Error('Native restored custody failed its captured binding check.')
    const receipt = restored.receipt ? copyCloseCustodyReceipt(restored.receipt) : undefined
    return {
      destination: target,
      status: reservation.status(),
      binding,
      receipt,
      commitHandoff: (action) => reservation.commitHandoff(action),
      cancel: (reason) => reservation.cancel(reason),
    }
  } catch (error) {
    reservation.cancel('Native restoration no longer matches its independently captured proof.')
    throw error
  }
}
/** Explicit manual-file restore; awaited editor-opening routes must use the held API above. */
export async function restoreCloseCleanupCustody(
  id: string,
  destination: string,
): Promise<{ destination: string; status: CloseCleanupStatus; entry: DraftEntry; sha256: string }> {
  const prepared = await prepareCloseCleanupRestore(id, destination)
  if (!prepared.commitHandoff(() => true))
    throw new Error(
      'The output remains visible for review; its source retired before manual handoff.',
    )
  return {
    destination: prepared.destination,
    status: getCloseCleanupStatus(id) ?? prepared.status,
    entry: prepared.entry,
    sha256: prepared.sha256,
  }
}

/** Explicit Root review only: keeps the visible user file and clears no destination path. */
export function acknowledgeCloseCleanupRestoreArtifact(id: string, restoreId: string): void {
  required().queue.acknowledgeRestoreArtifact(id, restoreId)
}
