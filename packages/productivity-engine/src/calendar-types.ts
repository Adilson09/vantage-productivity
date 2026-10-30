/** Primitive calendar contracts shared by the local engine, CLI and desktop IPC. */
export type CalendarDisambiguation = 'reject' | 'earlier' | 'later' | 'compatible'
export type CalendarParticipation = 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'
export type CalendarSchedulingMethod = 'PUBLISH' | 'REQUEST' | 'REPLY' | 'CANCEL'
export type CalendarMutationScope = 'instance' | 'series' | 'this-and-future'

export interface CalendarParticipant {
  address: string
  name?: string
  participation?: CalendarParticipation
  role?: string
  rsvp?: boolean
}
export interface CalendarEventInput {
  uid?: string
  summary: string
  /** YYYY-MM-DD, UTC ISO timestamp, or local YYYY-MM-DDTHH:mm:ss with timeZone. */
  start: string
  end: string
  timeZone?: string
  disambiguation?: CalendarDisambiguation
  description?: string
  location?: string
  recurrence?: string | null
  organizer?: CalendarParticipant | null
  attendees?: CalendarParticipant[]
  status?: 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED'
}
export type CalendarEventPatch = Partial<Omit<CalendarEventInput, 'uid'>>
export type CalendarMutation =
  | { type: 'create'; event: CalendarEventInput }
  | {
      type: 'update'
      uid: string
      recurrenceId?: string
      scope?: CalendarMutationScope
      patch: CalendarEventPatch
    }
  | { type: 'delete'; uid: string; recurrenceId?: string; scope?: CalendarMutationScope }
  | {
      type: 'respond'
      uid: string
      recurrenceId?: string
      attendee: string
      participation: CalendarParticipation
      comment?: string
    }

export interface CalendarEventDetails {
  uid: string
  recurrenceId: string | null
  summary: string
  start: string
  end: string
  localStart: string
  localEnd: string
  timeZone: string
  allDay: boolean
  floating: boolean
  description: string
  location: string
  recurrence: string | null
  recurring: boolean
  status: string
  sequence: number
  organizer: CalendarParticipant | null
  attendees: CalendarParticipant[]
}
export interface CalendarWorkspaceOccurrence extends CalendarEventDetails {
  calendarId: string
  calendarRevision: number
  /** Stable for a nonrecurring event; recurring instances use the original RECURRENCE-ID. */
  instanceId: string
  localStart: string
  localEnd: string
}
export interface CalendarRecordSummary {
  id: string
  name: string
  revision: number
  eventCount: number
  originPath: string | null
  originSha256: string | null
  updatedAt: string
  warnings: string[]
}
export interface CalendarRecord extends CalendarRecordSummary {
  source: string
}
export interface CalendarMutationOptions {
  expectedRevision: number
  /** Prepare an outgoing local message only. This never sends or notifies anybody. */
  queueMethod?: CalendarSchedulingMethod
}
export interface CalendarMutationResult {
  calendar: CalendarRecord
  changedUid: string
  changedRecurrenceId: string | null
  outboxIds: string[]
  warnings: string[]
}
export interface CalendarOccurrenceOptions {
  start: string
  end: string
  maxOccurrences?: number
  maxIterations?: number
  deadlineMs?: number
  /** Date/floating values keep their wall-time labels; this zone controls range filtering. */
  viewTimeZone?: string
}
export interface CalendarSchedulingResult {
  calendar: CalendarRecord
  applied: number
  ignored: number
  warnings: string[]
}
export type CalendarOutboxState = 'pending' | 'inflight' | 'delivered' | 'failed' | 'discarded'
export interface CalendarOutboxItem {
  id: string
  calendarId: string
  calendarRevision: number
  uid: string
  recurrenceId: string | null
  method: CalendarSchedulingMethod
  source: string
  state: CalendarOutboxState
  createdAt: string
  attempts: number
  attemptId: string | null
  error: string | null
}
export interface CalendarOutboxAcknowledgement {
  attemptId: string
  success: boolean
  error?: string
}
export type CalendarOutboxSummary = Omit<CalendarOutboxItem, 'source'>
export interface CalendarLocalTestTransport {
  kind: 'local-test'
  deliver(item: CalendarOutboxItem): Promise<void>
}
export interface CalendarWorkspaceOptions {
  create?: boolean
  maxCalendars?: number
  maxStoredEvents?: number
}
export interface CalendarWorkspaceApi {
  close(): void
  listCalendars(): CalendarRecordSummary[]
  createCalendar(input: { name: string; source?: string }): CalendarRecord
  importCalendar(
    source: string,
    input: { name: string; originPath?: string; originSha256?: string },
  ): CalendarRecord
  readCalendar(id: string): CalendarRecord
  eventDetails(
    id: string,
    selector: { uid: string; recurrenceId?: string; scope?: CalendarMutationScope },
  ): CalendarEventDetails
  renameCalendar(id: string, name: string, options: { expectedRevision: number }): CalendarRecord
  removeCalendar(id: string, options: { expectedRevision: number }): void
  occurrences(
    id: string,
    options: CalendarOccurrenceOptions,
  ): { occurrences: CalendarWorkspaceOccurrence[]; warnings: string[] }
  allOccurrences(options: CalendarOccurrenceOptions): {
    occurrences: CalendarWorkspaceOccurrence[]
    warnings: string[]
  }
  mutateCalendar(
    id: string,
    mutation: CalendarMutation,
    options: CalendarMutationOptions,
  ): CalendarMutationResult
  applySchedulingMessage(
    id: string,
    source: string,
    options: { expectedRevision: number },
  ): CalendarSchedulingResult
  exportCalendar(id: string): string
  exportToFile(
    id: string,
    path: string,
    options: { expectedRevision: number; expectedOriginSha256?: string },
  ): Promise<CalendarRecord>
  listOutbox(options?: {
    state?: CalendarOutboxState
    calendarId?: string
  }): CalendarOutboxSummary[]
  readOutbox(id: string): CalendarOutboxItem
  exportOutboxMessage(id: string): string
  beginOutboxAttempt(id: string): CalendarOutboxItem
  acknowledgeOutbox(id: string, result: CalendarOutboxAcknowledgement): CalendarOutboxItem
  discardOutbox(id: string): CalendarOutboxSummary
  runLocalTestTransport(
    transport: CalendarLocalTestTransport,
    options?: { limit?: number },
  ): Promise<{ delivered: number; failed: number }>
}
