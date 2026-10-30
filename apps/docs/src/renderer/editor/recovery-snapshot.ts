import type { Editor } from '@tiptap/core'
import type { Node as ModelNode } from '@tiptap/pm/model'
import { flushSync } from 'react-dom'
import type { PmNode } from './convert'

export const RECOVERY_SNAPSHOT_EVENT = 'vantage-docs-recovery-snapshot'

interface PendingSnapshot {
  patches: Map<number, Record<string, unknown>>
  changed: boolean
  error: unknown
}

function detailOf(event?: Event): PendingSnapshot | null {
  return event?.type === RECOVERY_SNAPSHOT_EVENT
    ? (event as CustomEvent<PendingSnapshot>).detail
    : null
}

/** Return true for a dry-run capture, leaving the live model and caret untouched. */
export function captureRecoveryAttrs(
  event: Event | undefined,
  position: number,
  attributes: Record<string, unknown>,
): boolean {
  const detail = detailOf(event)
  if (!detail) return false
  if (!Number.isSafeInteger(position) || position < 0)
    throw new Error('An editable document surface has no snapshot position.')
  detail.patches.set(position, { ...detail.patches.get(position), ...attributes })
  detail.changed = true
  return true
}

export function markRecoveryPending(event: Event): void {
  const detail = detailOf(event)
  if (detail) detail.changed = true
}

/** DOM dispatch normally hides listener exceptions from its caller; snapshots fail closed. */
export function recoverySnapshotListener(capture: (event: Event) => void): EventListener {
  return (event) => {
    try {
      capture(event)
    } catch (error) {
      const detail = detailOf(event)
      if (detail) detail.error = error
    }
  }
}

export function captureRecoverySurfaces(editor: Editor): {
  document: PmNode | undefined
  changed: boolean
} {
  const detail: PendingSnapshot = { patches: new Map(), changed: false, error: null }
  flushSync(() => window.dispatchEvent(new CustomEvent(RECOVERY_SNAPSHOT_EVENT, { detail })))
  if (detail.error) throw detail.error
  if (detail.patches.size === 0) return { document: undefined, changed: detail.changed }
  const copy = (node: ModelNode, position: number): PmNode => {
    const json: PmNode = { type: node.type.name }
    if (Object.keys(node.attrs).length) json.attrs = { ...node.attrs }
    if (node.marks.length) json.marks = node.marks.map((mark) => mark.toJSON())
    if (node.isText) json.text = node.text
    const patch = detail.patches.get(position)
    if (patch) json.attrs = { ...json.attrs, ...patch }
    if (node.childCount) {
      json.content = []
      node.forEach((child, offset) => {
        json.content!.push(copy(child, node.type.name === 'doc' ? offset : position + 1 + offset))
      })
    }
    return json
  }
  for (const position of detail.patches.keys())
    if (!editor.state.doc.nodeAt(position))
      throw new Error('An editable document surface changed during recovery capture.')
  return { document: copy(editor.state.doc, -1), changed: detail.changed }
}
