import {
  CloseMutationBarrier,
  installCloseInputFence,
} from '../../../../packages/electron-utils/src/renderer-close-barrier'
import {
  createAuthoredCell,
  type AuthoredCell,
} from '../../../../packages/electron-utils/src/authored-cell'
import type { CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
export interface SlidesAuthoredScope {
  source: string
  callbacks: number
}
/** Canonical cells and async scopes are independent of React render/replay. */
export class SlidesAuthoredRuntime {
  private readonly instance = crypto.randomUUID()
  private generation = 0
  private callbacks = 0
  private dead = false
  private retired = false
  private readonly cells = new Map<string, { getSnapshot(): unknown }>()
  private readonly workCounts = new Map<string, number>()
  private participant: () => string | null = () => null
  private readonly extraParticipants = new Set<() => string | null>()
  private pendingCanceled: () => void = () => {}
  private readonly readyListeners = new Set<() => void>()
  readonly barrier: CloseMutationBarrier
  constructor(
    private readonly api: {
      claimCloseLease(ticket: CloseLeaseTicket): Promise<boolean>
      cancelCloseLease(ticket: CloseLeaseTicket, reason: string): Promise<void>
    },
    private readonly report: (error: unknown) => void,
  ) {
    this.barrier = new CloseMutationBarrier({
      source: () => this.source(),
      claim: (ticket) => api.claimCloseLease(ticket),
      cancel: (ticket, reason) => api.cancelCloseLease(ticket, reason),
      report,
    })
  }
  source(): string {
    return this.instance + ':' + this.generation
  }
  scope(): SlidesAuthoredScope {
    return { source: this.source(), callbacks: this.callbacks }
  }
  current(scope: SlidesAuthoredScope): boolean {
    return !this.dead && scope.source === this.source() && scope.callbacks === this.callbacks
  }
  assert(scope: SlidesAuthoredScope): void {
    if (!this.current(scope))
      throw new Error('This pending edit belongs to a retired presentation or dialog.')
  }
  cell<State>(name: string, initial: () => State): AuthoredCell<State> {
    const existing = this.cells.get(name)
    // Names retain their original stable per-key State contract. The heterogeneous
    // registry stores only the covariant snapshot view, never an unknown setter.
    if (existing) return existing as AuthoredCell<State>
    const projection = [
      'slides',
      'path',
      'defaultFont',
      'comments',
      'animations',
      'transition',
      'sections',
      'masterItems',
      'dirty',
      'current',
      'slideSelRaw',
      'selectedIds',
      'enteredGroupId',
      'ungroupedSets',
      'viewMode',
    ].includes(name)
    const created = createAuthoredCell<State>(initial(), (commit) => {
      if (!this.dead) {
        if (projection && !this.barrier.locked) commit()
        else this.barrier.mutate(commit)
      }
    })
    const set = created.set
    created.set = (action) => {
      if (typeof action !== 'function' && Object.is(action, created.getSnapshot())) return
      set(action)
    }
    this.cells.set(name, created)
    return created
  }
  read<State>(name: string): State {
    return this.cells.get(name)!.getSnapshot() as State
  }
  bindSetter<Args extends unknown[]>(
    setter: (...args: Args) => void,
    scope = this.scope(),
  ): (...args: Args) => void {
    return (...args) => {
      if (this.current(scope)) this.barrier.mutate(() => setter(...args), scope.source)
    }
  }
  get busy(): boolean {
    return this.barrier.busy || (this.workCounts.get(this.source() + ':' + this.callbacks) ?? 0) > 0
  }
  reason(): string | null {
    if (this.busy) return 'A presentation operation is still finishing.'
    const own = this.participant()
    if (own) return own
    for (const check of this.extraParticipants) {
      const reason = check()
      if (reason) return reason
    }
    return null
  }
  mutate(scope: SlidesAuthoredScope, action: () => void): void {
    if (this.current(scope)) this.barrier.mutate(action, scope.source)
  }
  participants(check: () => string | null): void {
    this.participant = check
  }
  registerParticipant(check: () => string | null): () => void {
    this.extraParticipants.add(check)
    return () => this.extraParticipants.delete(check)
  }
  onPendingCanceled(callback: () => void): void {
    this.pendingCanceled = callback
  }
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener)
    return () => {
      this.readyListeners.delete(listener)
    }
  }
  notifyReady(): void {
    if (this.dead || this.barrier.locked || this.reason()) return
    for (const listener of [...this.readyListeners])
      try {
        listener()
      } catch (error) {
        this.report(error)
      }
  }
  async wait<Result>(
    scope: SlidesAuthoredScope,
    work: PromiseLike<Result> | Result,
  ): Promise<Result> {
    const result = await work
    this.assert(scope)
    return result
  }
  async work<Result>(scope: SlidesAuthoredScope, action: () => Promise<Result>): Promise<Result> {
    this.assert(scope)
    for (;;) {
      await this.barrier.beforeMutation(scope.source)
      this.assert(scope)
      if (!this.barrier.locked) break
    }
    const key = scope.source + ':' + scope.callbacks
    this.workCounts.set(key, (this.workCounts.get(key) ?? 0) + 1)
    try {
      return await action()
    } finally {
      const count = (this.workCounts.get(key) ?? 1) - 1
      if (count) this.workCounts.set(key, count)
      else this.workCounts.delete(key)
      this.notifyReady()
    }
  }
  /** Old promises stay owned, but every bound setter/API/await rejects their retired callback generation. */
  cancelPending(): void {
    this.callbacks++
    this.pendingCanceled()
  }
  adopt(): void {
    if (this.barrier.locked)
      throw new Error('Cancel the current close before changing presentations.')
    this.generation++
    this.callbacks++
  }
  attach(): void {
    if (this.retired) throw new Error('This presentation renderer owner was retired.')
    this.dead = false
  }
  suspend(): void {
    this.dead = true
  }
  retire(): void {
    this.retired = true
    this.dead = true
    this.generation++
    this.callbacks++
  }
  bindApi<Api extends object>(api: Api, scope = this.scope()): Api {
    return new Proxy(api, {
      get: (target, name) => {
        const value = Reflect.get(target, name)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          this.assert(scope)
          const result = value.apply(target, args)
          return result && typeof result.then === 'function'
            ? Promise.resolve(result).then((output) => {
                this.assert(scope)
                return output
              })
            : result
        }
      },
    })
  }
  install(root: Document): () => void {
    const input = installCloseInputFence(this.barrier, root)
    const owned = new Map<string, () => void>()
    const begin = (key: string) => {
      if (this.barrier.locked || owned.has(key)) return
      let done!: () => void
      const work = new Promise<void>((resolve) => {
        done = resolve
      })
      owned.set(key, done)
      void this.barrier.runMutationWork(() => work)
    }
    const start = (e: Event) => begin(e.type === 'compositionstart' ? 'ime' : 'pointer')
    const end = (e: Event) => {
      const key = e.type === 'compositionend' ? 'ime' : 'pointer'
      owned.get(key)?.()
      owned.delete(key)
    }
    for (const name of ['pointerdown', 'compositionstart']) root.addEventListener(name, start, true)
    for (const name of ['pointerup', 'pointercancel', 'compositionend'])
      root.addEventListener(name, end, true)
    const blur = () => {
      for (const done of owned.values()) done()
      owned.clear()
    }
    window.addEventListener('blur', blur)
    return () => {
      input()
      for (const name of ['pointerdown', 'compositionstart'])
        root.removeEventListener(name, start, true)
      for (const name of ['pointerup', 'pointercancel', 'compositionend'])
        root.removeEventListener(name, end, true)
      window.removeEventListener('blur', blur)
      blur()
    }
  }
}
let active: SlidesAuthoredRuntime | null = null
export function configureSlidesAuthored(value: SlidesAuthoredRuntime | null): void {
  active = value
}
export function slidesAuthored(): SlidesAuthoredRuntime | null {
  return active
}
