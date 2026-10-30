import {
  createAuthoredCell,
  type AuthoredCell,
} from '../../../../packages/electron-utils/src/authored-cell'
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { docCloseBarrier, docMutationSource } from './doc-close-lease'

export interface DocAuthoredScope {
  cells: Map<string, { value: () => unknown }>
}
const Scope = createContext<DocAuthoredScope | null>(null)

export function DocAuthoredStateProvider({ children }: { children: ReactNode }) {
  const scope = useMemo<DocAuthoredScope>(() => ({ cells: new Map() }), [])
  return createElement(Scope.Provider, { value: scope }, children)
}

export function useDocAuthoredScope(): DocAuthoredScope {
  const scope = useContext(Scope)
  if (!scope) throw new Error('Authored document state requires its document scope.')
  return scope
}

/** Authored actions run once in the canonical cell; React only projects immutable values. */
export function useDocAuthoredState<State>(
  name: string,
  initial: State | (() => State),
): [State, Dispatch<SetStateAction<State>>]
export function useDocAuthoredState<State = undefined>(
  name: string,
): [State | undefined, Dispatch<SetStateAction<State | undefined>>]
export function useDocAuthoredState<State>(name: string, initial?: State | (() => State)) {
  const scope = useDocAuthoredScope()
  const ref = useRef<AuthoredCell<State | undefined> | null>(null)
  if (!ref.current)
    ref.current = createAuthoredCell<State | undefined>(
      typeof initial === 'function' ? (initial as () => State)() : initial,
      (commit) => docCloseBarrier.mutate(commit, docMutationSource()),
    )
  const cell = ref.current
  scope.cells.set(name, { value: cell.getSnapshot })
  const value = useSyncExternalStore(cell.subscribe, cell.getSnapshot, cell.getSnapshot)
  const set = cell.set
  return [value, set] as [State | undefined, Dispatch<SetStateAction<State | undefined>>]
}

export function readDocAuthored<State>(
  scope: DocAuthoredScope,
  name: string,
  fallback: State,
): State {
  return scope.cells.has(name) ? (scope.cells.get(name)!.value() as State) : fallback
}

/** Live gates use this view; writers synchronously spread a represented snapshot. */
export function withDocAuthoredContext<Context extends object>(
  context: Context,
  scope: DocAuthoredScope,
  derived: Record<string, () => unknown> = {},
): Context {
  return new Proxy(context, {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        if (derived[property]) return derived[property]()
        const cell = scope.cells.get(property)
        if (cell) return cell.value()
      }
      return Reflect.get(target, property, receiver)
    },
  })
}
