import type { WorkbookAuthoredAdmission } from './workbook-authored-admission'

export interface WorkbookPublicationOwner {
  readonly identity: symbol
}

interface QueuedWork {
  readonly owner: WorkbookPublicationOwner | null
}

const owners = new WeakSet<WorkbookPublicationOwner>()
const work = new Set<QueuedWork>()
let configured: { admission: WorkbookAuthoredAdmission } | null = null
let tail: Promise<void> = Promise.resolve()
let active: QueuedWork | null = null

/** Mount-scoped; a stale App disposer cannot detach a newer App's admission. */
export function configureWorkbookMutationAdmission(
  admission: WorkbookAuthoredAdmission,
): () => void {
  if (configured) throw new Error('Workbook mutation admission already has a mounted owner.')
  const binding = { admission }
  configured = binding
  return () => {
    if (configured === binding) configured = null
  }
}

export function createWorkbookPublicationOwner(): WorkbookPublicationOwner {
  const owner = Object.freeze({ identity: Symbol('workbook-publication') })
  owners.add(owner)
  return owner
}

function assertOwner(owner: WorkbookPublicationOwner): void {
  if (!owners.has(owner)) throw new Error('Workbook publication requires an allocated owner token.')
}

function enqueue<T>(entry: QueuedWork, task: () => Promise<T> | T): Promise<T> {
  work.add(entry)
  const result = tail.then(async () => {
    active = entry
    try {
      return await task()
    } finally {
      active = null
      work.delete(entry)
    }
  })
  // Rejection remains observable on result, while later accepted tasks still run.
  tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** Capture source when work is accepted, before its position in the queue runs. */
export function enqueueWorkbookMutation<T>(task: () => Promise<T> | T): Promise<T> {
  const admission = configured?.admission
  const source = admission?.captureSource()
  return enqueue({ owner: null }, () => (admission ? admission.runAsync(task, source) : task()))
}

/** Publication serializes with authored producers but is not itself an authored mutation. */
export function enqueueWorkbookPublication<T>(
  owner: WorkbookPublicationOwner,
  task: () => Promise<T> | T,
): Promise<T> {
  assertOwner(owner)
  return enqueue({ owner }, task)
}

/** Only the currently executing publication may propagate its own busy exclusion. */
export function withPublicationOwner<T>(owner: WorkbookPublicationOwner, task: () => T): T {
  assertOwner(owner)
  if (active?.owner !== owner) throw new Error('This publication owner is not executing.')
  return task()
}

export function workbookWorkPending(excludeOwner?: WorkbookPublicationOwner | null): boolean {
  if (excludeOwner) {
    assertOwner(excludeOwner)
    if (active?.owner !== excludeOwner)
      throw new Error('Only an executing publication can exclude its own work.')
  }
  for (const entry of work) {
    if (entry !== active || entry.owner !== excludeOwner || !excludeOwner) return true
  }
  return false
}

export function workbookMutationsPending(): boolean {
  return workbookWorkPending()
}

/** Called by close preparation outside the queue; never await it from its own writer. */
export async function drainWorkbookWork(): Promise<void> {
  for (;;) {
    const accepted = tail
    await accepted
    await configured?.admission.drain()
    if (accepted === tail && work.size === 0) return
  }
}
