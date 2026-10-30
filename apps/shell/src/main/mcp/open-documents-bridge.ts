import { awaitCloseCleanup } from '../../../../../packages/electron-utils/src/close-cleanup-runtime'
type EditorAssetCleanupReport = { assetCleanup?: { assets: 'retained' }; warnings?: string[] }
import type { MarkdownCloseReceipt } from '../../../../markdown/src/shared/markdown-close-lease'
import type { WebContents } from 'electron'
import { rootQuitIntent } from '../root-quit-intent'
import type { HtmlCloseReceipt } from '../../../../html/src/shared/html-close-lease'
import type { PdfCloseReceipt } from '../../../../pdf/src/shared/pdf-workspace'
import type { OpenDocumentCloseResult } from './tools/open-documents-tools'
import type { OpenDocumentTab } from '../../shared/tabs-api'
import type { OpenDocumentsControl } from './tools/open-documents-tools'
import { closeSavePath, resolveOpenDocumentOfFamily } from './tools/open-documents-tools'
import type { DocsControl } from './tools/document-tools'
import type { SlidesControl } from './tools/slides-tools'
import type { SheetsControl } from './tools/sheets-tools'
import type { EditorFamily } from './tools/formats'

/**
 * The shell's implementation of the `open_documents` control: the four actions
 * over the tab-manager plus each family's own bridge, so an MCP agent reaches
 * the documents the *user* has open (the bridges are addressed by webContents
 * id, so they do not care who opened the tab).
 */

export interface OpenDocumentsBridgeDeps {
  /** the tab-manager's open-document list, dirtiness already resolved */
  list: () => Promise<OpenDocumentTab[]>
  /** the tab's webContents, for the families that must be asked in the renderer */
  webContentsFor: (tabId: string) => WebContents | undefined
  /** remove one tab with no save prompt; false when it is already gone */
  closeTab: (tabId: string) => boolean
  /** folder an untitled dirty document is saved into before closing */
  defaultSaveDir: () => string
  docs?: DocsControl
  sheets?: SheetsControl
  slides?: SlidesControl
  /**
   * slides: drop the session's crash-recovery copies (autosave + untitled draft)
   * on a discard close, so the next open does not offer to restore edits the
   * caller explicitly dropped. Mirrors the interactive "Don't Save" branch.
   */
  slidesDiscard?: (contents: WebContents) => void
  sheetsClose?: (
    tabId: string,
    request: { unsaved: 'save' | 'discard'; path?: string; overwrite?: boolean },
  ) => Promise<OpenDocumentCloseResult>
  pdf?: {
    prepareClose(
      contents: WebContents,
      filePath: string | undefined,
      intent: 'save' | 'discard',
    ): Promise<PdfCloseReceipt>
    completeClose(contents: WebContents, receipt: PdfCloseReceipt, remove: () => boolean): boolean
    cancelClose(contents: WebContents, receipt: PdfCloseReceipt, reason?: string): Promise<void>
    cleanup(
      receipt: PdfCloseReceipt,
    ): Promise<
      | import('../../../../../packages/electron-utils/src/close-cleanup').CloseCleanupStatus
      | undefined
    >
  }
  /** markdown: live text + dialog-free save (the app owns the renderer protocol) */
  markdown?: {
    read: (contents: WebContents) => Promise<string>
    save: (
      contents: WebContents,
      filePath: string,
      options?: { requireClean?: boolean },
    ) => Promise<void | EditorAssetCleanupReport>
    prepareClose: (
      contents: WebContents,
      filePath: string | undefined,
      intent: 'save' | 'discard' | 'clean',
    ) => Promise<MarkdownCloseReceipt>
    completeClose: (
      contents: WebContents,
      receipt: MarkdownCloseReceipt,
      remove: () => boolean,
    ) => boolean
    cancelClose: (
      contents: WebContents,
      receipt: MarkdownCloseReceipt,
      reason?: string,
    ) => Promise<void>
    /** release assets staged next to the document but never written into it */
    discard: (contents: WebContents) => Promise<void>
  }
  /** html: same three, its own renderer protocol */
  html?: {
    read: (contents: WebContents) => Promise<string>
    save: (contents: WebContents, filePath: string) => Promise<void | EditorAssetCleanupReport>
    prepareClose: (
      contents: WebContents,
      filePath: string | undefined,
      intent: 'save' | 'discard' | 'clean',
    ) => Promise<HtmlCloseReceipt>
    completeClose: (
      contents: WebContents,
      receipt: HtmlCloseReceipt,
      remove: () => boolean,
    ) => boolean
    cancelClose: (
      contents: WebContents,
      receipt: HtmlCloseReceipt,
      reason?: string,
    ) => Promise<void>
    discard: (contents: WebContents) => Promise<void>
  }
}

function requireContents(tab: OpenDocumentTab, deps: OpenDocumentsBridgeDeps): WebContents {
  const contents = deps.webContentsFor(tab.id)
  if (!contents || contents.isDestroyed()) {
    throw new Error(`"${tab.title}" is no longer open`)
  }
  return contents
}

/** deps for the content tools' "target an open document" lookup */
export interface OpenTargetDeps {
  list: () => Promise<OpenDocumentTab[]>
  webContentsFor: (tabId: string) => WebContents | undefined
  /**
   * Make a tab the visible one. Called before a mutating command runs, so the
   * user sees the document the agent is about to change rather than discovering
   * it later. Absent in headless/unit runs.
   */
  activate?: (tabId: string) => void
  /**
   * Bring the window hosting this document forward (un-minimize, show, focus):
   * the shell, or a detached editor window. Separate from `activate` because
   * raising the window is a stronger action than switching a tab inside it.
   */
  revealWindow?: (tabId: string) => void
}

/**
 * Resolver behind the content tools' optional `document` argument: an agent can
 * point an edit at a tab the *user* has open (by tab id or path) instead of the
 * blank one `create_session` opened. Every family's bridge is addressed by
 * webContents id, so a resolved tab needs no session of its own — the caller
 * edits what the user is looking at, and the user decides when to save it.
 *
 * Like `createOpenDocumentsControl`, this lives behind an injected dep so the
 * tool layer never imports Electron.
 */
export function createOpenTargetResolver(
  deps: OpenTargetDeps,
): (target: string, family: EditorFamily, options?: { focus?: boolean }) => Promise<number> {
  return async (target, family, options) => {
    const documents = await deps.list()
    const doc = resolveOpenDocumentOfFamily(documents, target, family)
    const contents = deps.webContentsFor(doc.id)
    if (!contents || contents.isDestroyed()) {
      throw new Error(`"${doc.title}" is no longer open`)
    }
    if (options?.focus && !doc.active) {
      // Showing the tab is a courtesy, not part of the edit: a UI failure here
      // must not fail the command the caller actually asked for.
      try {
        deps.activate?.(doc.id)
        deps.revealWindow?.(doc.id)
      } catch (error) {
        console.warn('[mcp] could not bring the target document into view:', error)
      }
    }
    return contents.id
  }
}

export function createOpenDocumentsControl(deps: OpenDocumentsBridgeDeps): OpenDocumentsControl {
  /** save one document to `filePath` through its family's own writer */
  const saveTo = async (
    tab: OpenDocumentTab,
    filePath: string,
    requireClean = false,
  ): Promise<void | EditorAssetCleanupReport> => {
    switch (tab.kind) {
      case 'docs': {
        if (!deps.docs) throw new Error('the Word editor is unavailable in this build')
        const wcId = requireContents(tab, deps).id
        await deps.docs.runCommand(wcId, 'save_document', { path: filePath, overwrite: true })
        return
      }
      case 'sheets': {
        if (!deps.sheets) throw new Error('the spreadsheet editor is unavailable in this build')
        const wcId = requireContents(tab, deps).id
        await deps.sheets.runCommand(wcId, 'save_sheet', { path: filePath, overwrite: true })
        return
      }
      case 'slides': {
        if (!deps.slides) throw new Error('the presentation editor is unavailable in this build')
        const wcId = requireContents(tab, deps).id
        await deps.slides.saveDeck(wcId, filePath, true)
        return
      }
      case 'markdown': {
        if (!deps.markdown) throw new Error('the Markdown editor is unavailable in this build')
        return await deps.markdown.save(requireContents(tab, deps), filePath, { requireClean })
      }
      case 'html': {
        if (!deps.html) throw new Error('the HTML editor is unavailable in this build')
        return await deps.html.save(requireContents(tab, deps), filePath)
      }
      case 'pdf':
        throw new Error('a PDF cannot be saved through this tool: the pdf app is a viewer')
      default:
        throw new Error(`cannot save a ${tab.kind} tab`)
    }
  }

  const readDocument = async (tab: OpenDocumentTab): Promise<unknown> => {
    switch (tab.kind) {
      case 'docs': {
        if (!deps.docs) throw new Error('the Word editor is unavailable in this build')
        return deps.docs.runCommand(requireContents(tab, deps).id, 'read_document', {})
      }
      case 'sheets': {
        if (!deps.sheets) throw new Error('the spreadsheet editor is unavailable in this build')
        return deps.sheets.runCommand(requireContents(tab, deps).id, 'read_sheet', {})
      }
      case 'slides': {
        if (!deps.slides) throw new Error('the presentation editor is unavailable in this build')
        return deps.slides.readDeck(requireContents(tab, deps).id)
      }
      case 'markdown':
        if (!deps.markdown) throw new Error('the Markdown editor is unavailable in this build')
        return deps.markdown.read(requireContents(tab, deps))
      case 'html':
        if (!deps.html) throw new Error('the HTML editor is unavailable in this build')
        return deps.html.read(requireContents(tab, deps))
      default:
        throw new Error(`cannot read a ${tab.kind} tab`)
    }
  }

  return {
    list: deps.list,

    read: readDocument,

    save: async (tab) => {
      rootQuitIntent.assertMutationAvailable()
      // the caller's snapshot may predate an edit: settle against the live state
      const live = (await deps.list()).find((doc) => doc.id === tab.id)
      rootQuitIntent.assertMutationAvailable()
      if (!live) throw new Error(`"${tab.title}" is already closed`)
      const savedPath = closeSavePath(live, deps.defaultSaveDir)
      const assetReport = await saveTo(live, savedPath)
      return { savedPath, ...(assetReport ?? {}) }
    },

    close: async (tab, { unsaved }) => {
      rootQuitIntent.assertMutationAvailable()
      const live = (await deps.list()).find((doc) => doc.id === tab.id)
      rootQuitIntent.assertMutationAvailable()
      if (!live) throw new Error(`"${tab.title}" is already closed`)
      const exactRemove = (contents: WebContents): boolean => {
        rootQuitIntent.assertMutationAvailable()
        return (
          deps.webContentsFor(live.id) === contents &&
          !contents.isDestroyed() &&
          deps.closeTab(live.id)
        )
      }
      if (live.kind === 'sheets') {
        if (!deps.sheetsClose)
          throw new Error('Spreadsheet close protection is unavailable; the document remains open.')
        return deps.sheetsClose(live.id, {
          unsaved,
          ...(unsaved === 'save' && live.dirty
            ? { path: closeSavePath(live, deps.defaultSaveDir), overwrite: true }
            : {}),
        })
      }
      if (live.kind === 'pdf') {
        const control = deps.pdf,
          contents = requireContents(live, deps)
        if (!control)
          throw new Error('PDF close protection is unavailable; the document remains open.')
        const receipt = await control.prepareClose(contents, live.filePath, unsaved)
        try {
          if (!control.completeClose(contents, receipt, () => exactRemove(contents)))
            throw new Error('The PDF changed or its close permission expired; it remains open.')
          const cleanup = await control.cleanup(receipt)
          return {
            ...(receipt.cleanupId ? { cleanupId: receipt.cleanupId } : {}),
            ...(cleanup ? { cleanup } : {}),
          }
        } finally {
          await control.cancelClose(contents, receipt, 'MCP close finished')
        }
      }
      if (unsaved === 'discard' && live.kind === 'docs') {
        if (!deps.docs?.prepareDiscardClose || !deps.docs.completeSaveClose)
          throw new Error('The Word discard close lease is unavailable; the document remains open.')
        const contents = requireContents(live, deps)
        const lease = await deps.docs.prepareDiscardClose(contents.id, live.filePath ?? null)
        if (!lease)
          throw new Error(
            'The Word editor could not lock the approved discard revision; the document remains open.',
          )
        try {
          if (!deps.docs.completeSaveClose(contents.id, lease, () => exactRemove(contents)))
            throw new Error(
              'The Word discard lease expired or removal was refused; the document remains open.',
            )
        } finally {
          deps.docs.cancelSaveClose?.(contents.id, lease)
        }
        const journalCleanup = await deps.docs.closeCleanup?.(contents.id, lease)
        return journalCleanup ? { journalCleanup } : {}
      } else if (unsaved === 'save' && live.kind === 'docs') {
        if (!deps.docs) throw new Error('the Word editor is unavailable in this build')
        const target = closeSavePath(live, deps.defaultSaveDir)
        const contents = requireContents(live, deps)
        const value = await deps.docs.runCommand(contents.id, 'save_document', {
          path: target,
          overwrite: true,
          requireClean: true,
          sourcePath: live.filePath ?? null,
        })
        const receipt = value as {
          ok?: unknown
          published?: unknown
          current?: unknown
          clean?: unknown
          error?: unknown
          closeLease?: unknown
        } | null
        if (
          !receipt ||
          receipt.ok !== true ||
          typeof receipt.published !== 'boolean' ||
          receipt.current !== true ||
          receipt.clean !== true ||
          !receipt.closeLease ||
          !deps.docs.completeSaveClose
        ) {
          if (receipt?.closeLease) deps.docs.cancelSaveClose?.(contents.id, receipt.closeLease)
          const publication = receipt?.published === true ? 'An earlier revision was saved. ' : ''
          throw new Error(
            `${publication}The Word editor did not confirm the current document is fully persisted; the document remains open.`,
          )
        }
        const wcId = contents.id
        try {
          if (!deps.docs.completeSaveClose(wcId, receipt.closeLease, () => exactRemove(contents)))
            throw new Error(
              'The Word close lease expired or removal was refused; the document remains open.',
            )
        } catch (error) {
          deps.docs.cancelSaveClose?.(wcId, receipt.closeLease)
          throw error
        }
        const journalCleanup = await deps.docs.closeCleanup?.(wcId, receipt.closeLease)
        return {
          ...(receipt.published ? { savedPath: target } : {}),
          ...(journalCleanup ? { journalCleanup } : {}),
        }
      }
      if (live.kind === 'slides') {
        const control = deps.slides,
          contents = requireContents(live, deps)
        if (!control?.prepareClose || !control.completeClose || !control.cancelClose)
          throw new Error(
            'Slides complete close protection is unavailable; the document stayed open.',
          )
        const receipt = await control.prepareClose(
          contents.id,
          unsaved === 'save' ? closeSavePath(live, deps.defaultSaveDir) : live.filePath,
          unsaved === 'save' ? 'save' : 'discard',
        )
        try {
          if (!control.completeClose(contents.id, receipt, () => exactRemove(contents)))
            throw new Error('The presentation changed before actual removal; it stayed open.')
          const cleanup = receipt.cleanupId ? await awaitCloseCleanup(receipt.cleanupId) : undefined
          return {
            ...(unsaved === 'save' && receipt.published ? { savedPath: receipt.path } : {}),
            ...(receipt.cleanupId ? { cleanupId: receipt.cleanupId, cleanup } : {}),
          }
        } finally {
          await control.cancelClose(contents.id, receipt)
        }
      }
      if (live.kind === 'markdown') {
        if (!deps.markdown) throw new Error('The Markdown editor is unavailable.')
        const contents = requireContents(live, deps),
          target = unsaved === 'save' ? closeSavePath(live, deps.defaultSaveDir) : undefined
        const receipt = await deps.markdown.prepareClose(
          contents,
          target,
          unsaved === 'discard' ? 'discard' : 'save',
        )
        try {
          if (!deps.markdown.completeClose(contents, receipt, () => exactRemove(contents)))
            throw new Error(
              'The Markdown document changed or close permission expired; it remains open.',
            )
        } finally {
          await deps.markdown.cancelClose(contents, receipt, 'MCP close finished')
        }
        if (receipt.journalCleanup) {
          const status = await awaitCloseCleanup(receipt.journalCleanup.id)
          if (status) {
            receipt.journalCleanup = status
            if (receipt.cleanup)
              receipt.cleanup.journal =
                status.phase === 'complete'
                  ? 'complete'
                  : status.phase === 'retained'
                    ? 'retained'
                    : status.phase === 'canceled'
                      ? 'canceled'
                      : 'running'
            if (status.phase === 'retained')
              receipt.warnings = [
                ...(receipt.warnings ?? []),
                'The document closed, but recovery cleanup did not finish. Its protected copy was retained. ' +
                  (status.error ?? ''),
              ]
          }
        }
        return {
          ...(receipt.published && target ? { savedPath: target } : {}),
          ...(receipt.cleanup ? { cleanup: receipt.cleanup } : {}),
          ...(receipt.journalCleanup ? { journalCleanup: receipt.journalCleanup } : {}),
          ...(receipt.assetCleanup ? { assetCleanup: receipt.assetCleanup } : {}),
          ...(receipt.warnings?.length ? { warnings: receipt.warnings } : {}),
        }
      }
      if (live.kind === 'html') {
        if (!deps.html) throw new Error('The HTML editor is unavailable.')
        const contents = requireContents(live, deps),
          target = unsaved === 'save' ? closeSavePath(live, deps.defaultSaveDir) : undefined
        const receipt = await deps.html.prepareClose(
          contents,
          target,
          unsaved === 'discard' ? 'discard' : 'save',
        )
        try {
          if (!deps.html.completeClose(contents, receipt, () => exactRemove(contents)))
            throw new Error(
              'The HTML document changed or close permission expired; it remains open.',
            )
        } finally {
          await deps.html.cancelClose(contents, receipt, 'MCP close finished')
        }
        if (receipt.journalCleanup) {
          const status = await awaitCloseCleanup(receipt.journalCleanup.id)
          if (status) {
            receipt.journalCleanup = status
            if (receipt.cleanup)
              receipt.cleanup.journal =
                status.phase === 'complete'
                  ? 'complete'
                  : status.phase === 'retained'
                    ? 'retained'
                    : status.phase === 'canceled'
                      ? 'canceled'
                      : 'running'
            if (status.phase === 'retained')
              receipt.warnings = [
                ...(receipt.warnings ?? []),
                'The document closed, but recovery cleanup did not finish. Its protected copy was retained. ' +
                  (status.error ?? ''),
              ]
          }
        }
        return {
          ...(receipt.published && target ? { savedPath: target } : {}),
          ...(receipt.cleanup ? { cleanup: receipt.cleanup } : {}),
          ...(receipt.journalCleanup ? { journalCleanup: receipt.journalCleanup } : {}),
          ...(receipt.assetCleanup ? { assetCleanup: receipt.assetCleanup } : {}),
          ...(receipt.warnings?.length ? { warnings: receipt.warnings } : {}),
        }
      }
      throw new Error(`Cannot close a ${live.kind} tab through this tool.`)
    },
  }
}
