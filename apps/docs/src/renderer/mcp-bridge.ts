import type { Editor } from '@tiptap/react'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@vantage/docx-engine'
import type {
  McpCommandMessage, McpEditorCommand, DocMcpSaveInput, DocMcpSaveCompletion,
} from '../shared/ipc'
import { executeTool, markDocSeen } from './ai/tools'
import { findNumId, type NumIds } from './ai/protocol'
import {
  save, currentDocGeneration, currentRecoverySequence, canCloseSavedDocument, type FileActionContext,
} from './file-actions'
import { saveUntilPersisted } from './save-until-persisted'
import { isCloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
import { docCloseBarrier, installDocCloseLease, releaseDocCloseAfterFailure } from './doc-close-lease'

/**
 * MCP bridge (renderer half).
 *
 * The shell main process pushes editor commands over `docs:mcp-command`; this
 * module runs them against the *live* Tiptap editor so an external agent drives
 * the same visible editor the built-in agent does, then reports the outcome
 * back on `docs:mcp-result`. Command execution is serialized so a burst cannot
 * interleave two edits into one document.
 *
 * The executors are the built-in agent's own (`executeTool`), so external edits
 * inherit the same parsing, atomicity, formatting rules and stale-index guard.
 */

export interface McpBridgeDeps {
  /** live file-action context (refreshed every render by App) */
  getCtx: () => FileActionContext
}

function numIdsFor(ctx: FileActionContext): NumIds {
  const blocks = ctx.doc?.parsed.blocks ?? []
  const isBlank = ctx.doc?.isBlank === true
  return {
    bullet: findNumId(blocks, 'bullet') ?? (isBlank ? BLANK_BULLET_NUM_ID : null),
    ordered: findNumId(blocks, 'ordered') ?? (isBlank ? BLANK_ORDERED_NUM_ID : null),
  }
}

/** the payload shapes this bridge accepts per command (validated by the executors) */
interface InsertContentInput {
  html: string
  afterBlockIndex?: number
}
interface ReplaceBlocksInput {
  startBlockIndex: number
  endBlockIndex: number
  html: string
}
interface ApplyOpsInput {
  ops: unknown[]
  dryRun?: boolean
}
interface InsertPictureInput {
  url: string
  afterBlockIndex?: number
  width?: number | string
  height?: number | string
  float?: unknown
  altText?: string
}

/** mirror of AiPanel's clearAiHighlights: auto-accept the external edit, keeping undo history */
function clearAiChangedFlags(editor: Editor): void {
  const view = editor.view
  let tr = view.state.tr
  let touched = false
  view.state.doc.forEach((node, offset) => {
    if (node.attrs.aiChanged) {
      tr = tr.setNodeMarkup(offset, undefined, { ...node.attrs, aiChanged: false })
      touched = true
    }
  })
  if (!touched) return
  tr = tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  markDocSeen(editor)
}

/**
 * The executors are shared with the in-app agent, whose tool set includes
 * `get_document_context`. That name does not exist on the MCP surface, where the
 * same readout is `read_document` — so hinting at it would send an external
 * agent chasing a tool it cannot call. Rename the reference on the way out.
 */
function mcpErrorText(output: string): string {
  return output.replaceAll('get_document_context', 'read_document')
}

async function runCommand(
  deps: McpBridgeDeps,
  command: McpEditorCommand,
  payload: unknown,
  requestId: string,
): Promise<unknown> {
  const ctx = deps.getCtx()
  const editor = ctx.editor
  if (!editor || !ctx.doc) throw new Error('the document is not ready')

  switch (command) {
    case 'insert_content': {
      const input = (payload ?? {}) as InsertContentInput
      if (typeof input.html !== 'string') throw new Error('insert_content requires "html"')
      // The shared executor clamps an out-of-range afterBlockIndex to the last
      // block, so a mistyped index quietly inserts somewhere unintended while
      // replace_blocks rejects the same mistake. Reject it here too — the
      // in-app agent keeps the clamping behavior it was built around.
      if (input.afterBlockIndex !== undefined) {
        const last = editor.state.doc.childCount - 1
        if (!Number.isInteger(input.afterBlockIndex) || input.afterBlockIndex < -1) {
          throw new Error(`afterBlockIndex must be an integer >= -1 (got ${input.afterBlockIndex})`)
        }
        if (input.afterBlockIndex > last) {
          throw new Error(
            `afterBlockIndex ${input.afterBlockIndex} is out of range (valid: -1..${last}); ` +
              'call read_document for fresh block indexes',
          )
        }
      }
      const outcome = await executeTool(
        editor,
        { id: 'mcp', name: 'insert_content', input: { ...input } },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      clearAiChangedFlags(editor)
      return { summary: outcome.summary, mutated: outcome.mutated }
    }

    case 'replace_blocks': {
      const input = (payload ?? {}) as ReplaceBlocksInput
      if (typeof input.html !== 'string') throw new Error('replace_blocks requires "html"')
      const outcome = await executeTool(
        editor,
        { id: 'mcp', name: 'replace_blocks', input: { ...input } },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      clearAiChangedFlags(editor)
      return { summary: outcome.summary, mutated: outcome.mutated }
    }

    case 'apply_ops': {
      const input = (payload ?? {}) as ApplyOpsInput
      // Route through executeTool rather than executeOps: the wrapper is what
      // refuses a block-indexed batch after the user edited the document (the
      // stale-index guard) and supplies numbering ids, so an external batch
      // behaves exactly like the built-in agent's.
      const outcome = await executeTool(
        editor,
        {
          id: 'mcp',
          name: 'apply_ops',
          input: { ops: input.ops, ...(input.dryRun === true ? { dryRun: true } : {}) },
        },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      if (input.dryRun !== true) clearAiChangedFlags(editor)
      return { summary: outcome.summary, output: outcome.output, mutated: outcome.mutated }
    }

    case 'insert_picture': {
      const input = (payload ?? {}) as InsertPictureInput
      // The shared executor validates the url scheme, the block-index range, the
      // size fields and the float spec, and fetches the image exactly like the
      // built-in agent's insert_picture (its stale-index guard applies too).
      const outcome = await executeTool(
        editor,
        { id: 'mcp', name: 'insert_picture', input: { ...input } },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      clearAiChangedFlags(editor)
      return { summary: outcome.summary, mutated: outcome.mutated }
    }

    case 'read_document': {
      const outcome = await executeTool(
        editor,
        { id: 'mcp', name: 'get_document_context', input: {} },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(mcpErrorText(outcome.output))
      return { text: outcome.output }
    }

    case 'save_document': {
      const input = (payload ?? {}) as DocMcpSaveInput
      if (typeof input.path !== 'string' || !input.path) {
        throw new Error('save_document requires an absolute "path"')
      }
      if (input.requireClean !== undefined && typeof input.requireClean !== 'boolean')
        throw new Error('save_document requires a Boolean internal requireClean option')
      const generation = currentDocGeneration()
      const path = input.path
      let reason = ''
      let published = false
      const isCurrent = () => currentDocGeneration() === generation
      const canClose = () => canCloseSavedDocument(deps.getCtx(), generation)
      const finish = (complete: boolean): DocMcpSaveCompletion => {
        const clean = complete && canClose()
        const current = isCurrent()
        const savedPath = published ? path : current ? deps.getCtx().doc?.filePath : undefined
        return {
          ok: true, throughSequence:currentRecoverySequence(),published, current, clean: current && clean,
          ...(savedPath ? { path: savedPath } : {}),
          ...(reason ? { error: reason } : {}),
        }
      }
      const publish = async (): Promise<boolean> => {
        const ok = await save(deps.getCtx(), false, true, undefined, {
          path,
          overwrite: input.overwrite === true,
          onError: (message) => (reason = message),
        }, ...(input.requireClean&&isCloseLeaseTicket(input.closeTicket)?[input.closeTicket] as const:[] as const))
        published ||= ok
        return ok
      }
      if (input.requireClean) {
        if (!Object.hasOwn(input, 'sourcePath') ||
          (input.sourcePath !== null && typeof input.sourcePath !== 'string'))
          throw new Error('An internal close-save request requires its sourcePath')
        if (input.sourcePath !== (ctx.doc?.filePath ?? null))
          return { ok: true, throughSequence:currentRecoverySequence(),published: false, current: false, clean: false }
        if (!isCloseLeaseTicket(input.closeTicket) || input.closeTicket.id !== requestId)
          throw new Error('The internal close request has no valid main-owned ticket.')
        const ticket = input.closeTicket
        // Consult the renderer even when main's dirty mirror says clean. A
        // genuinely clean document needs no new publication or invented path.
        try {
          if (docCloseBarrier.busy) { await releaseDocCloseAfterFailure(ticket); return finish(false) }
          window.dispatchEvent(new Event('ai-docs-commit-tables'))
          const complete = canClose() || await saveUntilPersisted({
            save: publish,
            wasIncomplete: () => deps.getCtx().saveIncompleteRef.current,
            hasPath: () => true,
            isCurrent,
            canClose,
          })
          if (!complete || !isCurrent()) {
            await releaseDocCloseAfterFailure(ticket)
            return finish(false)
          }
          const stamp = await docCloseBarrier.acquire(ticket, () => isCurrent() && canClose())
          const result = finish(stamp !== null)
          if (!stamp || !result.current || !result.clean || !docCloseBarrier.locked) {
            await releaseDocCloseAfterFailure(ticket)
            return finish(false)
          }
          // Held until main commits actual removal or explicitly cancels/expires.
          return { ...result, closeLease: { ticket, stamp } }
        } catch (error) {
          await releaseDocCloseAfterFailure(ticket)
          throw error
        }
      }
      if (!(await publish())) throw new Error(reason || 'the document could not be saved')
      return finish(true)
    }

    default: {
      const unreachable: never = command
      throw new Error(`unknown MCP command: ${String(unreachable)}`)
    }
  }
}

/**
 * A fresh tab boots asynchronously (`newFile()` calls setContent, then setDoc),
 * so a command that lands before `doc` exists would be wiped by that blank
 * reset. Wait for the loaded document before announcing readiness.
 *
 * The wait never stops retrying, only slows down: a tab that gave up while its
 * renderer was still booting would look fine in the UI yet stay unaddressable
 * over MCP for the rest of its life, because readiness is announced exactly
 * once and never re-derived.
 */
const READY_POLL_MS = 50
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000

async function announceWhenLoaded(
  deps: McpBridgeDeps,
  signal: () => void,
  isCancelled: () => boolean,
): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    if (isCancelled()) return
    const ctx = deps.getCtx()
    if (ctx?.editor && ctx.doc) {
      signal()
      return
    }
    const slow = Date.now() - startedAt > READY_FAST_WINDOW_MS
    await new Promise((resolve) => setTimeout(resolve, slow ? READY_SLOW_POLL_MS : READY_POLL_MS))
  }
}

/** Subscribe the live editor to MCP commands. Returns the unsubscribe function. */
export function installMcpBridge(deps: McpBridgeDeps): () => void {
  const desktop = window.desktop
  if (!desktop?.onMcpCommand || !desktop.reportMcpResult) return () => {}
  let cancelled = false
  const disposeClose = installDocCloseLease((error) => deps.getCtx().setStatus(String(error)))
  let queue: Promise<void> = Promise.resolve()
  const unsubscribe = desktop.onMcpCommand((message: McpCommandMessage) => {
    if (!message || typeof message.requestId !== 'string') return
    queue = queue.then(async () => {
      try {
        const closing = message.command === 'save_document' &&
          (message.payload as DocMcpSaveInput | null)?.requireClean === true
        if (!closing && message.command !== 'read_document') await docCloseBarrier.beforeMutation()
        const result = await runCommand(deps, message.command, message.payload, message.requestId)
        desktop.reportMcpResult({ requestId: message.requestId, ok: true, result })
      } catch (error) {
        desktop.reportMcpResult({
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  })
  // Let the shell know this tab can accept commands (device for targeted routing).
  void announceWhenLoaded(
    deps,
    () => desktop.signalMcpReady?.(),
    () => cancelled,
  )
  return () => {
    cancelled = true
    disposeClose()
    unsubscribe()
  }
}
