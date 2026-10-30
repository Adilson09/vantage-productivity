import type { ChildProcess } from 'node:child_process'

export interface CleanupEvent {
  phase: 'evaluate' | 'app.close' | 'process.close' | 'video.saveAs' | 'watchdog'
  state: 'started' | 'completed' | 'failed' | 'timed-out' | 'skipped' | 'kill-requested'
  at: string
  detail?: string
}

export interface CleanupReceipt {
  events: CleanupEvent[]
  failures: string[]
  termination: { requested: boolean; confirmed: boolean }
  video: { status: 'saved' | 'disabled' | 'omitted'; path?: string; reason?: string }
}

export interface CleanupBudgets {
  evaluateMs?: number
  closeMs?: number
  processDeadlineMs?: number
  exitWaitMs?: number
  videoMs?: number
}

export interface ChildCloseObservation {
  readonly child: ChildProcess
  readonly actualClose: Promise<void>
  isClosed(): boolean
}

/** Retained-child close only; neither descendants nor losing RPCs are attested. */
export function observeChildClose(child: ChildProcess): ChildCloseObservation {
  let closed = false
  const actualClose = new Promise<void>((resolve) => {
    child.once('close', () => {
      closed = true
      resolve()
    })
  })
  return Object.freeze({ child, actualClose, isClosed: () => closed })
}
/** Test-owned process only. Timers are event-loop-relative, not an OS wall-clock guarantee. */
export async function runBoundedCleanup(
  operations: {
    child: ChildProcess
    closeObservation: ChildCloseObservation
    evaluate: () => Promise<unknown>
    close: () => Promise<unknown>
    saveVideo?: () => Promise<string>
  },
  budgets: CleanupBudgets = {},
): Promise<CleanupReceipt> {
  const { child, closeObservation } = operations
  if (!closeObservation || closeObservation.child !== child)
    throw new Error('Cleanup close observation belongs to a different retained child.')
  const receipt: CleanupReceipt = {
    events: [],
    failures: [],
    termination: { requested: false, confirmed: false },
    video: { status: operations.saveVideo ? 'omitted' : 'disabled' },
  }
  const alive = () =>
    !closeObservation.isClosed() && child.exitCode === null && child.signalCode === null
  const event = (phase: CleanupEvent['phase'], state: CleanupEvent['state'], detail?: string) => {
    receipt.events.push({
      phase,
      state,
      at: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    })
  }
  const diagnostic = (error: unknown) =>
    String(error instanceof Error ? error.message : error).slice(0, 2000)
  const kill = (reason: string) => {
    if (!alive() || receipt.termination.requested) return
    receipt.termination.requested = true
    receipt.failures.push(`Owned process required forced termination: ${reason}`)
    event('watchdog', 'kill-requested', reason)
    try {
      // This handle belongs to the app launched for this test. Never enumerate or kill by name.
      if (!child.kill('SIGKILL')) receipt.failures.push('The owned process did not accept SIGKILL.')
    } catch (error) {
      receipt.failures.push(`Owned process termination failed: ${diagnostic(error)}`)
    }
  }
  // Install before invoking any Electron RPC, including the dialog override.
  const watchdog = setTimeout(
    () => kill('Owned process cleanup deadline exceeded.'),
    budgets.processDeadlineMs ?? 20_000,
  )
  const phase = async (
    name: CleanupEvent['phase'],
    action: () => Promise<unknown>,
    milliseconds: number,
    required = true,
  ): Promise<'completed' | 'failed' | 'timed-out'> => {
    event(name, 'started')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CleanupDeadlineError(name)), milliseconds)
        }),
      ])
      event(name, 'completed')
      return 'completed'
    } catch (error) {
      const state = error instanceof CleanupDeadlineError ? 'timed-out' : 'failed'
      const detail = diagnostic(error)
      event(name, state, detail)
      if (required) receipt.failures.push(`${name}: ${detail}`)
      return state
    } finally {
      clearTimeout(timer)
    }
  }
  const waitForClose = async () => {
    if (closeObservation.isClosed()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        closeObservation.actualClose,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, budgets.exitWaitMs ?? 5_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    if (alive()) {
      const evaluated = await phase('evaluate', operations.evaluate, budgets.evaluateMs ?? 5_000)
      if (evaluated === 'timed-out') kill('The dialog-override RPC timed out.')
      if (!receipt.termination.requested && alive()) {
        const closed = await phase('app.close', operations.close, budgets.closeMs ?? 15_000)
        if (closed !== 'completed') kill('The app.close phase did not complete.')
      } else {
        event(
          'app.close',
          'skipped',
          'The owned process exited or forced termination was requested.',
        )
      }
    } else {
      event('evaluate', 'skipped', 'The owned process has already exited.')
      event('app.close', 'skipped', 'The owned process has already exited.')
    }
    if (!closeObservation.isClosed()) {
      if (alive()) kill('The close operation returned without a confirmed process close.')
      event('process.close', 'started')
      await waitForClose()
    }
    receipt.termination.confirmed = closeObservation.isClosed()
    event('process.close', receipt.termination.confirmed ? 'completed' : 'timed-out')
    if (!receipt.termination.confirmed)
      receipt.failures.push('Owned process close remains unconfirmed; cleanup is incomplete.')
  } finally {
    clearTimeout(watchdog)
  }
  if (operations.saveVideo) {
    let path: string | undefined
    const saved = await phase(
      'video.saveAs',
      async () => {
        path = await operations.saveVideo!()
      },
      budgets.videoMs ?? 10_000,
      false,
    )
    receipt.video =
      saved === 'completed'
        ? { status: 'saved', path }
        : {
            status: 'omitted',
            reason: `video.saveAs ${saved}; the recording was not saved to its final destination.`,
          }
  }
  return receipt
}

class CleanupDeadlineError extends Error {
  constructor(phase: CleanupEvent['phase']) {
    super(`${phase} exceeded its cleanup budget.`)
  }
}
