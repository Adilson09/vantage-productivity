import { createSaveGate } from './save-scheduler'

/** AI/ribbon applies and publication share one order, including awaited edits. */
const mutations = createSaveGate()

export function enqueueWorkbookMutation<T>(task: () => Promise<T>): Promise<T> {
  return mutations.run(task)
}

export function workbookMutationsPending(): boolean {
  return mutations.busy
}
