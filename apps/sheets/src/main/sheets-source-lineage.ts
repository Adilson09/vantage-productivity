import { randomUUID } from 'node:crypto'
import { sameSheetsCloseSource, type SheetsCloseSource } from '../shared/sheets-close'

export interface SheetsReaderIdentity {
  sessionId: string
  openedSha256: string
  documentPath: string | null
}
export interface SheetsSourceOpen {
  readonly sequence: number
  readonly lineage: string
}
export interface SheetsSourceAdoption {
  readonly next: SheetsCloseSource
}
interface OwnerState {
  sequence: number
  current: SheetsCloseSource | null
  pending?: SheetsSourceOpen
}

/** Main owns active-reader identity. Merge inputs must never call beginOpen/commitOpen. */
export class SheetsSourceLineages<Owner> {
  private readonly owners = new Map<Owner, OwnerState>()
  private readonly opens = new WeakMap<
    SheetsSourceOpen,
    { owner: Owner; ticket: SheetsSourceOpen }
  >()
  private readonly adoptions = new WeakMap<
    SheetsSourceAdoption,
    {
      owner: Owner
      previous: SheetsCloseSource
      sequence: number
    }
  >()

  constructor(private readonly invalidate: (owner: Owner, reason: string) => void) {}

  current(owner: Owner): SheetsCloseSource | null {
    const source = this.owners.get(owner)?.current
    return source ? { ...source } : null
  }

  busy(owner: Owner): boolean {
    return !!this.owners.get(owner)?.pending
  }

  /** Invoke synchronously at accepted source-open admission, before opening bytes. */
  beginOpen(owner: Owner): SheetsSourceOpen {
    const state = this.owners.get(owner) ?? { sequence: 0, current: null }
    const ticket = Object.freeze({ sequence: ++state.sequence, lineage: randomUUID() })
    state.pending = ticket
    this.owners.set(owner, state)
    this.opens.set(ticket, { owner, ticket })
    this.invalidate(owner, 'source open admitted')
    return ticket
  }

  /** An older successful open cannot select itself over a later request. */
  commitOpen(owner: Owner, ticket: SheetsSourceOpen, reader: SheetsReaderIdentity): boolean {
    const issued = this.opens.get(ticket)
    const state = this.owners.get(owner)
    if (!issued || issued.owner !== owner || state?.pending !== ticket) return false
    assertReader(reader)
    this.opens.delete(ticket)
    state.current = { ...reader, lineage: ticket.lineage }
    delete state.pending
    return true
  }

  cancelOpen(owner: Owner, ticket: SheetsSourceOpen): void {
    const issued = this.opens.get(ticket)
    if (!issued || issued.owner !== owner) return
    this.opens.delete(ticket)
    const state = this.owners.get(owner)
    if (state?.pending === ticket) delete state.pending
  }

  /** Publication is not renderer adoption and grants no permission to retire its old reader. */
  offerOwnedPublication(
    owner: Owner,
    previous: SheetsCloseSource,
    next: SheetsReaderIdentity,
  ): SheetsSourceAdoption {
    const state = this.owners.get(owner)
    if (!state?.current || state.pending || !sameSheetsCloseSource(state.current, previous))
      throw new Error('The active workbook changed before its publication could be offered.')
    assertReader(next)
    if (next.sessionId === previous.sessionId)
      throw new Error('An owned publication must offer a distinct replacement reader.')
    const adoption = Object.freeze({ next: Object.freeze({ ...next, lineage: previous.lineage }) })
    this.adoptions.set(adoption, { owner, previous: { ...previous }, sequence: state.sequence })
    return adoption
  }

  /** Call only after the renderer acknowledged coherent full-state rebase/adoption. */
  adoptOwnedPublication(owner: Owner, adoption: SheetsSourceAdoption): SheetsCloseSource | null {
    const issued = this.adoptions.get(adoption)
    this.adoptions.delete(adoption)
    const state = this.owners.get(owner)
    if (
      !issued ||
      issued.owner !== owner ||
      !state?.current ||
      state.pending ||
      state.sequence !== issued.sequence ||
      !sameSheetsCloseSource(state.current, issued.previous)
    )
      return null
    state.current = { ...adoption.next }
    // The caller may release only this returned old reader, preserving its recovery authority.
    return { ...issued.previous }
  }

  rejectOwnedPublication(adoption: SheetsSourceAdoption): void {
    this.adoptions.delete(adoption)
  }

  /** Main calls only after byte verification of an acknowledged owned path move. */
  relocateOwnedPath(
    owner: Owner,
    previous: SheetsCloseSource,
    documentPath: string | null,
  ): SheetsCloseSource | null {
    const state = this.owners.get(owner)
    if (
      !state?.current ||
      state.pending ||
      !sameSheetsCloseSource(state.current, previous) ||
      !(documentPath === null || (typeof documentPath === 'string' && documentPath.length > 0))
    )
      return null
    this.invalidate(owner, 'owned source path relocated')
    if (!state.current || state.pending || !sameSheetsCloseSource(state.current, previous))
      return null
    state.sequence++ // every outstanding adoption was issued against an older path epoch
    state.current = { ...previous, documentPath }
    return { ...state.current }
  }

  destroy(owner: Owner): void {
    this.invalidate(owner, 'owner destroyed')
    this.owners.delete(owner)
  }
}

function assertReader(reader: SheetsReaderIdentity): void {
  if (
    !reader.sessionId ||
    !/^[a-f0-9]{64}$/i.test(reader.openedSha256) ||
    !(reader.documentPath === null || typeof reader.documentPath === 'string')
  )
    throw new Error('A source requires its owned reader and opening digest.')
}
