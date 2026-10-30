import type { SlidesApi } from '../shared/ipc'
import { isSlidesHistoryBatchTicket } from '../shared/slides-history-batch'
import type { SlidesAuthoredRuntime, SlidesAuthoredScope } from './slides-authored'
import type { ActionCtx } from './action-context'
import { slidesAuthored } from './slides-authored'
import { slidesActionApi } from './slides-action-ownership'
export interface SlidesHistoryBatchLease {
  finish(): Promise<number | null>
}
export interface SlidesHistoryBatchAccess {
  acquire(): Promise<SlidesHistoryBatchLease | null>
  assertCurrent(): void
  retire(): void
}
/** Capture only the dedicated capability methods, never an unfenced editor API. */
export function captureSlidesHistoryBatches(
  api: Pick<SlidesApi, 'beginOwnedHistoryBatch' | 'finishOwnedHistoryBatch'>,
  runtime: SlidesAuthoredRuntime | null,
  scope: SlidesAuthoredScope | undefined,
): SlidesHistoryBatchAccess {
  const begin = api.beginOwnedHistoryBatch.bind(api),
    finish = api.finishOwnedHistoryBatch.bind(api)
  let retired = false
  const assertCurrent = () => {
    if (retired) throw new Error('This history batch action was retired.')
    if (runtime) {
      if (!scope) throw new Error('A captured presentation scope is required.')
      runtime.assert(scope)
    }
  }
  return {
    assertCurrent,
    retire: () => {
      retired = true
    },
    async acquire() {
      assertCurrent()
      // Capture the actual begin receipt BEFORE the callback-generation check.
      // A retired response must still finish the depth Main already accepted.
      const ticket = await begin()
      if (ticket === null) {
        assertCurrent()
        return null
      }
      if (!isSlidesHistoryBatchTicket(ticket))
        throw new Error('Main returned an invalid owned history batch receipt.')
      let actual: Promise<number | null> | undefined
      const lease: SlidesHistoryBatchLease = Object.freeze({
        finish: () => (actual ??= (async () => finish(ticket))()),
      })
      try {
        assertCurrent()
        return lease
      } catch (error) {
        await lease.finish()
        throw error
      }
    },
  }
}
export async function runSlidesHistoryBatch<Result>(
  access: SlidesHistoryBatchAccess,
  action: () => Promise<Result>,
): Promise<{ value: Result; snapshotId: number | null }> {
  const lease = await access.acquire()
  if (!lease) throw new Error('The presentation history batch is unavailable.')
  let snapshotId: number | null = null
  const value = await (async () => {
    try {
      access.assertCurrent()
      return await action()
    } finally {
      snapshotId = await lease.finish()
    }
  })()
  access.assertCurrent()
  return { value, snapshotId }
}
export async function withSlidesHistoryBatch<Result>(
  ctx: ActionCtx,
  action: () => Promise<Result>,
): Promise<Result> {
  let access = ctx.historyBatches
  if (!access) {
    if (slidesAuthored()) throw new Error('This action has no captured owned history batch access.')
    // Standalone action fixtures without an authored runtime still exercise the
    // same capability protocol. Production contexts always capture access.
    access = captureSlidesHistoryBatches(slidesActionApi(ctx), null, undefined)
  }
  return (await runSlidesHistoryBatch(access, action)).value
}
