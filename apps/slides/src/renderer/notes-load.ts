export interface NotesLoadTicket {
  source: number
  part: string
  load: number
  edit: number
}

/** Per-view read receipts cannot replace a newer edit, part, or presentation. */
export class NotesLoadGuard {
  private source = 0
  private load = 0
  private edit = 0
  private part = ''
  get sourceGeneration(): number {
    return this.source
  }
  get editGeneration(): number {
    return this.edit
  }
  reset(): void {
    this.source++
    this.load++
    this.edit++
    this.part = ''
  }
  begin(part: string): NotesLoadTicket {
    this.part = part
    return { source: this.source, part, load: ++this.load, edit: this.edit }
  }
  edited(): void {
    this.edit++
  }
  isCurrent(ticket: NotesLoadTicket): boolean {
    return ticket.source === this.source && ticket.part === this.part && ticket.load === this.load
  }
  mayReplace(ticket: NotesLoadTicket): boolean {
    return this.isCurrent(ticket) && ticket.edit === this.edit
  }
  cancel(ticket: NotesLoadTicket): void {
    if (this.isCurrent(ticket)) this.load++
  }
}
