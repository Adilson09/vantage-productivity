import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import { observeChildClose, runBoundedCleanup, type ChildCloseObservation } from './cleanup-harness'

const budgets = {
  evaluateMs: 80,
  closeMs: 80,
  processDeadlineMs: 500,
  exitWaitMs: 1_000,
  videoMs: 80,
}
const never = () => new Promise<never>(() => {})

const observations = new WeakMap<ChildProcess, ChildCloseObservation>()
function closeObservation(child: ChildProcess): ChildCloseObservation {
  const observed = observations.get(child)
  if (!observed) throw new Error('Owned child close observer was not installed.')
  return observed
}

async function ownedChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [
    '-e',
    "setInterval(() => {}, 1000); process.stdout.write('ready')",
  ])
  observations.set(child, observeChildClose(child))
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    await Promise.race([
      once(child.stdout!, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('Owned test child exited before readiness.')
      }),
    ])
    return child
  } finally {
    clearTimeout(timer)
  }
}

async function closeChild(child: ChildProcess): Promise<void> {
  const observed = closeObservation(child)
  if (observed.isClosed()) return
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await observed.actualClose
}

test('normal cleanup labels all phases and confirms actual owned process close', async () => {
  const child = await ownedChild()
  try {
    const receipt = await runBoundedCleanup(
      {
        child,
        closeObservation: closeObservation(child),
        evaluate: async () => {},
        close: () => closeChild(child),
        saveVideo: async () => 'recording.webm',
      },
      budgets,
    )
    expect(receipt.failures).toEqual([])
    expect(receipt.termination).toEqual({ requested: false, confirmed: true })
    expect(receipt.video).toEqual({ status: 'saved', path: 'recording.webm' })
    expect(receipt.events.filter((e) => e.state === 'started').map((e) => e.phase)).toEqual([
      'evaluate',
      'app.close',
      'video.saveAs',
    ])
  } finally {
    await closeChild(child)
  }
})

for (const blockedPhase of ['evaluate', 'app.close', 'video.saveAs'] as const) {
  test(`hung ${blockedPhase} has a bounded caller outcome and visible failure`, async () => {
    const child = await ownedChild()
    let closeCalled = false
    const started = Date.now()
    try {
      const receipt = await runBoundedCleanup(
        {
          child,
          closeObservation: closeObservation(child),
          evaluate: blockedPhase === 'evaluate' ? never : async () => {},
          close: async () => {
            closeCalled = true
            if (blockedPhase === 'app.close') return never()
            await closeChild(child)
          },
          saveVideo: blockedPhase === 'video.saveAs' ? never : async () => 'recording.webm',
        },
        budgets,
      )
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(receipt.events.some((e) => e.phase === blockedPhase && e.state === 'timed-out')).toBe(
        true,
      )
      if (blockedPhase === 'video.saveAs') expect(receipt.failures).toEqual([])
      else expect(receipt.failures.some((f) => f.startsWith(blockedPhase + ':'))).toBe(true)
      expect(receipt.termination.confirmed).toBe(true)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      if (blockedPhase === 'evaluate') expect(closeCalled).toBe(false)
      if (blockedPhase === 'video.saveAs')
        expect(receipt.video).toMatchObject({
          status: 'omitted',
          reason: expect.stringContaining('timed-out'),
        })
      else expect(receipt.termination.requested).toBe(true)
    } finally {
      await closeChild(child)
    }
  })
}

test('watchdog is active during the first unresolved Electron RPC', async () => {
  const child = await ownedChild()
  try {
    const receipt = await runBoundedCleanup(
      { child, closeObservation: closeObservation(child), evaluate: never, close: never },
      { ...budgets, evaluateMs: 150, processDeadlineMs: 20 },
    )
    expect(receipt.events.find((e) => e.state === 'kill-requested')?.detail).toBe(
      'Owned process cleanup deadline exceeded.',
    )
    expect(receipt.termination).toEqual({ requested: true, confirmed: true })
    expect(receipt.failures.some((f) => f.includes('forced termination'))).toBe(true)
  } finally {
    await closeChild(child)
  }
})

test('unconfirmed process termination stays incomplete without hanging the caller', async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess
  observations.set(child, observeChildClose(child))
  const receipt = await runBoundedCleanup(
    { child, closeObservation: closeObservation(child), evaluate: never, close: never },
    { ...budgets, exitWaitMs: 30 },
  )
  expect(receipt.termination).toEqual({ requested: true, confirmed: false })
  expect(receipt.failures).toContain(
    'Owned process close remains unconfirmed; cleanup is incomplete.',
  )
  expect(child.listenerCount('exit')).toBe(0)
  expect(closeObservation(child).isClosed()).toBe(false)
})

test('cleanup receipts do not replace an assertion unwinding through finally', async () => {
  const child = await ownedChild()
  const original = new Error('original assertion failed')
  let caught: unknown
  let cleanupFailures: string[] = []
  try {
    try {
      throw original
    } finally {
      cleanupFailures = (
        await runBoundedCleanup(
          { child, closeObservation: closeObservation(child), evaluate: never, close: never },
          budgets,
        )
      ).failures
    }
  } catch (error) {
    caught = error
  } finally {
    await closeChild(child)
  }
  expect(caught).toBe(original)
  expect(cleanupFailures).not.toEqual([])
})

test('rejected optional recording is reported with its exact cleanup phase', async () => {
  const child = await ownedChild()
  try {
    const receipt = await runBoundedCleanup(
      {
        child,
        closeObservation: closeObservation(child),
        evaluate: async () => {},
        close: () => closeChild(child),
        saveVideo: async () => {
          throw new Error('recording unavailable')
        },
      },
      budgets,
    )
    expect(receipt.video).toMatchObject({
      status: 'omitted',
      reason: expect.stringContaining('failed'),
    })
    expect(receipt.failures).toEqual([])
    expect(receipt.events).toContainEqual(
      expect.objectContaining({
        phase: 'video.saveAs',
        state: 'failed',
        detail: 'recording unavailable',
      }),
    )
    expect(receipt.termination.confirmed).toBe(true)
  } finally {
    await closeChild(child)
  }
})
