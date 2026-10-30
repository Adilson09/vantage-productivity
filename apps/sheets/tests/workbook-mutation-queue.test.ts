import { describe, expect, it } from 'vitest'
import {
  enqueueWorkbookMutation,
  workbookMutationsPending,
} from '../src/renderer/workbook-mutation-queue'

describe('workbook apply and publication order', () => {
  it('captures metadata from an accepted batch that was awaiting its input', async () => {
    let finish!: () => void
    const input = new Promise<void>((resolve) => {
      finish = resolve
    })
    const journal = { pageSetup: '', constantFill: 0 }
    let state = 'old'
    const apply = enqueueWorkbookMutation(async () => {
      await input
      journal.pageSetup = 'landscape'
      journal.constantFill = 42
    })
    let published: typeof journal | undefined
    const save = enqueueWorkbookMutation(async () => {
      published = { ...journal }
      state = 'replacement'
    })
    const later = enqueueWorkbookMutation(async () => {
      if (state !== 'old') return { ok: false }
      journal.constantFill = 99
      return { ok: true }
    })
    await Promise.resolve()
    expect(workbookMutationsPending()).toBe(true)
    expect(published).toBeUndefined()
    finish()
    await apply
    await save
    expect(published).toEqual({ pageSetup: 'landscape', constantFill: 42 })
    expect(await later).toEqual({ ok: false })
    expect(journal.constantFill).toBe(42)
    expect(workbookMutationsPending()).toBe(false)
  })

  it('releases later workbook edits after a failed publication', async () => {
    const failed = enqueueWorkbookMutation(async () => {
      throw new Error('disk full')
    })
    let applied = false
    const later = enqueueWorkbookMutation(async () => {
      applied = true
    })
    await expect(failed).rejects.toThrow('disk full')
    await later
    expect(applied).toBe(true)
  })
})
