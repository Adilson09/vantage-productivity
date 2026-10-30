import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { createAuthoredCell, type AuthoredCell } from '@vantage/electron-utils/authored-cell'
import { CloseMutationBarrier } from '@vantage/electron-utils/renderer-close-barrier'

let source = 'pdf-initial'
let barrier: CloseMutationBarrier | undefined
let installing = 0
let retirement = 0
let fileRewrite = false
const cells = new Map<string, AuthoredCell<unknown>>()
const deferredSubscribers = new Set<() => void>()

export function configurePdfAuthoredBarrier(value: CloseMutationBarrier): void {
  barrier = value
}
export function pdfAuthoredSource(): string {
  return source
}
export function retirePdfAuthoredSource(expected: string): void {
  if (source === expected) source = `pdf-retired-${++retirement}`
}
export function pdfAuthoredSourceIsCurrent(expected: string): boolean {
  return installing > 0 || expected === source
}
export function pdfAuthoredBarrier(): CloseMutationBarrier {
  if (!barrier) throw new Error('PDF close protection is not initialized.')
  return barrier
}
export function submitPdfAuthored(action: () => void, expectedSource = source): boolean {
  if (installing) {
    if (barrier?.locked)
      throw new Error('A PDF source cannot change behind an active close decision.')
    return barrier ? barrier.mutate(action, source) : (action(), true)
  }
  if (expectedSource !== source) return false
  if (fileRewrite) return false
  return barrier ? barrier.mutate(action, expectedSource) : (action(), true)
}
/** Save/capture consumes canonical values; React only projects them to the screen. */
export function usePdfAuthoredState<Value>(
  key: string,
  initial: Value | (() => Value),
): [Value, Dispatch<SetStateAction<Value>>] {
  const cellRef = useRef<AuthoredCell<Value> | null>(null)
  const cellIdentity = useRef({ source, key })
  if (
    !cellRef.current ||
    cellIdentity.current.key !== key ||
    (key.startsWith('editor:') && cellIdentity.current.source !== source)
  ) {
    const value = typeof initial === 'function' ? (initial as () => Value)() : initial
    cellRef.current = createAuthoredCell(value, (commit) => commit())
    cells.set(key, cellRef.current as AuthoredCell<unknown>)
    cellIdentity.current = { source, key }
  }
  const cell = cellRef.current
  const expectedSource = source
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = cell.subscribe(() => {
        if (installing) deferredSubscribers.add(listener)
        else listener()
      })
      return () => {
        deferredSubscribers.delete(listener)
        unsubscribe()
      }
    },
    [cell],
  )
  const value = useSyncExternalStore(subscribe, cell.getSnapshot, cell.getSnapshot)
  const set = useCallback<Dispatch<SetStateAction<Value>>>(
    (action) => {
      submitPdfAuthored(() => cell.set(action), expectedSource)
    },
    [cell, expectedSource],
  )
  useEffect(() => {
    cells.set(key, cell as AuthoredCell<unknown>)
    return () => {
      if (cells.get(key) === cell) cells.delete(key)
    }
  }, [cell, key])
  return [value, set]
}
export function readPdfAuthored<Value>(key: string, fallback: Value): Value {
  return cells.has(key) ? (cells.get(key)!.getSnapshot() as Value) : fallback
}
/** No await is permitted inside this synchronous installation. All actual loading
 * work is reserved with runPdfAuthoredWork before adopting a new source. */
export function installPdfAuthoredSource<Value>(next: string, action: () => Value): Value {
  if (!next || next.length > 1024) throw new Error('Invalid PDF source generation.')
  if (barrier?.locked) throw new Error('The PDF is still reserved for closing.')
  installing++
  try {
    const result = action()
    if (result && typeof (result as unknown as Promise<unknown>).then === 'function')
      throw new Error('PDF source installation must finish synchronously.')
    source = next
    return result
  } finally {
    installing--
    if (!installing) {
      const listeners = [...deferredSubscribers]
      deferredSubscribers.clear()
      for (const listener of listeners) listener()
    }
  }
}
export function runPdfAuthoredWork<Value>(
  action: () => Value | Promise<Value>,
  expectedSource = source,
): Value | Promise<Value> {
  return barrier ? barrier.runMutationWork(action, expectedSource) : action()
}
/** File rewrites consume the on-disk post-Save order. Block authoring until its
 * verified reload is installed, rather than dropping edits typed during I/O. */
export async function withPdfFileRewrite<Value>(
  action: () => Promise<Value>,
  expectedSource: string,
): Promise<Value> {
  if (fileRewrite || expectedSource !== source || barrier?.locked)
    throw new Error('The PDF changed or another file operation is still finishing.')
  fileRewrite = true
  try {
    return await action()
  } finally {
    fileRewrite = false
  }
}
export function pdfFileRewriteHeld(expectedSource: string): boolean {
  return fileRewrite && expectedSource === source
}
