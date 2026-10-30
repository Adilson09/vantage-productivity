import type { BrowserWindow, WebContents } from 'electron'
import {
  requestSheetsClose, sheetsCloseState, prepareSheetsClose, completeSheetsClose, cancelSheetsClose,
} from '../../../sheets/src/main/sheets-main'

export interface SheetsCloseAdapterOptions {
  contents(tabId: string): WebContents | undefined
  /** Exact tab removal only, without another save/close prompt. */
  remove(tabId: string): boolean
  authorizeSave(contents: WebContents, path: string): void
  cleanupStatus?(id: string): { phase: string; custody: boolean } | undefined
}

/** Sheets-only adapter. Root composes generic TabManager/MCP/detached dispatchers. */
export function createSheetsCloseAdapter(options: SheetsCloseAdapterOptions) {
  const requireOwner = (id: string): WebContents => {
    const owner = options.contents(id)
    if (!owner || owner.isDestroyed()) throw new Error('The spreadsheet is no longer open.')
    return owner
  }
  const exactRemove = (id: string, owner: WebContents): boolean =>
    options.contents(id) === owner && !owner.isDestroyed() && options.remove(id)
  return {
    /** Invoke for every live Sheets view, even when its badge says clean. */
    request: async (id: string, parent?: BrowserWindow | null): Promise<boolean> => {
      const owner = requireOwner(id)
      return requestSheetsClose(owner, parent, () => exactRemove(id, owner))
    },
    close: async (id: string, request: { unsaved?: 'save' | 'discard' | 'error'; path?: string; overwrite?: boolean }) => {
      const owner = requireOwner(id)
      const state = sheetsCloseState(owner)
      if (!state) throw new Error('The spreadsheet cannot attest its current source/revision.')
      if (state.dirty && request.unsaved !== 'save' && request.unsaved !== 'discard')
        throw new Error('The spreadsheet has unsaved changes. Choose save or discard explicitly.')
      // A nominally clean default close approves discarding this exact clean
      // stamp, never an implicit save of a later programmatic/editor mutation.
      const intent = request.unsaved === 'save' ? 'save' as const : 'discard' as const
      if (request.path !== undefined && intent !== 'save')
        throw new Error('A save destination is only valid when saving the spreadsheet.')
      const path = request.path === undefined ? undefined : /\.(xlsx|xlsm)$/i.test(request.path) ? request.path : `${request.path}.xlsx`
      if (path) options.authorizeSave(owner, path)
      const receipt = await prepareSheetsClose(owner, intent, intent === 'discard' ? { ...state.stamp } : undefined,
        path ? { path, overwrite: request.overwrite === true } : undefined)
      try {
        if (!completeSheetsClose(owner, receipt, () => exactRemove(id, owner)))
          throw new Error('The spreadsheet changed or its exact removal was refused; recovery was retained.')
        const status = options.cleanupStatus?.(receipt.cleanup.id)
        return { removed: true, published: receipt.published, clean: receipt.clean,
          ...(receipt.savedPath ? { savedPath: receipt.savedPath } : {}),
          cleanup: { id: receipt.cleanup.id, phase: status?.phase ?? 'pending', custody: status?.custody ?? receipt.cleanup.custody } }
      } finally { cancelSheetsClose(owner, receipt, 'Sheets adapter close attempt finished') }
      // Root must hold the final MCP response through transport flush before
      // last-detached-window quit. A returned object alone is not delivery proof.
    },
  }
}
