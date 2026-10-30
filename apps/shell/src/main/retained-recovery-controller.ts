import { basename } from 'node:path'
import type { CloseCleanupStatus } from '../../../../packages/electron-utils/src/close-cleanup'
import type {
  RetainedRecoveryCopy, RetainedRecoveryItem, RetainedRecoveryList, RetainedRecoverySelection,
} from '../shared/retained-recovery'

export interface RetainedRecoveryCapabilities { restore: boolean; remove: boolean; retry: boolean }
export interface RetainedRecoveryPreparedCopy {
  destination: string
  commitHandoff(action: () => boolean): boolean
  cancel(reason?: string): void
}
export interface RetainedRecoveryDependencies {
  list(): CloseCleanupStatus[]
  get(id: string): CloseCleanupStatus | undefined
  capabilities(status: CloseCleanupStatus): RetainedRecoveryCapabilities
  prepare(status: CloseCleanupStatus, destination: string): Promise<RetainedRecoveryPreparedCopy>
  remove(status: CloseCleanupStatus): Promise<void>
  retry(status: CloseCleanupStatus): Promise<void>
  keep(status: CloseCleanupStatus, outputId: string): void
}

const identifier = /^[a-zA-Z0-9:._-]{1,240}$/
const available = new Set(['retained', 'canceled', 'complete'])
const pendingOutput = (status: CloseCleanupStatus) => {
  const output = status.restoration
  return output && output.phase !== 'handed-off' && (output.created || output.publicationAttempted)
    ? { id: output.id, path: output.destination }
    : undefined
}

/** Main-owned selected-record operations. Renderer data supplies no paths or cleanup grants. */
export function createRetainedRecoveryController(dependencies: RetainedRecoveryDependencies) {
  const item = (status: CloseCleanupStatus): RetainedRecoveryItem => {
    const capability = dependencies.capabilities(status)
    const output = pendingOutput(status)
    const idle = available.has(status.phase)
    const busyRestore = status.restoration && ['preparing', 'publishing', 'pending-handoff'].includes(status.restoration.phase)
    return {
      id: status.id, updatedAt: status.updatedAt, module: status.module,
      fileName: status.documentPath ? basename(status.documentPath) || 'Untitled document' : 'Untitled document',
      originalPath: status.documentPath,
      state: status.phase === 'purging' ? 'removing' : !idle ? 'working' :
        status.phase === 'complete' ? 'closed-copy' : status.phase === 'canceled' ? 'canceled-close' : 'needs-review',
      detail: output ? 'A previous restore left a file to review. Keeping it does not remove that file.' :
        !idle ? 'Recovery work is still finishing.' : !status.custody ?
          'Cleanup needs attention. A verified recovery copy may not be available for this item.' :
          'This copy was kept while a document was closing. You can save a separate copy or remove it.',
      canRestore: idle && !busyRestore && !output && status.custody && !!status.capturedEntry && capability.restore,
      canRemove: idle && !busyRestore && !output && capability.remove,
      canRetry: idle && !busyRestore && !output && capability.retry,
      ...(output ? { pendingOutput: output } : {}),
    }
  }
  const selected = (value: unknown): CloseCleanupStatus => {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => key !== 'id' && key !== 'updatedAt'))
      throw new Error('Choose a valid recovery item.')
    const selection = value as RetainedRecoverySelection
    if (typeof selection.id !== 'string' || !identifier.test(selection.id) || typeof selection.updatedAt !== 'string' || selection.updatedAt.length > 64)
      throw new Error('Choose a valid recovery item.')
    const status = dependencies.get(selection.id)
    if (!status || status.phase === 'purged') throw new Error('This recovery item is no longer available.')
    if (status.updatedAt !== selection.updatedAt) throw new Error('This recovery item changed. Refresh the list and try again.')
    return status
  }
  return {
    list(): RetainedRecoveryList {
      const statuses = dependencies.list().filter(status => status.phase !== 'purged')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      return { items: statuses.slice(0, 256).map(item), truncated: statuses.length > 256 }
    },
    async recover(value: unknown, choose: (status: CloseCleanupStatus) => Promise<string | null>): Promise<RetainedRecoveryCopy | null> {
      const status = selected(value)
      if (!item(status).canRestore) throw new Error('This copy is not ready to recover. Refresh the list or retry cleanup.')
      const destination = await choose(status)
      if (!destination) return null
      const current = selected(value)
      if (!item(current).canRestore) throw new Error('This copy changed while you selected a folder. Please refresh.')
      const prepared = await dependencies.prepare(current, destination)
      let handedOff = false
      try {
        // This action saves an independent user-selected file. It grants no
        // editor activation or inherited journal deletion authority.
        handedOff = prepared.commitHandoff(() => true)
        if (!handedOff) throw new Error('The restored file needs review before recovery can finish. Refresh this list.')
        return { path: prepared.destination, module: current.module }
      } finally {
        if (!handedOff) prepared.cancel('The separate recovered file was not handed over.')
      }
    },
    async remove(value: unknown): Promise<void> {
      const status = selected(value)
      if (!item(status).canRemove) throw new Error('This item is still in use or needs a separate repair. Please refresh.')
      await dependencies.remove(status)
    },
    async retry(value: unknown): Promise<void> {
      const status = selected(value)
      if (!item(status).canRetry) throw new Error('No safe cleanup retry is available for this item yet.')
      await dependencies.retry(status)
    },
    keep(value: unknown, outputId: unknown): void {
      const status = selected(value)
      const output = pendingOutput(status)
      if (typeof outputId !== 'string' || !identifier.test(outputId) || !output || output.id !== outputId)
        throw new Error('That restored file changed. Refresh the list before keeping it.')
      dependencies.keep(status, outputId)
    },
  }
}
