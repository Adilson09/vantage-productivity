import type { DocCloseEnvelope } from '../shared/ipc'
import type { CloseCleanupStatus } from '../../../../packages/electron-utils/src/close-cleanup'
import { ipcMain, type WebContents } from 'electron'
import {
  CloseLeaseBroker,
  isCloseLeaseTicket,
  type CloseLeaseStamp,
} from '../../../../packages/electron-utils/src/close-lease'

type ReleaseListener = (
  owner: WebContents,
  ticket: import('../../../../packages/electron-utils/src/close-lease').CloseLeaseTicket,
  reason: string,
) => void
const releaseListeners = new Set<ReleaseListener>()
interface CompletionHooks {
  stage(
    owner: WebContents,
    lease: DocCloseEnvelope,
    published: boolean,
    throughSequence: number,
  ): Promise<{ cleanupId?: string } | null>
  complete(owner: WebContents, lease: DocCloseEnvelope, remove: () => boolean): boolean
  cancel(owner: WebContents, lease: DocCloseEnvelope): void
  cleanup(ownerKey: string, lease: DocCloseEnvelope): Promise<CloseCleanupStatus | undefined>
}
let completionHooks: CompletionHooks | null = null
export function onDocsCloseLeaseRelease(listener: ReleaseListener): () => void {
  releaseListeners.add(listener)
  return () => {
    releaseListeners.delete(listener)
  }
}
export function setDocsCloseCompletionHooks(hooks: CompletionHooks): void {
  completionHooks = hooks
}
export async function stageDocsSavedClose(
  owner: WebContents,
  lease: DocCloseEnvelope,
  published: boolean,
  throughSequence: number,
) {
  if (!completionHooks) throw new Error('Document close custody is unavailable.')
  return completionHooks.stage(owner, lease, published, throughSequence)
}
export function completePreparedDocsClose(
  owner: WebContents,
  lease: DocCloseEnvelope,
  remove: () => boolean,
): boolean {
  return completionHooks?.complete(owner, lease, remove) ?? false
}
export function cancelPreparedDocsClose(owner: WebContents, lease: DocCloseEnvelope): void {
  completionHooks?.cancel(owner, lease)
}
export function preparedDocsCleanup(
  ownerKey: string,
  lease: DocCloseEnvelope,
): Promise<CloseCleanupStatus | undefined> {
  return completionHooks?.cleanup(ownerKey, lease) ?? Promise.resolve(undefined)
}

let sourceReader = (_owner: WebContents): string => {
  throw new Error('Document close source is not configured.')
}
let installed = false
let stampValidator = (_owner: WebContents, _stamp: CloseLeaseStamp): boolean => false
const watched = new WeakSet<WebContents>()

export const docsCloseLeases = new CloseLeaseBroker<WebContents>({
  alive: (owner) => !owner.isDestroyed(),
  source: (owner) => sourceReader(owner),
  validate: (owner, _ticket, stamp) => stampValidator(owner, stamp),
  release: (owner, ticket, reason) => {
    for (const listener of releaseListeners) listener(owner, ticket, reason)
    if (!owner.isDestroyed()) owner.send('docs:close-lease-release', ticket)
  },
})

export function setDocsCloseSourceReader(reader: (owner: WebContents) => string): void {
  sourceReader = reader
}
export function setDocsCloseStampValidator(
  validate: (owner: WebContents, stamp: CloseLeaseStamp) => boolean,
): void {
  stampValidator = validate
}

export function reserveDocsClose(owner: WebContents, id: string) {
  if (!watched.has(owner)) {
    watched.add(owner)
    owner.once('destroyed', () => docsCloseLeases.destroy(owner))
  }
  return docsCloseLeases.reserve(owner, id)
}

/** Registered by both standalone Docs and Root; ownership is the actual event sender. */
export function installDocsCloseService(): void {
  if (installed) return
  installed = true
  ipcMain.handle(
    'docs:close-lease-claim',
    (event, value: unknown) =>
      isCloseLeaseTicket(value) && docsCloseLeases.claim(event.sender, value),
  )
  ipcMain.handle('docs:close-lease-cancel', (event, value: unknown) => {
    if (!isCloseLeaseTicket(value)) throw new Error('Invalid document close cancellation.')
    docsCloseLeases.cancel(event.sender, value, 'renderer canceled close')
  })
}
