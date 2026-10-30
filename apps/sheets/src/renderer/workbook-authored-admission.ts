import {
  createAuthoredCell,
  type AuthoredCell,
} from '../../../../packages/electron-utils/src/authored-cell'
import type { CloseMutationBarrier } from '../../../../packages/electron-utils/src/renderer-close-barrier'

export interface WorkbookAuthoredAdmissionOptions {
  readonly barrier: CloseMutationBarrier
  source(): string
  /** Only app-owned load/calculation scopes; never trust a caller's fromFormula flag. */
  isDerived(): boolean
  report(error: unknown): void
  changed?(): void
}

export class WorkbookAuthoredDeferredError extends Error {
  readonly code = 'WORKBOOK_AUTHORED_DEFERRED'
  constructor(readonly completion: Promise<unknown>) {
    super('This authored operation is deferred until main revokes the exact close permission.')
    this.name = 'WorkbookAuthoredDeferredError'
  }
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Pre-commit revision admission and real producer lifetime; rendering is not the authority. */
export class WorkbookAuthoredAdmission {
  private depth = 0
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly options: WorkbookAuthoredAdmissionOptions) {}

  captureSource(): string {
    const source = this.options.source()
    if (!source)
      throw new Error('An authored workbook operation requires its accepted source epoch.')
    return source
  }

  get busy(): boolean {
    return this.pending.size !== 0 || this.options.barrier.busy
  }
  get locked(): boolean {
    return this.options.barrier.locked
  }
  get derived(): boolean {
    return this.options.isDerived()
  }

  private assertSource(source: string): void {
    if (source !== this.captureSource())
      throw new Error(
        'The accepted workbook source changed before its authored operation could commit.',
      )
  }

  private observe<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    this.changed()
    void work.then(
      () => {
        this.pending.delete(work)
        this.changed()
      },
      (error) => {
        this.pending.delete(work)
        this.options.report(error)
        this.changed()
      },
    )
    return work
  }

  private changed(): void {
    try {
      this.options.changed?.()
    } catch (error) {
      try {
        this.options.report(error)
      } catch {
        /* Notification is never authority. */
      }
    }
  }

  private invoke<T>(action: () => T, source: string): T | Promise<T> {
    this.assertSource(source)
    if (this.depth > 0 || this.derived) return action()
    return this.options.barrier.runMutationWork(() => {
      this.assertSource(source)
      let value!: T
      // The synchronous stamp advances BEFORE any journal, metadata or model write.
      const admitted = this.options.barrier.mutate(() => {
        this.assertSource(source)
        this.depth++
        try {
          value = action()
        } finally {
          this.depth--
        }
      }, source)
      if (!admitted)
        throw new Error('A close lease appeared inside a synchronous authored reservation.')
      return value
    }, source)
  }

  /**
   * Synchronous callers never receive fabricated return values. If held, the
   * complete captured action is preserved and completion is exposed explicitly.
   * Command adapters translate only this typed deferred result to legacy false.
   */
  commit<T>(action: () => T, source = this.captureSource(), captureReplay?: () => () => T): T {
    this.assertSource(source)
    const selected =
      this.locked && !this.derived && this.depth === 0 ? (captureReplay?.() ?? action) : action
    const value = this.invoke(selected, source)
    if (promiseLike(value)) {
      const completion = this.observe(Promise.resolve(value))
      throw new WorkbookAuthoredDeferredError(completion)
    }
    this.changed()
    return value
  }

  /** Void authored-cell setters preserve their accepted action without a fake sync result. */
  submit(action: () => void, source = this.captureSource()): boolean {
    try {
      this.commit(action, source)
      return true
    } catch (error) {
      if (error instanceof WorkbookAuthoredDeferredError) return false
      throw error
    }
  }

  runAsync<T>(action: () => Promise<T> | T, source = this.captureSource()): Promise<T> {
    try {
      const result = this.invoke(action, source)
      return this.observe(Promise.resolve(result))
    } catch (error) {
      return this.observe(Promise.reject(error))
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size !== 0) await Promise.allSettled([...this.pending])
  }
}

export function createWorkbookAuthoredAdmission(
  options: WorkbookAuthoredAdmissionOptions,
): WorkbookAuthoredAdmission {
  return new WorkbookAuthoredAdmission(options)
}

export function createWorkbookAuthoredStorage<T>(
  initial: T,
  admission: WorkbookAuthoredAdmission,
  source = admission.captureSource(),
): AuthoredCell<T> {
  return createAuthoredCell(initial, (action) => admission.submit(action, source))
}

interface JournalBinding {
  admission: WorkbookAuthoredAdmission
  source: string
}
const journals = new WeakMap<object, JournalBinding>()

export function bindJournalAuthoredAdmission(
  journal: object,
  admission: WorkbookAuthoredAdmission,
  source = admission.captureSource(),
): () => void {
  const existing = journals.get(journal)
  if (existing && (existing.admission !== admission || existing.source !== source))
    throw new Error('A journal cannot be rebound to another authored source epoch.')
  const binding = existing ?? { admission, source }
  journals.set(journal, binding)
  return () => {
    if (journals.get(journal) === binding) journals.delete(journal)
  }
}

/** Clone replay inputs now, before awaiting cancellation; unknown executable inputs are refused. */
function captureArguments<Args extends readonly unknown[]>(
  args: Args,
  preserveIdentity: readonly number[] = [],
  allowCallbacks = false,
): Args {
  let nodes = 0
  let bytes = 0
  const visiting = new Set<object>()
  const clone = (value: unknown, depth: number): unknown => {
    if (++nodes > 1_000_000 || depth > 64)
      throw new Error('The captured authored operation exceeds its replay budget.')
    if (typeof value === 'string') {
      bytes += value.length * 2
      if (bytes > 256 * 1024 * 1024)
        throw new Error('Captured authored text exceeds its replay byte budget.')
      return value
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    )
      return value
    if (typeof value === 'function' && allowCallbacks) return value
    if (typeof value !== 'object' || visiting.has(value))
      throw new Error('An authored command replay requires finite acyclic data.')
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      bytes += value.byteLength
      if (bytes > 256 * 1024 * 1024)
        throw new Error('Captured authored binary data exceeds its replay budget.')
      return structuredClone(value)
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw new Error(
        'An authored command replay cannot retain a mutable executable/class instance.',
      )
    visiting.add(value)
    try {
      if (Array.isArray(value)) return value.map((item) => clone(item, depth + 1))
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor))
          throw new Error('An authored replay cannot evaluate accessor properties.')
        result[key] = clone(descriptor.value, depth + 1)
      }
      return result
    } finally {
      visiting.delete(value)
    }
  }
  return args.map((value, index) =>
    preserveIdentity.includes(index) ? value : clone(value, 0),
  ) as unknown as Args
}

/** Called at exported journal mutation entry, not from an after-change listener. */
export function admitJournalAuthored<Args extends readonly unknown[], Result>(
  journal: object,
  args: Args,
  action: (...args: Args) => Result,
  preserveIdentity: readonly number[] = [],
): Result {
  const binding = journals.get(journal)
  if (!binding) return action(...args)
  return binding.admission.commit(
    () => action(...args),
    binding.source,
    () => {
      // Shared-formula resolver callbacks are captured source-bound capabilities;
      // mutator arguments needing object identity opt in explicitly below.
      const captured = captureArguments(args, preserveIdentity, true)
      return () => action(...captured)
    },
  )
}

export interface WorkbookCommandAdmissionOptions {
  /** Unknown commands default to authored. Only audited operations/derived work may bypass. */
  classify?(id: string, params: unknown, options: unknown): 'authored' | 'derived' | 'operation'
  /** Resolve explicit unit IDs to the accepted source; never rebind stale unit IDs to current. */
  resolveSource?(id: string, params: unknown, options: unknown): string
}

type CommandCall = (id: string, params?: unknown, options?: unknown) => unknown

/**
 * Wrap actual ICommandService entry methods before model handlers run. Existing
 * synchronous BeforeCommandExecute guards still run on normal/deferred replay.
 * No listener awaits, no node_modules patch, no global async nesting context.
 */
export function installWorkbookCommandAdmission(
  commandService: object,
  admission: WorkbookAuthoredAdmission,
  options: WorkbookCommandAdmissionOptions = {},
): () => void {
  const service = commandService as { executeCommand: CommandCall; syncExecuteCommand: CommandCall }
  if (
    typeof service.executeCommand !== 'function' ||
    typeof service.syncExecuteCommand !== 'function'
  )
    throw new Error('Workbook admission requires the actual ICommandService execution methods.')
  const originalAsync = service.executeCommand
  const originalSync = service.syncExecuteCommand
  let disposed = false
  const authored = (id: string, params: unknown, execution: unknown) =>
    !admission.derived && (options.classify?.(id, params, execution) ?? 'authored') === 'authored'
  const sourceFor = (id: string, params: unknown, execution: unknown) =>
    options.resolveSource?.(id, params, execution) ?? admission.captureSource()
  const assertInstalled = () => {
    if (disposed) throw new Error('The accepted workbook command owner was disposed before replay.')
  }
  const asyncWrapper: CommandCall = (id, params, execution) => {
    if (!authored(id, params, execution))
      return originalAsync.call(commandService, id, params, execution)
    const source = sourceFor(id, params, execution)
    const captured = admission.locked
      ? captureArguments([params, execution] as const)
      : ([params, execution] as const)
    return admission.runAsync(() => {
      assertInstalled()
      return originalAsync.call(commandService, id, captured[0], captured[1])
    }, source)
  }
  const syncWrapper: CommandCall = (id, params, execution) => {
    if (!authored(id, params, execution))
      return originalSync.call(commandService, id, params, execution)
    const source = sourceFor(id, params, execution)
    try {
      return admission.commit(
        () => {
          assertInstalled()
          return originalSync.call(commandService, id, params, execution)
        },
        source,
        () => {
          const captured = captureArguments([params, execution] as const)
          return () => {
            assertInstalled()
            return originalSync.call(commandService, id, captured[0], captured[1])
          }
        },
      )
    } catch (error) {
      if (error instanceof WorkbookAuthoredDeferredError) return false
      throw error
    }
  }
  service.executeCommand = asyncWrapper
  service.syncExecuteCommand = syncWrapper
  return () => {
    disposed = true
    if (service.executeCommand === asyncWrapper) service.executeCommand = originalAsync
    if (service.syncExecuteCommand === syncWrapper) service.syncExecuteCommand = originalSync
  }
}
