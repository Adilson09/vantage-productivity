import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CloseMutationBarrier,
  installCloseInputFence,
} from '../../../packages/electron-utils/src/renderer-close-barrier'
import { installDocInputReservations } from '../src/renderer/doc-input-reservations'
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean()
})
function fixture() {
  const barrier = new CloseMutationBarrier({
    source: () => 'A',
    claim: async () => true,
    cancel: async () => {},
    report: vi.fn(),
  })
  cleanups.push(
    installCloseInputFence(barrier, document),
    installDocInputReservations(barrier, () => 'A', vi.fn()),
  )
  return barrier
}
const ticket = (sequence: number) => ({ id: `input-${sequence}`, sequence, source: 'main-A' })
describe('Docs pending gesture reservations', () => {
  it.each([
    ['pointerdown', 'pointerup'],
    ['compositionstart', 'compositionend'],
  ])('refuses readiness during %s and allows it only after %s', async (start, end) => {
    const barrier = fixture()
    document.dispatchEvent(new Event(start, { bubbles: true }))
    expect(barrier.busy).toBe(true)
    expect(await barrier.acquire(ticket(1), () => true)).toBeNull()
    document.dispatchEvent(new Event(end, { bubbles: true }))
    await vi.waitFor(() => expect(barrier.busy).toBe(false))
    expect(await barrier.acquire(ticket(2), () => true)).not.toBeNull()
  })
  it('does not admit a new held input gesture behind a ready lease', async () => {
    const barrier = fixture()
    await barrier.acquire(ticket(3), () => true)
    const input = new Event('pointerdown', { bubbles: true, cancelable: true })
    document.dispatchEvent(input)
    expect(input.defaultPrevented).toBe(true)
    expect(barrier.busy).toBe(false)
  })
  it('releases abandoned input reservations on window blur and disposal', async () => {
    const barrier = fixture()
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    window.dispatchEvent(new Event('blur'))
    await vi.waitFor(() => expect(barrier.busy).toBe(false))
    document.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    for (const clean of cleanups.splice(0)) clean()
    await vi.waitFor(() => expect(barrier.busy).toBe(false))
  })
})
