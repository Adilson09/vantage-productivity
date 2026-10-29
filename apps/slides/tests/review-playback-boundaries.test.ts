import { describe, expect, it } from 'vitest'
import { buildSteps, computeMediaCommands, computeNodeStates } from '../src/renderer/animation-play'
import type { AnimationItem } from '../src/shared/ipc'

const item = (sourceId: string, effect: AnimationItem['effect'], trigger: AnimationItem['trigger'], durationMs: number, delayMs: number): AnimationItem => ({ sourceId, targetName: sourceId, effect, trigger, durationMs, delayMs })

describe('ten deterministic presentation timing fixtures', () => {
  for (let fixture = 0; fixture < 10; fixture++) {
    it(`dispatches media and visual transitions at the exact clock boundaries (${fixture})`, () => {
      const delay = fixture * 17
      const duration = 200 + fixture * 31
      const steps = buildSteps([
        item('audio', 'mediaPlay', 'withPrev', 1, delay),
        item('title', 'fade', 'withPrev', duration, 0),
        item('audio', 'mediaPause', 'afterPrev', 1, 50),
        item('title', 'fadeOut', 'onClick', 200, 0),
        item('audio', 'mediaStop', 'withPrev', 1, 100),
      ])
      expect(steps).toHaveLength(2)
      expect(steps[0]?.auto).toBe(true)
      const pauseAt = delay + duration + 50
      if (delay > 0) expect(computeMediaCommands(steps, 0, delay - .001)).toEqual([])
      expect(computeMediaCommands(steps, 0, delay)).toEqual([{ sourceId: 'audio', effect: 'mediaPlay' }])
      expect(computeMediaCommands(steps, 0, pauseAt - .001)).toEqual([{ sourceId: 'audio', effect: 'mediaPlay' }])
      expect(computeMediaCommands(steps, 0, pauseAt).map((c) => c.effect)).toEqual(['mediaPlay', 'mediaPause'])
      const initial = computeNodeStates(steps, 0, delay, 540, 960).get('title')!
      expect(initial.hidden).toBe(false)
      expect(initial.opacity).toBe(0)
      const end = computeNodeStates(steps, 0, delay + duration, 540, 960).get('title')!
      expect(end.opacity).toBe(1)
      expect(computeMediaCommands(steps, 1, 99).map((c) => c.effect)).toEqual(['mediaPlay', 'mediaPause'])
      expect(computeMediaCommands(steps, 1, 100).map((c) => c.effect)).toEqual(['mediaPlay', 'mediaPause', 'mediaStop'])
      expect(computeNodeStates(steps, 2, null, 540, 960).get('title')?.hidden).toBe(true)
    })
  }
})
