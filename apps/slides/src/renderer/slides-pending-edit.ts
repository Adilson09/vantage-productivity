import type { SlidesPendingText } from '../shared/slides-draft'

interface PendingEditor {
  capture: () => SlidesPendingText | null
  composing: () => boolean
  commit: () => Promise<void>
}
let editor: PendingEditor | null = null
let generation = 0
const commits = new Set<Promise<void>>()
const listeners = new Set<() => void>()
const errorListeners = new Set<(error: unknown) => void>()
export function notifySlidesPendingChanged(): void {
  for (const listener of listeners) listener()
}
export function onSlidesPendingChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function onSlidesEditCommitError(listener: (error: unknown) => void): () => void {
  errorListeners.add(listener)
  return () => {
    errorListeners.delete(listener)
  }
}
export function registerSlidesPendingEditor(value: PendingEditor): () => void {
  editor = value
  notifySlidesPendingChanged()
  return () => {
    if (editor === value) {
      editor = null
      notifySlidesPendingChanged()
    }
  }
}
export function retireSlidesPendingEditor(): void {
  generation++
  editor = null
  commits.clear()
  notifySlidesPendingChanged()
}
export function captureSlidesPendingText(): { text?: SlidesPendingText; composing: boolean } {
  const text = editor?.capture()
  return { ...(text ? { text } : {}), composing: editor?.composing() ?? false }
}
export function slidesEditIsComposing(): boolean {
  return editor?.composing() ?? false
}
export function trackSlidesEditCommit(operation: () => void | Promise<void>): Promise<void> {
  const epoch = generation
  const pending = Promise.resolve().then(() => {
    if (epoch === generation) return operation()
  })
  commits.add(pending)
  void pending.then(
    () => {
      commits.delete(pending)
      notifySlidesPendingChanged()
    },
    (error) => {
      commits.delete(pending)
      notifySlidesPendingChanged()
      if (epoch === generation) for (const listener of errorListeners) listener(error)
    },
  )
  return pending
}
export async function flushSlidesPendingEditor(): Promise<void> {
  if (editor?.composing()) throw new Error('Finish composing the current text before saving.')
  if (editor) await editor.commit()
  while (commits.size) await Promise.all([...commits])
}
