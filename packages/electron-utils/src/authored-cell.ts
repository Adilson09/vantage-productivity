let notificationDepth = 0
const pendingNotifications = new Set<() => void>()

/** Commit source stamps and related fields synchronously, then project once. */
export function batchAuthoredCells<Result>(action: () => Result): Result {
  notificationDepth++
  try {
    const result = action()
    if (result && typeof (result as {then?:unknown}).then === 'function')
      throw new Error('An authored cell batch must be synchronous; capture before awaiting.')
    return result
  } finally {
    notificationDepth--
    if (notificationDepth === 0) {
      const notifications = [...pendingNotifications]
      pendingNotifications.clear()
      for (const listener of notifications) listener()
    }
  }
}

export type AuthoredAction<State> = State | ((prior: State) => State)
export interface AuthoredCell<State> {
  getSnapshot(): State
  subscribe(listener: () => void): () => void
  set(action: AuthoredAction<State>): void
}

/** Canonical truth is synchronous; rendering is only a subscribed projection. */
export function createAuthoredCell<State>(
  initial: State,
  submit: (commit: () => void) => unknown,
): AuthoredCell<State> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (action) => {
      // Exactly one original submission. The author action never runs inside
      // React's replayable updater or a renderer's delayed projection.
      let applied = false
      submit(() => {
        if (applied) return
        applied = true
        const next = typeof action === 'function' ? (action as (prior: State) => State)(value) : action
        if (Object.is(next, value)) return
        value = next
        for (const listener of [...listeners]) {
          if (notificationDepth) pendingNotifications.add(listener)
          else listener()
        }
      })
    },
  }
}
