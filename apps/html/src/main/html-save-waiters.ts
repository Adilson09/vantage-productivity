import { randomUUID } from 'node:crypto'
import { setTimeout, clearTimeout } from 'node:timers'
interface SaveWaiter {
  id: string
  activation: string | null
  targetPath?: string
  settle: (clean: boolean) => void
  timer: ReturnType<typeof setTimeout>
}
/** Physical publication and final renderer cleanliness are distinct acknowledgments. */
export class HtmlSaveWaiters {
  private readonly pending = new Map<number, SaveWaiter>()
  constructor(private readonly timeoutMs = 120000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new Error('Invalid HTML Save acknowledgment budget.')
  }
  start(
    owner: number,
    activation: string | null,
    settle: (clean: boolean) => void,
    targetPath?: string,
  ): string {
    this.cancelOwner(owner)
    const id = randomUUID()
    const timer = setTimeout(() => this.finish(owner, id, activation, false), this.timeoutMs)
    timer.unref()
    this.pending.set(owner, { id, activation, settle, timer, targetPath })
    return id
  }
  matches(owner: number, id: unknown, activation: string | null): boolean {
    const current = this.pending.get(owner)
    return (
      typeof id === 'string' && !!current && current.id === id && current.activation === activation
    )
  }
  targetFor(owner: number, id: unknown, activation: string | null): string | undefined {
    return this.matches(owner, id, activation) ? this.pending.get(owner)!.targetPath : undefined
  }
  writeResult(owner: number, id: unknown, activation: string | null, ok: boolean): void {
    if (!this.matches(owner, id, activation)) return
    // Successful write IPC returns promptly; its waiter remains owned until the
    // same renderer request acknowledges current, fully clean source.
    if (!ok) this.finish(owner, id, activation, false)
  }
  finish(owner: number, id: unknown, activation: string | null, clean: boolean): boolean {
    const current = this.pending.get(owner)
    if (!current || typeof id !== 'string' || current.id !== id) return false
    this.pending.delete(owner)
    clearTimeout(current.timer)
    current.settle(clean && activation === current.activation)
    return true
  }
  cancelOwner(owner: number): void {
    const current = this.pending.get(owner)
    if (current) this.finish(owner, current.id, current.activation, false)
  }
}
