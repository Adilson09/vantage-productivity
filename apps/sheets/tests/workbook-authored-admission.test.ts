/** Source-only proposal: compose the shared close-safety helpers before running. */
import { CommandType, ICommandService, LogLevel, Univer } from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseMutationBarrier } from '../../../packages/electron-utils/src/renderer-close-barrier'
import type { CloseLeaseTicket } from '../../../packages/electron-utils/src/close-lease'
import {
  bindJournalAuthoredAdmission,
  createWorkbookAuthoredAdmission,
  createWorkbookAuthoredStorage,
  installWorkbookCommandAdmission,
  WorkbookAuthoredDeferredError,
} from '../src/renderer/workbook-authored-admission'
import {
  createEditJournal,
  recordDefinedNamesChange,
  recordNoteChange,
  recordSetRangeValues,
  recordThemeColors,
  replaceChartJournalEntry,
  replaceJournalVisualAdds,
} from '../src/renderer/edit-journal'
import {
  configureWorkbookMutationAdmission,
  createWorkbookPublicationOwner,
  drainWorkbookWork,
  enqueueWorkbookMutation,
  enqueueWorkbookPublication,
  withPublicationOwner,
  workbookWorkPending,
} from '../src/renderer/workbook-mutation-queue'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

function fixture() {
  let epoch = 'source-epoch-1'
  let derived = false
  const cancellation = deferred<void>()
  const report = vi.fn()
  const cancel = vi.fn(() => cancellation.promise)
  const barrier = new CloseMutationBarrier({
    source: () => epoch,
    claim: async () => true,
    cancel,
    report,
  })
  const admission = createWorkbookAuthoredAdmission({
    barrier,
    source: () => epoch,
    isDerived: () => derived,
    report,
  })
  const journal = createEditJournal()
  cleanup.push(bindJournalAuthoredAdmission(journal, admission))
  const univer = new Univer({ logLevel: LogLevel.SILENT })
  cleanup.push(() => univer.dispose())
  const service = univer.__getInjector().get(ICommandService)
  const restore = installWorkbookCommandAdmission(service, admission, {
    resolveSource: (_id, params) => {
      const requested = (params as { sourceEpoch?: string } | undefined)?.sourceEpoch
      return requested ?? epoch
    },
  })
  cleanup.push(restore)
  const ticket: CloseLeaseTicket = { id: 'main-ticket-1', source: 'main-reader-1', sequence: 1 }
  return {
    admission,
    barrier,
    journal,
    service,
    report,
    cancel,
    restore,
    nextSource: () => {
      epoch = 'source-epoch-2'
    },
    derived: (value: boolean) => {
      derived = value
    },
    hold: () => barrier.acquire(ticket, () => true),
    acknowledgeCancel: () => cancellation.resolve(),
  }
}

describe('precommit workbook admission using the real Univer command service', () => {
  it('advances the source stamp before the real handler or its journal write', () => {
    const f = fixture()
    const observed: string[] = []
    f.service.registerCommand({
      id: 'test.mutation.write',
      type: CommandType.MUTATION,
      handler: () => {
        observed.push(f.barrier.snapshot().revision)
        recordSetRangeValues(f.journal, 'sheet-1', { 0: { 0: { v: '12' } } })
        return true
      },
    })
    expect(f.service.syncExecuteCommand('test.mutation.write')).toBe(true)
    expect(observed).toEqual(['1'])
    expect(f.journal.cells.get('sheet-1')?.get('0:0')?.value).toBe('12')
    expect(f.barrier.snapshot().revision).toBe('1')
  })

  it('defers the whole sync command until main cancellation, with captured input', async () => {
    const f = fixture()
    let model = ''
    f.service.registerCommand({
      id: 'test.command.write',
      type: CommandType.COMMAND,
      handler: (_accessor, params) => {
        model = (params as { text: string }).text
        recordNoteChange(f.journal, model)
        return true
      },
    })
    expect(await f.hold()).not.toBeNull()
    const params = { text: 'accepted' }
    expect(f.service.syncExecuteCommand('test.command.write', params)).toBe(false)
    params.text = 'later mutation of caller object'
    expect(model).toBe('')
    expect(f.journal.noteDirty.size).toBe(0)
    expect(f.admission.busy).toBe(true)
    f.acknowledgeCancel()
    await f.admission.drain()
    expect(model).toBe('accepted')
    expect([...f.journal.noteDirty]).toEqual(['accepted'])
    expect(f.barrier.locked).toBe(false)
    expect(f.cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps a real asynchronous producer busy through its final application', async () => {
    const f = fixture()
    const gate = deferred<void>()
    const finalizer = deferred<void>()
    f.service.registerCommand({
      id: 'test.command.async',
      type: CommandType.COMMAND,
      handler: async () => {
        try {
          await gate.promise
          recordDefinedNamesChange(f.journal)
          return true
        } finally {
          await finalizer.promise
        }
      },
    })
    const result = f.service.executeCommand('test.command.async')
    expect(f.admission.busy).toBe(true)
    expect(f.journal.definedNames.dirty).toBe(false)
    gate.resolve()
    await Promise.resolve()
    expect(f.journal.definedNames.dirty).toBe(true)
    expect(f.admission.busy).toBe(true)
    finalizer.resolve()
    expect(await result).toBe(true)
    await f.admission.drain()
    expect(f.admission.busy).toBe(false)
  })

  it('admits synchronous nested commands once without an asynchronous global bypass', () => {
    const f = fixture()
    f.service.registerCommand({
      id: 'test.mutation.inner',
      type: CommandType.MUTATION,
      handler: () => {
        recordNoteChange(f.journal, 'inner')
        return true
      },
    })
    f.service.registerCommand({
      id: 'test.command.outer',
      type: CommandType.COMMAND,
      handler: () => f.service.syncExecuteCommand('test.mutation.inner'),
    })
    expect(f.service.syncExecuteCommand('test.command.outer')).toBe(true)
    expect(f.barrier.snapshot().revision).toBe('1')
    expect(f.journal.noteDirty.has('inner')).toBe(true)
  })

  it('retains existing synchronous command guards on deferred replay', async () => {
    const f = fixture()
    let writes = 0
    f.service.registerCommand({
      id: 'test.command.guard',
      type: CommandType.COMMAND,
      handler: () => {
        writes++
        return true
      },
    })
    const guard = f.service.beforeCommandExecuted(() => {
      throw new Error('existing guard refused')
    })
    cleanup.push(() => guard.dispose())
    await f.hold()
    expect(f.service.syncExecuteCommand('test.command.guard')).toBe(false)
    f.acknowledgeCancel()
    await f.admission.drain()
    expect(writes).toBe(0)
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'existing guard refused' }),
    )
  })

  it('rejects old bound journal callbacks after source replacement', () => {
    const f = fixture()
    f.nextSource()
    expect(() => recordNoteChange(f.journal, 'old-reader')).toThrow(/source changed/)
    expect(f.journal.noteDirty.size).toBe(0)
    expect(f.barrier.snapshot().revision).toBe('0')
  })

  it('rejects a captured explicit old unit epoch before its real command handler', () => {
    const f = fixture()
    const handler = vi.fn(() => true)
    f.service.registerCommand({ id: 'test.command.source', type: CommandType.COMMAND, handler })
    f.nextSource()
    expect(() =>
      f.service.syncExecuteCommand('test.command.source', { sourceEpoch: 'source-epoch-1' }),
    ).toThrow(/source changed/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not trust a caller fromFormula flag as a derived-work exemption', () => {
    const f = fixture()
    f.service.registerCommand({
      id: 'test.mutation.formula-flag',
      type: CommandType.MUTATION,
      handler: () => {
        recordNoteChange(f.journal, 'authored')
        return true
      },
    })
    f.service.syncExecuteCommand('test.mutation.formula-flag', { fromFormula: true })
    expect(f.barrier.snapshot().revision).toBe('1')
    f.derived(true)
    f.service.syncExecuteCommand('test.mutation.formula-flag')
    expect(f.barrier.snapshot().revision).toBe('1')
  })

  it('does not replay a command into a disposed owner after cancellation', async () => {
    const f = fixture()
    const handler = vi.fn(() => true)
    f.service.registerCommand({ id: 'test.command.disposed', type: CommandType.COMMAND, handler })
    await f.hold()
    expect(f.service.syncExecuteCommand('test.command.disposed')).toBe(false)
    f.restore()
    f.acknowledgeCancel()
    await f.admission.drain()
    expect(handler).not.toHaveBeenCalled()
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('disposed') }),
    )
  })

  it('defers real cell-journal inputs without inventing a synchronous return value', async () => {
    const f = fixture()
    await f.hold()
    const values = { 0: { 0: { v: 'accepted text' } } }
    expect(() => recordSetRangeValues(f.journal, 'sheet-1', values)).toThrow(
      WorkbookAuthoredDeferredError,
    )
    values[0][0].v = 'changed later'
    expect(f.journal.cells.size).toBe(0)
    f.acknowledgeCancel()
    await f.admission.drain()
    expect(f.journal.cells.get('sheet-1')?.get('0:0')?.value).toBe('accepted text')
  })

  it('admits metadata storage before subscribers observe committed redactions', async () => {
    const f = fixture()
    const storage = createWorkbookAuthoredStorage<readonly string[]>([], f.admission)
    const snapshots: { stamp: string; value: readonly string[] }[] = []
    storage.subscribe(() =>
      snapshots.push({ stamp: f.barrier.snapshot().revision, value: storage.getSnapshot() }),
    )
    await f.hold()
    storage.set((old) => [...old, 'A1:B2'])
    expect(storage.getSnapshot()).toEqual([])
    expect(snapshots).toEqual([])
    f.acknowledgeCancel()
    await f.admission.drain()
    expect(snapshots).toEqual([{ stamp: '1', value: ['A1:B2'] }])
  })

  it('includes direct metadata and undo collection restoration in the precommit stamp', () => {
    const f = fixture()
    recordThemeColors(f.journal, 'Accepted theme', ['#112233'])
    replaceChartJournalEntry(f.journal, 'xl/charts/chart1.xml', { title: 'accepted' })
    replaceChartJournalEntry(f.journal, 'xl/charts/chart1.xml', undefined)
    replaceJournalVisualAdds(f.journal, [])
    expect(f.journal.theme.colors).toEqual({ name: 'Accepted theme', values: ['#112233'] })
    expect(f.journal.chartEdits.size).toBe(0)
    expect(f.barrier.snapshot().revision).toBe('4')
  })
})

describe('authored queue and exact publication owner', () => {
  it('keeps queued producers busy while excluding only the active publication', async () => {
    const f = fixture()
    cleanup.push(configureWorkbookMutationAdmission(f.admission))
    const owner = createWorkbookPublicationOwner()
    const gate = deferred<void>()
    const started = deferred<void>()
    const checks: boolean[] = []
    const publication = enqueueWorkbookPublication(owner, async () => {
      checks.push(withPublicationOwner(owner, () => workbookWorkPending(owner)))
      started.resolve()
      await gate.promise
      checks.push(workbookWorkPending(owner))
    })
    await started.promise
    const edit = enqueueWorkbookMutation(() => recordNoteChange(f.journal, 'queued'))
    expect(workbookWorkPending()).toBe(true)
    gate.resolve()
    await publication
    await edit
    expect(checks).toEqual([false, true])
    expect(f.journal.noteDirty.has('queued')).toBe(true)
    await drainWorkbookWork()
    expect(workbookWorkPending()).toBe(false)
  })

  it('captures queued source before waiting instead of applying to a replacement reader', async () => {
    const f = fixture()
    cleanup.push(configureWorkbookMutationAdmission(f.admission))
    const gate = deferred<void>()
    const started = deferred<void>()
    const publication = enqueueWorkbookPublication(createWorkbookPublicationOwner(), async () => {
      started.resolve()
      await gate.promise
    })
    await started.promise
    const handler = vi.fn()
    const edit = enqueueWorkbookMutation(handler)
    const rejected = expect(edit).rejects.toThrow(/source changed/)
    f.nextSource()
    gate.resolve()
    await publication
    await rejected
    expect(handler).not.toHaveBeenCalled()
    await drainWorkbookWork()
  })

  it('rejects manufactured publication exclusion tokens', () => {
    expect(() => workbookWorkPending({ identity: Symbol('not-issued') })).toThrow(/allocated owner/)
    expect(() => withPublicationOwner(createWorkbookPublicationOwner(), () => undefined)).toThrow(
      /not executing/,
    )
  })

  it('disposes mount configuration without leaving the next App attached to old admission', async () => {
    const f = fixture()
    const dispose = configureWorkbookMutationAdmission(f.admission)
    dispose()
    const next = fixture()
    cleanup.push(configureWorkbookMutationAdmission(next.admission))
    dispose()
    await enqueueWorkbookMutation(() => recordNoteChange(next.journal, 'new-owner'))
    expect(next.barrier.snapshot().revision).toBe('1')
    expect(f.barrier.snapshot().revision).toBe('0')
  })
})
