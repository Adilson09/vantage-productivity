import { describe, expect, it } from 'vitest'
import { NativeCloseAdmission } from '../src/native-close-admission'
describe('main-owned native prompt and automatic publication admission', () => {
  it('denies a blur/timer write until the exact native decision settles, then permits dirty retry', () => {
    const gate = new NativeCloseAdmission<number>(),
      hold = gate.hold(1, 1)!
    expect(gate.write(1, true)).toBeNull()
    hold.release()
    const write = gate.write(1, true)!
    expect(write).toBeTypeOf('function')
    expect(gate.busy(1)).toBe(true)
    write()
    expect(gate.busy(1)).toBe(false)
  })
  it('a manual publication invalidates native approval while retaining actual writer ownership', () => {
    const gate = new NativeCloseAdmission<number>(),
      hold = gate.hold(1, 1)!,
      write = gate.write(1, false)!
    expect(hold.current()).toBe(false)
    hold.release()
    expect(gate.hold(1, 1)).toBeNull()
    write()
    expect(gate.hold(1, 1)?.current()).toBe(true)
  })
  it('an exact main-correlated owned close write preserves its own prompt but invalidates peer decisions', () => {
    const source = {},
      gate = new NativeCloseAdmission<object>(),
      first = gate.hold(1, source)!,
      peer = gate.hold(2, source)!,
      write = gate.write(source, false, 1)!
    expect(first.current()).toBe(true)
    expect(peer.current()).toBe(false)
    first.release()
    peer.release()
    expect(gate.busy(source)).toBe(true)
    write()
    expect(gate.busy(source)).toBe(false)
  })
  it('one alias decision suppresses automatic publication by every alias sharing the same deck domain', () => {
    const source = {},
      gate = new NativeCloseAdmission<object>(),
      first = gate.hold(1, source)!,
      peer = gate.hold(2, source)!
    first.release()
    expect(gate.write(source, true)).toBeNull()
    peer.release()
    const retry = gate.write(source, true)!
    retry()
    expect(gate.busy(source)).toBe(false)
  })
  it('old release/destroy cannot release a replacement hold or free an unresolved writer', () => {
    const gate = new NativeCloseAdmission<number>(),
      old = gate.hold(1, 1)!
    gate.destroy(1)
    const current = gate.hold(1, 2)!
    old.release()
    expect(current.current()).toBe(true)
    expect(gate.write(2, true)).toBeNull()
    const writer = gate.write(2, false)!
    gate.destroy(1)
    expect(gate.busy(2)).toBe(true)
    writer()
    writer()
    expect(gate.busy(2)).toBe(false)
  })
  it('holds are refusal-only and grant no timer-renewable or reusable close permission', () => {
    const gate = new NativeCloseAdmission<number>(),
      hold = gate.hold(1, 1)!
    expect(gate.hold(1, 1)).toBeNull()
    hold.release()
    expect(hold.current()).toBe(false)
    const next = gate.hold(1, 1)!
    hold.release()
    expect(next.current()).toBe(true)
    next.release()
  })
})
