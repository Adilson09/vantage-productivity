import type { WorkbookWriteContext } from '../shared/desktop-api'

export const AUTOMATIC_WORKBOOK_WRITE: Readonly<WorkbookWriteContext> = Object.freeze({
  origin: 'automatic',
})

interface BlurTarget {
  addEventListener(type: 'blur', listener: () => void): void
  removeEventListener(type: 'blur', listener: () => void): void
}

/** The actual App timer/blur seam always carries its automatic provenance to main. */
export function installAutomaticWorkbookWriteLoop(options: {
  intervalMs: number
  target?: BlurTarget
  setInterval(callback: () => void, milliseconds: number): unknown
  clearInterval(timer: unknown): void
  write(context: Readonly<WorkbookWriteContext>): void | Promise<unknown>
  report?(error: unknown): void
}): () => void {
  let disposed = false
  const tick = () => {
    if (disposed) return
    try {
      void Promise.resolve(options.write(AUTOMATIC_WORKBOOK_WRITE)).catch((error) =>
        options.report?.(error),
      )
    } catch (error) {
      options.report?.(error)
    }
  }
  const timer = options.setInterval(tick, options.intervalMs)
  options.target?.addEventListener('blur', tick)
  return () => {
    disposed = true
    options.clearInterval(timer)
    options.target?.removeEventListener('blur', tick)
  }
}
