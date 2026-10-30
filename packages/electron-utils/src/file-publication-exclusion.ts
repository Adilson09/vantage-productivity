import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'

/** In-process source moves and publications only; this is not an OS file lock. */
export interface FilePublicationScope {
  targetPath: string
  /** Main-owned multi-output/asset namespaces, never renderer permission data. */
  targetKind?: 'file' | 'directory'
  additionalTargetPaths?: readonly string[]
  additionalTargetNamespaces?: readonly FileMutationPath[]
  sourcePaths?: readonly string[]
  temporaryPaths?: readonly string[]
}
export interface FileMutationPath { path: string; kind: 'file' | 'directory' }
interface Scope { aliases: readonly string[]; directory: boolean }
interface Publisher { id: number; target: Scope; targets?: readonly Scope[]; scopes: readonly Scope[]; done: Promise<void>; finish(): void }
interface Mutation { id: number; scopes: readonly Scope[]; active: boolean; running: boolean }
interface Registry {
  version: 1; next: number
  publishers: Map<number, Publisher>; mutations: Map<number, Mutation>
  context: AsyncLocalStorage<ReadonlySet<number>>
}
const symbol = Symbol.for('vantage.file-publication-exclusion.v1')
const globals = globalThis as typeof globalThis & { [key: symbol]: Registry | undefined }
const registry: Registry = globals[symbol] ??= {
  version: 1, next: 0, publishers: new Map(), mutations: new Map(),
  context: new AsyncLocalStorage<ReadonlySet<number>>(),
}
if (registry.version !== 1) throw new Error('The file publication exclusion registry is incompatible.')
const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

function scope(path: string, directory: boolean): Scope {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('An exact filesystem path is required.')
  const lexical = resolve(path)
  let parent = lexical
  const missing: string[] = []
  // A fresh destination may not exist. Resolve its nearest existing ancestor
  // synchronously, before any admission or filesystem work can be interleaved.
  for (;;) {
    try {
      const physical = resolve(realpathSync(parent), ...missing)
      return { aliases: [...new Set([normalize(lexical), normalize(physical)])], directory }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        // Do not walk past a dangling alias and silently reserve only its
        // lexical spelling while its actual destination cannot be attested.
        if (lstatSync(parent).isSymbolicLink()) throw new Error('A broken filesystem alias cannot be reserved safely.')
      } catch (inspection) {
        if ((inspection as NodeJS.ErrnoException).code !== 'ENOENT') throw inspection
      }
      const next = dirname(parent)
      if (next === parent) throw error
      missing.unshift(parent.slice(next.length).replace(/^[/\\]+/, ''))
      parent = next
    }
  }
}
const contains = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
function overlap(a: Scope, b: Scope): boolean {
  return a.aliases.some(left => b.aliases.some(right => left === right || a.directory && contains(left, right) || b.directory && contains(right, left)))
}
const overlaps = (a: readonly Scope[], b: readonly Scope[]) => a.some(left => b.some(right => overlap(left, right)))
const sameTarget = (a: Scope, b: Scope) => a.aliases.some(left => b.aliases.includes(left))
function covers(outer: Scope, inner: Scope): boolean {
  return (!inner.directory || outer.directory) && outer.aliases.some(parent => inner.aliases.some(child => child === parent || outer.directory && contains(parent, child)))
}
function ownedSiblingTemp(target: Scope, temporary: Scope): boolean {
  if (target.directory || temporary.directory) return false
  return target.aliases.some(path => temporary.aliases.some(temp => {
    const prefix = basename(path) + '.'
    return dirname(path) === dirname(temp) && basename(temp).startsWith(prefix) && /^[a-f0-9]{12}\.tmp$/.test(basename(temp).slice(prefix.length))
  }))
}
function publicationScopes(value: FilePublicationScope): { target: Scope; targets: Scope[]; scopes: Scope[]; temporary: Scope[] } {
  if (value.targetKind !== undefined && value.targetKind !== 'file' && value.targetKind !== 'directory') throw new Error('An output namespace must be a file or directory.')
  if (1 + (value.additionalTargetPaths?.length ?? 0) + (value.additionalTargetNamespaces?.length ?? 0) + (value.sourcePaths?.length ?? 0) + (value.temporaryPaths?.length ?? 0) > 4096)
    throw new Error('Too many paths in one publication namespace.')
  const target = scope(value.targetPath, value.targetKind === 'directory')
  const targets = [target, ...(value.additionalTargetPaths ?? []).map(path => scope(path, false)), ...(value.additionalTargetNamespaces ?? []).map(value => {
    if (value.kind !== 'file' && value.kind !== 'directory') throw new Error('An additional output namespace must be a file or directory.')
    return scope(value.path, value.kind === 'directory')
  })]
  const temporary = (value.temporaryPaths ?? []).map(path => scope(path, false))
  return { target, targets, temporary, scopes: [...targets, ...(value.sourcePaths ?? []).map(path => scope(path, false)), ...temporary] }
}
export class FilePublicationBlockedError extends Error {
  readonly code = 'VANTAGE_FILE_MUTATION_PENDING'
  constructor() { super('A file move is pending for this source or destination. Keep the document open and retry after it finishes.'); this.name = 'FilePublicationBlockedError' }
}
export class FilePublicationUnattestedError extends Error {
  readonly code = 'VANTAGE_FILE_PUBLICATION_UNATTESTED'
  constructor() { super('The publisher did not attest actual filesystem settlement. Its source remains protected until the process ends.'); this.name = 'FilePublicationUnattestedError' }
}
const promiseLike = (value: unknown): value is PromiseLike<unknown> => {
  try { return !!value && typeof (value as PromiseLike<unknown>).then === 'function' }
  catch { return false }
}
function admit(value: FilePublicationScope): Publisher {
  const captured = publicationScopes(value)
  const parents = [...(registry.context.getStore() ?? [])].map(id => registry.publishers.get(id)).filter((entry): entry is Publisher => !!entry)
  for (const mutation of registry.mutations.values()) {
    if (!mutation.active || !overlaps(captured.scopes, mutation.scopes)) continue
    // A previously admitted native/JS owner may reach its nested shared atomic
    // publisher while a move drains it. This is continuation of the SAME exact
    // target, not permission for a new independent writer. The drain rescans
    // actual entries, so even a late child remains owned through settlement.
    const affected = captured.scopes.filter(child => overlaps([child], mutation.scopes))
    if (!parents.some(parent => {
      const targets = parent.targets ?? [parent.target]
      if (!targets.some(target => covers(target, captured.target))) return false
      // Every added overlapping path must be inside an already admitted exact
      // namespace/input. Only the shared writer's bounded sibling temp naming
      // is a permitted file-target continuation; ancestry alone grants nothing.
      return affected.every(child => parent.scopes.some(admitted => covers(admitted, child)) ||
        captured.temporary.includes(child) && targets.some(target => sameTarget(target, captured.target) && ownedSiblingTemp(target, child)))
    }))
      throw new FilePublicationBlockedError()
  }
  if (registry.publishers.size >= 4096) throw new Error('Too many unsettled file publications; the source remains protected.')
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const entry: Publisher = { id: ++registry.next, ...captured, done, finish }
  registry.publishers.set(entry.id, entry)
  return entry
}
function retire(entry: Publisher): void {
  if (registry.publishers.get(entry.id) !== entry) return
  registry.publishers.delete(entry.id)
  entry.finish()
}

/**
 * Native seam: call BEFORE dispatch, with the exact normalized output target.
 * result may reject on caller cancellation/timeout. actualSettled must attest
 * the real native write/final publication terminal event, including failure.
 * A missing attestation or throwing dispatch deliberately leaves ownership
 * held: it cannot prove that no filesystem work was dispatched.
 */
export function withAttestedFilePublication<T>(value: FilePublicationScope, start: () => {
  result: Promise<T>; actualSettled: Promise<unknown>
}): Promise<T> {
  const entry = admit(value)
  const parent = registry.context.getStore() ?? new Set<number>()
  let operation: { result: Promise<T>; actualSettled: Promise<unknown> }
  try { operation = registry.context.run(new Set([...parent, entry.id]), start) }
  catch { return Promise.reject(new FilePublicationUnattestedError()) }
  if (!operation || !promiseLike(operation.result) || !promiseLike(operation.actualSettled)) {
    if (operation && promiseLike(operation.result)) void Promise.resolve(operation.result).catch(() => {})
    if (operation && promiseLike(operation.actualSettled)) void Promise.resolve(operation.actualSettled).catch(() => {})
    return Promise.reject(new FilePublicationUnattestedError())
  }
  void Promise.resolve(operation.actualSettled).then(() => retire(entry), () => retire(entry))
  return operation.result
}

/** JS callback Promise must own its actual writes, not a caller timeout race. */
export function withFilePublication<T>(value: FilePublicationScope, startActual: () => Promise<T>): Promise<T> {
  return withAttestedFilePublication(value, () => {
    const actual = startActual()
    return { result: actual, actualSettled: actual }
  })
}

/** Synchronous small metadata writes must also respect an overlapping move. */
export function withSynchronousFilePublication<T>(value: FilePublicationScope, write: () => T): T {
  const entry = admit(value)
  let valueReturned: T
  try { valueReturned = write() }
  catch (error) { retire(entry); throw error }
  if (promiseLike(valueReturned)) {
    void Promise.resolve(valueReturned).catch(() => {})
    throw new FilePublicationUnattestedError()
  }
  retire(entry)
  return valueReturned
}

export interface FileMutationReservation {
  /** Snapshot plus fixed-point drain of genuinely admitted actual work. */
  readonly ready: Promise<void>
  isReady(): boolean
  /** Only a still-pending intent can be canceled; this never retires a writer. */
  cancelPending(): boolean
  /** Owns physical mutation AND awaited source refresh until actual settlement. */
  run<T>(actual: () => Promise<T>): Promise<T>
  /** Legacy ABI: starts synchronously only when no existing writer overlaps. */
  runReady<T>(actual: () => Promise<T>): Promise<T>
}
export function reserveFileMutation(paths: readonly FileMutationPath[]): FileMutationReservation {
  if (!paths.length) throw new Error('A mutation must reserve its exact source and destination.')
  const scopes = paths.map(value => {
    if (value.kind !== 'file' && value.kind !== 'directory') throw new Error('A mutation must declare an exact file or directory scope.')
    return scope(value.path, value.kind === 'directory')
  })
  for (const other of registry.mutations.values())
    if (other.active && overlaps(scopes, other.scopes)) throw new FilePublicationBlockedError()
  const mutation: Mutation = { id: ++registry.next, scopes, active: true, running: false }
  registry.mutations.set(mutation.id, mutation)
  const pending = () => [...registry.publishers.values()].filter(entry => overlaps(scopes, entry.scopes))
  const release = () => { mutation.active = false; registry.mutations.delete(mutation.id) }
  const ready = (async () => {
    while (mutation.active) {
      const current = pending()
      if (!current.length) return
      await Promise.all(current.map(entry => entry.done))
    }
  })()
  const start = <T>(actual: () => Promise<T>): Promise<T> => {
    if (!mutation.active || mutation.running) return Promise.reject(new Error('The source move reservation is no longer available.'))
    if (pending().length) return Promise.reject(new FilePublicationBlockedError())
    mutation.running = true
    let operation: Promise<T>
    // An async Root callback returns its actual Promise even for a synchronous
    // filesystem throw. An arbitrary throwing/unattested callback stays held.
    try { operation = actual() }
    catch { return Promise.reject(new FilePublicationUnattestedError()) }
    if (!promiseLike(operation)) return Promise.reject(new FilePublicationUnattestedError())
    return Promise.resolve(operation).then(value => { release(); return value }, error => { release(); throw error })
  }
  return {
    ready,
    isReady: () => mutation.active && !mutation.running && pending().length === 0,
    cancelPending: () => { if (!mutation.active || mutation.running) return false; release(); return true },
    run: async actual => { await ready; return start(actual) },
    runReady: start,
  }
}
