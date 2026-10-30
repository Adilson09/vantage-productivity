import { describe, expect, it, vi } from 'vitest'
import {
  DocumentCheckpointLoop,
  type CheckpointObservation,
} from '../src/renderer/document-checkpoint-loop'

function fixture() {
  let state: CheckpointObservation | null = {
    sessionId: 'one',
    generation: 1,
    pending: true,
    paused: false,
  }
  let now = 0
  const checkpoint = vi.fn(async () => ({ ok: true }))
  const loop = new DocumentCheckpointLoop({ observe: () => state, checkpoint, now: () => now })
  return {
    loop,
    checkpoint,
    state: () => state!,
    update: (patch: Partial<CheckpointObservation>) => {
      state = { ...state!, ...patch }
    },
    setTime: (value: number) => {
      now = value
    },
  }
}

describe('document checkpoints independent of calculation and edit counts', () => {
  it('does not create recovery state for viewing a clean workbook', async () => {
    const f = fixture()
    f.update({ pending: false })
    await f.loop.poll()
    expect(f.checkpoint).not.toHaveBeenCalled()
  })

  it('persists repeated edits to the same target even when the badge count is unchanged', async () => {
    const f = fixture()
    await f.loop.poll()
    await f.loop.poll()
    f.update({ generation: 2 })
    await f.loop.poll()
    expect(f.checkpoint).toHaveBeenCalledTimes(2)
  })

  it('coalesces in-flight work without acknowledging a later unsent generation', async () => {
    const f = fixture()
    let finish!: (value: { ok: boolean }) => void
    f.checkpoint.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = f.loop.poll()
    await Promise.resolve()
    f.update({ generation: 2 })
    expect(f.loop.poll()).toBe(first)
    finish({ ok: true })
    await first
    await f.loop.poll()
    expect(f.checkpoint).toHaveBeenCalledTimes(2)
  })

  it('retries a failed checkpoint with backoff and permits a fresh edit immediately', async () => {
    const f = fixture()
    f.checkpoint.mockResolvedValueOnce({ ok: false })
    await f.loop.poll()
    await f.loop.poll()
    expect(f.checkpoint).toHaveBeenCalledTimes(1)
    f.setTime(1_000)
    await f.loop.poll()
    expect(f.checkpoint).toHaveBeenCalledTimes(2)
    f.update({ generation: 3 })
    await f.loop.poll()
    expect(f.checkpoint).toHaveBeenCalledTimes(3)
  })

  it('replaces an earlier draft after undo to clean, then stops creating empty drafts', async () => {
    const f = fixture()
    await f.loop.poll()
    f.update({ generation: 2, pending: false })
    await f.loop.poll()
    f.update({ generation: 3 })
    await f.loop.poll()
    expect(f.checkpoint).toHaveBeenCalledTimes(2)
  })

  it('does not start deferred work after disposal', async () => {
    const f = fixture()
    const pending = f.loop.poll()
    f.loop.dispose()
    await pending
    expect(f.checkpoint).not.toHaveBeenCalled()
  })

  it('rechecks session ownership before starting deferred work', async () => {
    const f = fixture()
    const pending = f.loop.poll()
    f.update({ sessionId: 'two' })
    await pending
    expect(f.checkpoint).not.toHaveBeenCalled()
    await f.loop.poll()
    expect(f.checkpoint).toHaveBeenCalledTimes(1)
  })

  it('pauses for an active editor or save and resumes without losing the generation', async () => {
    const f = fixture()
    const pending = f.loop.poll()
    f.update({ paused: true })
    await pending
    await f.loop.poll()
    expect(f.checkpoint).not.toHaveBeenCalled()
    f.update({ paused: false })
    await f.loop.poll()
    expect(f.checkpoint).toHaveBeenCalledTimes(1)
  })
})
