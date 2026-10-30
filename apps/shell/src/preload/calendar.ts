import { ipcRenderer } from 'electron'
import { CALENDAR_CHANNELS, type CalendarDesktopApi } from '../shared/calendar-api'

export const calendarDesktopApi: CalendarDesktopApi = {
  calendarWorkspaceStatus: () => ipcRenderer.invoke(CALENDAR_CHANNELS.status),
  calendarCreate: (name) => ipcRenderer.invoke(CALENDAR_CHANNELS.create, name),
  calendarImportFile: () => ipcRenderer.invoke(CALENDAR_CHANNELS.import),
  calendarRename: (id, name, revision) =>
    ipcRenderer.invoke(CALENDAR_CHANNELS.rename, id, name, revision),
  calendarRemove: (id, revision) => ipcRenderer.invoke(CALENDAR_CHANNELS.remove, id, revision),
  calendarAgenda: (query) => ipcRenderer.invoke(CALENDAR_CHANNELS.agenda, query),
  calendarEventDetails: (id, selector) => ipcRenderer.invoke(CALENDAR_CHANNELS.event, id, selector),
  calendarMutate: (id, mutation, options) =>
    ipcRenderer.invoke(CALENDAR_CHANNELS.mutate, id, mutation, options),
  calendarApplyMessage: (id, revision) =>
    ipcRenderer.invoke(CALENDAR_CHANNELS.applyMessage, id, revision),
  calendarExport: (id, revision, updateOriginal) =>
    ipcRenderer.invoke(CALENDAR_CHANNELS.export, id, revision, updateOriginal),
  calendarExportMessage: (id) => ipcRenderer.invoke(CALENDAR_CHANNELS.exportMessage, id),
  calendarDiscardMessage: (id) => ipcRenderer.invoke(CALENDAR_CHANNELS.discardMessage, id),
}
