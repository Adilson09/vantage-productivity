import {
  CloseMutationBarrier,
  installCloseInputFence,
} from '../../../../packages/electron-utils/src/renderer-close-barrier'
import type { CloseLeaseStamp } from '../../../../packages/electron-utils/src/close-lease'

interface Surface {
  pending(): boolean
  composing(): boolean
  flush(): boolean
}
interface Binding {
  barrier: CloseMutationBarrier
  publish(): void
  alive(): boolean
}
let binding: Binding | null = null
let previouslyBound = false
const surfaces = new Set<Surface>()
const participantLocks = new Set<() => () => void>()
export function bindHtmlCloseBarrier(next: Binding): () => void {
  if (binding && binding !== next) throw new Error('A Html close barrier is already bound.')
  binding = next
  previouslyBound = true
  for (const lock of participantLocks) next.barrier.registerLock(lock)
  return () => {
    if (binding === next) binding = null
  }
}
export function htmlCloseStamp(): CloseLeaseStamp {
  return binding?.barrier.snapshot() ?? { source: 'unbound', revision: '0' }
}
export function htmlCloseBusy(): boolean {
  return binding?.barrier.busy === true
}
export function htmlCloseLocked(): boolean {
  return binding?.barrier.locked === true
}
export function publishHtmlCloseState(): void {
  binding?.publish()
}
export function mutateHtml(action: () => void, source = htmlCloseStamp().source): boolean {
  const current = binding
  if (!current) {
    if (previouslyBound) throw new Error('The Html source is no longer mounted.')
    action()
    return true
  }
  return current.barrier.mutate(() => {
    if (!current.alive()) throw new Error('The Html view was closed.')
    action()
    current.publish()
  }, source)
}
export function noteHtmlAuthoredMutation(): boolean {
  return mutateHtml(() => {})
}
export async function beforeHtmlMutation(source: string): Promise<void> {
  const current = binding
  if (!current) {
    if (previouslyBound) throw new Error('The Html source is no longer mounted.')
    return
  }
  await current.barrier.beforeMutation(source)
  if (!current.alive())
    throw new Error('The Html view was closed before its pending edit finished.')
}
export function runHtmlMutationWork<Result>(
  action: (source: string) => Result | Promise<Result>,
): Result | Promise<Result> {
  const current = binding,
    source = htmlCloseStamp().source
  if (!current) {
    if (previouslyBound) throw new Error('The Html source is no longer mounted.')
    return action(source)
  }
  let result: Result | Promise<Result>
  try {
    result = current.barrier.runMutationWork(() => {
      current.publish()
      return action(source)
    }, source)
  } catch (error) {
    current.publish()
    throw error
  }
  if (result && typeof (result as Promise<Result>).then === 'function')
    return Promise.resolve(result).finally(() => current.publish())
  current.publish()
  return result
}
export async function runHtmlAsyncMutation<Result>(
  action: (source: string) => Promise<Result>,
): Promise<Result> {
  return await runHtmlMutationWork(action)
}
export function registerHtmlPendingSurface(surface: Surface): () => void {
  surfaces.add(surface)
  return () => surfaces.delete(surface)
}
export function hasHtmlPendingSurface(): boolean {
  return [...surfaces].some((surface) => surface.pending() || surface.composing())
}
export function flushHtmlPendingSurfaces(): boolean {
  if ([...surfaces].some((surface) => surface.composing())) return false
  for (const surface of [...surfaces]) if (!surface.flush()) return false
  return !hasHtmlPendingSurface()
}
export function installHtmlCloseInputFence(barrier: CloseMutationBarrier): () => void {
  return installCloseInputFence(barrier, document)
}

export function requireHtmlMutation(): void {
  if (htmlCloseLocked()) {
    void beforeHtmlMutation(htmlCloseStamp().source).catch((error) => console.error(error))
    throw new Error('Close is being cancelled before this edit can begin; retry the operation.')
  }
}
export function registerHtmlCloseLock(lock: () => () => void): () => void {
  participantLocks.add(lock)
  const dispose = binding?.barrier.registerLock(lock)
  return () => {
    participantLocks.delete(lock)
    dispose?.()
  }
}

export function assertHtmlSource(source: string): void {
  if (source !== htmlCloseStamp().source)
    throw new Error('The asynchronous edit belongs to a replaced HTML document.')
  requireHtmlMutation()
}
