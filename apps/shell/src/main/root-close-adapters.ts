import type { BrowserWindow, WebContents } from 'electron'
import type { DocumentTabKind } from '../shared/tabs-api'
import type {
  RootClosePrepareOptions,
  RootPreparedClose,
  RootReadyClose,
} from './root-close-preparation'
export interface NativeCloseReceipt {
  phase: 'prepared' | 'ready' | 'force'
}
export interface NativeCloseOptions {
  deferSeal?: boolean
  signal?: AbortSignal
  isCurrent?: () => boolean
  allowForce?: boolean
}
export interface RootCloseAdapter {
  prepare(
    contents: WebContents,
    parent: BrowserWindow,
    options: NativeCloseOptions,
  ): Promise<NativeCloseReceipt | null>
  isPrepared(contents: WebContents, receipt: NativeCloseReceipt): boolean
  seal(contents: WebContents, receipt: NativeCloseReceipt): NativeCloseReceipt | null
  complete(contents: WebContents, receipt: NativeCloseReceipt, removeSync: () => boolean): boolean
  cancel(contents: WebContents, receipt: NativeCloseReceipt, reason: string): void | Promise<void>
}
/** Typed leaf closures retain their own receipt shape; registry callers never fabricate one. */
export function rootCloseAdapter<R extends NativeCloseReceipt>(adapter: {
  prepare(
    contents: WebContents,
    parent: BrowserWindow,
    options: NativeCloseOptions,
  ): Promise<R | null>
  isPrepared(contents: WebContents, receipt: NoInfer<R>): boolean
  seal(contents: WebContents, receipt: NoInfer<R>): R | null
  complete(contents: WebContents, receipt: NoInfer<R>, removeSync: () => boolean): boolean
  cancel(contents: WebContents, receipt: NoInfer<R>, reason: string): void | Promise<void>
}): RootCloseAdapter {
  // Keep each leaf's actual receipt type and object identity inside its closure.
  // The registry can route a minimal phase without fabricating or casting a grant.
  const issued = new WeakMap<NativeCloseReceipt, R>()
  return {
    prepare: async (contents, parent, options) => {
      const receipt = await adapter.prepare(contents, parent, options)
      if (receipt) issued.set(receipt, receipt)
      return receipt
    },
    isPrepared: (contents, receipt) => {
      const own = issued.get(receipt)
      return own !== undefined && adapter.isPrepared(contents, own)
    },
    seal: (contents, receipt) => {
      const own = issued.get(receipt)
      if (own === undefined) return null
      const sealed = adapter.seal(contents, own)
      if (sealed) issued.set(sealed, sealed)
      return sealed
    },
    complete: (contents, receipt, remove) => {
      const own = issued.get(receipt)
      return own !== undefined && adapter.complete(contents, own, remove)
    },
    cancel: (contents, receipt, reason) => {
      const own = issued.get(receipt)
      if (own !== undefined) return adapter.cancel(contents, own, reason)
    },
  }
}
const adapters = new Map<DocumentTabKind, RootCloseAdapter>()
export function registerRootCloseAdapter(kind: DocumentTabKind, adapter: RootCloseAdapter): void {
  if (adapters.has(kind)) throw new Error(`Close adapter already registered: ${kind}`)
  adapters.set(kind, adapter)
}
function binding(kind: DocumentTabKind): RootCloseAdapter {
  const value = adapters.get(kind)
  if (!value)
    throw new Error(`The ${kind} close protocol is unavailable; the document remains open.`)
  return value
}
export async function prepareRootClose(
  kind: DocumentTabKind,
  contents: WebContents,
  parent: BrowserWindow,
  options: RootClosePrepareOptions,
): Promise<RootPreparedClose | null> {
  const adapter = binding(kind),
    receipt = await adapter.prepare(contents, parent, { ...options, allowForce: false })
  if (!receipt) return null
  if (receipt.phase !== 'prepared' || options.signal.aborted || !options.isCurrent()) {
    await adapter.cancel(contents, receipt, 'whole-window preparation became obsolete')
    return null
  }
  return {
    phase: 'prepared',
    isPrepared: () => !options.signal.aborted && adapter.isPrepared(contents, receipt),
    seal: () => {
      if (options.signal.aborted || !options.isCurrent() || !adapter.isPrepared(contents, receipt))
        return null
      const sealed = adapter.seal(contents, receipt)
      if (!sealed) return null
      if (sealed.phase !== 'ready') {
        void adapter.cancel(contents, sealed, 'invalid sealed receipt')
        return null
      }
      return ready(adapter, contents, sealed)
    },
    cancel: (reason) => adapter.cancel(contents, receipt, reason),
  }
}
function ready(
  adapter: RootCloseAdapter,
  contents: WebContents,
  receipt: NativeCloseReceipt,
): RootReadyClose {
  return {
    phase: 'ready',
    complete: (remove) => adapter.complete(contents, receipt, remove),
    cancel: (reason) => adapter.cancel(contents, receipt, reason),
  }
}
export async function prepareRootIndividualClose(
  kind: DocumentTabKind,
  contents: WebContents,
  parent: BrowserWindow,
  options: Omit<NativeCloseOptions, 'deferSeal'>,
): Promise<RootReadyClose | null> {
  const adapter = binding(kind),
    receipt = await adapter.prepare(contents, parent, { ...options, deferSeal: false })
  if (!receipt) return null
  if (
    options.signal?.aborted ||
    options.isCurrent?.() === false ||
    (receipt.phase !== 'ready' && (receipt.phase !== 'force' || options.allowForce !== true))
  ) {
    await adapter.cancel(contents, receipt, 'individual close became obsolete')
    return null
  }
  return ready(adapter, contents, receipt)
}
