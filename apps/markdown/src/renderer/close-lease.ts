import { CloseMutationBarrier, installCloseInputFence } from '../../../../packages/electron-utils/src/renderer-close-barrier'
import type { CloseLeaseStamp } from '../../../../packages/electron-utils/src/close-lease'

interface Surface { pending(): boolean; composing(): boolean; flush(): boolean }
interface Binding { barrier: CloseMutationBarrier; publish(): void; alive(): boolean }
let binding: Binding | null = null
let previouslyBound = false
const surfaces = new Set<Surface>()
export function bindMarkdownCloseBarrier(next: Binding): () => void {
  if (binding && binding !== next) throw new Error('A Markdown close barrier is already bound.')
  binding = next
  previouslyBound = true
  return () => { if (binding === next) binding = null }
}
export function markdownCloseStamp(): CloseLeaseStamp { return binding?.barrier.snapshot() ?? { source:'unbound',revision:'0' } }
export function markdownCloseBusy(): boolean { return binding?.barrier.busy === true }
export function markdownCloseLocked(): boolean { return binding?.barrier.locked === true }
export function publishMarkdownCloseState(): void { binding?.publish() }
export function mutateMarkdown(action: () => void, source = markdownCloseStamp().source): boolean {
  const current = binding
  if (!current) { if(previouslyBound)throw new Error('The Markdown source is no longer mounted.');action(); return true }
  return current.barrier.mutate(() => { if (!current.alive()) throw new Error('The Markdown view was closed.'); action(); current.publish() }, source)
}
export function noteMarkdownAuthoredMutation(): boolean { return mutateMarkdown(() => {}) }
export async function beforeMarkdownMutation(source: string): Promise<void> {
  const current = binding
  if (!current) {if(previouslyBound)throw new Error('The Markdown source is no longer mounted.');return}
  await current.barrier.beforeMutation(source)
  if (!current.alive()) throw new Error('The Markdown view was closed before its pending edit finished.')
}
export function runMarkdownMutationWork<Result>(action: (source: string) => Result | Promise<Result>): Result | Promise<Result> {
  const current = binding, source = markdownCloseStamp().source
  if (!current) {if(previouslyBound)throw new Error('The Markdown source is no longer mounted.');return action(source)}
  let result: Result | Promise<Result>
  try { result = current.barrier.runMutationWork(() => { current.publish(); return action(source) }, source) }
  catch (error) { current.publish(); throw error }
  if (result && typeof (result as Promise<Result>).then === 'function') return Promise.resolve(result).finally(() => current.publish())
  current.publish(); return result
}
export async function runMarkdownAsyncMutation<Result>(action: (source: string) => Promise<Result>): Promise<Result> {
  return await runMarkdownMutationWork(action)
}
export function registerMarkdownPendingSurface(surface: Surface): () => void { surfaces.add(surface); return () => surfaces.delete(surface) }
export function hasMarkdownPendingSurface(): boolean { return [...surfaces].some(surface => surface.pending() || surface.composing()) }
export function flushMarkdownPendingSurfaces(): boolean {
  if ([...surfaces].some(surface => surface.composing())) return false
  for (const surface of [...surfaces]) if (!surface.flush()) return false
  return !hasMarkdownPendingSurface()
}
export function installMarkdownCloseInputFence(barrier: CloseMutationBarrier): () => void { return installCloseInputFence(barrier, document) }
