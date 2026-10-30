import type {
  CalendarEventDetails,
  CalendarMutation,
  CalendarMutationOptions,
  CalendarMutationScope,
  CalendarOutboxSummary,
  CalendarRecordSummary,
} from '../../../../packages/productivity-engine/src/calendar-types'

export type { CalendarEventDetails, CalendarMutation, CalendarMutationScope, CalendarRecordSummary }

export interface CalendarAgendaQuery {
  calendarId?: string
  start: string
  end: string
  viewTimeZone?: string
}
export interface CalendarAgendaItem {
  calendarId: string
  calendarRevision: number
  uid: string
  recurrenceId: string | null
  instanceId: string
  summaryPreview: string
  locationPreview: string
  previewTruncated: boolean
  start: string
  end: string
  localStart: string
  localEnd: string
  timeZone: string
  allDay: boolean
  floating: boolean
  recurring: boolean
  status: string
}
export interface CalendarWorkspaceState {
  calendars: CalendarRecordSummary[]
  outbox: CalendarOutboxSummary[]
}
export interface CalendarEventSelection {
  event: CalendarEventDetails
  calendar: CalendarRecordSummary
}
export interface CalendarChangePreview {
  calendar: CalendarRecordSummary
  changedUid: string
  changedRecurrenceId: string | null
  outboxIds: string[]
  warnings: string[]
}
export interface CalendarDesktopApi {
  calendarWorkspaceStatus(): Promise<CalendarWorkspaceState>
  calendarCreate(name: string): Promise<CalendarRecordSummary>
  calendarImportFile(): Promise<CalendarRecordSummary | null>
  calendarRename(id: string, name: string, expectedRevision: number): Promise<CalendarRecordSummary>
  calendarRemove(id: string, expectedRevision: number): Promise<boolean>
  calendarAgenda(
    query: CalendarAgendaQuery,
  ): Promise<{ occurrences: CalendarAgendaItem[]; warnings: string[] }>
  calendarEventDetails(
    id: string,
    selector: { uid: string; recurrenceId?: string; scope?: CalendarMutationScope },
  ): Promise<CalendarEventSelection>
  calendarMutate(
    id: string,
    mutation: CalendarMutation,
    options: CalendarMutationOptions,
  ): Promise<CalendarChangePreview | null>
  calendarApplyMessage(
    id: string,
    expectedRevision: number,
  ): Promise<{
    calendar: CalendarRecordSummary
    applied: number
    ignored: number
    warnings: string[]
  } | null>
  calendarExport(
    id: string,
    expectedRevision: number,
    updateOriginal?: boolean,
  ): Promise<CalendarRecordSummary | null>
  calendarExportMessage(id: string): Promise<string | null>
  calendarDiscardMessage(id: string): Promise<void>
}
export const CALENDAR_CHANNELS = {
  status: 'calendar-workspace:status',
  create: 'calendar-workspace:create',
  import: 'calendar-workspace:import',
  rename: 'calendar-workspace:rename',
  remove: 'calendar-workspace:remove',
  agenda: 'calendar-workspace:agenda',
  event: 'calendar-workspace:event',
  mutate: 'calendar-workspace:mutate',
  applyMessage: 'calendar-workspace:apply-message',
  export: 'calendar-workspace:export',
  exportMessage: 'calendar-workspace:export-message',
  discardMessage: 'calendar-workspace:discard-message',
} as const
